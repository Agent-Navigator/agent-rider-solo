#!/usr/bin/env bash
set -Eeuo pipefail

DISPLAY_NUMBER=${LOCAL_DESKTOP_DISPLAY:-100}
DESKTOP_PORT=${LOCAL_DESKTOP_PORT:-14500}
DESKTOP_BIND=${LOCAL_DESKTOP_BIND:-127.0.0.1}

SESSION_COMMAND=(
  env
  XDG_CURRENT_DESKTOP=GNOME-Flashback:GNOME
  DESKTOP_SESSION=gnome-flashback-metacity
  dbus-run-session
  --
  gnome-session
  --session=gnome-flashback-metacity
)

exec xpra start-desktop ":${DISPLAY_NUMBER}" \
  --html=on \
  --bind-tcp="${DESKTOP_BIND}:${DESKTOP_PORT}" \
  --start-child="${SESSION_COMMAND[*]}" \
  --daemon=no \
  --exit-with-children=yes
