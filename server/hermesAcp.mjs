// Embedded Hermes API server, backed by the `hermes acp` CLI (Agent Client
// Protocol: newline-delimited JSON-RPC over stdio).
//
// Replaces the external hermes-webui backend dependency: this module exposes
// the exact REST/SSE surface src/hermesBridge.ts already speaks —
//   POST /api/session/new           {workspace} → {session:{session_id,...}}
//   GET  /api/sessions              → {sessions:[...]}  (also the health probe)
//   POST /api/chat/start            {session_id, message, workspace, model?,
//                                    model_provider?, images?} → {stream_id} | 409
//   GET  /api/chat/stream           ?stream_id= → SSE (token/thought/tool/plan/
//                                    stream_end/apperror/cancel/error) with
//                                    full replay
//   GET  /api/chat/stream/status    ?stream_id= → {active, replay_available}
//   POST /api/chat/cancel           ?stream_id= → {cancelled}
//   GET  /api/models                → {groups, default_model, active_provider}
//                                    ?refresh=1 re-asks hermes (the CLI may have
//                                    been pointed at a different provider since)
//   GET/POST /api/reasoning         → degrade-soft (ACP has no effort control)
//
// One `hermes acp` child serves all sessions (ACP is session-multiplexed).
// The child is spawned lazily and respawned on demand after an exit. Session
// continuity across restarts uses ACP session/load (hermes persists session
// history itself). Streams are owned HERE: every SSE event is buffered per
// stream_id, so a dropped browser connection can reconnect and replay — the
// same reliability contract the WebUI backend provided.

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const RPC_TIMEOUT_MS = 120_000 // session/new can take ~10s on cold start
const STREAM_RETENTION_MS = 30 * 60 * 1000
const MAX_BUFFERED_EVENTS = 20_000
const MODEL_CATALOG_KV_KEY = 'hermes_model_catalog'
const MAX_BODY_BYTES = 4_000_000
// Prompt images ride inline as base64, so a turn's body is far bigger than a
// text-only one. The card downscales before upload; this is the backstop.
const MAX_PROMPT_BODY_BYTES = 32_000_000
const MAX_PROMPT_IMAGES = 8
const IMAGE_PATH_RE = /(?:^|[\s"'`(\[])((?:\/|~\/)[^\s"'`()\[\]]+\.(?:png|jpe?g|gif|webp|bmp|svg))/gi

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((done, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => done(body))
    req.on('error', reject)
  })
}

/** Prompt attachments → ACP image content blocks. The card sends data URLs; the
 *  wire format wants bare base64 plus its mime type. */
function toImageBlocks(raw) {
  if (!Array.isArray(raw)) return []
  const blocks = []
  for (const item of raw.slice(0, MAX_PROMPT_IMAGES)) {
    const source = String(item?.data ?? '').trim()
    if (!source) continue
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(source)
    const data = match ? match[2] : source
    const mimeType = String(item?.mimeType ?? '').trim() || (match ? match[1] : 'image/png')
    if (!data || !mimeType.startsWith('image/')) continue
    blocks.push({ type: 'image', data, mimeType })
  }
  return blocks
}

