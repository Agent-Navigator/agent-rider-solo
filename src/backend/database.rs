use chrono::Utc;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, thread};
use tokio::sync::{mpsc, oneshot};

type Reply<T> = oneshot::Sender<Result<T, String>>;

enum Message {
    GetState(Reply<Value>),
    SaveState(Value, Reply<Value>),
    GetKv(String, Reply<Option<String>>),
    SetKv(String, String, Reply<()>),
    AppOrder(Reply<Vec<(String, i64)>>),
    SetAppOrder(Vec<String>, Reply<()>),
    AppLabels(Reply<Vec<(String, String)>>),
    SetAppLabel(String, Option<String>, Reply<()>),
}

#[derive(Clone)]
pub struct Database {
    tx: mpsc::Sender<Message>,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn parse(value: Option<String>, fallback: Value) -> Value {
    value
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or(fallback)
}
fn text(row: &rusqlite::Row<'_>, name: &str) -> rusqlite::Result<Option<String>> {
    row.get(name)
}

impl Database {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let (tx, mut rx) = mpsc::channel(64);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let result = Connection::open(path).and_then(|conn| {
                migrate(&conn)?;
                Ok(conn)
            });
            let mut conn = match result {
                Ok(conn) => {
                    let _ = ready_tx.send(Ok(()));
                    conn
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };
            while let Some(message) = rx.blocking_recv() {
                handle(&mut conn, message);
            }
        });
        ready_rx.recv().map_err(|e| e.to_string())??;
        Ok(Self { tx })
    }

    async fn call<T>(&self, build: impl FnOnce(Reply<T>) -> Message) -> Result<T, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(build(tx))
            .await
            .map_err(|_| "database actor stopped".to_string())?;
        rx.await.map_err(|_| "database actor stopped".to_string())?
    }
    pub async fn state(&self) -> Result<Value, String> {
        self.call(Message::GetState).await
    }
    pub async fn save(&self, value: Value) -> Result<Value, String> {
        self.call(|r| Message::SaveState(value, r)).await
    }
    pub async fn get_kv(&self, key: &str) -> Result<Option<String>, String> {
        self.call(|r| Message::GetKv(key.into(), r)).await
    }
    pub async fn set_kv(&self, key: &str, value: String) -> Result<(), String> {
        self.call(|r| Message::SetKv(key.into(), value, r)).await
    }
    pub async fn app_order(&self) -> Result<Vec<(String, i64)>, String> {
        self.call(Message::AppOrder).await
    }
    pub async fn set_app_order(&self, order: Vec<String>) -> Result<(), String> {
        self.call(|r| Message::SetAppOrder(order, r)).await
    }
    pub async fn app_labels(&self) -> Result<Vec<(String, String)>, String> {
        self.call(Message::AppLabels).await
    }
    pub async fn set_app_label(&self, slug: String, label: Option<String>) -> Result<(), String> {
        self.call(|r| Message::SetAppLabel(slug, label, r)).await
    }
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT, category TEXT, category_tags TEXT, project TEXT, workspace TEXT, workspace_path TEXT, task TEXT, job TEXT, job_status TEXT, resource_ids TEXT, model TEXT, model_provider TEXT, reasoning_effort TEXT, agent_type TEXT, agent_command TEXT, col_index INTEGER, sort_index INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, run_id TEXT, parent_turn_id TEXT, session_id TEXT, prompt TEXT, response TEXT, status TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS app_order (slug TEXT PRIMARY KEY, sort_index INTEGER, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS app_label (slug TEXT PRIMARY KEY, label TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);")?;
    let migrations = [
        "ALTER TABLE runs ADD COLUMN sort_index INTEGER",
        "ALTER TABLE turns ADD COLUMN parent_turn_id TEXT",
        "ALTER TABLE runs ADD COLUMN agent_type TEXT",
        "ALTER TABLE runs ADD COLUMN agent_command TEXT",
        "ALTER TABLE runs ADD COLUMN col_index INTEGER",
        "ALTER TABLE runs ADD COLUMN model TEXT",
        "ALTER TABLE runs ADD COLUMN model_provider TEXT",
        "ALTER TABLE runs ADD COLUMN reasoning_effort TEXT",
    ];
    for sql in migrations {
        let _ = conn.execute(sql, []);
    }
    Ok(())
}

