#!/usr/bin/env bash
set -Eeuo pipefail

DISPLAY_NUMBER=${LOCAL_DESKTOP_DISPLAY:-100}
DESKTOP_PORT=${LOCAL_DESKTOP_PORT:-14500}
DESKTOP_BIND=${LOCAL_DESKTOP_BIND:-127.0.0.1}

exec xpra start-desktop ":${DISPLAY_NUMBER}" \
  --html=on \
  --bind-tcp="${DESKTOP_BIND}:${DESKTOP_PORT}" \
  --start-child="$(dirname "$0")/start-gnome-flashback-session.sh" \
  --daemon=yes \
  --exit-with-children=no
