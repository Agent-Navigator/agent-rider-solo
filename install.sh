#!/bin/sh
set -eu

REPOSITORY=${AGRIDER_REPOSITORY:-Agent-Navigator/agent-rider-solo}
RELEASE_BASE=${AGRIDER_RELEASE_BASE:-https://github.com/$REPOSITORY/releases/latest/download}
RELEASE_BASE=${RELEASE_BASE%/}
UPGRADE_COMMAND=${AGRIDER_UPGRADE_COMMAND:-agrider upgrade}

fail() {
  printf 'Agent Rider install failed: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

case "$(uname -s 2>/dev/null || true)" in
  Linux) ;;
  *) fail 'only Linux is supported' ;;
esac

case "$(uname -m 2>/dev/null || true)" in
  x86_64|amd64) PLATFORM=linux-x86_64 ;;
  aarch64|arm64) PLATFORM=linux-aarch64 ;;
  *) fail "unsupported architecture: $(uname -m 2>/dev/null || printf unknown)" ;;
esac

for command_name in curl tar gzip sha256sum awk sed systemctl tmux; do
  need "$command_name"
done

HOME_DIR=${HOME:?HOME is not set}
INVOKING_USER=${USER:-$(id -un)}
DATA_HOME=${XDG_DATA_HOME:-$HOME_DIR/.local/share}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME_DIR/.config}
DATA_ROOT=${AGRIDER_DATA_ROOT:-$DATA_HOME/agrider}
CONFIG_FILE=${AGRIDER_CONFIG_FILE:-$CONFIG_HOME/agrider/env}
SERVICE_DIR=${AGRIDER_SERVICE_DIR:-$CONFIG_HOME/systemd/user}
SERVICE_FILE=$SERVICE_DIR/agrider.service
RUNTIME_SERVICE_FILE=$SERVICE_DIR/agrider-runtime.service
TMUX_SERVICE_FILE=$SERVICE_DIR/agrider-tmux.service
TMUX_CONFIG_FILE=$CONFIG_HOME/agrider/tmux.conf
BIN_DIR=${AGRIDER_BIN_DIR:-$HOME_DIR/.local/bin}
CLI_PATH=$BIN_DIR/agrider
SHARED_DIR=$DATA_ROOT/shared
RELEASES_DIR=$DATA_ROOT/releases
CURRENT_LINK=$DATA_ROOT/current
LEGACY_ROOT=${AGRIDER_LEGACY_ROOT:-/opt/agent-rider}
LEGACY_ENV=${AGRIDER_LEGACY_ENV:-/etc/default/agent-rider}
ARCHIVE=agrider-$PLATFORM.tar.gz

TMP_ROOT=${TMPDIR:-/tmp}
WORK_DIR=$(mktemp -d "$TMP_ROOT/agrider-install.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    case "${ROLLBACK_MODE:-}" in
      legacy) rollback_legacy ;;
      user) rollback_user_service ;;
    esac
  fi
  rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

printf 'Downloading Agent Rider for %s...\n' "$PLATFORM"
curl -fsSL "$RELEASE_BASE/checksums.txt" -o "$WORK_DIR/checksums.txt" \
  || fail 'could not download release checksums'
EXPECTED=$(awk -v name="$ARCHIVE" '$2 == name || $2 == "*" name { print $1 }' "$WORK_DIR/checksums.txt")
case "$EXPECTED" in
  *[!0-9A-Fa-f]*|'') fail "release checksum is missing or invalid for $ARCHIVE" ;;
esac
[ "${#EXPECTED}" -eq 64 ] || fail "release checksum is invalid for $ARCHIVE"
curl -fsSL "$RELEASE_BASE/$ARCHIVE" -o "$WORK_DIR/$ARCHIVE" \
  || fail "could not download $ARCHIVE"
ACTUAL=$(sha256sum "$WORK_DIR/$ARCHIVE" | awk '{print $1}')
[ "$ACTUAL" = "$EXPECTED" ] || fail "checksum mismatch for $ARCHIVE"

mkdir -p "$WORK_DIR/release"
tar -xzf "$WORK_DIR/$ARCHIVE" -C "$WORK_DIR/release" \
  || fail 'could not extract the release bundle'
