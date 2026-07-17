use flate2::read::GzDecoder;
use fs2::FileExt;
use reqwest::{Client, StatusCode};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, Read},
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tar::Archive;

const DEFAULT_RELEASE_BASE: &str = "https://github.com/ytk77/agent-rider/releases/latest/download";

#[derive(Debug, Deserialize)]
struct Manifest {
    version: Version,
    source_commit: String,
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    platform: String,
    archive: String,
    sha256: String,
}

struct InstallPaths {
    root: PathBuf,
    releases: PathBuf,
    current: PathBuf,
    shared: PathBuf,
    config: PathBuf,
}

impl InstallPaths {
    fn discover() -> Result<Self, String> {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is not set".to_string())?;
        let root = env::var_os("AGRIDER_DATA_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".local/share"))
                    .join("agrider")
            });
        let config = env::var_os("AGRIDER_CONFIG_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                env::var_os("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".config"))
                    .join("agrider/env")
            });
        Ok(Self {
            releases: root.join("releases"),
            current: root.join("current"),
            shared: root.join("shared"),
            root,
            config,
        })
    }
}

pub async fn run() -> Result<(), String> {
    let paths = InstallPaths::discover()?;
    fs::create_dir_all(&paths.root).map_err(display_error("create install root"))?;
    let lock_path = paths.root.join("upgrade.lock");
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(display_error("open upgrade lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| "another Agent Rider upgrade is already running".to_string())?;

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .user_agent(concat!("agrider/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let release_base = env::var("AGRIDER_RELEASE_BASE")
        .unwrap_or_else(|_| DEFAULT_RELEASE_BASE.to_string())
        .trim_end_matches('/')
        .to_string();
    let manifest_url = format!("{release_base}/manifest.json");
    println!("Checking {manifest_url}");
    let manifest: Manifest = download_json(&client, &manifest_url).await?;
    if !manifest.version.pre.is_empty() {
        return Err(format!(
            "latest release {} is a prerelease; stable upgrades ignore it",
            manifest.version
        ));
    }
    let current = Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|error| format!("invalid current version: {error}"))?;
    if manifest.version <= current {
        if manifest.version == current {
            println!("Agent Rider {current} is already current.");
        } else {
            println!(
                "Installed Agent Rider {current} is newer than stable {}.",
                manifest.version
            );
        }
        return Ok(());
    }

    let platform = current_platform()?;
    let asset = manifest
        .assets
        .iter()
        .find(|asset| asset.platform == platform)
        .ok_or_else(|| format!("release {} has no asset for {platform}", manifest.version))?;
    validate_asset(asset)?;

    let staging = paths
        .releases
        .join(format!(".{}-{}", manifest.version, std::process::id()));
    fs::create_dir_all(&paths.releases).map_err(display_error("create releases directory"))?;
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(display_error("clear stale staging directory"))?;
    }
    fs::create_dir_all(&staging).map_err(display_error("create staging directory"))?;
    let archive_path = staging.with_extension("tar.gz");
    let result = prepare_release(
        &client,
        &format!("{release_base}/{}", asset.archive),
        asset,
        &archive_path,
        &staging,
        &manifest,
    )
    .await;
    let _ = fs::remove_file(&archive_path);
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let destination = paths.releases.join(manifest.version.to_string());
    if destination.exists() {
        fs::remove_dir_all(&staging).map_err(display_error("discard duplicate staging release"))?;
    } else {
        fs::rename(&staging, &destination).map_err(display_error("install versioned release"))?;
    }

    let previous = fs::read_link(&paths.current).ok();
    let service_was_running = service_is_active();
    if service_was_running {
        systemctl(&["stop", "agrider.service"])?;
    }
    let backup = match backup_state(&paths) {
        Ok(path) => path,
        Err(error) => {
            if service_was_running {
                let _ = systemctl(&["start", "agrider.service"]);
            }
            return Err(error);
        }
    };
    println!("State backup: {}", backup.display());

    if let Err(error) = switch_current(&paths.current, &destination) {
        if service_was_running {
            let _ = systemctl(&["start", "agrider.service"]);
        }
        return Err(error);
    }

    let start_result =
        systemctl(&["restart", "agrider.service"]).and_then(|_| health_url(&paths.config));
    let healthy = match start_result {
        Ok(url) => wait_for_health(&client, &url).await,
        Err(error) => Err(error),
    };
    if let Err(error) = healthy {
        rollback_current(&paths.current, previous.as_deref())?;
        systemctl(&["restart", "agrider.service"])
            .map_err(|rollback| format!("{error}; rollback restart also failed: {rollback}"))?;
        return Err(format!(
            "{error}; restored previous release and restarted the service"
        ));
    }

    println!(
        "Upgraded Agent Rider to {} ({}).",
        manifest.version, manifest.source_commit
    );
    Ok(())
}

async fn prepare_release(
    client: &Client,
    url: &str,
    asset: &ReleaseAsset,
    archive_path: &Path,
    staging: &Path,
    manifest: &Manifest,
) -> Result<(), String> {
    println!("Downloading {}", asset.archive);
    let bytes = download_bytes(client, url).await?;
    fs::write(archive_path, &bytes).map_err(display_error("write release archive"))?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != asset.sha256.to_ascii_lowercase() {
        return Err(format!(
            "checksum mismatch for {}: expected {}, received {actual}",
            asset.archive, asset.sha256
        ));
    }
    let file = File::open(archive_path).map_err(display_error("open release archive"))?;
    Archive::new(GzDecoder::new(file))
        .unpack(staging)
        .map_err(display_error("extract release archive"))?;
    let executable = staging.join("agrider");
    if !executable.is_file() || !staging.join("frontend/index.html").is_file() {
        return Err("release bundle is missing agrider or frontend/index.html".into());
    }
    let metadata: serde_json::Value = read_json_file(&staging.join("release.json"))?;
    if metadata["version"].as_str() != Some(&manifest.version.to_string()) {
        return Err("release metadata version does not match the manifest".into());
    }
    Ok(())
}

async fn download_json<T: for<'de> Deserialize<'de>>(
    client: &Client,
    url: &str,
) -> Result<T, String> {
    let bytes = download_bytes(client, url).await?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid JSON from {url}: {error}"))
}

async fn download_bytes(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("download {url}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("download {url}: {error}"))?;
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("read {url}: {error}"))
}

fn validate_asset(asset: &ReleaseAsset) -> Result<(), String> {
    if asset.archive.contains('/') || asset.archive.contains("..") {
        return Err("manifest contains an unsafe archive name".into());
    }
    if asset.sha256.len() != 64 || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("manifest contains an invalid SHA-256 digest".into());
    }
    Ok(())
}

fn read_json_file(path: &Path) -> Result<serde_json::Value, String> {
    let mut contents = String::new();
    File::open(path)
        .and_then(|mut file| file.read_to_string(&mut contents))
        .map_err(display_error("read release metadata"))?;
    serde_json::from_str(&contents).map_err(|error| format!("invalid release metadata: {error}"))
}

fn current_platform() -> Result<String, String> {
    let arch = match env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => return Err(format!("unsupported Linux architecture: {other}")),
    };
    if env::consts::OS != "linux" {
        return Err(format!("unsupported operating system: {}", env::consts::OS));
    }
    Ok(format!("linux-{arch}"))
}

