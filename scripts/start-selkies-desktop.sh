#!/usr/bin/env bash
set -Eeuo pipefail

DISPLAY_NUMBER=${SELKIES_DISPLAY:-102}
SELKIES_BIND=${SELKIES_BIND:-127.0.0.1}
SELKIES_PORT=${SELKIES_PORT:-8080}
SELKIES_RESOLUTION=${SELKIES_RESOLUTION:-1920x1080}
SELKIES_ENCODER=${SELKIES_ENCODER:-x264enc}
SELKIES_ROOT=${SELKIES_ROOT:-/opt/selkies-gstreamer}
DISPLAY_VALUE=":${DISPLAY_NUMBER}"
X_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUMBER}"
X_LOCK="/tmp/.X${DISPLAY_NUMBER}-lock"
RUNTIME_DIR="${SELKIES_RUNTIME_DIR:-/tmp/selkies-${DISPLAY_NUMBER}}"

if [[ ! -x "${SELKIES_ROOT}/selkies-gstreamer-run" ]]; then
  echo "Missing Selkies runner: ${SELKIES_ROOT}/selkies-gstreamer-run" >&2
  exit 1
fi

cleanup_existing() {
  pkill -f "selkies-gstreamer.*--port=${SELKIES_PORT}" 2>/dev/null || true
  pkill -f "Xvfb ${DISPLAY_VALUE} " 2>/dev/null || true
  pkill -f "DISPLAY=${DISPLAY_VALUE} .*start-gnome-flashback-session.sh" 2>/dev/null || true
  rm -f "${X_LOCK}" "${X_SOCKET}"
}

cleanup_existing
mkdir -p "${RUNTIME_DIR}" /tmp/.X11-unix
chmod 700 "${RUNTIME_DIR}"

export DISPLAY="${DISPLAY_VALUE}"
export XDG_RUNTIME_DIR="${RUNTIME_DIR}"
export PIPEWIRE_RUNTIME_DIR="${RUNTIME_DIR}"
export PULSE_RUNTIME_PATH="${RUNTIME_DIR}/pulse"
export PULSE_SERVER="unix:${PULSE_RUNTIME_PATH}/native"
export PIPEWIRE_LATENCY="128/48000"

Xvfb "${DISPLAY_VALUE}" \
  -screen 0 "${SELKIES_RESOLUTION}x24" \
  +extension COMPOSITE +extension DAMAGE +extension GLX +extension RANDR \
  +extension RENDER +extension MIT-SHM +extension XFIXES +extension XTEST \
  +iglx +render -nolisten tcp -ac -noreset \
  >"/tmp/Xvfb_selkies_${DISPLAY_NUMBER}.log" 2>&1 &
xvfb_pid=$!

for _ in {1..80}; do
  [[ -S "${X_SOCKET}" ]] && break
  sleep 0.25
done
if [[ ! -S "${X_SOCKET}" ]]; then
  echo "Xvfb did not create ${X_SOCKET}" >&2
  exit 1
fi

scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPLAY="${DISPLAY_VALUE}" "${scripts_dir}/start-gnome-flashback-session.sh" &
session_pid=$!

sleep 1
gsettings set org.gnome.desktop.interface text-scaling-factor 2.0 >/dev/null 2>&1 || true

cleanup() {
  kill "${session_pid}" "${xvfb_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec "${SELKIES_ROOT}/selkies-gstreamer-run" \
  --addr="${SELKIES_BIND}" \
  --port="${SELKIES_PORT}" \
  --enable_https=false \
  --enable_basic_auth=false \
  --encoder="${SELKIES_ENCODER}" \
  --enable_resize=false \
  --framerate=60 \
  --video_bitrate=8000
