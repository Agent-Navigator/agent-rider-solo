#!/usr/bin/env bash
set -Eeuo pipefail

WEB_PORT=${WEB_PORT:-5173}
exec npm run preview -- --host 0.0.0.0 --port "$WEB_PORT"