fn handle(conn: &mut Connection, message: Message) {
    match message {
        Message::GetState(reply) => {
            let _ = reply.send(get_state(conn).map_err(|e| e.to_string()));
        }
        Message::SaveState(value, reply) => {
            let _ = reply.send(save_state(conn, value).map_err(|e| e.to_string()));
        }
        Message::GetKv(key, reply) => {
            let result = conn
                .query_row("SELECT value FROM app_kv WHERE key=?", [key], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string());
            let _ = reply.send(result);
        }
        Message::SetKv(key, value, reply) => {
            let result = conn.execute("INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", params![key,value,now()]).map(|_| ()).map_err(|e| e.to_string());
            let _ = reply.send(result);
        }
        Message::AppOrder(reply) => {
            let result =
                pairs_i64(conn, "SELECT slug,sort_index FROM app_order").map_err(|e| e.to_string());
            let _ = reply.send(result);
        }
        Message::SetAppOrder(order, reply) => {
            let result = (|| -> rusqlite::Result<()> { let tx=conn.transaction()?; for (i, slug) in order.iter().enumerate() { tx.execute("INSERT INTO app_order(slug,sort_index,updated_at) VALUES(?,?,?) ON CONFLICT(slug) DO UPDATE SET sort_index=excluded.sort_index,updated_at=excluded.updated_at", params![slug,i as i64,now()])?; } tx.commit() })().map_err(|e|e.to_string());
            let _ = reply.send(result);
        }
        Message::AppLabels(reply) => {
            let result =
                pairs_string(conn, "SELECT slug,label FROM app_label").map_err(|e| e.to_string());
            let _ = reply.send(result);
        }
        Message::SetAppLabel(slug, label, reply) => {
            let result = match label { Some(label) => conn.execute("INSERT INTO app_label(slug,label,updated_at) VALUES(?,?,?) ON CONFLICT(slug) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at",params![slug,label,now()]), None => conn.execute("DELETE FROM app_label WHERE slug=?",[slug]) }.map(|_|()).map_err(|e|e.to_string());
            let _ = reply.send(result);
        }
    }
}

