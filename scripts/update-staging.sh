#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage: update-staging.sh [--check] [STAGING_ROOT]

Verify and install an Agent Rider artifact-only staging candidate. STAGING_ROOT
defaults to the parent of this script's directory. --check validates the
candidate and platform bundle without changing the installation or service.

Environment overrides:
  AGRIDER_DATA_ROOT     Default: ~/.local/share/agrider
  AGRIDER_CONFIG_FILE   Default: ~/.config/agrider/env
  AGRIDER_BIN_DIR       Default: ~/.local/bin
  AGRIDER_HEALTH_URL    Default: derived from AGENT_RIDER_PORT, else port 5173
  AGRIDER_WORKSPACE_URL Default: derived local Agent Rider URL
USAGE
}

mode=update
if [[ ${1:-} == -h || ${1:-} == --help ]]; then usage; exit 0; fi
if [[ ${1:-} == --check ]]; then mode=check; shift; fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
STAGING_ROOT=${1:-$(dirname "$SCRIPT_DIR")}
[[ $# -le 1 ]] || { usage >&2; exit 2; }

fail() {
  echo "Agent Rider staging update failed: $*" >&2
  exit 1
}

for command_name in awk python3 sha256sum tar; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command not found: $command_name"
done

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) platform=linux-x86_64 ;;
  Linux:aarch64|Linux:arm64) platform=linux-aarch64 ;;
  *) fail "unsupported platform: $(uname -s):$(uname -m)" ;;
esac

