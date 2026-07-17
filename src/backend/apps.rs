use super::database::Database;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

fn valid_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

pub async fn scan(root: &Path, db: &Database) -> Value {
    let labels: HashMap<_, _> = db
        .app_labels()
        .await
        .unwrap_or_default()
        .into_iter()
        .collect();
    let order: HashMap<_, _> = db
        .app_order()
        .await
        .unwrap_or_default()
        .into_iter()
        .collect();
    let mut apps = vec![];
    let mut warnings = vec![];
    let entries = match fs::read_dir(root) {
        Ok(v) => v,
        Err(_) => return json!({"apps":[],"warnings":[],"hash":"0","appsRoot":root}),
    };
    for entry in entries.flatten() {
        let dir = entry.file_name().to_string_lossy().to_string();
        if dir.starts_with('.') || dir.starts_with('_') || !entry.path().is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let manifest: Value = match fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|v| serde_json::from_str(&v).ok())
        {
            Some(v) => v,
            None => {
                warnings.push(json!({"dir":dir,"error":"manifest.json is not valid JSON"}));
                continue;
            }
        };
        let id = manifest["id"].as_str().unwrap_or(&dir).to_string();
        if !valid_slug(&id) {
            warnings.push(json!({"dir":dir,"id":id,"error":"invalid slug (use lowercase letters, digits, hyphens)"}));
            continue;
        }
        if id != dir {
            warnings.push(json!({"dir":dir,"id":id,"error":"manifest id must match folder name"}));
            continue;
        }
        apps.push(json!({"id":id,"dir":dir,"workspacePath":entry.path(),"label":labels.get(&id).cloned().unwrap_or_else(||manifest["label"].as_str().unwrap_or(&id).into()),"group":manifest["group"].as_str().unwrap_or("App"),"kind":if manifest["kind"]=="embedded"{"embedded"}else{"static"},"entry":manifest["entry"].as_str().map(str::to_owned).unwrap_or_else(||format!("/apps/{id}/")),"description":manifest["description"].as_str().unwrap_or(""),"dataScopes":manifest["dataScopes"].as_array().cloned().unwrap_or_default(),"version":manifest["version"].as_f64().unwrap_or(1.0),"hasDist":entry.path().join("dist/index.html").exists()}));
    }
    apps.sort_by(|a, b| {
        let ai = order
            .get(a["id"].as_str().unwrap_or(""))
            .copied()
            .unwrap_or(i64::MAX);
        let bi = order
            .get(b["id"].as_str().unwrap_or(""))
            .copied()
            .unwrap_or(i64::MAX);
        ai.cmp(&bi)
            .then_with(|| a["label"].as_str().cmp(&b["label"].as_str()))
    });
    let source=json!({"apps":apps.iter().map(|a|json!([a["id"],a["label"],a["group"],a["kind"],a["entry"],a["hasDist"]])).collect::<Vec<_>>(),"warnings":warnings}).to_string();
    let mut hash: i32 = 0;
    for c in source.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(c as i32)
    }
    json!({"apps":apps,"warnings":warnings,"hash":hash.to_string(),"appsRoot":root})
}

pub fn static_path(root: &Path, slug: &str, tail: &str) -> Result<PathBuf, (u16, String)> {
    if !valid_slug(slug) {
        return Err((404, "not found".into()));
    }
    let dist = root.join(slug).join("dist");
    let decoded = urlencoding::decode(tail).map_err(|_| (400, "invalid path".into()))?;
    let clean = decoded.trim_start_matches('/');
    if Path::new(clean)
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err((403, "path outside app".into()));
    }
    let mut target = dist.join(if clean.is_empty() {
        "index.html"
    } else {
        clean
    });
    if target.is_dir() {
        target = target.join("index.html")
    }
    if !target.is_file() && Path::new(clean).extension().is_none() {
        target = dist.join("index.html")
    }
    if !target.is_file() {
        return Err((
            404,
            if !dist.join("index.html").exists() {
                "app not built (no dist/index.html)"
            } else {
                "not found"
            }
            .into(),
        ));
    }
    Ok(target)
}