fn pairs_i64(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut s = conn.prepare(sql)?;
    let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
    rows
}
fn pairs_string(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<(String, String)>> {
    let mut s = conn.prepare(sql)?;
    let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
    rows
}

fn get_state(conn: &Connection) -> rusqlite::Result<Value> {
    let mut stmt =
        conn.prepare("SELECT * FROM runs ORDER BY sort_index ASC,created_at ASC,rowid ASC")?;
    let runs=stmt.query_map([],|r|Ok(json!({
        "id":text(r,"id")?,"prompt":text(r,"prompt")?,"category":text(r,"category")?,
        "categoryTags":parse(text(r,"category_tags")?,json!([])),"project":text(r,"project")?,"workspace":text(r,"workspace")?,
        "workspacePath":text(r,"workspace_path")?,"task":text(r,"task")?,"job":text(r,"job")?,"jobStatus":text(r,"job_status")?,
        "resourceIds":parse(text(r,"resource_ids")?,json!([])),"model":text(r,"model")?.unwrap_or_default(),
        "modelProvider":text(r,"model_provider")?,"reasoningEffort":text(r,"reasoning_effort")?.unwrap_or_default(),
        "sessionId":text(r,"session_id")?,"agentType":text(r,"agent_type")?.filter(|v|!v.is_empty()).unwrap_or_else(||"hermes".into()),
        "agentCommand":text(r,"agent_command")?.unwrap_or_default(),"column":r.get::<_,Option<i64>>("col_index")?.unwrap_or(0),"createdAt":text(r,"created_at")?
    })))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stmt = conn.prepare("SELECT * FROM turns ORDER BY created_at ASC,rowid ASC")?;
    let turns=stmt.query_map([],|r|Ok(json!({"id":text(r,"id")?,"runId":text(r,"run_id")?,"parentTurnId":text(r,"parent_turn_id")?,"prompt":text(r,"prompt")?,"response":text(r,"response")?,"status":text(r,"status")?,"createdAt":text(r,"created_at")?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let layout: Option<String> = conn
        .query_row("SELECT value FROM app_kv WHERE key='layout'", [], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(json!({"runs":runs,"turns":turns,"layout":parse(layout,Value::Null)}))
}

fn string(v: Option<&Value>, fallback: &str) -> String {
    v.and_then(Value::as_str).unwrap_or(fallback).to_string()
}
fn save_state(conn: &mut Connection, value: Value) -> rusqlite::Result<Value> {
    let tx = conn.transaction()?;
    let stamp = now();
    let runs = value
        .get("runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let turns = value
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let session_id = value.get("sessionId").and_then(Value::as_str);
    for (i, r) in runs.iter().enumerate() {
        if r.get("id").and_then(Value::as_str).is_none() {
            continue;
        }
        tx.execute("INSERT INTO runs(id,session_id,prompt,category,category_tags,project,workspace,workspace_path,task,job,job_status,resource_ids,model,model_provider,reasoning_effort,agent_type,agent_command,col_index,sort_index,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,prompt=excluded.prompt,category=excluded.category,category_tags=excluded.category_tags,project=excluded.project,workspace=excluded.workspace,workspace_path=excluded.workspace_path,task=excluded.task,job=excluded.job,job_status=excluded.job_status,resource_ids=excluded.resource_ids,model=excluded.model,model_provider=excluded.model_provider,reasoning_effort=excluded.reasoning_effort,agent_type=excluded.agent_type,agent_command=excluded.agent_command,col_index=excluded.col_index,sort_index=excluded.sort_index,created_at=excluded.created_at,updated_at=excluded.updated_at", params![string(r.get("id"),""),r.get("sessionId").and_then(Value::as_str).or(session_id),string(r.get("prompt"),""),string(r.get("category"),""),r.get("categoryTags").cloned().unwrap_or(json!([])).to_string(),string(r.get("project"),""),string(r.get("workspace"),""),string(r.get("workspacePath"),""),string(r.get("task"),""),string(r.get("job"),""),string(r.get("jobStatus"),"queued"),r.get("resourceIds").cloned().unwrap_or(json!([])).to_string(),string(r.get("model"),""),r.get("modelProvider").and_then(Value::as_str),string(r.get("reasoningEffort"),""),string(r.get("agentType"),"codex"),string(r.get("agentCommand"),""),r.get("column").and_then(Value::as_i64).unwrap_or(0),i as i64,string(r.get("createdAt"),&stamp),stamp])?;
    }
    for t in &turns {
        if t.get("id").and_then(Value::as_str).is_none() {
            continue;
        }
        tx.execute("INSERT INTO turns(id,run_id,parent_turn_id,session_id,prompt,response,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,parent_turn_id=excluded.parent_turn_id,session_id=excluded.session_id,prompt=excluded.prompt,response=excluded.response,status=excluded.status,created_at=excluded.created_at,updated_at=excluded.updated_at",params![string(t.get("id"),""),string(t.get("runId"),""),t.get("parentTurnId").and_then(Value::as_str),session_id,string(t.get("prompt"),""),string(t.get("response"),""),string(t.get("status"),"queued"),string(t.get("createdAt"),&stamp),stamp])?;
    }
    reconcile(
        &tx,
        "runs",
        runs.iter()
            .filter_map(|v| v.get("id")?.as_str().map(str::to_owned))
            .collect(),
    )?;
    reconcile(
        &tx,
        "turns",
        turns
            .iter()
            .filter_map(|v| v.get("id")?.as_str().map(str::to_owned))
            .collect(),
    )?;
    if let Some(layout) = value.get("layout") {
        tx.execute("INSERT INTO app_kv(key,value,updated_at) VALUES('layout',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![layout.to_string(),stamp])?;
    }
    tx.commit()?;
    Ok(json!({"ok":true}))
}
fn reconcile(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    ids: Vec<String>,
) -> rusqlite::Result<()> {
    if ids.is_empty() {
        tx.execute(&format!("DELETE FROM {table}"), [])?;
    } else {
        let sql = format!(
            "DELETE FROM {table} WHERE id NOT IN ({})",
            vec!["?"; ids.len()].join(",")
        );
        tx.execute(&sql, params_from_iter(ids))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn migrates_and_reopens_the_same_database() {
        let path =
            std::env::temp_dir().join(format!("agent-rider-db-{}.sqlite", rand::random::<u64>()));
        let db = Database::open(path.clone()).unwrap();
        db.save(json!({"runs":[],"turns":[],"layout":{"columns":2}}))
            .await
            .unwrap();
        drop(db);
        let reopened = Database::open(path.clone()).unwrap();
        assert_eq!(reopened.state().await.unwrap()["layout"]["columns"], 2);
        let _ = fs::remove_file(path);
    }
}
