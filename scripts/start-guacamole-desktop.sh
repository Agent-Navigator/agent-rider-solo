#!/usr/bin/env bash
set -Eeuo pipefail

DISPLAY_NUMBER=${GUACAMOLE_DISPLAY:-103}
VNC_BIND=${GUACAMOLE_VNC_BIND:-127.0.0.1}
VNC_PORT=${GUACAMOLE_DESKTOP_PORT:-5903}
VNC_GEOMETRY=${GUACAMOLE_VNC_GEOMETRY:-1920x1080}
VNC_DEPTH=${GUACAMOLE_VNC_DEPTH:-24}
GUI_FONT_SIZE=${GUACAMOLE_FONT_SIZE:-30}
GUI_TEXT_SCALE=${GUACAMOLE_TEXT_SCALE:-1.5}
VNC_PASSWORD_FILE=${GUACAMOLE_TIGERVNC_PASSWORD_FILE:-/root/.vnc/guacamole-passwd}
PLAIN_PASSWORD_FILE=${GUACAMOLE_VNC_PASSWORD_FILE:-/root/.guacamole-vnc-password}
DISPLAY_VALUE=":${DISPLAY_NUMBER}"
X_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUMBER}"
X_LOCK="/tmp/.X${DISPLAY_NUMBER}-lock"

if ! command -v Xtigervnc >/dev/null 2>&1; then
  echo "Missing Xtigervnc. Install tigervnc-standalone-server first." >&2
  exit 1
fi

if ! command -v tigervncpasswd >/dev/null 2>&1; then
  echo "Missing tigervncpasswd. Install tigervnc-tools first." >&2
  exit 1
fi

if [[ ! -s "${PLAIN_PASSWORD_FILE}" ]]; then
  echo "Missing VNC password file: ${PLAIN_PASSWORD_FILE}" >&2
  echo "Create it with a local secret, then generate ${VNC_PASSWORD_FILE} using tigervncpasswd -f." >&2
  exit 1
fi

mkdir -p "$(dirname "${VNC_PASSWORD_FILE}")" /tmp/.X11-unix
chmod 700 "$(dirname "${VNC_PASSWORD_FILE}")"
tigervncpasswd -f <"${PLAIN_PASSWORD_FILE}" >"${VNC_PASSWORD_FILE}"
chmod 600 "${VNC_PASSWORD_FILE}"

pkill -f "Xtigervnc ${DISPLAY_VALUE} " 2>/dev/null || true
pkill -f "DISPLAY=${DISPLAY_VALUE} .*start-gnome-flashback-session.sh" 2>/dev/null || true
rm -f "${X_LOCK}" "${X_SOCKET}"

Xtigervnc "${DISPLAY_VALUE}" \
  -localhost yes \
  -interface "${VNC_BIND}" \
  -rfbport "${VNC_PORT}" \
  -SecurityTypes VncAuth \
  -PasswordFile "${VNC_PASSWORD_FILE}" \
  -geometry "${VNC_GEOMETRY}" \
  -depth "${VNC_DEPTH}" \
  -dpi 96 \
  -AlwaysShared \
  -AcceptSetDesktopSize \
  -noreset \
  >"/tmp/Xtigervnc_guacamole_${DISPLAY_NUMBER}.log" 2>&1 &
xvnc_pid=$!

for _ in {1..80}; do
  [[ -S "${X_SOCKET}" ]] && break
  sleep 0.25
done

if [[ ! -S "${X_SOCKET}" ]]; then
  echo "Xtigervnc did not create ${X_SOCKET}" >&2
  exit 1
fi

scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DISPLAY="${DISPLAY_VALUE}"
export GUI_FONT_SIZE
export GUI_TEXT_SCALE
"${scripts_dir}/start-gnome-flashback-session.sh" &
session_pid=$!

cleanup() {
  kill "${session_pid}" "${xvnc_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait "${xvnc_pid}"
