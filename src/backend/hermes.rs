use super::{config::Config, database::Database};
use axum::{
    body::{to_bytes, Body},
    http::{header, Method, Request, Response},
};
use bytes::Bytes;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    sync::{broadcast, oneshot, Mutex},
    time::timeout,
};

const MODEL_KEY: &str = "hermes_model_catalog";
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn json_response(status: u16, value: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(value.to_string()))
        .unwrap()
}

struct Rpc {
    target: String,
    writer: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next: AtomicU64,
    initialized: AtomicBool,
    start_lock: Mutex<()>,
    updates: tokio::sync::mpsc::UnboundedSender<Value>,
}
impl Rpc {
    fn new(target: String, updates: tokio::sync::mpsc::UnboundedSender<Value>) -> Arc<Self> {
        Arc::new(Self {
            target,
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            initialized: AtomicBool::new(false),
            start_lock: Mutex::new(()),
            updates,
        })
    }
    async fn ensure(self: &Arc<Self>) -> Result<(), String> {
        if self.initialized.load(Ordering::Acquire) {
            return Ok(());
        }
        let _guard = self.start_lock.lock().await;
        if self.initialized.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut child = Command::new(&self.target)
            .arg("acp")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or("hermes acp stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("hermes acp stdout unavailable")?;
        *self.writer.lock().await = Some(stdin);
        let rpc = self.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message.get("id").is_some()
                    && (message.get("result").is_some() || message.get("error").is_some())
                {
                    let id = message["id"].as_u64().unwrap_or(0);
                    if let Some(reply) = rpc.pending.lock().await.remove(&id) {
                        let value = if message.get("error").is_some() {
                            Err(message["error"]["message"]
                                .as_str()
                                .unwrap_or("ACP error")
                                .into())
                        } else {
                            Ok(message["result"].clone())
                        };
                        let _ = reply.send(value);
                    }
                } else if message["method"] == "session/update" {
                    let _ = rpc.updates.send(message["params"].clone());
                } else if message.get("id").is_some()
                    && message["method"] == "session/request_permission"
                {
                    let options = message["params"]["options"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let selected = options
                        .iter()
                        .find(|option| option["optionId"] == "allow_session")
                        .or_else(|| {
                            options
                                .iter()
                                .find(|option| option["optionId"] == "allow_once")
                        })
                        .or_else(|| options.first());
                    let option_id = selected
                        .and_then(|option| option["optionId"].as_str())
                        .unwrap_or("allow_once");
                    let reply = format!(
                        "{}\n",
                        json!({"jsonrpc":"2.0","id":message["id"],"result":{"outcome":{"outcome":"selected","optionId":option_id}}})
                    );
                    if let Some(writer) = rpc.writer.lock().await.as_mut() {
                        let _ = writer.write_all(reply.as_bytes()).await;
                    }
                } else if message.get("id").is_some() && message.get("method").is_some() {
                    let reply = format!(
                        "{}\n",
                        json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32601,"message":format!("unsupported client method: {}",message["method"].as_str().unwrap_or("unknown"))}})
                    );
                    if let Some(writer) = rpc.writer.lock().await.as_mut() {
                        let _ = writer.write_all(reply.as_bytes()).await;
                    }
                }
            }
            rpc.initialized.store(false, Ordering::Release);
            *rpc.writer.lock().await = None;
            for (_, reply) in rpc.pending.lock().await.drain() {
                let _ = reply.send(Err("hermes acp exited".into()));
            }
            let _ = rpc.updates.send(json!({"_childExit":true}));
            let _ = child.wait().await;
        });
        let initialized=self.raw_request("initialize",json!({"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}},"clientInfo":{"name":"agent-rider","version":"1.0"}}),Some(Duration::from_secs(120))).await;
        if initialized.is_err() {
            *self.writer.lock().await = None;
            return initialized.map(|_| ());
        }
        self.initialized.store(true, Ordering::Release);
        Ok(())
    }
    async fn raw_request(
        &self,
        method: &str,
        params: Value,
        wait: Option<Duration>,
    ) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let line = format!(
            "{}\n",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        );
        let write = async {
            let mut writer = self.writer.lock().await;
            writer
                .as_mut()
                .ok_or("hermes acp is not running")?
                .write_all(line.as_bytes())
                .await
                .map_err(|e| e.to_string())
        };
        if let Err(error) = write.await {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        match wait {
            Some(duration) => timeout(duration, rx)
                .await
                .map_err(|_| format!("{method} timed out"))?
                .map_err(|_| "hermes acp exited".to_string())?,
            None => rx.await.map_err(|_| "hermes acp exited".to_string())?,
        }
    }
    async fn request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        wait: Option<Duration>,
    ) -> Result<Value, String> {
        self.ensure().await?;
        self.raw_request(method, params, wait).await
    }
    async fn notify(self: &Arc<Self>, method: &str, params: Value) {
        if self.ensure().await.is_err() {
            return;
        }
        let line = format!(
            "{}\n",
            json!({"jsonrpc":"2.0","method":method,"params":params})
        );
        if let Some(writer) = self.writer.lock().await.as_mut() {
            let _ = writer.write_all(line.as_bytes()).await;
        }
    }
}

