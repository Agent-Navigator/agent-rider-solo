use super::{auth, server::AppState};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{process::Command, sync::mpsc, time::timeout};

fn safe_cwd(state: &AppState, value: Option<&str>) -> PathBuf {
    value
        .and_then(|v| state.files.existing(v).ok())
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| state.config.default_cwd.clone())
}

pub fn agents(state: &AppState) -> Value {
    let mut result = serde_json::Map::new();
    for name in ["hermes", "claude", "codex", "agy", "devin"] {
        let path = state.config.resolve_command(name);
        result.insert(
            name.into(),
            json!(path.contains('/') && Path::new(&path).exists()),
        );
    }
    json!({"agents": result})
}

pub async fn run(state: &AppState, body: &Value) -> Value {
    let command = body["command"].as_str().unwrap_or("").trim();
    let cwd = safe_cwd(state, body["cwd"].as_str());
    if command.is_empty() {
        return json!({"output":"","exitCode":0,"cwd":cwd,"nextCwd":cwd,"timedOut":false});
    }
    let script = format!("{command}\n__agent_rider_status=$?\nprintf '\\n__AGENT_RIDER_EXIT__%s\\n' \"$__agent_rider_status\"\nprintf '__AGENT_RIDER_CWD__%s\\n' \"$PWD\"\nexit \"$__agent_rider_status\"\n");
    let child = Command::new("/bin/bash")
        .args(["-lc", &script])
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(child) = child else {
        return json!({"output":"failed to start shell","exitCode":1,"cwd":cwd,"nextCwd":cwd,"timedOut":false});
    };
    let result = timeout(Duration::from_secs(120), child.wait_with_output()).await;
    let (bytes, status, timed_out) = match result {
        Ok(Ok(output)) => {
            let mut bytes = output.stdout;
            bytes.extend(output.stderr);
            (bytes, output.status.code(), false)
        }
        _ => (b"[command timed out]".to_vec(), None, true),
    };
    let mut output = String::from_utf8_lossy(&bytes).to_string();
    if output.len() > 500_000 {
        output.truncate(500_000);
        output.push_str("\n[output truncated]\n");
    }
    let marker = output.find("__AGENT_RIDER_EXIT__");
    let exit = marker
        .and_then(|i| output[i..].lines().next())
        .and_then(|v| {
            v.trim_start_matches("__AGENT_RIDER_EXIT__")
                .parse::<i32>()
                .ok()
        })
        .or(status);
    let next = output
        .rfind("__AGENT_RIDER_CWD__")
        .map(|i| output[i + "__AGENT_RIDER_CWD__".len()..].trim())
        .and_then(|v| state.files.existing(v).ok())
        .unwrap_or_else(|| cwd.clone());
    if let Some(i) = marker {
        output.truncate(i);
        output = output.trim_end_matches('\n').to_string();
    }
    json!({"output":output,"exitCode":exit,"signal":Value::Null,"cwd":cwd,"nextCwd":next,"timedOut":timed_out})
}

fn tmux_name(session: &str, agent: &str, cwd: &Path) -> String {
    let raw = format!("{session}|{}", cwd.display());
    let safe = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect::<String>();
    format!("ar_{agent}_{safe}")
}
fn tmux_exists(name: &str) -> bool {
    std::process::Command::new("tmux")
        .args(["-L", "agent-rider", "has-session", "-t", name])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|v| v.success())
}
pub fn usage(state: &AppState, body: &Value) -> Value {
    let agent = body["agent"].as_str().unwrap_or("");
    if !["claude", "codex", "agy"].contains(&agent) {
        return json!({"available":false,"reason":"unsupported"});
    }
    let session = body["session"].as_str().unwrap_or("").trim();
    if session.is_empty() {
        return json!({"available":false,"reason":"no-session"});
    }
    let cwd = safe_cwd(state, body["cwd"].as_str());
    if !tmux_exists(&tmux_name(session, agent, &cwd)) {
        return json!({"available":false,"reason":"no-session"});
    }
    json!({"available":false,"reason":"unparsed"})
}

