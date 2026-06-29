#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  APP_DIR=/opt/agent-rider bash scripts/install-remote.sh /tmp/agent-rider-release.tar.gz

Environment:
  APP_DIR             Install root. Default: /opt/agent-rider
  APP_USER            systemd user. Default: SUDO_USER, or root
  WEB_PORT            Public Vite preview port. Default: 5173
  STORE_PORT          Local store backend port. Default: 5174
  BROWSE_ROOT         File browser root. Default: APP_USER home
  HERMES_TARGET       Hermes proxy target. Default: http://127.0.0.1:8789
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
APP_DIR=${APP_DIR:-/opt/agent-rider}
APP_USER=${APP_USER:-${SUDO_USER:-root}}
APP_GROUP=${APP_GROUP:-$APP_USER}
WEB_PORT=${WEB_PORT:-5173}
STORE_PORT=${STORE_PORT:-5174}
HERMES_TARGET=${HERMES_TARGET:-http://127.0.0.1:8789}
VITE_ALLOWED_HOSTS=${VITE_ALLOWED_HOSTS:-all}

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "APP_USER '$APP_USER' does not exist." >&2
  exit 1
fi

app_home=$(getent passwd "$APP_USER" | cut -d: -f6)
if [[ -z "$app_home" ]]; then
  app_home=/root
fi
BROWSE_ROOT=${BROWSE_ROOT:-$app_home}

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ca-certificates curl gnupg tar gzip tmux build-essential python3
    return
  fi

  missing=()
  for cmd in tar gzip tmux; do
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
release_dir="$releases_dir/$release_name"
if [[ -e "$release_dir" ]]; then
  release_dir="$releases_dir/${release_name}-$(date -u +%Y%m%dT%H%M%SZ)"
fi

mkdir -p "$releases_dir" "$shared_dir/data" "$shared_dir/logs" "$release_dir"
tar -xzf "$archive" -C "$release_dir"
ln -sfn "$shared_dir/data" "$release_dir/data"

cd "$release_dir"
npm ci
npm run build

ln -sfn "$release_dir" "$APP_DIR/current"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

cat > /etc/default/agent-rider <<EOF
APP_DIR=$APP_DIR
HOME=$app_home
BROWSE_ROOT=$BROWSE_ROOT
STORE_PORT=$STORE_PORT
WEB_PORT=$WEB_PORT
HERMES_TARGET=$HERMES_TARGET
VITE_ALLOWED_HOSTS=$VITE_ALLOWED_HOSTS
EOF

cat > /etc/systemd/system/agent-rider-store.service <<EOF
[Unit]
Description=Agent Rider store backend
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR/current
EnvironmentFile=/etc/default/agent-rider
ExecStart=/usr/bin/node server/store.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/agent-rider-web.service <<EOF
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

systemctl daemon-reload
systemctl enable agent-rider-store.service agent-rider-web.service
systemctl restart agent-rider-store.service agent-rider-web.service

echo "Agent Rider deployed to $release_dir"
echo "Current symlink: $APP_DIR/current"
echo "Web UI: http://<server>:$WEB_PORT"
echo "Check status: systemctl status agent-rider-web agent-rider-store"
