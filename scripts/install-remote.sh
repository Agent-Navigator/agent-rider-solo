#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  APP_DIR=/opt/agent-rider bash scripts/install-remote.sh /tmp/agent-rider-release.tar.gz

Environment:
  APP_DIR             Install root. Default: /opt/agent-rider
  APP_USER            systemd user. Default: existing install's user, else the
                      session user (SUDO_USER/logname), else root
  WEB_HOST            Public Vite preview bind host. Default: 127.0.0.1
  WEB_PORT            Public Vite preview port. Default: 5173
  STORE_PORT          Local store backend port. Default: 5174
  BROWSE_ROOT         File browser root. Default: APP_USER home
  AGENT_RIDER_APPS_DIR Local Agent Apps root. Default: APP_DIR/shared/plugins
  HERMES_TARGET       Hermes ACP executable. Default: hermes resolved from PATH.
  VITE_ALLOWED_HOSTS  Comma-separated hosts, or "all". Default: all
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

archive=${1:-}
if [[ -z "$archive" || ! -f "$archive" ]]; then
  usage >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "This installer writes systemd units and should be run as root or through sudo." >&2
  exit 1
fi

APP_NAME=${APP_NAME:-agent-rider}
ENV_FILE=${ENV_FILE:-/etc/default/agent-rider}

read_env_value() {
  local key=$1
  [[ -f "$ENV_FILE" ]] || return 1
  awk -F= -v key="$key" '
    $0 ~ /^[[:space:]]*#/ { next }
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      gsub(/^'\''|'\''$/, "", value)
      print value
    }
  ' "$ENV_FILE" | tail -n 1
}

existing_app_dir=$(read_env_value APP_DIR || true)
APP_DIR=${APP_DIR:-${existing_app_dir:-/opt/agent-rider}}
# Auto-detect the systemd user. Priority:
#   1. APP_USER (explicit override)
#   2. the identity an existing install already runs as — so an update, even one
#      run straight as root (no sudo, e.g. root login / `su -` / cron), keeps the
#      current user instead of silently switching to root. A root service has
#      HOME=/root, so it can't find the user's CLI agents (~/.local/bin) and the
#      Conversation card greys them all out.
#   3. the user behind this session: SUDO_USER (via sudo) or logname (login/su -)
#   4. root
store_unit=/etc/systemd/system/agent-rider-store.service
existing_service_user=''
if [[ -r "$store_unit" ]]; then
  existing_service_user=$(awk -F= '/^User=/{print $2; exit}' "$store_unit")
fi
if [[ -z "$existing_service_user" && -e "$APP_DIR/current" ]]; then
  existing_service_user=$(stat -c '%U' "$APP_DIR/current" 2>/dev/null || true)
fi
session_user=${SUDO_USER:-$(logname 2>/dev/null || true)}
APP_USER=${APP_USER:-${existing_service_user:-${session_user:-root}}}
APP_GROUP=${APP_GROUP:-$APP_USER}
existing_web_host=$(read_env_value WEB_HOST || true)
existing_web_port=$(read_env_value WEB_PORT || true)
existing_store_port=$(read_env_value STORE_PORT || true)
existing_browse_root=$(read_env_value BROWSE_ROOT || true)
existing_apps_dir=$(read_env_value AGENT_RIDER_APPS_DIR || true)
existing_hermes_target=$(read_env_value HERMES_TARGET || true)
existing_allowed_hosts=$(read_env_value VITE_ALLOWED_HOSTS || true)
WEB_HOST=${WEB_HOST:-${existing_web_host:-127.0.0.1}}
WEB_PORT=${WEB_PORT:-${existing_web_port:-5173}}
STORE_PORT=${STORE_PORT:-${existing_store_port:-5174}}
# Retire the old external WebUI URL; the Rust backend expects an ACP executable.
if [[ "${existing_hermes_target:-}" == "http://127.0.0.1:8789" ]]; then
  existing_hermes_target=''
fi
HERMES_TARGET=${HERMES_TARGET:-${existing_hermes_target:-hermes}}
VITE_ALLOWED_HOSTS=${VITE_ALLOWED_HOSTS:-${existing_allowed_hosts:-all}}

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "APP_USER '$APP_USER' does not exist." >&2
  exit 1
fi

app_home=$(getent passwd "$APP_USER" | cut -d: -f6)
if [[ -z "$app_home" ]]; then
  app_home=/root
fi
BROWSE_ROOT=${BROWSE_ROOT:-${existing_browse_root:-$app_home}}

systemd_available() {
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]
}

stop_existing_services() {
  if systemd_available; then
    systemctl stop agent-rider-web.service agent-rider-store.service 2>/dev/null || true
  fi
}

