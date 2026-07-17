#!/usr/bin/env node

import readline from 'node:readline'

const sessions = new Set()
let nextSession = 1
let activePrompt = null

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

const models = {
  availableModels: [{ modelId: 'fixture:hermes-test', name: 'Hermes Test', description: 'Provider: Fixture' }],
  currentModelId: 'fixture:hermes-test',
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  const { id, method, params = {} } = message
  if (method === 'initialize') return result(id, { protocolVersion: 1 })
  if (method === 'session/new') {
    const sessionId = `fixture-session-${nextSession++}`
    sessions.add(sessionId)
    return result(id, { sessionId, models })
  }
  if (method === 'session/load') {
    sessions.add(params.sessionId)
    return result(id, { sessionId: params.sessionId, models })
  }
  if (method === 'session/set_model') return result(id, {})
  if (method === 'session/cancel') {
    if (activePrompt) {
      clearTimeout(activePrompt.timer)
      result(activePrompt.id, { stopReason: 'cancelled' })
      activePrompt = null
    }
    return
  }
  if (method === 'session/prompt') {
    const text = params.prompt?.find((block) => block.type === 'text')?.text ?? ''
    if (text === 'crash') return process.exit(23)
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'fixture thought' } },
    } })
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}` } },
    } })
    if (text === 'wait for cancel') {
      activePrompt = { id, timer: setTimeout(() => {
        result(id, { stopReason: 'end_turn', usage: { fixture: true } })
        activePrompt = null
      }, 60_000) }
      return
    }
    return setTimeout(() => result(id, { stopReason: 'end_turn', usage: { fixture: true } }), 25)
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported: ${method}` } })
})
