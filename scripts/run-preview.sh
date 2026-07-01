#!/usr/bin/env bash
set -Eeuo pipefail

WEB_HOST=${WEB_HOST:-127.0.0.1}
WEB_PORT=${WEB_PORT:-5173}
VITE_ALLOWED_HOSTS=${VITE_ALLOWED_HOSTS:-all}
exec env VITE_ALLOWED_HOSTS="$VITE_ALLOWED_HOSTS" npm run preview -- --host "$WEB_HOST" --port "$WEB_PORT"
