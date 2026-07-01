#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/deploy-scp.sh user@server [/opt/agent-rider]

Environment:
  ARCHIVE=/path/to/release.tar.gz  Use an existing archive instead of building.
  APP_DIR=/opt/agent-rider         Remote install root.
  SSH_OPTS='-p 2222'               Extra ssh/scp options.
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" || $# -lt 1 ]]; then
  usage
  exit $([[ $# -lt 1 ]] && echo 1 || echo 0)
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
target=$1
remote_app_dir=${2:-${APP_DIR:-/opt/agent-rider}}

quote_remote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

read -r -a ssh_opts <<< "${SSH_OPTS:-}"

if [[ -n ${ARCHIVE:-} ]]; then
  archive=$ARCHIVE
else
  "$SCRIPT_DIR/release.sh"
  archive=$(find "$ROOT_DIR/releases" -maxdepth 1 -type f -name 'agent-rider-*.tar.gz' -printf '%T@ %p\n' \
    | sort -nr \
    | awk 'NR == 1 {print $2}')
fi

if [[ -z ${archive:-} || ! -f "$archive" ]]; then
  echo "Release archive not found." >&2
  exit 1
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
remote_tmp="/tmp/agent-rider-deploy-$stamp"
remote_archive="$remote_tmp/$(basename "$archive")"
quoted_tmp=$(quote_remote "$remote_tmp")
quoted_app_dir=$(quote_remote "$remote_app_dir")
quoted_archive=$(quote_remote "$remote_archive")

ssh "${ssh_opts[@]}" "$target" "mkdir -p $quoted_tmp"
scp "${ssh_opts[@]}" \
  "$archive" \
  "$SCRIPT_DIR/install-remote.sh" \
  "$SCRIPT_DIR/update-remote.sh" \
  "$SCRIPT_DIR/pull-update.sh" \
  "$target:$remote_tmp/"

if ssh "${ssh_opts[@]}" "$target" "test -e $quoted_app_dir/current"; then
  remote_script=update-remote.sh
else
  remote_script=install-remote.sh
fi

quoted_script=$(quote_remote "$remote_tmp/$remote_script")
ssh "${ssh_opts[@]}" "$target" "\
  if command -v sudo >/dev/null 2>&1; then \
    sudo APP_DIR=$quoted_app_dir bash $quoted_script $quoted_archive; \
  else \
    APP_DIR=$quoted_app_dir bash $quoted_script $quoted_archive; \
  fi"

echo "Deployment finished."
echo "Remote app dir: $remote_app_dir"