pub async fn ws_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !auth::authorized(
        &state.db,
        headers.get(header::COOKIE).and_then(|v| v.to_str().ok()),
    )
    .await
    {
        return (axum::http::StatusCode::UNAUTHORIZED, "locked").into_response();
    }
    upgrade.on_upgrade(move |socket| terminal_socket(socket, state, query))
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
async fn terminal_socket(socket: WebSocket, state: Arc<AppState>, query: HashMap<String, String>) {
    let cwd = safe_cwd(&state, query.get("cwd").map(String::as_str));
    let cols = query
        .get("cols")
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(100)
        .clamp(20, 240);
    let rows = query
        .get("rows")
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(28)
        .clamp(6, 80);
    let agent = query.get("agent").map(String::as_str).unwrap_or("");
    let session = query
        .get("session")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    let reset = query.get("reset").is_some_and(|v| v == "1");
    let custom = query
        .get("command")
        .map(String::as_str)
        .unwrap_or("")
        .trim();
    if agent == "custom" && (custom.is_empty() || custom.len() > 2000) {
        let (mut sink, _) = socket.split();
        let _ = sink
            .send(Message::Text(
                "\r\n\x1b[31mInvalid custom agent command.\x1b[0m\r\n".into(),
            ))
            .await;
        let _ = sink.close().await;
        return;
    }
    let built_in = match agent {
        "claude" => Some(("claude", vec!["--permission-mode", "auto"])),
        "codex" => Some(("codex", vec!["--yolo"])),
        "agy" => Some(("agy", vec!["--dangerously-skip-permissions"])),
        "devin" => Some(("devin", vec!["--permission-mode", "auto"])),
        _ => None,
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let launch = if let Some((name, args)) = &built_in {
        std::iter::once(quote(&state.config.resolve_command(name)))
            .chain(args.iter().map(|v| quote(v)))
            .collect::<Vec<_>>()
            .join(" ")
    } else if agent == "custom" {
        custom.into()
    } else {
        format!("{} -l", quote(&shell))
    };
    let persistent = !session.is_empty();
    let mut builder = if persistent {
        let kind = if agent.is_empty() { "shell" } else { agent };
        let key = if agent == "custom" {
            let hash = format!("{:x}", Sha256::digest(launch.as_bytes()));
            format!("{session}-{hash}")
        } else {
            session.into()
        };
        let name = tmux_name(&key, kind, &cwd);
        if reset && tmux_exists(&name) {
            let _ = std::process::Command::new("tmux")
                .args(["-L", "agent-rider", "kill-session", "-t", &name])
                .status();
        }
        let mut b = CommandBuilder::new("tmux");
        let argv = vec![
            "-L".into(),
            "agent-rider".into(),
            "new-session".into(),
            "-A".into(),
            "-s".into(),
            name,
            "-x".into(),
            cols.to_string(),
            "-y".into(),
            rows.to_string(),
            "-c".into(),
            cwd.display().to_string(),
            "-e".into(),
            format!("PATH={}", state.config.agent_path),
            "--".into(),
            launch.clone(),
        ];
        b.args(argv);
        b
    } else if agent == "custom" {
        let mut b = CommandBuilder::new(&shell);
        b.args(["-lc", custom]);
        b
    } else if let Some((name, args)) = built_in {
        let mut b = CommandBuilder::new(state.config.resolve_command(name));
        b.args(args);
        b
    } else {
        let mut b = CommandBuilder::new(&shell);
        b.arg("-l");
        b
    };
    builder.cwd(&cwd);
    builder.env("PATH", &state.config.agent_path);
    builder.env("TERM", "xterm-256color");
    let Ok(pair) = native_pty_system().openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) else {
        return;
    };
    let Ok(child) = pair.slave.spawn_command(builder) else {
        return;
    };
    drop(pair.slave);
    let master = Arc::new(Mutex::new(pair.master));
    let Ok(mut reader) = master.lock().unwrap().try_clone_reader() else {
        return;
    };
    let Ok(writer) = master.lock().unwrap().take_writer() else {
        return;
    };
    let writer = Arc::new(Mutex::new(writer));
    let child = Arc::new(Mutex::new(child));
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            if tx.blocking_send(buffer[..count].to_vec()).is_err() {
                break;
            }
        }
    });
    let (mut sink, mut source) = socket.split();
    let label = if persistent {
        if reset {
            "Resetting"
        } else {
            "Attaching"
        }
    } else {
        "Starting"
    };
    let _ = sink
        .send(Message::Text(
            format!(
                "\r\n\x1b[32m{label} terminal in {}…\x1b[0m\r\n",
                cwd.display()
            )
            .into(),
        ))
        .await;
    loop {
        tokio::select! {Some(data)=rx.recv()=>{if sink.send(Message::Binary(data.into())).await.is_err(){break}},Some(Ok(message))=source.next()=>{match message{Message::Text(text)=>if let Ok(value)=serde_json::from_str::<Value>(&text){match value["type"].as_str(){Some("input")=>{let _=writer.lock().unwrap().write_all(value["data"].as_str().unwrap_or("").as_bytes());},Some("resize")=>{let c=value["cols"].as_u64().unwrap_or(100).clamp(20,240)as u16;let r=value["rows"].as_u64().unwrap_or(28).clamp(6,80)as u16;let _=master.lock().unwrap().resize(PtySize{rows:r,cols:c,pixel_width:0,pixel_height:0});},_=>{}}},Message::Close(_)=>break,_=>{} }},else=>break}
    }
    let _ = child.lock().unwrap().kill();
}