fn service_is_active() -> bool {
    Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", "agrider.service"])
        .status()
        .is_ok_and(|status| status.success())
}

fn systemctl(args: &[&str]) -> Result<(), String> {
    let status = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .status()
        .map_err(|error| format!("run systemctl --user: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "systemctl --user {} exited with {status}",
            args.join(" ")
        ))
    }
}

fn backup_state(paths: &InstallPaths) -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup = paths.shared.join("backups").join(stamp.to_string());
    fs::create_dir_all(&backup).map_err(display_error("create state backup"))?;
    for name in ["data", "plugins"] {
        let source = paths.shared.join(name);
        if source.exists() {
            copy_tree(&source, &backup.join(name))?;
        }
    }
    if paths.config.is_file() {
        fs::copy(&paths.config, backup.join("env"))
            .map_err(display_error("backup configuration"))?;
    }
    Ok(backup)
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(display_error("create backup directory"))?;
    for entry in fs::read_dir(source).map_err(display_error("read backup source"))? {
        let entry = entry.map_err(display_error("read backup entry"))?;
        let target = destination.join(entry.file_name());
        if entry
            .file_type()
            .map_err(display_error("inspect backup entry"))?
            .is_dir()
        {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(display_error("copy backup entry"))?;
        }
    }
    Ok(())
}

fn switch_current(current: &Path, destination: &Path) -> Result<(), String> {
    let parent = current
        .parent()
        .ok_or_else(|| "current link has no parent".to_string())?;
    let next = parent.join(format!(".current-{}", std::process::id()));
    let _ = fs::remove_file(&next);
    symlink(destination, &next).map_err(display_error("create current symlink"))?;
    fs::rename(next, current).map_err(display_error("switch current symlink"))
}

fn rollback_current(current: &Path, previous: Option<&Path>) -> Result<(), String> {
    match previous {
        Some(path) => switch_current(current, path),
        None => fs::remove_file(current).map_err(display_error("remove failed current symlink")),
    }
}

fn health_url(config: &Path) -> Result<String, String> {
    if let Ok(url) = env::var("AGRIDER_HEALTH_URL") {
        return Ok(url);
    }
    let mut port = "5173".to_string();
    if let Ok(contents) = fs::read_to_string(config) {
        for line in contents.lines() {
            if let Some(value) = line.trim().strip_prefix("AGENT_RIDER_PORT=") {
                port = value.trim_matches(['\'', '"']).to_string();
            }
        }
    }
    port.parse::<u16>()
        .map_err(|_| format!("invalid AGENT_RIDER_PORT in {}", config.display()))?;
    Ok(format!("http://127.0.0.1:{port}/store/state"))
}

async fn wait_for_health(client: &Client, url: &str) -> Result<(), String> {
    let mut last = String::new();
    let attempts = env::var("AGRIDER_HEALTH_ATTEMPTS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(30);
    let delay = env::var("AGRIDER_HEALTH_DELAY_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(500);
    for _ in 0..attempts {
        match client.get(url).send().await {
            Ok(response)
                if response.status() == StatusCode::OK
                    || response.status() == StatusCode::UNAUTHORIZED =>
            {
                return Ok(())
            }
            Ok(response) => last = format!("HTTP {}", response.status()),
            Err(error) => last = error.to_string(),
        }
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    Err(format!("new service failed health check at {url}: {last}"))
}

fn display_error(context: &'static str) -> impl FnOnce(io::Error) -> String {
    move |error| format!("{context}: {error}")
}
