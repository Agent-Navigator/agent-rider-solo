#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
APP_NAME=${APP_NAME:-agent-rider}
RELEASE_DIR=${RELEASE_DIR:-"$ROOT_DIR/releases"}

cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to build a release." >&2
  exit 1
fi

mkdir -p "$RELEASE_DIR"

echo "Building production assets..."
npm run build

stamp=$(date -u +%Y%m%dT%H%M%SZ)
sha=nogit
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  sha=$(git rev-parse --short HEAD)
  if [[ -n $(git status --porcelain) ]]; then
    sha="${sha}-dirty"
  fi
fi

archive="$RELEASE_DIR/${APP_NAME}-${stamp}-${sha}.tar.gz"

echo "Creating $archive..."
tar -czf "$archive" \
  --exclude='./.git' \
  --exclude='./.agents' \
  --exclude='./.codex' \
  --exclude='./.claude' \
  --exclude='./node_modules' \
  --exclude='./data' \
  --exclude='./releases' \
  --exclude='./*.log' \
  .

echo "Release archive ready:"
echo "$archive"