#[derive(Clone)]
struct Session {
    cwd: String,
    model: String,
    provider: String,
    created_at: u64,
    loaded: bool,
}
struct Stream {
    session_id: String,
    active: bool,
    events: Vec<String>,
    sender: broadcast::Sender<String>,
    finished_at: Option<u64>,
}
pub struct Hermes {
    rpc: Arc<Rpc>,
    db: Database,
    sessions: Mutex<HashMap<String, Session>>,
    streams: Mutex<HashMap<String, Stream>>,
    active: Mutex<HashMap<String, String>>,
    models: Mutex<Value>,
    browse_root: PathBuf,
}
impl Hermes {
    pub async fn new(config: &Config, db: Database) -> Arc<Self> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let models = db
            .get_kv(MODEL_KEY)
            .await
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_else(
                || json!({"groups":[],"default_model":"","active_provider":Value::Null}),
            );
        let hermes = Arc::new(Self {
            rpc: Rpc::new(config.resolve_command(&config.hermes_target), tx),
            db,
            sessions: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
            models: Mutex::new(models),
            browse_root: config.browse_root.clone(),
        });
        let weak = Arc::downgrade(&hermes);
        tokio::spawn(async move {
            while let Some(update) = rx.recv().await {
                let Some(hermes) = weak.upgrade() else { break };
                if update["_childExit"] == true {
                    for session in hermes.sessions.lock().await.values_mut() {
                        session.loaded = false
                    }
                    continue;
                }
                hermes.session_update(update).await;
            }
        });
        hermes
    }
    async fn capture_models(&self, result: &Value) {
        let Some(items) = result["models"]["availableModels"].as_array() else {
            return;
        };
        if items.is_empty() {
            return;
        }
        let mut groups: Vec<Value> = vec![];
        for item in items {
            let full = item["modelId"].as_str().unwrap_or("");
            let (provider, id) = full.split_once(':').unwrap_or(("", full));
            if id.is_empty() {
                continue;
            }
            if let Some(group) = groups.iter_mut().find(|g| g["provider_id"] == provider) {
                group["models"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"id":id,"label":item["name"].as_str().unwrap_or(id)}));
            } else {
                groups.push(json!({"provider":item["description"].as_str().unwrap_or(provider).trim_start_matches("Provider: "),"provider_id":if provider.is_empty(){Value::Null}else{json!(provider)},"models":[{"id":id,"label":item["name"].as_str().unwrap_or(id)}]}));
            }
        }
        let current = result["models"]["currentModelId"].as_str().unwrap_or("");
        let (provider, model) = current.split_once(':').unwrap_or(("", current));
        let catalog = json!({"groups":groups,"default_model":model,"active_provider":if provider.is_empty(){Value::Null}else{json!(provider)}});
        *self.models.lock().await = catalog.clone();
        let _ = self.db.set_kv(MODEL_KEY, catalog.to_string()).await;
    }
    async fn refresh_models(&self, workspace: &str) -> Result<(), String> {
        if let Some((id, session)) = self
            .sessions
            .lock()
            .await
            .iter()
            .next()
            .map(|(id, session)| (id.clone(), session.clone()))
        {
            let result = self
                .rpc
                .request(
                    "session/load",
                    json!({"sessionId":id,"cwd":session.cwd,"mcpServers":[]}),
                    Some(Duration::from_secs(120)),
                )
                .await?;
            self.capture_models(&result).await;
            return Ok(());
        }
        if workspace.is_empty() {
            return Err("workspace is required to refresh the model catalog".into());
        }
        self.new_session(workspace).await.map(|_| ())
    }
    async fn new_session(&self, cwd: &str) -> Result<String, String> {
        let result = self
            .rpc
            .request(
                "session/new",
                json!({"cwd":cwd,"mcpServers":[]}),
                Some(Duration::from_secs(120)),
            )
            .await?;
        self.capture_models(&result).await;
        let id = result["sessionId"].as_str().unwrap_or("").to_string();
        if id.is_empty() {
            return Err("session/new did not return a sessionId".into());
        }
        let models = self.models.lock().await.clone();
        self.sessions.lock().await.insert(
            id.clone(),
            Session {
                cwd: cwd.into(),
                model: models["default_model"].as_str().unwrap_or("").into(),
                provider: models["active_provider"].as_str().unwrap_or("").into(),
                created_at: now_ms(),
                loaded: true,
            },
        );
        Ok(id)
    }
    async fn ensure_session(&self, id: &str, cwd: &str) -> Result<String, String> {
        self.rpc.ensure().await?;
        if self.sessions.lock().await.get(id).is_some_and(|s| s.loaded) {
            return Ok(id.into());
        }
        let actual_cwd = self
            .sessions
            .lock()
            .await
            .get(id)
            .map(|s| s.cwd.clone())
            .unwrap_or_else(|| cwd.into());
        match self
            .rpc
            .request(
                "session/load",
                json!({"sessionId":id,"cwd":actual_cwd,"mcpServers":[]}),
                Some(Duration::from_secs(120)),
            )
            .await
        {
            Ok(result) => {
                self.capture_models(&result).await;
                let models = self.models.lock().await.clone();
                self.sessions.lock().await.insert(
                    id.into(),
                    Session {
                        cwd: actual_cwd,
                        model: models["default_model"].as_str().unwrap_or("").into(),
                        provider: models["active_provider"].as_str().unwrap_or("").into(),
                        created_at: now_ms(),
                        loaded: true,
                    },
                );
                Ok(id.into())
            }
            Err(_) => self.new_session(&actual_cwd).await,
        }
    }
    async fn push(&self, id: &str, event: &str, payload: Value) {
        let mut streams = self.streams.lock().await;
        if let Some(stream) = streams.get_mut(id) {
            if stream.events.len() >= 20_000 {
                return;
            }
            let frame = format!("event: {event}\ndata: {}\n\n", payload);
            stream.events.push(frame.clone());
            let _ = stream.sender.send(frame);
        }
    }
    async fn finish(&self, id: &str, event: &str, payload: Value) {
        let session = {
            let mut streams = self.streams.lock().await;
            let Some(stream) = streams.get_mut(id) else {
                return;
            };
            if !stream.active {
                return;
            }
            stream.active = false;
            stream.finished_at = Some(now_ms());
            stream.session_id.clone()
        };
        self.push(id, event, payload).await;
        let mut active = self.active.lock().await;
        if active.get(&session).is_some_and(|v| v == id) {
            active.remove(&session);
        }
    }
    async fn session_update(&self, params: Value) {
        let session = params["sessionId"].as_str().unwrap_or("");
        let Some(stream_id) = self.active.lock().await.get(session).cloned() else {
            return;
        };
        let update = &params["update"];
        match update["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => {
                if let Some(text) = update["content"]["text"].as_str() {
                    if !text.is_empty() {
                        self.push(&stream_id, "token", json!({"text":text})).await
                    }
                }
            }
            "agent_thought_chunk" => {
                if let Some(text) = update["content"]["text"].as_str() {
                    if !text.is_empty() {
                        self.push(&stream_id, "thought", json!({"text":text})).await
                    }
                }
            }
            "tool_call" | "tool_call_update" => {
                let id = update["toolCallId"].as_str().unwrap_or("");
                if !id.is_empty() {
                    let mut payload =
                        json!({"id":id,"status":update["status"].as_str().unwrap_or("pending")});
                    for key in ["title", "kind", "locations"] {
                        if !update[key].is_null() {
                            payload[key] = update[key].clone()
                        }
                    }
                    let output = content_text(&update["content"]);
                    if !output.is_empty() {
                        payload["output"] = json!(output);
                    }
                    let images = discover_images(&self.browse_root, &output, &update["locations"]);
                    if !images.is_empty() {
                        payload["images"] = json!(images);
                    }
                    self.push(&stream_id, "tool", payload).await
                }
            }
            "plan" => {
                self.push(&stream_id, "plan", json!({"entries":update["entries"]}))
                    .await
            }
            _ => {}
        }
    }
    async fn start(self: &Arc<Self>, body: &Value) -> Result<String, String> {
        let requested = body["session_id"].as_str().unwrap_or("");
        let cwd = body["workspace"].as_str().unwrap_or("");
        let session_id = self.ensure_session(requested, cwd).await?;
        if let Some(existing) = self.active.lock().await.get(&session_id).cloned() {
            if self
                .streams
                .lock()
                .await
                .get(&existing)
                .is_some_and(|s| s.active)
            {
                return Err(format!("conflict:{existing}"));
            }
        }
        let model = body["model"].as_str().unwrap_or("");
        let provider = body["model_provider"].as_str().unwrap_or("");
        if !model.is_empty() {
            let model_id = if provider.is_empty() {
                model.into()
            } else {
                format!("{provider}:{model}")
            };
            let _ = self
                .rpc
                .request(
                    "session/set_model",
                    json!({"sessionId":session_id,"modelId":model_id}),
                    Some(Duration::from_secs(120)),
                )
                .await;
        }
        let id = format!("st_{}_{}", now_ms(), rand::random::<u32>());
        let (sender, _) = broadcast::channel(1024);
        self.streams.lock().await.insert(
            id.clone(),
            Stream {
                session_id: session_id.clone(),
                active: true,
                events: vec![],
                sender,
                finished_at: None,
            },
        );
        self.active
            .lock()
            .await
            .insert(session_id.clone(), id.clone());
        let mut prompt = vec![json!({"type":"text","text":body["message"].as_str().unwrap_or("")})];
        for image in body["images"].as_array().into_iter().flatten().take(8) {
            let source = image["data"].as_str().unwrap_or("");
            let (data, mime) = source
                .strip_prefix("data:")
                .and_then(|v| v.split_once(";base64,"))
                .map(|(m, d)| (d, m))
                .unwrap_or((source, image["mimeType"].as_str().unwrap_or("image/png")));
            if !data.is_empty() && mime.starts_with("image/") {
                prompt.push(json!({"type":"image","data":data,"mimeType":mime}));
            }
        }
        let hermes = self.clone();
        let stream_id = id.clone();
        tokio::spawn(async move {
            match hermes
                .rpc
                .request(
                    "session/prompt",
                    json!({"sessionId":session_id,"prompt":prompt}),
                    None,
                )
                .await
            {
                Ok(result) => match result["stopReason"].as_str().unwrap_or("end_turn") {
                    "cancelled" => {
                        hermes
                            .finish(&stream_id, "cancel", json!({"message":"Task stopped."}))
                            .await
                    }
                    "refusal" => {
                        hermes
                            .finish(
                                &stream_id,
                                "apperror",
                                json!({"message":"Hermes declined this request."}),
                            )
                            .await
                    }
                    _ => hermes
                        .finish(
                            &stream_id,
                            "stream_end",
                            json!({"usage":result.get("usage").cloned().unwrap_or(Value::Null)}),
                        )
                        .await,
                },
                Err(error) => {
                    hermes
                        .finish(&stream_id, "apperror", json!({"message":error}))
                        .await
                }
            }
        });
        Ok(id)
    }
}