[ -x "$WORK_DIR/release/agrider" ] || fail 'release bundle is missing executable agrider'
[ -f "$WORK_DIR/release/frontend/index.html" ] || fail 'release bundle is missing frontend/index.html'
[ -f "$WORK_DIR/release/release.json" ] || fail 'release bundle is missing release.json'
VERSION=$($WORK_DIR/release/agrider --version | awk 'NR == 1 { print $2 }')
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail 'release executable returned an invalid version' ;;
esac
grep -F "\"version\":\"$VERSION\"" "$WORK_DIR/release/release.json" >/dev/null \
  || fail 'release metadata does not match the executable version'

read_env() {
  key=$1
  file=$2
  [ -r "$file" ] || return 1
  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      gsub(/^\047|\047$/, "", value)
      print value
    }
  ' "$file" | tail -n 1
}

unit_user() {
  value=$(systemctl show -p User --value agent-rider-store.service 2>/dev/null || true)
  if [ -z "$value" ] && [ -r /etc/systemd/system/agent-rider-store.service ]; then
    value=$(awk -F= '$1 == "User" { print $2; exit }' /etc/systemd/system/agent-rider-store.service)
  fi
  printf '%s\n' "$value"
}

LEGACY=0
LEGACY_USER=''
if [ -d "$LEGACY_ROOT" ] && { [ -e "$LEGACY_ROOT/current" ] || [ -d "$LEGACY_ROOT/shared" ]; }; then
  # A rootless installation is already authoritative. Residual /opt files are
  # common after the one-time migration and must never trigger it again: the
  # migration copies legacy shared/data over the rootless database.
  if [ -L "$CURRENT_LINK" ]; then
    printf '%s\n' 'Ignoring residual legacy /opt/agent-rider because a rootless current release already exists.' >&2
  else
    LEGACY=1
    LEGACY_USER=$(unit_user)
    [ -n "$LEGACY_USER" ] || fail 'legacy /opt installation found but its service User= could not be determined'
    [ "$LEGACY_USER" = "$INVOKING_USER" ] || fail "legacy services run as '$LEGACY_USER'; rerun the installer while logged in as that user"
  fi
fi

if [ "$(id -u)" -ne 0 ]; then
  need sudo
fi

install_browser_prerequisites() {
  [ -r /etc/os-release ] || return 0
  os_id=$(awk -F= '$1 == "ID" { gsub(/^"|"$/, "", $2); print $2; exit }' /etc/os-release)
  [ "$os_id" = ubuntu ] || return 0
  if ! command -v apt-get >/dev/null 2>&1; then
    printf '%s\n' \
      'Warning: apt-get is unavailable, so optional Ubuntu Browser prerequisites were not installed.' \
      'Agent Rider will continue installing. The Browser button will report what is missing.' >&2
    return 0
  fi
  printf 'Installing Browser WebRTC system prerequisites...\n'
  if ! as_root apt-get update; then
    printf '%s\n' \
      'Warning: could not refresh Ubuntu package metadata for optional Browser prerequisites.' \
      'Agent Rider will continue installing. The Browser button will report what is missing.' >&2
    return 0
  fi
  alsa_package=libasound2
  if command -v apt-cache >/dev/null 2>&1 \
    && apt-cache show --no-all-versions libasound2t64 >/dev/null 2>&1; then
    alsa_package=libasound2t64
  fi
  if ! as_root apt-get install --no-install-recommends -y \
    xvfb openbox xcvt x11-utils x11-xkb-utils x11-xserver-utils xserver-xorg-core xsel \
    python3 libpulse0 wayland-protocols libwayland-dev libwayland-egl1 \
    libx11-xcb1 libxcb-dri3-0 libxkbcommon0 libxdamage1 libxfixes3 libxv1 libxtst6 libxext6 \
    fonts-liberation "$alsa_package" libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libu2f-udev libvulkan1 xdg-utils; then
    printf '%s\n' \
      'Warning: could not install optional Ubuntu Browser prerequisites.' \
      'Agent Rider will continue installing. The Browser button will report what is missing.' >&2
  fi
}

