#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" != "--inside-dbus" ]]; then
  exec dbus-run-session -- "$0" --inside-dbus
fi

export XDG_CURRENT_DESKTOP=GNOME-Flashback:GNOME
export DESKTOP_SESSION=gnome-flashback-metacity
export XDG_MENU_PREFIX=gnome-

pids=()
start_component() {
  "$@" &
  pids+=("$!")
}

cleanup() {
  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

start_component /usr/libexec/gnome-flashback-clipboard
start_component /usr/libexec/gnome-flashback-idle-monitor
start_component /usr/libexec/gnome-flashback-media-keys
start_component /usr/libexec/gnome-flashback-polkit
start_component /usr/bin/metacity --replace
start_component /usr/bin/gnome-panel
start_component /usr/bin/nautilus --no-default-window

wait -n "${pids[@]}"