pub async fn handle(hermes: Arc<Hermes>, req: Request<Body>) -> Response<Body> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query: HashMap<String, String> =
        serde_urlencoded::from_str(req.uri().query().unwrap_or("")).unwrap_or_default();
    match (method, path.as_str()) {
        (Method::POST, "/api/session/new") => {
            let body = read(req, 4_000_000).await;
            let workspace = body["workspace"].as_str().unwrap_or("").trim();
            if workspace.is_empty() {
                return json_response(400, json!({"error":"workspace is required"}));
            }
            match hermes.new_session(workspace).await {
                Ok(id) => {
                    let session = hermes.sessions.lock().await.get(&id).cloned().unwrap();
                    json_response(
                        200,
                        json!({"session":{"session_id":id,"workspace":workspace,"model":session.model,"model_provider":session.provider,"created_at":session.created_at as f64/1000.0}}),
                    )
                }
                Err(e) => json_response(500, json!({"error":format!("hermes acp: {e}")})),
            }
        }
        (Method::GET, "/api/sessions") => {
            let active = hermes.active.lock().await;
            let sessions=hermes.sessions.lock().await.iter().map(|(id,s)|json!({"session_id":id,"workspace":s.cwd,"model":if s.model.is_empty(){Value::Null}else{json!(s.model)},"model_provider":if s.provider.is_empty(){Value::Null}else{json!(s.provider)},"created_at":s.created_at as f64/1000.0,"is_streaming":active.contains_key(id)})).collect::<Vec<_>>();
            json_response(200, json!({"sessions":sessions}))
        }
        (Method::POST, "/api/chat/start") => {
            let body = read(req, 32_000_000).await;
            let session = body["session_id"].as_str().unwrap_or("");
            let has_images = body["images"].as_array().is_some_and(|v| !v.is_empty());
            if session.is_empty()
                || (body["message"].as_str().unwrap_or("").is_empty() && !has_images)
            {
                return json_response(400, json!({"error":"session_id and message are required"}));
            }
            match hermes.start(&body).await {
                Ok(id) => json_response(200, json!({"stream_id":id})),
                Err(e) if e.starts_with("conflict:") => json_response(
                    409,
                    json!({"error":"session already has an active stream","active_stream_id":e.trim_start_matches("conflict:")}),
                ),
                Err(e) => json_response(500, json!({"error":format!("hermes acp: {e}")})),
            }
        }
        (Method::GET, "/api/chat/stream") => {
            let id = query.get("stream_id").cloned().unwrap_or_default();
            let (stream_events, mut receiver, active) = match hermes.streams.lock().await.get(&id) {
                Some(s) => (s.events.clone(), s.sender.subscribe(), s.active),
                None => {
                    return json_response(404, json!({"error":format!("unknown stream: {id}")}))
                }
            };
            let stream = async_stream::stream! {
                for event in stream_events { yield Ok::<Bytes,Infallible>(Bytes::from(event)); }
                if active {
                    while let Ok(event) = receiver.recv().await {
                        let terminal = event.starts_with("event: stream_end") || event.starts_with("event: cancel") || event.starts_with("event: apperror") || event.starts_with("event: error");
                        yield Ok(Bytes::from(event));
                        if terminal { break; }
                    }
                }
            };
            Response::builder()
                .status(200)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .header(header::CACHE_CONTROL, "no-cache")
                .header("x-accel-buffering", "no")
                .body(Body::from_stream(stream))
                .unwrap()
        }
        (Method::GET, "/api/chat/stream/status") => {
            let id = query.get("stream_id").cloned().unwrap_or_default();
            let streams = hermes.streams.lock().await;
            json_response(
                200,
                json!({"stream_id":id,"active":streams.get(&id).is_some_and(|s|s.active),"replay_available":streams.contains_key(&id)}),
            )
        }
        (Method::POST | Method::GET, "/api/chat/cancel") => {
            let id = query.get("stream_id").cloned().unwrap_or_default();
            let session = hermes
                .streams
                .lock()
                .await
                .get(&id)
                .filter(|s| s.active)
                .map(|s| s.session_id.clone());
            let Some(session) = session else {
                return json_response(200, json!({"cancelled":false}));
            };
            hermes
                .rpc
                .notify("session/cancel", json!({"sessionId":session}))
                .await;
            let h = hermes.clone();
            let stream = id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(10)).await;
                h.finish(&stream, "cancel", json!({"message":"Task stopped."}))
                    .await;
            });
            json_response(200, json!({"cancelled":true}))
        }
        (Method::GET, "/api/models") => {
            if query.get("refresh").is_some_and(|value| value == "1") {
                if let Err(error) = hermes
                    .refresh_models(query.get("workspace").map(String::as_str).unwrap_or(""))
                    .await
                {
                    return json_response(502, json!({"error":format!("hermes acp: {error}")}));
                }
            }
            json_response(200, hermes.models.lock().await.clone())
        }
        (Method::GET, "/api/reasoning") => {
            json_response(200, json!({"supported_efforts":[],"reasoning_effort":""}))
        }
        (_, "/api/reasoning") => json_response(200, json!({"ok":true})),
        _ => json_response(404, json!({"error":"not found"})),
    }
}
async fn read(req: Request<Body>, limit: usize) -> Value {
    to_bytes(req.into_body(), limit)
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}))
}

