#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  SOURCE_GIT=root@YOUR-SOURCE-TAILNET-HOST:/srv/git/agent-rider.git bash scripts/pull-update.sh
  SOURCE_GIT=root@YOUR-SOURCE-TAILNET-HOST:/srv/git/agent-rider.git SOURCE_REF=master APP_DIR=/opt/agent-rider bash scripts/pull-update.sh

Environment:
  SOURCE_GIT          SSH git remote for Agent Rider. Required, or pass as arg 1.
  SOURCE_REF          Branch, tag, or commit to deploy. Default: master.
  APP_DIR             Remote install root. Default: /opt/agent-rider
  GIT_CACHE           Local mirror cache. Default: ~/.cache/agent-rider/source.git
  WORK_DIR            Temporary update directory. Default: /tmp/agent-rider-git-update
  SSH_OPTS            Extra ssh options, for example: -p 2222
  GIT_SSH_COMMAND     Full git SSH command. Overrides SSH_OPTS when set.
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

SOURCE_GIT=${SOURCE_GIT:-${1:-}}
SOURCE_REF=${SOURCE_REF:-master}
APP_NAME=${APP_NAME:-agent-rider}
APP_DIR=${APP_DIR:-/opt/agent-rider}
WORK_DIR=${WORK_DIR:-/tmp/agent-rider-git-update}

cache_root=${XDG_CACHE_HOME:-${HOME:+$HOME/.cache}}
GIT_CACHE=${GIT_CACHE:-${cache_root:-/tmp}/agent-rider/source.git}

if [[ -z "$SOURCE_GIT" ]]; then
  usage >&2
  exit 1
fi

if [[ -n ${SSH_OPTS:-} && -z ${GIT_SSH_COMMAND:-} ]]; then
  export GIT_SSH_COMMAND="ssh $SSH_OPTS"
fi

install_pull_tools() {
  missing=()
  for cmd in git tar gzip; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  (( ${#missing[@]} == 0 )) && return 0

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Missing required commands: ${missing[*]}" >&2
    echo "Install them with your OS package manager, then run this script again." >&2
    exit 1
  fi

  if [[ $EUID -eq 0 ]]; then
    apt-get update
    apt-get install -y git tar gzip
  elif command -v sudo >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y git tar gzip
  else
    echo "Missing required commands: ${missing[*]} and sudo is unavailable." >&2
    exit 1
  fi
}

resolve_commit() {
  local ref=$1
  local candidate
  for candidate in "$ref" "refs/heads/$ref" "refs/tags/$ref"; do
    if git -C "$GIT_CACHE" rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then
      git -C "$GIT_CACHE" rev-parse "$candidate^{commit}"
      return 0
    fi
  done
  return 1
}

run_installer() {
  local installer=$1
  local archive=$2
  local installer_env=(
    APP_DIR="$APP_DIR"
    AGENT_RIDER_DEPLOY_COMMIT="$commit"
    AGENT_RIDER_DEPLOY_SHORT_SHA="$short_sha"
    AGENT_RIDER_SOURCE_GIT="$SOURCE_GIT"
    AGENT_RIDER_SOURCE_REF="$SOURCE_REF"
  )

  for name in APP_USER APP_GROUP WEB_PORT STORE_PORT BROWSE_ROOT AGENT_RIDER_APPS_DIR HERMES_TARGET VITE_ALLOWED_HOSTS ENV_FILE; do
    if [[ -n ${!name+x} ]]; then
      installer_env+=("$name=${!name}")
    fi
  done

  if [[ $EUID -eq 0 ]]; then
    env "${installer_env[@]}" bash "$installer" "$archive"
  elif command -v sudo >/dev/null 2>&1; then
    sudo env "${installer_env[@]}" bash "$installer" "$archive"
  else
    env "${installer_env[@]}" bash "$installer" "$archive"
  fi
}

install_pull_tools

mkdir -p "$(dirname "$GIT_CACHE")"
if [[ -d "$GIT_CACHE/objects" ]]; then
  echo "Fetching $SOURCE_GIT into $GIT_CACHE..."
  git -C "$GIT_CACHE" remote set-url origin "$SOURCE_GIT"
  git -C "$GIT_CACHE" fetch --prune origin '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
else
  rm -rf "$GIT_CACHE"
  echo "Cloning mirror $SOURCE_GIT into $GIT_CACHE..."
  git clone --mirror "$SOURCE_GIT" "$GIT_CACHE"
fi

commit=$(resolve_commit "$SOURCE_REF" || true)
if [[ -z "$commit" ]]; then
  echo "Could not resolve SOURCE_REF '$SOURCE_REF' from $SOURCE_GIT." >&2
  exit 1
fi
short_sha=$(git -C "$GIT_CACHE" rev-parse --short "$commit")
stamp=$(date -u +%Y%m%dT%H%M%SZ)

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
archive="$WORK_DIR/${APP_NAME}-${stamp}-${short_sha}.tar.gz"

echo "Resolved SOURCE_REF '$SOURCE_REF' to $commit."
echo "Creating release archive from $short_sha..."
git -C "$GIT_CACHE" archive --format=tar "$commit" | gzip -9 > "$archive"
tar -xzf "$archive" -C "$WORK_DIR" scripts/install-remote.sh scripts/update-remote.sh
chmod +x "$WORK_DIR/scripts/install-remote.sh" "$WORK_DIR/scripts/update-remote.sh"

if [[ -e "$APP_DIR/current" ]]; then
  installer="$WORK_DIR/scripts/update-remote.sh"
else
  installer="$WORK_DIR/scripts/install-remote.sh"
fi

echo "Applying $short_sha with $installer..."
run_installer "$installer" "$archive"

echo "Agent Rider git update complete: $short_sha"