candidate=$STAGING_ROOT/candidate.json
[[ -f $candidate ]] || fail "candidate.json not found in $STAGING_ROOT"
mapfile -t fields < <(python3 - "$candidate" "$platform" <<'PY'
import json, sys

candidate = json.load(open(sys.argv[1], encoding='utf-8'))
platform = sys.argv[2]
assets = [asset for asset in candidate.get('assets', []) if asset.get('platform') == platform]
if candidate.get('schema') != 1 or len(assets) != 1:
    raise SystemExit(1)
asset = assets[0]
for value in (candidate.get('version'), candidate.get('source_commit'), asset.get('archive'), asset.get('sha256')):
    if not isinstance(value, str) or '\n' in value or '\r' in value:
        raise SystemExit(1)
    print(value)
PY
) || fail 'candidate.json is invalid or has no unique bundle for this platform'
[[ ${#fields[@]} -eq 4 ]] || fail 'candidate.json is missing required fields'
version=${fields[0]}
commit=${fields[1]}
archive_name=${fields[2]}
expected_sha=${fields[3],,}

[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] || fail "invalid candidate version: $version"
[[ $commit =~ ^[0-9a-fA-F]{40}$ ]] || fail 'candidate source_commit must be a full Git commit'
[[ $archive_name == bundles/agrider-$platform.tar.gz ]] || fail "unexpected archive path: $archive_name"
[[ $expected_sha =~ ^[0-9a-f]{64}$ ]] || fail 'candidate SHA-256 is invalid'

archive=$STAGING_ROOT/$archive_name
[[ -f $archive ]] || fail "candidate bundle not found: $archive_name"
actual_sha=$(sha256sum "$archive" | awk '{print tolower($1)}')
[[ $actual_sha == "$expected_sha" ]] || fail "checksum mismatch for $archive_name"

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/agrider-staging-update.XXXXXX")
release_dir=$work_dir/release
cleanup_only() { rm -rf "$work_dir"; }
trap cleanup_only EXIT HUP INT TERM

python3 - "$archive" <<'PY' || fail 'bundle contains an unsafe or unsupported archive entry'
import pathlib, sys, tarfile

with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk():
            raise SystemExit(1)
PY
mkdir -p "$release_dir"
tar -xzf "$archive" -C "$release_dir"
[[ -x $release_dir/agrider ]] || fail 'bundle is missing executable agrider'
[[ -f $release_dir/frontend/index.html ]] || fail 'bundle is missing frontend/index.html'
[[ -f $release_dir/release.json ]] || fail 'bundle is missing release.json'

python3 - "$release_dir/release.json" "$version" "$commit" "$platform" <<'PY' \
  || fail 'release metadata does not match candidate.json'
import json, sys

metadata = json.load(open(sys.argv[1], encoding='utf-8'))
expected = {'version': sys.argv[2], 'source_commit': sys.argv[3], 'platform': sys.argv[4]}
if any(metadata.get(key) != value for key, value in expected.items()):
    raise SystemExit(1)
PY
expected_version="agrider $version ($commit)"
[[ $($release_dir/agrider --version) == "$expected_version" ]] \
  || fail 'candidate executable version does not match its metadata'

echo "Verified Agent Rider staging candidate $version (${commit:0:7}) for $platform."
[[ $mode == check ]] && exit 0

for command_name in curl flock systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command not found: $command_name"
done

HOME_DIR=${HOME:?HOME is not set}
DATA_ROOT=${AGRIDER_DATA_ROOT:-${XDG_DATA_HOME:-$HOME_DIR/.local/share}/agrider}
CONFIG_FILE=${AGRIDER_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME_DIR/.config}/agrider/env}
BIN_DIR=${AGRIDER_BIN_DIR:-$HOME_DIR/.local/bin}
RELEASES_DIR=$DATA_ROOT/releases
CURRENT_LINK=$DATA_ROOT/current
SHARED_DIR=$DATA_ROOT/shared
[[ -L $CURRENT_LINK ]] || fail "rootless Agent Rider current link not found: $CURRENT_LINK"

mkdir -p "$DATA_ROOT"
exec 9>"$DATA_ROOT/upgrade.lock"
flock -n 9 || fail 'another Agent Rider update is already running'

runtime_service_file=${AGRIDER_RUNTIME_SERVICE_FILE:-${XDG_CONFIG_HOME:-$HOME_DIR/.config}/systemd/user/agrider-runtime.service}
if [[ ! -f $runtime_service_file ]]; then
  [[ -f $STAGING_ROOT/install.sh ]] \
    || fail 'single-service migration requires install.sh from the staging snapshot'
  bootstrap=$work_dir/bootstrap
  mkdir -p "$bootstrap"
  cp "$archive" "$bootstrap/agrider-$platform.tar.gz"
  printf '%s  %s\n' "$expected_sha" "agrider-$platform.tar.gz" > "$bootstrap/checksums.txt"
  echo 'Single-service installation detected; starting the session-preserving runtime migration.'
  AGRIDER_RELEASE_BASE=file://$bootstrap \
  AGRIDER_RELEASE_ID=$version-${commit:0:12}-staging \
  AGRIDER_UPGRADE_COMMAND='rerun update_agrider_staging.sh for the latest staging candidate' \
    sh "$STAGING_ROOT/install.sh"
  exit 0
fi

current_metadata=$CURRENT_LINK/release.json
if [[ -f $current_metadata ]] && python3 - "$current_metadata" "$commit" <<'PY'
import json, sys
try:
    current = json.load(open(sys.argv[1], encoding='utf-8'))
except (OSError, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if current.get('source_commit') == sys.argv[2] else 1)
PY
then
  echo "Agent Rider staging ${commit:0:7} is already installed."
  exit 0
fi

short_commit=${commit:0:12}
destination=$RELEASES_DIR/$version-$short_commit-staging
mkdir -p "$RELEASES_DIR" "$SHARED_DIR/backups" "$BIN_DIR"
if [[ -e $destination ]]; then
  python3 - "$destination/release.json" "$commit" <<'PY' \
    || fail "existing staging release directory has different metadata: $destination"
import json, sys
metadata = json.load(open(sys.argv[1], encoding='utf-8'))
raise SystemExit(0 if metadata.get('source_commit') == sys.argv[2] else 1)
PY
else
  mv "$release_dir" "$destination"
fi

service_has_embedded_sessions() {
  [[ ${AGRIDER_ASSUME_ACTIVE_SESSIONS:-0} == 1 ]] && return 0
  systemctl --user is-active --quiet agrider.service >/dev/null 2>&1 || return 1
  if systemctl --user is-active --quiet agrider-runtime.service >/dev/null 2>&1; then
    return 1
  fi

  local main_pid control_group cgroup_procs process_id
  main_pid=$(systemctl --user show -p MainPID --value agrider.service 2>/dev/null || true)
  control_group=$(systemctl --user show -p ControlGroup --value agrider.service 2>/dev/null || true)
  if [[ $main_pid =~ ^[1-9][0-9]*$ && $control_group =~ ^/[A-Za-z0-9_./@-]+$ ]]; then
    cgroup_procs=/sys/fs/cgroup$control_group/cgroup.procs
    if [[ -r $cgroup_procs ]]; then
      while IFS= read -r process_id; do
        [[ -z $process_id || $process_id == "$main_pid" ]] || return 0
      done < "$cgroup_procs"
    fi
  fi

  command -v tmux >/dev/null 2>&1 \
    && tmux -L agent-rider list-sessions >/dev/null 2>&1
}

if ! systemctl --user is-active --quiet agrider-runtime.service >/dev/null 2>&1 \
  && service_has_embedded_sessions
then
  pending_link=$DATA_ROOT/.pending-staging-$$
  rm -f "$pending_link"
  ln -s "$destination" "$pending_link"
  mv -Tf "$pending_link" "$DATA_ROOT/pending"
  echo "Staged Agent Rider $version ($short_commit) without interrupting active sessions."
  echo "Pending release: $destination"
  echo 'Run the staging updater again after the current sessions finish to activate it.'
  exit 0
fi

previous=$(readlink "$CURRENT_LINK")
service_stopped=0
switched=0
upgrade_preparing_marker=$SHARED_DIR/data/.upgrade-preparing
upgrade_ready_marker=$SHARED_DIR/data/.upgrade-ready
finish() {
  status=$?
  trap - EXIT HUP INT TERM
  if (( status != 0 )); then
    if (( switched )); then
      rollback_link=$DATA_ROOT/.current-rollback-$$
      rm -f "$rollback_link"
      ln -s "$previous" "$rollback_link"
      mv -Tf "$rollback_link" "$CURRENT_LINK"
    fi
    if (( service_stopped )); then
      systemctl --user restart agrider.service >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$upgrade_preparing_marker" "$upgrade_ready_marker"
  rm -rf "$work_dir"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

workspace_base_url=${AGRIDER_WORKSPACE_URL:-}
if [[ -z $workspace_base_url ]]; then
  port=$(awk -F= '$1 == "AGENT_RIDER_PORT" { value=$2; gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", value); print value }' "$CONFIG_FILE" 2>/dev/null | tail -n1)
  workspace_base_url=http://127.0.0.1:${port:-5173}
fi
workspace_base_url=${workspace_base_url%/}

prepare_workspace_upgrade() {
  local capabilities_file=$work_dir/workspace-upgrade-capabilities.json
  local status active
  status=$(curl -sS --max-time 2 -o "$capabilities_file" -w '%{http_code}' \
    "$workspace_base_url/store/workspace/upgrade-capabilities" 2>/dev/null || true)
  [[ $status == 200 ]] || return 0
  active=$(python3 - "$capabilities_file" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1], encoding='utf-8'))
except (OSError, ValueError):
    raise SystemExit(1)
print('yes' if value.get('prepareHandshake') is True and value.get('workspaceClientActive') is True else 'no')
PY
  ) || return 0
  [[ $active == yes ]] || return 0

  mkdir -p "$SHARED_DIR/data"
  rm -f "$upgrade_ready_marker"
  : > "$upgrade_preparing_marker"
  echo 'Waiting for the open Agent Rider workspace to save its window list and Desktop locations.'
  for _ in $(seq 1 "${AGRIDER_UPGRADE_PREPARE_ATTEMPTS:-30}"); do
    if [[ -f $upgrade_ready_marker ]]; then
      echo 'Open workspace acknowledged a durable SQLite checkpoint.'
      return 0
    fi
    sleep "${AGRIDER_UPGRADE_PREPARE_DELAY_SECONDS:-0.5}"
  done
  rm -f "$upgrade_preparing_marker" "$upgrade_ready_marker"
  fail 'open workspace did not acknowledge a durable checkpoint; the service was not stopped'
}

