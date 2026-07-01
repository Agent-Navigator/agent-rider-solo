#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  SOURCE_SSH=root@source-machine bash scripts/pull-update.sh
  SOURCE_SSH=root@source-machine SOURCE_DIR=/root/agent-work/DEV/agent-rider APP_DIR=/opt/agent-rider bash scripts/pull-update.sh

Environment:
  SOURCE_SSH          SSH target for the machine that has the Agent Rider repo. Required.
  SOURCE_DIR          Agent Rider repo path on SOURCE_SSH. Default: /root/agent-work/DEV/agent-rider
  APP_DIR             Remote install root. Default: /opt/agent-rider
  WORK_DIR            Temporary pull directory. Default: /tmp/agent-rider-pull
  SSH_OPTS            Extra ssh/scp options, for example: -p 2222
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

SOURCE_SSH=${SOURCE_SSH:-${1:-}}
SOURCE_DIR=${SOURCE_DIR:-/root/agent-work/DEV/agent-rider}
APP_DIR=${APP_DIR:-/opt/agent-rider}
WORK_DIR=${WORK_DIR:-/tmp/agent-rider-pull}

if [[ -z "$SOURCE_SSH" ]]; then
  usage >&2
  exit 1
fi

quote_remote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

read -r -a ssh_opts <<< "${SSH_OPTS:-}"
quoted_source_dir=$(quote_remote "$SOURCE_DIR")

echo "Building latest Agent Rider release on $SOURCE_SSH..."
ssh "${ssh_opts[@]}" "$SOURCE_SSH" "cd $quoted_source_dir && scripts/release.sh"

release=$(
  ssh "${ssh_opts[@]}" "$SOURCE_SSH" "cd $quoted_source_dir && ls -t releases/agent-rider-*.tar.gz | head -1"
)

if [[ -z "$release" ]]; then
  echo "No release archive found on source machine." >&2
  exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

echo "Pulling release and installer scripts into $WORK_DIR..."
scp "${ssh_opts[@]}" "$SOURCE_SSH:$SOURCE_DIR/$release" "$WORK_DIR/"
scp "${ssh_opts[@]}" \
  "$SOURCE_SSH:$SOURCE_DIR/scripts/install-remote.sh" \
  "$SOURCE_SSH:$SOURCE_DIR/scripts/update-remote.sh" \
  "$WORK_DIR/"

archive="$WORK_DIR/$(basename "$release")"
if [[ -e "$APP_DIR/current" ]]; then
  installer="$WORK_DIR/update-remote.sh"
else
  installer="$WORK_DIR/install-remote.sh"
fi

echo "Applying release with $installer..."
if [[ $EUID -eq 0 ]]; then
  APP_DIR="$APP_DIR" bash "$installer" "$archive"
elif command -v sudo >/dev/null 2>&1; then
  sudo APP_DIR="$APP_DIR" bash "$installer" "$archive"
else
  APP_DIR="$APP_DIR" bash "$installer" "$archive"
fi

echo "Agent Rider update complete."