fn content_text(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            let inner = block.get("content").unwrap_or(block);
            (inner["type"] == "text")
                .then(|| inner["text"].as_str())
                .flatten()
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn discover_images(root: &Path, output: &str, locations: &Value) -> Vec<String> {
    let mut candidates = locations
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| value["path"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    if let Ok(pattern) = regex::Regex::new(
        r#"(?:^|[\s\"'`(\[])((?:/|~/)[^\s\"'`()\[\]]+\.(?:png|jpe?g|gif|webp|bmp|svg))"#,
    ) {
        candidates.extend(
            pattern
                .captures_iter(output)
                .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_owned())),
        );
    }
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let home = std::env::var("HOME").unwrap_or_default();
    let mut found = Vec::new();
    for candidate in candidates {
        let path = if let Some(rest) = candidate.strip_prefix("~/") {
            PathBuf::from(&home).join(rest)
        } else {
            PathBuf::from(candidate)
        };
        let Ok(canonical) = std::fs::canonicalize(&path) else {
            continue;
        };
        if !canonical.is_file() || !canonical.starts_with(&canonical_root) {
            continue;
        }
        let Ok(relative) = canonical.strip_prefix(&canonical_root) else {
            continue;
        };
        let value = relative
            .to_string_lossy()
            .trim_start_matches('/')
            .to_string();
        if !value.is_empty() && !found.contains(&value) {
            found.push(value);
        }
    }
    found
}