if systemctl --user is-active --quiet agrider.service; then
  prepare_workspace_upgrade
  systemctl --user stop agrider.service
  service_stopped=1
fi
rm -f "$upgrade_preparing_marker" "$upgrade_ready_marker"

backup=$SHARED_DIR/backups/staging-$(date -u +%Y%m%dT%H%M%SZ)-$short_commit
mkdir -p "$backup"
[[ ! -d $SHARED_DIR/data ]] || cp -a "$SHARED_DIR/data" "$backup/data"
[[ ! -d $SHARED_DIR/plugins ]] || cp -a "$SHARED_DIR/plugins" "$backup/plugins"
[[ ! -f $CONFIG_FILE ]] || cp -a "$CONFIG_FILE" "$backup/env"

next_link=$DATA_ROOT/.current-staging-$$
rm -f "$next_link"
ln -s "$destination" "$next_link"
mv -Tf "$next_link" "$CURRENT_LINK"
switched=1
rm -f "$DATA_ROOT/pending"
ln -sfn "$CURRENT_LINK/agrider" "$BIN_DIR/agrider"
systemctl --user restart agrider.service

health_url=${AGRIDER_HEALTH_URL:-}
if [[ -z $health_url ]]; then
  port=$(awk -F= '$1 == "AGENT_RIDER_PORT" { value=$2; gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", value); print value }' "$CONFIG_FILE" 2>/dev/null | tail -n1)
  health_url=http://127.0.0.1:${port:-5173}/store/state
fi
healthy=0
for _ in $(seq 1 "${AGRIDER_HEALTH_ATTEMPTS:-30}"); do
  status=$(curl -sS -o /dev/null -w '%{http_code}' "$health_url" 2>/dev/null || true)
  if [[ $status == 200 || $status == 401 ]]; then healthy=1; break; fi
  sleep "${AGRIDER_HEALTH_DELAY_SECONDS:-1}"
done
(( healthy )) || fail "health check failed at $health_url; the previous release will be restored"

service_stopped=0
switched=0
echo "Updated Agent Rider to staging $version ($short_commit)."
echo "State backup: $backup"
