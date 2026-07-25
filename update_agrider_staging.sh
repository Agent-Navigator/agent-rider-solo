#!/bin/sh
set -eu

HOME_DIR=${HOME:?HOME is not set}
TOKEN_FILE=${AGRIDER_STAGING_GITHUB_TOKEN_FILE:-${XDG_CONFIG_HOME:-$HOME_DIR/.config}/agrider/staging-github-token}
[ -r "$TOKEN_FILE" ] || {
  printf 'Agent Rider staging update failed: token file is not readable: %s\n' "$TOKEN_FILE" >&2
  exit 1
}
IFS= read -r AGRIDER_STAGING_GITHUB_TOKEN < "$TOKEN_FILE" || true
[ -n "$AGRIDER_STAGING_GITHUB_TOKEN" ] || {
  printf 'Agent Rider staging update failed: token file is empty: %s\n' "$TOKEN_FILE" >&2
  exit 1
}
export AGRIDER_STAGING_GITHUB_TOKEN

umask 077
bootstrap=$(mktemp "${TMPDIR:-/tmp}/agrider-staging-bootstrap.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -f "$bootstrap"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

curl -fsSL -H "Authorization: Bearer $AGRIDER_STAGING_GITHUB_TOKEN" \
  https://raw.githubusercontent.com/Agent-Navigator/agent-rider-solo-dev/staging/install-staging.sh \
  -o "$bootstrap"
sh "$bootstrap"
unset AGRIDER_STAGING_GITHUB_TOKEN

export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}

if systemctl --user is-active --quiet agrider-runtime.service; then
  systemctl --user status \
    agrider.service agrider-runtime.service agrider-tmux.service --no-pager
else
  systemctl --user status agrider.service --no-pager
  printf '%s\n' \
    'The verified release is pending because active legacy sessions were preserved.' \
    'Run this updater again after those sessions finish to activate the split runtime.'
fi