restart_services() {
  if systemd_available; then
    systemctl daemon-reload
    systemctl enable agent-rider-store.service agent-rider-web.service
    systemctl restart agent-rider-store.service agent-rider-web.service
  fi
}

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ca-certificates curl git gnupg tar gzip tmux build-essential python3
    return
  fi

  missing=()
  for cmd in git tar gzip tmux; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    echo "Missing required commands: ${missing[*]}" >&2
    echo "Install them with your OS package manager, then run this script again." >&2
    exit 1
  fi
}

install_node_22() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
  fi
  if (( major >= 22 )); then
    return
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Node.js 22+ is required. Install Node.js 22, then run this script again." >&2
    exit 1
  fi

  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
}

install_packages
install_node_22

release_name=$(basename "$archive")
release_name=${release_name%.tar.gz}
release_name=${release_name%.tgz}
release_name=${release_name//[^A-Za-z0-9._-]/-}
if [[ -z "$release_name" ]]; then
  release_name="release-$(date -u +%Y%m%dT%H%M%SZ)"
fi

releases_dir="$APP_DIR/releases"
shared_dir="$APP_DIR/shared"
shared_data_dir="$shared_dir/data"
shared_plugins_dir="$shared_dir/plugins"
AGENT_RIDER_APPS_DIR=${AGENT_RIDER_APPS_DIR:-${existing_apps_dir:-$shared_plugins_dir}}
release_dir="$releases_dir/$release_name"
if [[ -e "$release_dir" ]]; then
  release_dir="$releases_dir/${release_name}-$(date -u +%Y%m%dT%H%M%SZ)"
fi

backup_shared_state() {
  local backup_root="$shared_dir/backups"
  local backup_dir="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)"
  local has_state=0
  [[ -e "$shared_data_dir" ]] && has_state=1
  [[ -e "$shared_plugins_dir" ]] && has_state=1
  (( has_state == 1 )) || return 0

  mkdir -p "$backup_dir"
  [[ -e "$shared_data_dir" ]] && cp -a "$shared_data_dir" "$backup_dir/data"
  [[ -e "$shared_plugins_dir" ]] && cp -a "$shared_plugins_dir" "$backup_dir/plugins"
  echo "Local state backup: $backup_dir"
}

replace_shared_path() {
  local src=$1
  local dest=$2
  rm -rf "$dest"
  cp -a "$src" "$dest"
}

sync_plugins() {
  local release_plugins=$1
  local shared_plugins=$2
  [[ -d "$release_plugins" ]] || return 0
  mkdir -p "$shared_plugins"

  # The shared directory contains both build-time source plugins and local
  # Agent Apps. Remove source plugins that no longer ship in the release, but
  # never prune App directories: their manifest marks them as persistent
  # runtime data owned by the installation rather than the release.
  while IFS= read -r -d '' existing; do
    local name
    name=$(basename "$existing")
    [[ "$name" == .* ]] && continue
    [[ -e "$release_plugins/$name" ]] && continue
    [[ -f "$existing/manifest.json" ]] && continue
    echo "Removing retired source plugin: plugins/$name"
    rm -rf "$existing"
  done < <(find "$shared_plugins" -mindepth 1 -maxdepth 1 -type d -print0)

  while IFS= read -r -d '' src; do
    cp -a "$src" "$shared_plugins/"
  done < <(find "$release_plugins" -mindepth 1 -maxdepth 1 -type f -print0)

  while IFS= read -r -d '' src; do
    local name dest
    name=$(basename "$src")
    [[ "$name" == .* ]] && continue
    dest="$shared_plugins/$name"

    if [[ "$name" == _* ]]; then
      replace_shared_path "$src" "$dest"
    elif [[ -f "$src/manifest.json" ]]; then
      echo "Skipping source Agent App: plugins/$name (local apps live in AGENT_RIDER_APPS_DIR)"
    else
      replace_shared_path "$src" "$dest"
    fi
  done < <(find "$release_plugins" -mindepth 1 -maxdepth 1 -type d -print0)
}

mkdir -p "$releases_dir" "$shared_data_dir" "$shared_plugins_dir" "$shared_dir/logs" "$release_dir"
tar -xzf "$archive" -C "$release_dir"
if [[ ! -x "$release_dir/bin/agent-rider-store" ]]; then
  echo "Release is missing executable bin/agent-rider-store." >&2
  exit 1
fi
cat > "$release_dir/.agent-rider-release" <<EOF
commit=${AGENT_RIDER_DEPLOY_COMMIT:-unknown}
short_sha=${AGENT_RIDER_DEPLOY_SHORT_SHA:-unknown}
source_ref=${AGENT_RIDER_SOURCE_REF:-unknown}
source_git=${AGENT_RIDER_SOURCE_GIT:-unknown}
archive=$release_name
deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

backup_shared_state
sync_plugins "$release_dir/plugins" "$shared_plugins_dir"
rm -rf "$release_dir/data" "$release_dir/plugins"
ln -sfn "$shared_data_dir" "$release_dir/data"
ln -sfn "$shared_plugins_dir" "$release_dir/plugins"

cd "$release_dir"
npm ci
npm run build

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

staging_dir="$release_dir/.agent-rider-install"
mkdir -p "$staging_dir"
new_env="$staging_dir/environment"
new_store_unit="$staging_dir/agent-rider-store.service"
new_web_unit="$staging_dir/agent-rider-web.service"

cat > "$new_env" <<EOF
APP_DIR=$APP_DIR
HOME=$app_home
BROWSE_ROOT=$BROWSE_ROOT
AGENT_RIDER_APPS_DIR=$AGENT_RIDER_APPS_DIR
WEB_HOST=$WEB_HOST
STORE_PORT=$STORE_PORT
WEB_PORT=$WEB_PORT
HERMES_TARGET=$HERMES_TARGET
VITE_ALLOWED_HOSTS=$VITE_ALLOWED_HOSTS
EOF

cat > "$new_store_unit" <<EOF
[Unit]
Description=Agent Rider store backend
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR/current
EnvironmentFile=/etc/default/agent-rider
ExecStart=$APP_DIR/current/bin/agent-rider-store
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > "$new_web_unit" <<EOF
[Unit]
Description=Agent Rider web UI
After=network.target agent-rider-store.service
Requires=agent-rider-store.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR/current
EnvironmentFile=/etc/default/agent-rider
ExecStart=$APP_DIR/current/scripts/run-preview.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

old_current=$(readlink -f "$APP_DIR/current" 2>/dev/null || true)
rollback_dir="$staging_dir/rollback"
mkdir -p "$rollback_dir"
[[ -f "$store_unit" ]] && cp -a "$store_unit" "$rollback_dir/store.service"
[[ -f /etc/systemd/system/agent-rider-web.service ]] && cp -a /etc/systemd/system/agent-rider-web.service "$rollback_dir/web.service"
[[ -f "$ENV_FILE" ]] && cp -a "$ENV_FILE" "$rollback_dir/environment"

services_were_stopped=0
rollback_install() {
  local status=$?
  trap - ERR
  if (( services_were_stopped == 1 )); then
    echo "Deployment failed; restoring the previous release and systemd units." >&2
    if [[ -n "$old_current" && -d "$old_current" ]]; then ln -sfn "$old_current" "$APP_DIR/current"; else rm -f "$APP_DIR/current"; fi
    if [[ -f "$rollback_dir/store.service" ]]; then cp -a "$rollback_dir/store.service" "$store_unit"; else rm -f "$store_unit"; fi
    if [[ -f "$rollback_dir/web.service" ]]; then cp -a "$rollback_dir/web.service" /etc/systemd/system/agent-rider-web.service; else rm -f /etc/systemd/system/agent-rider-web.service; fi
    if [[ -f "$rollback_dir/environment" ]]; then cp -a "$rollback_dir/environment" "$ENV_FILE"; else rm -f "$ENV_FILE"; fi
    if systemd_available; then
      systemctl daemon-reload
      systemctl restart agent-rider-store.service agent-rider-web.service 2>/dev/null || true
    fi
  fi
  exit "$status"
}
trap rollback_install ERR

stop_existing_services
services_were_stopped=1
ln -sfn "$release_dir" "$APP_DIR/current"
install -m 0644 "$new_env" "$ENV_FILE"
install -m 0644 "$new_store_unit" "$store_unit"
install -m 0644 "$new_web_unit" /etc/systemd/system/agent-rider-web.service
restart_services

healthy=0
for _ in $(seq 1 30); do
  status=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$STORE_PORT/store/state" || true)
  if [[ "$status" == 200 || "$status" == 401 ]]; then healthy=1; break; fi
  sleep 1
done
if (( healthy == 0 )); then
  echo "Rust backend health check failed on /store/state." >&2
  false
fi

services_were_stopped=0
trap - ERR
rm -rf "$staging_dir"

echo "Agent Rider deployed to $release_dir"
echo "Current symlink: $APP_DIR/current"
echo "Preserved data: $shared_data_dir"
echo "Preserved Local Agent Apps: $shared_plugins_dir"
echo "Web UI: http://<server>:$WEB_PORT"
echo "Check status: systemctl status agent-rider-web agent-rider-store"
