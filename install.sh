#!/bin/sh
set -eu

REPOSITORY=${AGRIDER_REPOSITORY:-ytk77/agent-rider}
RELEASE_BASE=${AGRIDER_RELEASE_BASE:-https://github.com/$REPOSITORY/releases/latest/download}
RELEASE_BASE=${RELEASE_BASE%/}

fail() {
  printf 'Agent Rider install failed: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
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

for command_name in curl tar gzip sha256sum awk sed systemctl; do
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
  LEGACY=1
  LEGACY_USER=$(unit_user)
  [ -n "$LEGACY_USER" ] || fail 'legacy /opt installation found but its service User= could not be determined'
  [ "$LEGACY_USER" = "$INVOKING_USER" ] || fail "legacy services run as '$LEGACY_USER'; rerun the installer while logged in as that user"
fi

need sudo
printf 'Enabling the Agent Rider user service at boot...\n'
sudo loginctl enable-linger "$INVOKING_USER" \
  || fail "could not enable lingering; run: sudo loginctl enable-linger $INVOKING_USER"

mkdir -p "$RELEASES_DIR" "$SHARED_DIR/data" "$SHARED_DIR/plugins" \
  "$SHARED_DIR/backups" "$(dirname "$CONFIG_FILE")" "$SERVICE_DIR" "$BIN_DIR"
DESTINATION=$RELEASES_DIR/$VERSION
if [ ! -d "$DESTINATION" ]; then
  mv "$WORK_DIR/release" "$DESTINATION"
fi

env_quote() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_config() {
  config_port=${AGENT_RIDER_PORT:-5173}
  config_browse=${BROWSE_ROOT:-$HOME_DIR}
  config_hermes=${HERMES_TARGET:-hermes}
  config_hosts=${VITE_ALLOWED_HOSTS:-all}
  if [ "$LEGACY" -eq 1 ]; then
    config_port=${AGENT_RIDER_PORT:-$(read_env WEB_PORT "$LEGACY_ENV" || printf 5173)}
    config_browse=${BROWSE_ROOT:-$(read_env BROWSE_ROOT "$LEGACY_ENV" || printf %s "$HOME_DIR")}
    config_hermes=${HERMES_TARGET:-$(read_env HERMES_TARGET "$LEGACY_ENV" || printf hermes)}
    config_hosts=${VITE_ALLOWED_HOSTS:-$(read_env VITE_ALLOWED_HOSTS "$LEGACY_ENV" || printf all)}
  fi
  {
    printf 'APP_DIR="%s"\n' "$(env_quote "$DATA_ROOT")"
    printf 'AGENT_RIDER_DATA_DIR="%s"\n' "$(env_quote "$SHARED_DIR/data")"
    printf 'AGENT_RIDER_APPS_DIR="%s"\n' "$(env_quote "$SHARED_DIR/plugins")"
    printf 'AGENT_RIDER_WEB_ROOT="%s"\n' "$(env_quote "$CURRENT_LINK/frontend")"
    printf 'AGENT_RIDER_HOST="127.0.0.1"\n'
    printf 'AGENT_RIDER_PORT="%s"\n' "$(env_quote "$config_port")"
    printf 'BROWSE_ROOT="%s"\n' "$(env_quote "$config_browse")"
    printf 'HERMES_TARGET="%s"\n' "$(env_quote "$config_hermes")"
    printf 'VITE_ALLOWED_HOSTS="%s"\n' "$(env_quote "$config_hosts")"
  } > "$CONFIG_FILE"
}

if [ ! -f "$CONFIG_FILE" ]; then
  write_config
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
}

rollback_legacy() {
  systemctl --user disable --now agrider.service >/dev/null 2>&1 || true
  sudo systemctl enable agent-rider-store.service agent-rider-web.service >/dev/null 2>&1 || true
  sudo systemctl start agent-rider-store.service agent-rider-web.service >/dev/null 2>&1 || true
}

if [ "$LEGACY" -eq 1 ]; then
  printf 'Migrating the existing /opt/agent-rider installation...\n'
  mkdir -p "$BACKUP/legacy"
  [ -L "$LEGACY_ROOT/current" ] && readlink "$LEGACY_ROOT/current" > "$BACKUP/legacy/current-link"
  [ -r "$LEGACY_ENV" ] && sudo cp -a "$LEGACY_ENV" "$BACKUP/legacy/environment"
  for old_unit in agent-rider-store.service agent-rider-web.service; do
    [ -r "/etc/systemd/system/$old_unit" ] && sudo cp -a "/etc/systemd/system/$old_unit" "$BACKUP/legacy/$old_unit"
  done
  ROLLBACK_MODE=legacy
  sudo systemctl stop agent-rider-web.service agent-rider-store.service \
    || fail 'could not stop the legacy services'
  sudo systemctl disable agent-rider-web.service agent-rider-store.service \
    || { rollback_legacy; fail 'could not disable the legacy services'; }
  legacy_data=$LEGACY_ROOT/shared/data
  [ -d "$legacy_data" ] || legacy_data=$LEGACY_ROOT/current/data
  legacy_plugins=$LEGACY_ROOT/shared/plugins
  if [ -d "$legacy_data" ]; then
    sudo cp -a "$legacy_data" "$BACKUP/data"
    sudo chown -R "$INVOKING_USER" "$BACKUP/data"
    cp -a "$BACKUP/data/." "$SHARED_DIR/data/"
  fi
  if [ -d "$legacy_plugins" ]; then
    sudo cp -a "$legacy_plugins" "$BACKUP/plugins"
    sudo chown -R "$INVOKING_USER" "$BACKUP/plugins"
    cp -a "$BACKUP/plugins/." "$SHARED_DIR/plugins/"
  fi
else
  ROLLBACK_MODE=user
  systemctl --user stop agrider.service >/dev/null 2>&1 || true
  [ -d "$SHARED_DIR/data" ] && cp -a "$SHARED_DIR/data" "$BACKUP/data"
  [ -d "$SHARED_DIR/plugins" ] && cp -a "$SHARED_DIR/plugins" "$BACKUP/plugins"
  [ -f "$CONFIG_FILE" ] && cp -a "$CONFIG_FILE" "$BACKUP/env"
fi

rm -f "$DATA_ROOT/.current-install"
ln -s "$DESTINATION" "$DATA_ROOT/.current-install"
mv -Tf "$DATA_ROOT/.current-install" "$CURRENT_LINK"
ln -sfn "$CURRENT_LINK/agrider" "$CLI_PATH"

systemctl --user daemon-reload || { [ "$LEGACY" -eq 1 ] && rollback_legacy || rollback_user_service; fail 'could not reload the user service'; }
systemctl --user enable --now agrider.service || { [ "$LEGACY" -eq 1 ] && rollback_legacy || rollback_user_service; fail 'could not start the user service'; }

PORT=$(read_env AGENT_RIDER_PORT "$CONFIG_FILE" || printf 5173)
HEALTH_URL=${AGRIDER_HEALTH_URL:-http://127.0.0.1:$PORT/store/state}
ATTEMPTS=${AGRIDER_HEALTH_ATTEMPTS:-30}
healthy=0
attempt=0
while [ "$attempt" -lt "$ATTEMPTS" ]; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)
  if [ "$status" = 200 ] || [ "$status" = 401 ]; then
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
  *":$BIN_DIR:"*) printf 'Upgrade later with: agrider upgrade\n' ;;
  *)
    printf '%s\n' "Installation succeeded, but $BIN_DIR is not currently on PATH."
    printf '%s\n' 'Open a new login shell before running: agrider upgrade'
    ;;
esac