install_browser_prerequisites

printf 'Enabling the Agent Rider user service at boot...\n'
as_root loginctl enable-linger "$INVOKING_USER" \
  || fail "could not enable lingering; run: sudo loginctl enable-linger $INVOKING_USER"

RELEASE_ID=${AGRIDER_RELEASE_ID:-$VERSION}
case "$RELEASE_ID" in
  ''|*[!A-Za-z0-9._-]*) fail 'release identifier contains unsupported characters' ;;
esac

mkdir -p "$RELEASES_DIR" "$SHARED_DIR/data" "$SHARED_DIR/plugins" \
  "$SHARED_DIR/backups" "$(dirname "$CONFIG_FILE")" "$SERVICE_DIR" "$BIN_DIR"
DESTINATION=$RELEASES_DIR/$RELEASE_ID
if [ ! -d "$DESTINATION" ]; then
  mv "$WORK_DIR/release" "$DESTINATION"
fi

service_has_embedded_sessions() {
  [ "${AGRIDER_ASSUME_ACTIVE_SESSIONS:-0}" = 1 ] && return 0
  systemctl --user is-active --quiet agrider.service >/dev/null 2>&1 || return 1
  if systemctl --user is-active --quiet agrider-runtime.service >/dev/null 2>&1; then
    return 1
  fi

  main_pid=$(systemctl --user show -p MainPID --value agrider.service 2>/dev/null || true)
  control_group=$(systemctl --user show -p ControlGroup --value agrider.service 2>/dev/null || true)
  case "$main_pid" in
    ''|0|*[!0-9]*) ;;
    *) case "$control_group" in
      *..*|*[!A-Za-z0-9_./@-]*) ;;
      /*)
      cgroup_procs=/sys/fs/cgroup$control_group/cgroup.procs
      if [ -r "$cgroup_procs" ]; then
        while IFS= read -r process_id; do
          [ -z "$process_id" ] || [ "$process_id" = "$main_pid" ] || return 0
        done < "$cgroup_procs"
      fi
      ;;
    esac ;;
  esac

  command -v tmux >/dev/null 2>&1 \
    && tmux -L agent-rider list-sessions >/dev/null 2>&1
}

stage_pending_release() {
  pending_link=$DATA_ROOT/.pending-install
  rm -f "$pending_link"
  ln -s "$DESTINATION" "$pending_link"
  mv -Tf "$pending_link" "$DATA_ROOT/pending"
  ln -sfn "$CURRENT_LINK/agrider" "$CLI_PATH"
  printf '\nAgent Rider %s was staged without interrupting active sessions.\n' "$VERSION"
  printf 'Pending release: %s\n' "$DESTINATION"
  printf '%s\n' 'Run the installer again after the current sessions finish to activate it.'
}

# A pre-split installation owns tmux agents and Browser process groups inside
# agrider.service. Stopping that unit would destroy the user's live work. Stage
# the verified release and defer the one-time service migration until it is idle.
if [ "$LEGACY" -eq 0 ] && [ -L "$CURRENT_LINK" ] && service_has_embedded_sessions; then
  stage_pending_release
  exit 0
fi

env_quote() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_config() {
  config_port=${AGENT_RIDER_PORT:-5173}
  config_browse=${BROWSE_ROOT:-$HOME_DIR}
  config_hosts=${VITE_ALLOWED_HOSTS:-all}
  if [ "$LEGACY" -eq 1 ]; then
    config_port=${AGENT_RIDER_PORT:-$(read_env WEB_PORT "$LEGACY_ENV" || printf 5173)}
    config_browse=${BROWSE_ROOT:-$(read_env BROWSE_ROOT "$LEGACY_ENV" || printf %s "$HOME_DIR")}
    config_hosts=${VITE_ALLOWED_HOSTS:-$(read_env VITE_ALLOWED_HOSTS "$LEGACY_ENV" || printf all)}
  fi
  case "$config_port" in
    ''|*[!0-9]*) fail 'AGENT_RIDER_PORT must be a TCP port number' ;;
  esac
  [ "$config_port" -ge 1 ] && [ "$config_port" -lt 65535 ] \
    || fail 'AGENT_RIDER_PORT must be between 1 and 65534'
  runtime_port=${AGENT_RIDER_RUNTIME_PORT:-$((config_port + 1))}
  case "$runtime_port" in
    ''|*[!0-9]*) fail 'AGENT_RIDER_RUNTIME_PORT must be a TCP port number' ;;
  esac
  [ "$runtime_port" -ge 1 ] && [ "$runtime_port" -le 65535 ] \
    || fail 'AGENT_RIDER_RUNTIME_PORT must be between 1 and 65535'
  {
    printf 'APP_DIR="%s"\n' "$(env_quote "$DATA_ROOT")"
    printf 'AGENT_RIDER_DATA_DIR="%s"\n' "$(env_quote "$SHARED_DIR/data")"
    printf 'AGENT_RIDER_APPS_DIR="%s"\n' "$(env_quote "$SHARED_DIR/plugins")"
    printf 'AGENT_RIDER_WEB_ROOT="%s"\n' "$(env_quote "$CURRENT_LINK/frontend")"
    printf 'AGENT_RIDER_HOST="127.0.0.1"\n'
    printf 'AGENT_RIDER_PORT="%s"\n' "$(env_quote "$config_port")"
    printf 'AGENT_RIDER_RUNTIME_PORT="%s"\n' "$(env_quote "$runtime_port")"
    printf 'AGENT_RIDER_RUNTIME_URL="http://127.0.0.1:%s"\n' "$(env_quote "$runtime_port")"
    printf 'BROWSE_ROOT="%s"\n' "$(env_quote "$config_browse")"
    printf 'VITE_ALLOWED_HOSTS="%s"\n' "$(env_quote "$config_hosts")"
  } > "$CONFIG_FILE"
}

if [ ! -f "$CONFIG_FILE" ]; then
  write_config
fi

if ! grep -q '^AGENT_RIDER_RUNTIME_PORT=' "$CONFIG_FILE"; then
  existing_port=$(read_env AGENT_RIDER_PORT "$CONFIG_FILE" || printf 5173)
  case "$existing_port" in
    ''|*[!0-9]*) fail 'existing AGENT_RIDER_PORT must be a TCP port number' ;;
  esac
  [ "$existing_port" -ge 1 ] && [ "$existing_port" -lt 65535 ] \
    || fail 'existing AGENT_RIDER_PORT must be between 1 and 65534'
  runtime_port=${AGENT_RIDER_RUNTIME_PORT:-$((existing_port + 1))}
  case "$runtime_port" in
    ''|*[!0-9]*) fail 'AGENT_RIDER_RUNTIME_PORT must be a TCP port number' ;;
  esac
  [ "$runtime_port" -ge 1 ] && [ "$runtime_port" -le 65535 ] \
    || fail 'AGENT_RIDER_RUNTIME_PORT must be between 1 and 65535'
  {
    printf 'AGENT_RIDER_RUNTIME_PORT="%s"\n' "$(env_quote "$runtime_port")"
    printf 'AGENT_RIDER_RUNTIME_URL="http://127.0.0.1:%s"\n' "$(env_quote "$runtime_port")"
  } >> "$CONFIG_FILE"
fi

{
  printf '%s\n' '[Unit]'
  printf '%s\n' 'Description=Agent Rider'
  printf '%s\n' 'After=network-online.target'
  printf '%s\n' 'Wants=network-online.target'
  printf '\n%s\n' '[Service]'
  printf '%s\n' 'Type=simple'
  printf 'EnvironmentFile=%s\n' "$CONFIG_FILE"
  printf 'WorkingDirectory=%s\n' "$CURRENT_LINK"
  printf 'ExecStart=%s serve\n' "$CURRENT_LINK/agrider"
  printf '%s\n' 'Restart=on-failure'
  printf '%s\n' 'RestartSec=3'
  printf '\n%s\n' '[Install]'
  printf '%s\n' 'WantedBy=default.target'
} > "$SERVICE_FILE"

{
  printf '%s\n' '[Unit]'
  printf '%s\n' 'Description=Agent Rider session runtime'
  printf '%s\n' 'After=network-online.target agrider-tmux.service'
  printf '%s\n' 'Wants=network-online.target agrider-tmux.service'
  printf '\n%s\n' '[Service]'
  printf '%s\n' 'Type=simple'
  printf 'EnvironmentFile=%s\n' "$CONFIG_FILE"
  printf 'WorkingDirectory=%s\n' "$CURRENT_LINK"
  printf 'ExecStart=%s runtime\n' "$CURRENT_LINK/agrider"
  printf '%s\n' 'Restart=on-failure'
  printf '%s\n' 'RestartSec=3'
  printf '\n%s\n' '[Install]'
  printf '%s\n' 'WantedBy=default.target'
} > "$RUNTIME_SERVICE_FILE"

mkdir -p "$(dirname "$TMUX_CONFIG_FILE")"
cat > "$TMUX_CONFIG_FILE" <<'EOF'
set -g status off
set -g window-size latest
set -g mouse on
set -g set-clipboard external
set -g history-limit 10000
set -g destroy-unattached off
setw -g aggressive-resize on
EOF
TMUX_PATH=$(command -v tmux)
{
  printf '%s\n' '[Unit]'
  printf '%s\n' 'Description=Agent Rider persistent terminal runtime'
  printf '\n%s\n' '[Service]'
  printf '%s\n' 'Type=simple'
  printf 'ExecStart=%s -L agent-rider -f %s -D\n' "$TMUX_PATH" "$TMUX_CONFIG_FILE"
  printf '%s\n' 'Restart=always'
  printf '%s\n' 'RestartSec=1'
  printf '\n%s\n' '[Install]'
  printf '%s\n' 'WantedBy=default.target'
} > "$TMUX_SERVICE_FILE"

OLD_CURRENT=''
if [ -L "$CURRENT_LINK" ]; then
  OLD_CURRENT=$(readlink "$CURRENT_LINK")
fi
BACKUP=$SHARED_DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP"

rollback_user_service() {
  if [ -n "$OLD_CURRENT" ]; then
    ln -s "$OLD_CURRENT" "$DATA_ROOT/.current-rollback"
    mv -Tf "$DATA_ROOT/.current-rollback" "$CURRENT_LINK"
    systemctl --user restart agrider.service >/dev/null 2>&1 || true
  else
    rm -f "$CURRENT_LINK"
    systemctl --user disable --now agrider.service >/dev/null 2>&1 || true
  fi
  if [ "${STARTED_RUNTIME_SERVICES:-0}" -eq 1 ]; then
    systemctl --user disable --now agrider-runtime.service agrider-tmux.service \
      >/dev/null 2>&1 || true
  fi
}

rollback_legacy() {
  systemctl --user disable --now agrider.service >/dev/null 2>&1 || true
  as_root systemctl enable agent-rider-store.service agent-rider-web.service >/dev/null 2>&1 || true
  as_root systemctl start agent-rider-store.service agent-rider-web.service >/dev/null 2>&1 || true
}

if [ "$LEGACY" -eq 1 ]; then
  printf 'Migrating the existing /opt/agent-rider installation...\n'
  mkdir -p "$BACKUP/legacy"
  [ -L "$LEGACY_ROOT/current" ] && readlink "$LEGACY_ROOT/current" > "$BACKUP/legacy/current-link"
  [ -r "$LEGACY_ENV" ] && as_root cp -a "$LEGACY_ENV" "$BACKUP/legacy/environment"
  for old_unit in agent-rider-store.service agent-rider-web.service; do
    [ -r "/etc/systemd/system/$old_unit" ] && as_root cp -a "/etc/systemd/system/$old_unit" "$BACKUP/legacy/$old_unit"
  done
  ROLLBACK_MODE=legacy
  as_root systemctl stop agent-rider-web.service agent-rider-store.service \
    || fail 'could not stop the legacy services'
  as_root systemctl disable agent-rider-web.service agent-rider-store.service \
    || { rollback_legacy; fail 'could not disable the legacy services'; }
  legacy_data=$LEGACY_ROOT/shared/data
  [ -d "$legacy_data" ] || legacy_data=$LEGACY_ROOT/current/data
  legacy_plugins=$LEGACY_ROOT/shared/plugins
  if [ -d "$legacy_data" ]; then
    as_root cp -a "$legacy_data" "$BACKUP/data"
    as_root chown -R "$INVOKING_USER" "$BACKUP/data"
    cp -a "$BACKUP/data/." "$SHARED_DIR/data/"
  fi
  if [ -d "$legacy_plugins" ]; then
    as_root cp -a "$legacy_plugins" "$BACKUP/plugins"
    as_root chown -R "$INVOKING_USER" "$BACKUP/plugins"
    cp -a "$BACKUP/plugins/." "$SHARED_DIR/plugins/"
  fi
else
  ROLLBACK_MODE=user
  RUNTIME_WAS_ACTIVE=0
  if systemctl --user is-active --quiet agrider-runtime.service >/dev/null 2>&1; then
    RUNTIME_WAS_ACTIVE=1
  fi
  systemctl --user stop agrider.service >/dev/null 2>&1 || true
  [ -d "$SHARED_DIR/data" ] && cp -a "$SHARED_DIR/data" "$BACKUP/data"
  [ -d "$SHARED_DIR/plugins" ] && cp -a "$SHARED_DIR/plugins" "$BACKUP/plugins"
  [ -f "$CONFIG_FILE" ] && cp -a "$CONFIG_FILE" "$BACKUP/env"
fi

rm -f "$DATA_ROOT/.current-install"
ln -s "$DESTINATION" "$DATA_ROOT/.current-install"
mv -Tf "$DATA_ROOT/.current-install" "$CURRENT_LINK"
rm -f "$DATA_ROOT/pending"
ln -sfn "$CURRENT_LINK/agrider" "$CLI_PATH"

systemctl --user daemon-reload || { [ "$LEGACY" -eq 1 ] && rollback_legacy || rollback_user_service; fail 'could not reload the user service'; }
STARTED_RUNTIME_SERVICES=0
if [ "${RUNTIME_WAS_ACTIVE:-0}" -eq 0 ]; then STARTED_RUNTIME_SERVICES=1; fi
systemctl --user enable --now agrider-tmux.service agrider-runtime.service agrider.service \
  || { [ "$LEGACY" -eq 1 ] && rollback_legacy || rollback_user_service; fail 'could not start the user services'; }

PORT=$(read_env AGENT_RIDER_PORT "$CONFIG_FILE" || printf 5173)
RUNTIME_PORT=$(read_env AGENT_RIDER_RUNTIME_PORT "$CONFIG_FILE" || printf 5174)
RUNTIME_HEALTH_URL=${AGRIDER_RUNTIME_HEALTH_URL:-http://127.0.0.1:$RUNTIME_PORT/healthz}
HEALTH_URL=${AGRIDER_HEALTH_URL:-http://127.0.0.1:$PORT/store/state}
ATTEMPTS=${AGRIDER_HEALTH_ATTEMPTS:-30}
healthy=0
attempt=0
while [ "$attempt" -lt "$ATTEMPTS" ]; do
  runtime_status=$(curl -sS -o /dev/null -w '%{http_code}' "$RUNTIME_HEALTH_URL" 2>/dev/null || true)
  status=$(curl -sS -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)
  if [ "$runtime_status" = 200 ] && { [ "$status" = 200 ] || [ "$status" = 401 ]; }; then
    healthy=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  if [ "$LEGACY" -eq 1 ]; then rollback_legacy; else rollback_user_service; fi
  fail "health check failed at $HEALTH_URL; the previous installation was restored"
fi
ROLLBACK_MODE=''

printf '\nAgent Rider %s is installed and running at http://127.0.0.1:%s\n' "$VERSION" "$PORT"
case ":$PATH:" in
  *":$BIN_DIR:"*) printf 'Upgrade later with: %s\n' "$UPGRADE_COMMAND" ;;
  *)
    printf '%s\n' "Installation succeeded, but $BIN_DIR is not currently on PATH."
    printf 'Open a new login shell before running: %s\n' "$UPGRADE_COMMAND"
    ;;
esac
