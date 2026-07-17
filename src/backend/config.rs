use std::{
    env, fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub db_path: PathBuf,
    pub browse_root: PathBuf,
    pub default_cwd: PathBuf,
    pub apps_dir: PathBuf,
    pub hermes_target: String,
    pub agent_path: String,
}

fn readable_dir(path: &Path) -> bool {
    path.is_dir() && fs::read_dir(path).is_ok()
}

impl Config {
    pub fn load() -> Self {
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let app_dir = env::var_os("APP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| cwd.clone());
        let requested_home = env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/root"));
        let configured_root = env::var_os("BROWSE_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| requested_home.clone());
        let browse_root = [configured_root.clone(), requested_home.clone(), cwd.clone()]
            .into_iter()
            .find(|path| readable_dir(path))
            .unwrap_or(configured_root);
        let default_cwd = if readable_dir(&requested_home) {
            requested_home.clone()
        } else {
            browse_root.clone()
        };
        let apps_dir = env::var_os("AGENT_RIDER_APPS_DIR")
            .or_else(|| env::var_os("AGENT_RIDER_PLUGINS_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if env::var_os("APP_DIR").is_some() {
                    app_dir.join("shared/plugins")
                } else {
                    browse_root.join(".agent-rider/apps")
                }
            });
        let _ = fs::create_dir_all(&apps_dir);
        let path = env::var("PATH").unwrap_or_default();
        let mut paths = vec![
            default_cwd.join(".local/bin").display().to_string(),
            "/usr/local/bin".into(),
            "/usr/bin".into(),
            "/bin".into(),
        ];
        paths.extend(
            path.split(':')
                .filter(|part| !part.is_empty())
                .map(str::to_owned),
        );
        paths.dedup();
        Self {
            port: env::var("STORE_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5174),
            db_path: app_dir.join("data/agent-rider.db"),
            browse_root,
            default_cwd,
            apps_dir,
            hermes_target: env::var("HERMES_TARGET")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "hermes".into()),
            agent_path: paths.join(":"),
        }
    }

    pub fn resolve_command(&self, name: &str) -> String {
        if name.contains('/') {
            return name.into();
        }
        self.agent_path
            .split(':')
            .map(|dir| Path::new(dir).join(name))
            .find(|path| path.exists())
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| name.into())
    }
}
