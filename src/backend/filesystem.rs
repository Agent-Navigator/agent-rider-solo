use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

const PREVIEW_LIMIT: u64 = 25 * 1024 * 1024;

#[derive(Clone)]
pub struct Filesystem {
    pub root: PathBuf,
    canonical_root: PathBuf,
}

impl Filesystem {
    pub fn new(root: PathBuf) -> Self {
        let canonical_root = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        Self {
            root,
            canonical_root,
        }
    }
    fn lexical(&self, input: &str) -> Option<PathBuf> {
        let path = if input.is_empty() {
            self.root.clone()
        } else {
            PathBuf::from(input)
        };
        let path = if path.is_absolute() {
            path
        } else {
            self.root.join(path)
        };
        let mut clean = PathBuf::new();
        for component in path.components() {
            match component {
                Component::ParentDir => {
                    clean.pop();
                }
                Component::CurDir => {}
                other => clean.push(other.as_os_str()),
            }
        }
        if clean == self.root || clean.starts_with(&self.root) {
            Some(clean)
        } else {
            None
        }
    }
    pub fn existing(&self, input: &str) -> Result<PathBuf, (u16, &'static str)> {
        let path = self
            .lexical(input)
            .ok_or((403, "path outside allowed root"))?;
        let canonical = fs::canonicalize(&path).map_err(|_| (404, "path not found"))?;
        if canonical == self.canonical_root || canonical.starts_with(&self.canonical_root) {
            Ok(path)
        } else {
            Err((403, "path outside allowed root"))
        }
    }
    fn target(&self, input: &str) -> Result<PathBuf, (u16, &'static str)> {
        let path = self
            .lexical(input)
            .ok_or((403, "path outside allowed root"))?;
        let parent = path.parent().ok_or((403, "path outside allowed root"))?;
        let canonical = fs::canonicalize(parent).map_err(|_| (404, "path not found"))?;
        if canonical == self.canonical_root || canonical.starts_with(&self.canonical_root) {
            Ok(path)
        } else {
            Err((403, "path outside allowed root"))
        }
    }
    pub fn list(&self, input: &str) -> Result<Value, (u16, String)> {
        let path = self.existing(input).map_err(err)?;
        if !path.is_dir() {
            return Err((400, "not a directory".into()));
        }
        let mut dirs = vec![];
        let mut files = vec![];
        for entry in fs::read_dir(&path)
            .map_err(|_| (403, "cannot read directory".into()))?
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let kind = entry.file_type().ok();
            if kind.as_ref().is_some_and(|v| v.is_dir()) {
                dirs.push(json!({"name":name,"path":entry.path()}))
            } else if kind.as_ref().is_some_and(|v| v.is_file()) {
                files.push(json!({"name":name,"path":entry.path(),"size":entry.metadata().ok().map(|m|m.len())}))
            }
        }
        dirs.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_lowercase());
        files.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_lowercase());
        Ok(
            json!({"root":self.root,"path":path,"parent":if path==self.root{Value::Null}else{json!(path.parent())},"dirs":dirs,"files":files}),
        )
    }
    pub fn search(&self, input: &str, query: &str) -> Result<Value, (u16, String)> {
        let path = self.existing(input).map_err(err)?;
        if !path.is_dir() {
            return Err((400, "not a directory".into()));
        }
        let needle = query.trim().to_lowercase();
        let mut results = vec![];
        if !needle.is_empty() {
            walk(&path, &needle, 0, &mut results)
        }
        results.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_lowercase());
        Ok(
            json!({"root":self.root,"path":path,"query":needle,"results":results,"truncated":results.len()>=200}),
        )
    }
    pub fn read(&self, input: &str) -> Result<Value, (u16, String)> {
        let path = self.existing(input).map_err(|(s, m)| {
            (
                s,
                if s == 404 {
                    "file not found".into()
                } else {
                    m.into()
                },
            )
        })?;
        let meta = fs::metadata(&path).map_err(|_| (404, "file not found".into()))?;
        if !meta.is_file() {
            return Err((400, "not a file".into()));
        }
        let kind = preview_kind(&path).ok_or((415, "unsupported file type".into()))?;
        if kind != "html" && meta.len() > PREVIEW_LIMIT {
            return Err((413, "file too large to preview".into()));
        }
        let mime = mime(&path, kind);
        let mut base = json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"path":path,"size":meta.len(),"kind":kind,"mime":mime});
        if kind == "html" {
            base["viewUrl"] = json!(self.view_url(&path));
        } else {
            let bytes = fs::read(&path).map_err(|e| (400, e.to_string()))?;
            if kind == "image" {
                base["dataUrl"] = json!(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
            } else {
                base["content"] = json!(String::from_utf8_lossy(&bytes));
            }
        }
        Ok(base)
    }
    pub fn mkdir(&self, parent: &str, name: &str) -> Result<Value, (u16, String)> {
        let name = name.trim();
        if invalid_name(name) {
            return Err((400, "invalid folder name".into()));
        }
        let parent = self.existing(parent).map_err(|(s, m)| {
            (
                s,
                if s == 403 {
                    "parent outside allowed root".into()
                } else {
                    m.into()
                },
            )
        })?;
        let target = parent.join(name);
        self.target(target.to_string_lossy().as_ref())
            .map_err(err)?;
        fs::create_dir_all(&target).map_err(|e| (400, e.to_string()))?;
        Ok(json!({"path":target,"name":name}))
    }
    pub fn upload(&self, dir: &str, name: &str, bytes: &[u8]) -> Result<Value, (u16, String)> {
        if invalid_name(name.trim()) {
            return Err((400, "invalid file name".into()));
        }
        let dir = self.existing(dir).map_err(|(s, m)| {
            (
                s,
                if s == 403 {
                    "directory outside allowed root".into()
                } else if s == 404 {
                    "directory not found".into()
                } else {
                    m.into()
                },
            )
        })?;
        if !dir.is_dir() {
            return Err((400, "not a directory".into()));
        }
        let target = dir.join(name.trim());
        if target.exists() {
            return Err((409, "a file with that name already exists".into()));
        }
        fs::write(&target, bytes).map_err(|e| (400, e.to_string()))?;
        Ok(json!({"path":target,"name":name.trim(),"size":bytes.len(),"uploaded":true}))
    }
    pub fn delete(&self, input: &str) -> Result<Value, (u16, String)> {
        let path = self.existing(input).map_err(|(s, m)| {
            (
                s,
                if s == 404 {
                    "file not found".into()
                } else {
                    m.into()
                },
            )
        })?;
        if path == self.root {
            return Err((400, "cannot delete the workspace root".into()));
        }
        if !path.is_file() {
            return Err((400, "only files can be deleted".into()));
        }
        fs::remove_file(&path).map_err(|e| (400, e.to_string()))?;
        Ok(json!({"path":path,"deleted":true}))
    }
    pub fn move_dir(&self, source: &str, target: &str) -> Result<Value, (u16, String)> {
        let source = self.existing(source).map_err(|(s, m)| {
            (
                s,
                if s == 404 {
                    "source folder not found".into()
                } else {
                    m.into()
                },
            )
        })?;
        let target = self.target(target).map_err(err)?;
        if source == self.root {
            return Err((400, "cannot move browse root".into()));
        }
        if source == target {
            return Ok(json!({"path":target,"moved":false}));
        }
        if target.starts_with(&source) {
            return Err((400, "cannot move a folder inside itself".into()));
        }
        if !source.is_dir() {
            return Err((400, "source is not a directory".into()));
        }
        if target.exists() {
            return Err((409, "target folder already exists".into()));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| (400, e.to_string()))?
        }
        fs::rename(&source, &target).map_err(|e| (400, e.to_string()))?;
        Ok(json!({"path":target,"moved":true}))
    }
    pub fn file(&self, input: &str) -> Result<(PathBuf, u64, String), (u16, String)> {
        let path = self.existing(input).map_err(err)?;
        let meta = fs::metadata(&path).map_err(|_| (404, "file not found".into()))?;
        if !meta.is_file() {
            return Err((400, "not a file".into()));
        }
        let mime = mime_guess::from_path(&path)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        Ok((path, meta.len(), mime))
    }
    pub fn view_path(&self, relative: &str) -> Result<PathBuf, (u16, String)> {
        let decoded =
            urlencoding::decode(relative).map_err(|_| (400, "invalid file path".into()))?;
        let mut path = self
            .existing(self.root.join(decoded.as_ref()).to_string_lossy().as_ref())
            .map_err(err)?;
        if path.is_dir() {
            path = path.join("index.html")
        }
        if !path.is_file() {
            return Err((400, "not a file".into()));
        }
        Ok(path)
    }
    fn view_url(&self, path: &Path) -> String {
        let relative = path.strip_prefix(&self.root).unwrap_or(path);
        format!(
            "/store/fs/view/{}",
            relative
                .components()
                .map(|v| urlencoding::encode(v.as_os_str().to_string_lossy().as_ref()).to_string())
                .collect::<Vec<_>>()
                .join("/")
        )
    }
}
fn err((s, m): (u16, &'static str)) -> (u16, String) {
    (s, m.into())
}
fn invalid_name(v: &str) -> bool {
    v.is_empty() || v.contains('/') || v == "." || v == ".."
}
fn walk(path: &Path, needle: &str, depth: u8, out: &mut Vec<Value>) {
    if depth > 12 || out.len() >= 200 {
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= 200 {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().is_ok_and(|v| v.is_dir());
        if name.to_lowercase().contains(needle) {
            out.push(if is_dir{json!({"name":name,"path":entry.path(),"type":"dir"})}else{json!({"name":name,"path":entry.path(),"type":"file","size":entry.metadata().ok().map(|m|m.len())})})
        }
        if is_dir {
            walk(&entry.path(), needle, depth + 1, out)
        }
    }
}
fn preview_kind(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(&ext.as_str()) {
        Some("image")
    } else if ["html", "htm"].contains(&ext.as_str()) {
        Some("html")
    } else if ["md", "mdx", "markdown"].contains(&ext.as_str()) {
        Some("markdown")
    } else if [
        "js", "jsx", "ts", "tsx", "mjs", "cjs", "css", "scss", "sass", "less", "json", "jsonc",
        "yaml", "yml", "toml", "xml", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h",
        "cpp", "cc", "cxx", "hpp", "cs", "php", "r", "sh", "bash", "zsh", "fish", "sql", "vue",
        "svelte", "astro",
    ]
    .contains(&ext.as_str())
    {
        Some("code")
    } else if [
        "txt", "text", "log", "csv", "tsv", "ini", "conf", "config", "env", "example", "",
    ]
    .contains(&ext.as_str())
    {
        Some("text")
    } else {
        None
    }
}
pub fn mime(path: &Path, kind: &str) -> String {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8".into(),
        "js" | "mjs" => "text/javascript; charset=utf-8".into(),
        "css" => "text/css; charset=utf-8".into(),
        "txt" | "r" | "md" => "text/plain; charset=utf-8".into(),
        "json" => "application/json; charset=utf-8".into(),
        _ if kind != "image" => "text/plain; charset=utf-8".into(),
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_symlink_escape() {
        let root = std::env::temp_dir().join(format!("ar-fs-{}", rand::random::<u64>()));
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink("/etc", root.join("escape")).unwrap();
        let files = Filesystem::new(root.clone());
        assert_eq!(
            files
                .existing(root.join("escape/passwd").to_string_lossy().as_ref())
                .unwrap_err()
                .0,
            403
        );
        fs::remove_dir_all(root).unwrap();
    }
}
