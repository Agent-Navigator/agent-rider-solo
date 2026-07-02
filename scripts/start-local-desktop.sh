#!/usr/bin/env bash
set -Eeuo pipefail

DISPLAY_NUMBER=${LOCAL_DESKTOP_DISPLAY:-100}
DESKTOP_PORT=${LOCAL_DESKTOP_PORT:-14500}
DESKTOP_BIND=${LOCAL_DESKTOP_BIND:-127.0.0.1}

# Defensive: reap any session loop left over from a previous xpra instance so
# it cannot fight the new session's window manager (see the session script).
pkill -f 'start-gnome-flashback-session.sh --inside-dbus' 2>/dev/null || true

exec xpra start-desktop ":${DISPLAY_NUMBER}" \
  --html=on \
  --bind-tcp="${DESKTOP_BIND}:${DESKTOP_PORT}" \
  --start-child="$(dirname "$0")/start-gnome-flashback-session.sh" \
  --daemon=yes \
  --exit-with-children=no
