use super::{
    apps, auth,
    config::Config,
    database::Database,
    filesystem::{self, Filesystem},
    terminal,
};
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderMap, Method, Request, Response, StatusCode},
    routing::{any, get},
    Router,
};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, sync::Arc};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: Database,
    pub files: Filesystem,
}
pub async fn serve(config: Config, db: Database) -> Result<(), String> {
    let address = format!("127.0.0.1:{}", config.port);
    let state = Arc::new(AppState {
        files: Filesystem::new(config.browse_root.clone()),
        config,
        db,
    });
    let app = Router::new()
        .route("/store/terminal/ws", get(terminal::ws_handler))
        .route("/", any(dispatch))
        .route("/{*path}", any(dispatch))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "[store] Agent Rider Rust backend on http://{address} → {}",
        listener.local_addr().map(|_| "").unwrap_or("")
    );
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}
fn response(status: u16, value: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(value.to_string()))
        .unwrap()
}
fn error((status, message): (u16, String)) -> Response<Body> {
    response(status, json!({"error":message,"status":status}))
}
fn cookie(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::COOKIE).and_then(|v| v.to_str().ok())
}
async fn json_body(req: Request<Body>, limit: usize) -> Result<Value, Response<Body>> {
    let bytes = to_bytes(req.into_body(), limit)
        .await
        .map_err(|e| response(400, json!({"error":e.to_string()})))?;
    serde_json::from_slice(if bytes.is_empty() { b"{}" } else { &bytes })
        .map_err(|e| response(400, json!({"error":e.to_string()})))
}
fn query(req: &Request<Body>) -> HashMap<String, String> {
    serde_urlencoded::from_str(req.uri().query().unwrap_or("")).unwrap_or_default()
}
async fn dispatch(State(state): State<Arc<AppState>>, req: Request<Body>) -> Response<Body> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    if path == "/store/password/status" && method == Method::GET {
        let record = auth::record(&state.db).await;
        let enabled = record.is_some();
        return response(
            200,
            json!({"enabled":enabled,"authenticated":!enabled||auth::authorized(&state.db,cookie(req.headers())).await,"version":record.map(|r|r.version)}),
        );
    }
    if path == "/store/password/login" && method == Method::POST {
        let body = match json_body(req, 20_000).await {
            Ok(v) => v,
            Err(v) => return v,
        };
        let Some(record) = auth::record(&state.db).await else {
            return response(200, json!({"ok":true,"enabled":false,"authenticated":true}));
        };
        if !auth::verify(body["password"].as_str().unwrap_or(""), &record) {
            return response(401, json!({"error":"Invalid password"}));
        }
        let value = auth::cookie(&state.db, &record).await.unwrap();
        return Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::SET_COOKIE, value)
            .body(Body::from(
                json!({"ok":true,"enabled":true,"authenticated":true,"version":record.version})
                    .to_string(),
            ))
            .unwrap();
    }
    if path == "/store/password/set" && method == Method::POST {
        let body = match json_body(req, 20_000).await {
            Ok(v) => v,
            Err(v) => return v,
        };
        let next = body["nextPassword"].as_str().unwrap_or("");
        if next.len() < 4 {
            return response(
                400,
                json!({"error":"Password must be at least 4 characters"}),
            );
        }
        if let Some(current) = auth::record(&state.db).await {
            if !auth::verify(body["currentPassword"].as_str().unwrap_or(""), &current) {
                return response(401, json!({"error":"Current password is incorrect"}));
            }
        }
        let record = match auth::set(&state.db, next).await {
            Ok(v) => v,
            Err(e) => return response(500, json!({"error":e})),
        };
        let value = auth::cookie(&state.db, &record).await.unwrap();
        return Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::SET_COOKIE, value)
            .body(Body::from(
                json!({"ok":true,"enabled":true,"authenticated":true,"version":record.version})
                    .to_string(),
            ))
            .unwrap();
    }
    if path == "/store/password/logout" && method == Method::POST {
        return Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CACHE_CONTROL, "no-store")
            .header(
                header::SET_COOKIE,
                "agent_rider_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
            )
            .body(Body::from("{\"ok\":true}"))
            .unwrap();
    }
    if !auth::authorized(&state.db, cookie(req.headers())).await {
        return response(401, json!({"error":"locked"}));
    }
    let q = query(&req);
    match (method.clone(), path.as_str()) {
        (Method::GET, "/store/state") => match state.db.state().await {
            Ok(v) => response(200, v),
            Err(e) => response(500, json!({"error":e})),
        },
        (Method::POST, "/store/save") => {
            let body = match json_body(req, 25_000_000).await {
                Ok(v) => v,
                Err(v) => return v,
            };
            match state.db.save(body).await {
                Ok(v) => response(200, v),
                Err(e) => response(400, json!({"error":e})),
            }
        }
        (Method::GET, "/store/fs/list") => state
            .files
            .list(q.get("path").map(String::as_str).unwrap_or(""))
            .map(|v| response(200, v))
            .unwrap_or_else(error),
        (Method::GET, "/store/fs/read") => state
            .files
            .read(q.get("path").map(String::as_str).unwrap_or(""))
            .map(|v| response(200, v))
            .unwrap_or_else(error),
        (Method::GET, "/store/fs/search") => state
            .files
            .search(
                q.get("path").map(String::as_str).unwrap_or(""),
                q.get("query").map(String::as_str).unwrap_or(""),
            )
            .map(|v| response(200, v))
            .unwrap_or_else(error),
        (Method::POST, "/store/fs/mkdir") => {
            let body = match json_body(req, 100_000).await {
                Ok(v) => v,
                Err(v) => return v,
            };
            state
                .files
                .mkdir(
                    body["parent"].as_str().unwrap_or(""),
                    body["name"].as_str().unwrap_or(""),
                )
                .map(|v| response(200, v))
                .unwrap_or_else(error)
        }
        (Method::POST, "/store/fs/upload") => {
            let bytes = match to_bytes(req.into_body(), 100 * 1024 * 1024).await {
                Ok(v) => v,
                Err(_) => return response(413, json!({"error":"file too large (max 100 MB)"})),
            };
            state
                .files
                .upload(
                    q.get("path").map(String::as_str).unwrap_or(""),
                    q.get("name").map(String::as_str).unwrap_or(""),
                    &bytes,
                )
                .map(|v| response(200, v))
                .unwrap_or_else(error)
        }
        (Method::POST, "/store/fs/delete") => {
            let body = match json_body(req, 100_000).await {
                Ok(v) => v,
                Err(v) => return v,
            };
            state
                .files
                .delete(body["path"].as_str().unwrap_or(""))
                .map(|v| response(200, v))
                .unwrap_or_else(error)
        }
        (Method::POST, "/store/fs/move-dir") => {
            let body = match json_body(req, 100_000).await {
                Ok(v) => v,
                Err(v) => return v,
            };
            state
                .files
                .move_dir(
                    body["source"].as_str().unwrap_or(""),
                    body["target"].as_str().unwrap_or(""),
                )
                .map(|v| response(200, v))
                .unwrap_or_else(error)
        }
        (Method::GET, "/store/fs/download") => file_response(
            state
                .files
                .file(q.get("path").map(String::as_str).unwrap_or("")),
            true,
        ),
        (Method::GET, "/store/apps") => {
            response(200, apps::scan(&state.config.apps_dir, &state.db).await)
        }
        (Method::GET, "/store/agents") => response(200, terminal::agents(&state)),
        (Method::POST, "/store/terminal/run") => {
            let body = match json_body(req, 100_000).await {
                Ok(v) => v,
                Err(v) => return v,
            };
            response(200, terminal::run(&state, &body).await)
        }
        (Method::POST, "/store/terminal/usage") => {
            let body = match json_body(req, 10_000).await {
                Ok(v) => v,
                Err(v) => return v,
            };
            response(200, terminal::usage(&state, &body))
        }
        (Method::POST, "/store/apps/order") => {
            let body = match json_body(req, 100_000).await {
                Ok(v) => v,
                Err(v) => return v,
            };
            let Some(order) = body["order"].as_array() else {
                return response(400, json!({"error":"order must be an array of slugs"}));
            };
            let order = order
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            if let Err(e) = state.db.set_app_order(order).await {
                return response(400, json!({"error":e}));
            }
            response(200, apps::scan(&state.config.apps_dir, &state.db).await)
        }
        (Method::POST, "/store/apps/rename") => {
            let body = match json_body(req, 100_000).await {
                Ok(v) => v,
                Err(v) => return v,
            };
            let slug = body["slug"].as_str().unwrap_or("");
            if slug.is_empty() {
                return response(400, json!({"error":"invalid slug"}));
            }
            let label = body["label"]
                .as_str()
                .unwrap_or("")
                .trim()
                .chars()
                .take(80)
                .collect::<String>();
            if let Err(e) = state
                .db
                .set_app_label(
                    slug.into(),
                    if label.is_empty() { None } else { Some(label) },
                )
                .await
            {
                return response(400, json!({"error":e}));
            }
            response(200, apps::scan(&state.config.apps_dir, &state.db).await)
        }
        _ if path.starts_with("/store/fs/view/") && method == Method::GET => file_response(
            state
                .files
                .view_path(path.trim_start_matches("/store/fs/view/"))
                .map(|p| {
                    let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    let mime = filesystem::mime(&p, "");
                    (p, size, mime)
                }),
            false,
        ),
        _ if path.starts_with("/apps/") && method == Method::GET => {
            let rest = path.trim_start_matches("/apps/");
            let mut split = rest.splitn(2, '/');
            let slug = split.next().unwrap_or("");
            let tail = split.next().unwrap_or("");
            file_response(
                apps::static_path(&state.config.apps_dir, slug, tail).map(|p| {
                    let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    let mime = filesystem::mime(&p, "");
                    (p, size, mime)
                }),
                false,
            )
        }
        _ => response(404, json!({"error":"not found"})),
    }
}
fn file_response(
    result: Result<(std::path::PathBuf, u64, String), (u16, String)>,
    download: bool,
) -> Response<Body> {
    match result {
        Err(e) => error(e),
        Ok((path, size, mime)) => {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let bytes = fs::read(&path).unwrap_or_default();
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, size)
                .header(header::CACHE_CONTROL, "no-store");
            if download {
                builder = builder.header(
                    header::CONTENT_DISPOSITION,
                    format!(
                        "attachment; filename*=UTF-8''{}",
                        urlencoding::encode(&name)
                    ),
                )
            }
            builder.body(Body::from(bytes)).unwrap()
        }
    }
}
