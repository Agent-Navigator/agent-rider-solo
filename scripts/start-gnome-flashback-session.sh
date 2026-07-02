#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" != "--inside-dbus" ]]; then
  exec dbus-run-session -- "$0" --inside-dbus
fi

export XDG_CURRENT_DESKTOP=GNOME-Flashback:GNOME
export DESKTOP_SESSION=gnome-flashback-metacity
export XDG_MENU_PREFIX=gnome-

pids=()
start_optional_component() {
  "$@" &
  pids+=("$!")
}

cleanup() {
  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

start_optional_component /usr/libexec/gnome-flashback-clipboard
start_optional_component /usr/libexec/gnome-flashback-idle-monitor
start_optional_component /usr/libexec/gnome-flashback-media-keys
start_optional_component /usr/libexec/gnome-flashback-polkit
start_optional_component /usr/bin/nautilus --no-default-window

metacity_pid=
panel_pid=

while true; do
  # Exit (and clean up children) once our X server is gone. Without this the
  # respawn loop survives `xpra stop` and keeps launching metacity/gnome-panel
  # against the NEXT server started on the same display number — two competing
  # `metacity --replace` loops then kick each other out forever.
  if ! timeout 5 xset q >/dev/null 2>&1; then
    exit 0
  fi

  if [[ -z "${metacity_pid}" ]] || ! kill -0 "${metacity_pid}" 2>/dev/null; then
    /usr/bin/metacity --replace &
    metacity_pid="$!"
    pids+=("${metacity_pid}")
  fi

  if [[ -z "${panel_pid}" ]] || ! kill -0 "${panel_pid}" 2>/dev/null; then
    /usr/bin/gnome-panel &
    panel_pid="$!"
    pids+=("${panel_pid}")
  fi

  sleep 5
done