export function createHermesAcp({ command = 'hermes', args = ['acp'], env = {}, getKv, setKv, browseRoot = '', log = console } = {}) {
  // Hermes never sends image content blocks back over ACP — its image-producing
  // tools (browser screenshots, image_generate) report a *file path* in their
  // text result instead. So the only way an image Hermes made reaches the card
  // is to spot that path and let the store's sandboxed /store/fs/view/ serve it.
  const viewRoot = browseRoot ? resolve(browseRoot) : ''

  /** Absolute image path → path relative to BROWSE_ROOT, or null when it escapes
   *  the sandbox, does not exist, or is not a file. */
  function viewablePath(candidate) {
    if (!viewRoot) return null
    const home = process.env.HOME || ''
    const expanded = candidate.startsWith('~/') && home ? resolve(home, candidate.slice(2)) : resolve(candidate)
    const rel = relative(viewRoot, expanded)
    if (!rel || rel.startsWith('..') || rel.startsWith('/')) return null
    try {
      if (!statSync(expanded).isFile()) return null
    } catch {
      return null // reported but not (yet) on disk
    }
    return rel
  }

  function findImages(text, locations) {
    const found = new Set()
    for (const location of locations ?? []) {
      const rel = viewablePath(location)
      if (rel) found.add(rel)
    }
    for (const match of String(text ?? '').matchAll(IMAGE_PATH_RE)) {
      const rel = viewablePath(match[1])
      if (rel) found.add(rel)
    }
    return Array.from(found)
  }

  // ── ACP child + JSON-RPC plumbing ──────────────────────────────────────────
  let child = null
  let childInitialized = null // Promise while an initialize handshake is in flight
  let nextRpcId = 1
  let stdoutBuf = ''
  const pendingRpc = new Map() // id → {resolve, reject, timer}

  // ── API state ──────────────────────────────────────────────────────────────
  const sessions = new Map() // session_id → {cwd, model, provider, createdAt, loaded}
  const streams = new Map() // stream_id → stream record
  const activeStreamBySession = new Map() // session_id → stream_id
  let modelCatalog = null // {groups, default_model, active_provider}

  try {
    const persisted = getKv?.(MODEL_CATALOG_KV_KEY)
    if (persisted) modelCatalog = JSON.parse(persisted)
  } catch {
    // corrupt cache — rebuilt on the next session/new
  }

  function killChild(reason) {
    if (!child) return
    log.warn?.(`[hermes-acp] terminating child: ${reason}`)
    try {
      child.kill()
    } catch {
      // already gone
    }
    child = null
    childInitialized = null
  }

  function handleChildExit(code, signal) {
    child = null
    childInitialized = null
    const reason = `hermes acp exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`
    log.warn?.(`[hermes-acp] ${reason}`)
    for (const [, entry] of pendingRpc) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pendingRpc.clear()
    // Any in-flight streams can never finish now — surface the failure.
    for (const stream of streams.values()) {
      if (stream.active) finishStream(stream, 'error', { error: reason })
    }
    // Sessions must be re-loaded into the next child.
    for (const session of sessions.values()) session.loaded = false
  }

  function handleRpcLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      log.warn?.(`[hermes-acp] unparseable line: ${line.slice(0, 200)}`)
      return
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = pendingRpc.get(msg.id)
      if (!entry) return
      pendingRpc.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
      return
    }
    if (msg.method === 'session/update') {
      handleSessionUpdate(msg.params ?? {})
      return
    }
    if (msg.id !== undefined && msg.method === 'session/request_permission') {
      // Auto-approve for the session — same trust model as the TUI agents this
      // app launches (--yolo / --dangerously-skip-permissions style).
      const options = msg.params?.options ?? []
      const pick = options.find((o) => o.optionId === 'allow_session')
        ?? options.find((o) => o.optionId === 'allow_once')
        ?? options[0]
      writeRpc({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: pick?.optionId ?? 'allow_once' } } })
      return
    }
    if (msg.id !== undefined && msg.method) {
      // Unknown server→client request (fs/*, terminal/*): we advertised no such
      // capabilities, but answer anyway so the child never hangs on us.
      writeRpc({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported client method: ${msg.method}` } })
    }
  }

  function writeRpc(msg) {
    if (!child) throw new Error('hermes acp is not running')
    child.stdin.write(JSON.stringify(msg) + '\n')
  }

  function rpcRequest(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = nextRpcId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
          pendingRpc.delete(id)
          reject(new Error(`${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        : null
      pendingRpc.set(id, { resolve, reject, timer })
      try {
        writeRpc({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        pendingRpc.delete(id)
        if (timer) clearTimeout(timer)
        reject(error)
      }
    })
  }

  function rpcNotify(method, params) {
    try {
      writeRpc({ jsonrpc: '2.0', method, params })
    } catch {
      // child gone; the prompt promise rejection handles the fallout
    }
  }

  async function ensureChild() {
    if (child && childInitialized) return childInitialized
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    child = proc
    stdoutBuf = ''
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString()
      let idx
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (line) handleRpcLine(line)
      }
    })
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim()
      if (text) log.info?.(`[hermes-acp stderr] ${text.slice(0, 400)}`)
    })
    proc.on('exit', (code, signal) => {
      if (child === proc) handleChildExit(code, signal)
    })
    proc.on('error', (error) => {
      log.warn?.(`[hermes-acp] spawn error: ${error.message}`)
      if (child === proc) handleChildExit(null, 'spawn-error')
    })

    childInitialized = rpcRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'agent-rider', version: '1.0' },
    }).catch((error) => {
      killChild(`initialize failed: ${error.message}`)
      throw error
    })
    return childInitialized
  }

  // ── Model catalog ──────────────────────────────────────────────────────────
  // ACP reports models on session/new as modelId "provider:model". Convert to
  // the {groups:[{provider, provider_id, models:[{id,label}]}]} shape the
  // frontend already parses, and persist so /api/models is instant on boot.
  function captureModelCatalog(result) {
    const models = result?.models?.availableModels
    if (!Array.isArray(models) || !models.length) return
    const groups = new Map()
    for (const item of models) {
      const modelId = String(item.modelId ?? '')
      const sep = modelId.indexOf(':')
      const providerId = sep > 0 ? modelId.slice(0, sep) : ''
      const id = sep > 0 ? modelId.slice(sep + 1) : modelId
      if (!id) continue
      const key = providerId || 'default'
      if (!groups.has(key)) {
        groups.set(key, {
          provider: String(item.description ?? '').replace(/^Provider:\s*/i, '').trim() || providerId || 'Provider',
          provider_id: providerId || null,
          models: [],
        })
      }
      groups.get(key).models.push({ id, label: String(item.name ?? id) })
    }
    const currentId = String(result?.models?.currentModelId ?? '')
    const sep = currentId.indexOf(':')
    modelCatalog = {
      groups: Array.from(groups.values()),
      default_model: sep > 0 ? currentId.slice(sep + 1) : currentId,
      active_provider: sep > 0 ? currentId.slice(0, sep) : null,
    }
    try {
      setKv?.(MODEL_CATALOG_KV_KEY, JSON.stringify(modelCatalog))
    } catch {
      // persistence is best-effort
    }
  }

  /** Re-ask hermes what models it offers. The catalog only rides along on
   *  session/{new,load}, so a cached one goes stale the moment the hermes CLI
   *  is pointed at another provider — and nothing here would ever notice.
   *  Prefer reloading a session we already know over minting a throwaway one. */
  async function refreshModelCatalog(workspace) {
    await ensureChild()
    const [sessionId, session] = sessions.entries().next().value ?? []
    if (sessionId) {
      const result = await rpcRequest('session/load', {
        sessionId,
        cwd: session.cwd || workspace,
        mcpServers: [],
      })
      captureModelCatalog(result)
      return
    }
    if (!workspace) throw new Error('workspace is required to refresh the model catalog')
    await createSession(workspace)
  }

  // ── Sessions ───────────────────────────────────────────────────────────────
  async function createSession(workspace) {
    await ensureChild()
    const result = await rpcRequest('session/new', { cwd: workspace, mcpServers: [] })
    captureModelCatalog(result)
    const sessionId = String(result?.sessionId ?? '')
    if (!sessionId) throw new Error('session/new did not return a sessionId')
    sessions.set(sessionId, {
      cwd: workspace,
      model: modelCatalog?.default_model ?? '',
      provider: modelCatalog?.active_provider ?? '',
      createdAt: Date.now(),
      loaded: true,
    })
    return sessionId
  }

  /** Make `sessionId` usable in the current child, session/load-ing it if the
   *  child hasn't seen it (server restart, child respawn). Hermes persists the
   *  transcript itself, so a load resumes the conversation with history. */
  async function ensureSessionLoaded(sessionId, workspace) {
    await ensureChild()
    const known = sessions.get(sessionId)
    if (known?.loaded) return sessionId
    const cwd = known?.cwd || workspace
    try {
      const result = await rpcRequest('session/load', { sessionId, cwd, mcpServers: [] })
      captureModelCatalog(result)
      sessions.set(sessionId, { ...(known ?? { createdAt: Date.now() }), cwd, loaded: true })
      return sessionId
    } catch (error) {
      log.warn?.(`[hermes-acp] session/load ${sessionId} failed (${error.message}); starting a fresh session`)
      return createSession(cwd)
    }
  }

  // ── Streams ────────────────────────────────────────────────────────────────
  function pushEvent(stream, eventName, payload) {
    if (stream.events.length >= MAX_BUFFERED_EVENTS) return
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
    stream.events.push(frame)
    for (const client of stream.clients) {
      try {
        client.write(frame)
      } catch {
        stream.clients.delete(client)
      }
    }
  }

  function finishStream(stream, eventName, payload) {
    if (!stream.active) return
    stream.active = false
    stream.finishedAt = Date.now()
    pushEvent(stream, eventName, payload)
    if (activeStreamBySession.get(stream.sessionId) === stream.id) {
      activeStreamBySession.delete(stream.sessionId)
    }
    for (const client of stream.clients) {
      try {
        client.end()
      } catch {
        // already closed
      }
    }
    stream.clients.clear()
    purgeOldStreams()
  }

  function purgeOldStreams() {
    const cutoff = Date.now() - STREAM_RETENTION_MS
    for (const [id, stream] of streams) {
      if (!stream.active && (stream.finishedAt ?? 0) < cutoff) streams.delete(id)
    }
  }

  /** Flatten ACP content blocks to display text, dropping non-text parts. */
  function contentText(blocks) {
    if (!Array.isArray(blocks)) return ''
    const parts = []
    for (const block of blocks) {
      const inner = block?.content ?? block
      if (inner?.type === 'text' && inner.text) parts.push(String(inner.text))
    }
    return parts.join('\n').trim()
  }

  function handleSessionUpdate(params) {
    const sessionId = String(params.sessionId ?? '')
    const update = params.update ?? {}
    const streamId = activeStreamBySession.get(sessionId)
    if (!streamId) return // replay noise from session/load, or late events
    const stream = streams.get(streamId)
    if (!stream || !stream.active) return

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content?.type !== 'text') return
        const text = String(update.content.text ?? '')
        if (text) pushEvent(stream, 'token', { text })
        return
      }
      case 'agent_thought_chunk': {
        if (update.content?.type !== 'text') return
        const text = String(update.content.text ?? '')
        if (text) pushEvent(stream, 'thought', { text })
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        const id = String(update.toolCallId ?? '')
        if (!id) return
        // A fresh tool_call carries no status — it has only just started. Updates
        // carry one, but hermes does not always send a terminal update for every
        // call (an unmatched `read` was observed), so the client also reconciles
        // leftovers when the turn ends.
        const payload = { id, status: String(update.status ?? 'pending') }
        if (update.title !== undefined) payload.title = String(update.title)
        if (update.kind !== undefined) payload.kind = String(update.kind)
        if (Array.isArray(update.locations)) {
          payload.locations = update.locations.map((loc) => String(loc?.path ?? '')).filter(Boolean)
        }
        const output = contentText(update.content)
        if (output) payload.output = output
        const images = findImages(output, payload.locations)
        if (images.length) payload.images = images
        pushEvent(stream, 'tool', payload)
        return
      }
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : []
        pushEvent(stream, 'plan', {
          entries: entries.map((entry) => ({
            content: String(entry?.content ?? ''),
            status: String(entry?.status ?? 'pending'),
          })).filter((entry) => entry.content),
        })
        return
      }
      default:
        // usage_update / available_commands_update have no slot in the card UI
        // today; the SSE heartbeat keeps the connection alive regardless.
    }
  }

  async function startTurn({ sessionId, message, workspace, model, provider, images = [] }) {
    const effectiveSessionId = await ensureSessionLoaded(sessionId, workspace)
    const session = sessions.get(effectiveSessionId)

    if (model && (model !== session.model || (provider && provider !== session.provider))) {
      const modelId = provider ? `${provider}:${model}` : model
      try {
        await rpcRequest('session/set_model', { sessionId: effectiveSessionId, modelId })
        session.model = model
        if (provider) session.provider = provider
      } catch (error) {
        log.warn?.(`[hermes-acp] session/set_model ${modelId} failed: ${error.message}`)
      }
    }

    const streamId = `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    const stream = {
      id: streamId,
      sessionId: effectiveSessionId,
      active: true,
      events: [],
      clients: new Set(),
      createdAt: Date.now(),
      finishedAt: null,
    }
    streams.set(streamId, stream)
    activeStreamBySession.set(effectiveSessionId, streamId)

    rpcRequest('session/prompt', {
      sessionId: effectiveSessionId,
      prompt: [{ type: 'text', text: message }, ...images],
    }, 0)
      .then((result) => {
        const stopReason = String(result?.stopReason ?? 'end_turn')
        if (stopReason === 'cancelled') finishStream(stream, 'cancel', { message: 'Task stopped.' })
        else if (stopReason === 'refusal') finishStream(stream, 'apperror', { message: 'Hermes declined this request.' })
        else finishStream(stream, 'stream_end', { usage: result?.usage ?? null })
      })
      .catch((error) => {
        finishStream(stream, 'apperror', { message: error.message || 'Hermes prompt failed' })
      })

    return streamId
  }

  // ── HTTP surface ───────────────────────────────────────────────────────────
  async function handle(req, res, pathname, requestUrl) {
    if (req.method === 'POST' && pathname === '/api/session/new') {
      let workspace = ''
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        workspace = String(body.workspace ?? '').trim()
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      if (!workspace) {
        sendJson(res, 400, { error: 'workspace is required' })
        return
      }
      try {
        const sessionId = await createSession(workspace)
        const session = sessions.get(sessionId)
        sendJson(res, 200, {
          session: {
            session_id: sessionId,
            workspace,
            model: session?.model ?? '',
            model_provider: session?.provider ?? '',
            created_at: Date.now() / 1000,
          },
        })
      } catch (error) {
        sendJson(res, 500, { error: `hermes acp: ${error.message}` })
      }
      return
    }

    if (req.method === 'GET' && pathname === '/api/sessions') {
      const list = Array.from(sessions, ([id, s]) => ({
        session_id: id,
        workspace: s.cwd,
        model: s.model || null,
        model_provider: s.provider || null,
        created_at: s.createdAt / 1000,
        is_streaming: activeStreamBySession.has(id),
      }))
      sendJson(res, 200, { sessions: list })
      return
    }

    if (req.method === 'POST' && pathname === '/api/chat/start') {
      let body
      try {
        body = JSON.parse((await readBody(req, MAX_PROMPT_BODY_BYTES)) || '{}')
      } catch (error) {
        sendJson(res, 400, { error: error.message === 'body too large' ? 'attachments too large' : 'invalid JSON body' })
        return
      }
      const sessionId = String(body.session_id ?? '').trim()
      const message = String(body.message ?? '')
      const workspace = String(body.workspace ?? '').trim()
      const images = toImageBlocks(body.images)
      if (!sessionId || (!message && !images.length)) {
        sendJson(res, 400, { error: 'session_id and message are required' })
        return
      }
      const existing = activeStreamBySession.get(sessionId)
      if (existing && streams.get(existing)?.active) {
        sendJson(res, 409, { error: 'session already has an active stream', active_stream_id: existing })
        return
      }
      try {
        const streamId = await startTurn({
          sessionId,
          message,
          workspace,
          model: String(body.model ?? '').trim(),
          provider: String(body.model_provider ?? '').trim(),
          images,
        })
        sendJson(res, 200, { stream_id: streamId })
      } catch (error) {
        sendJson(res, 500, { error: `hermes acp: ${error.message}` })
      }
      return
    }

    if (req.method === 'GET' && pathname === '/api/chat/stream') {
      const streamId = String(requestUrl.searchParams.get('stream_id') ?? '')
      const stream = streams.get(streamId)
      if (!stream) {
        sendJson(res, 404, { error: `unknown stream: ${streamId}` })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // Full replay, then live.
      for (const frame of stream.events) res.write(frame)
      if (!stream.active) {
        res.end()
        return
      }
      stream.clients.add(res)
      const heartbeat = setInterval(() => {
        try {
          res.write(': keepalive\n\n')
        } catch {
          // cleaned up on close
        }
      }, 15_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        stream.clients.delete(res)
      })
      return
    }

    if (req.method === 'GET' && pathname === '/api/chat/stream/status') {
      const streamId = String(requestUrl.searchParams.get('stream_id') ?? '')
      const stream = streams.get(streamId)
      sendJson(res, 200, {
        stream_id: streamId,
        active: Boolean(stream?.active),
        replay_available: Boolean(stream),
      })
      return
    }

    if ((req.method === 'POST' || req.method === 'GET') && pathname === '/api/chat/cancel') {
      const streamId = String(requestUrl.searchParams.get('stream_id') ?? '')
      const stream = streams.get(streamId)
      if (!stream || !stream.active) {
        sendJson(res, 200, { cancelled: false })
        return
      }
      rpcNotify('session/cancel', { sessionId: stream.sessionId })
      // The prompt promise resolves with stopReason=cancelled and finishes the
      // stream; if the child is wedged, force-finish after a grace period.
      setTimeout(() => {
        if (stream.active) finishStream(stream, 'cancel', { message: 'Task stopped.' })
      }, 10_000)
      sendJson(res, 200, { cancelled: true })
      return
    }

    if (req.method === 'GET' && pathname === '/api/models') {
      // ?refresh=1 re-asks hermes, so switching the CLI to another provider is
      // one click away in the card instead of stuck behind a stale cache.
      if (requestUrl.searchParams.get('refresh') === '1') {
        try {
          await refreshModelCatalog(String(requestUrl.searchParams.get('workspace') ?? '').trim())
        } catch (error) {
          sendJson(res, 502, { error: `hermes acp: ${error.message}` })
          return
        }
      }
      if (modelCatalog) {
        sendJson(res, 200, modelCatalog)
        return
      }
      // Cold start with no persisted catalog: models are only reported on
      // session/new, so return an empty catalog rather than block for ~10s.
      // The first real conversation populates and persists it.
      sendJson(res, 200, { groups: [], default_model: '', active_provider: null })
      return
    }

    if (pathname === '/api/reasoning') {
      // ACP has no reasoning-effort control; report none so the UI falls back
      // to its defaults, and accept writes as a no-op.
      if (req.method === 'GET') sendJson(res, 200, { supported_efforts: [], reasoning_effort: '' })
      else sendJson(res, 200, { ok: true })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  return {
    /** Route an /api/* request. Returns true if handled. */
    handleHttp(req, res, pathname, requestUrl) {
      if (!pathname.startsWith('/api/')) return false
      handle(req, res, pathname, requestUrl).catch((error) => {
        try {
          sendJson(res, 500, { error: error.message || 'internal error' })
        } catch {
          // headers already sent (mid-SSE) — nothing else to do
        }
      })
      return true
    },
    shutdown() {
      killChild('server shutdown')
    },
  }
}
