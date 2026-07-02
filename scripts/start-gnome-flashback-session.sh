#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" != "--inside-dbus" ]]; then
  exec dbus-run-session -- "$0" --inside-dbus
fi

export XDG_CURRENT_DESKTOP=GNOME-Flashback:GNOME
export DESKTOP_SESSION=gnome-flashback-metacity
export XDG_MENU_PREFIX=gnome-

pids=()
core_pids=()
start_optional_component() {
  "$@" &
  pids+=("$!")
}
start_core_component() {
  "$@" &
  pids+=("$!")
  core_pids+=("$!")
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
start_core_component /usr/bin/metacity --replace
start_core_component /usr/bin/gnome-panel
start_optional_component /usr/bin/nautilus --no-default-window

wait -n "${core_pids[@]}"
