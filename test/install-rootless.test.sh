#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/agrider-rootless-test.XXXXXX")
trap 'rm -rf "$SANDBOX"' EXIT

mkdir -p "$SANDBOX/mock-bin" "$SANDBOX/release/frontend"
printf '%s\n' '#!/bin/sh' 'if [ "${1:-}" = --version ]; then echo "agrider 0.1.2 (fixture)"; else exit 0; fi' \
  > "$SANDBOX/release/agrider"
chmod +x "$SANDBOX/release/agrider"
printf '%s\n' '<!doctype html><title>fixture</title>' > "$SANDBOX/release/frontend/index.html"
printf '%s\n' '{"version":"0.1.2","source_commit":"fixture"}' > "$SANDBOX/release/release.json"
for arch in x86_64 aarch64; do
  archive="$SANDBOX/agrider-linux-$arch.tar.gz"
  tar -C "$SANDBOX/release" -czf "$archive" .
  (cd "$SANDBOX" && sha256sum "${archive##*/}") >> "$SANDBOX/checksums.txt"
done

cat > "$SANDBOX/mock-bin/uname" <<'SCRIPT'
#!/bin/sh
case "${1:-}" in
  -s) printf '%s\n' "${MOCK_OS:-Linux}" ;;
  -m) printf '%s\n' "${MOCK_ARCH:-x86_64}" ;;
  *) printf '%s\n' "${MOCK_OS:-Linux}" ;;
esac
SCRIPT
cat > "$SANDBOX/mock-bin/curl" <<'SCRIPT'
#!/bin/sh
output=''
write_status=0
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -w) write_status=1; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
if [ "$write_status" -eq 1 ]; then
  printf '%s' "${MOCK_HEALTH_STATUS:-200}"
elif [ "${url##*/}" = checksums.txt ]; then
  cp "$MOCK_RELEASE_DIR/checksums.txt" "$output"
else
  cp "$MOCK_RELEASE_DIR/${url##*/}" "$output"
fi
SCRIPT
cat > "$SANDBOX/mock-bin/systemctl" <<'SCRIPT'
#!/bin/sh
printf 'user:%s\n' "$*" >> "$MOCK_SERVICE_LOG"
if [ "${1:-}" = show ]; then printf '%s\n' "${MOCK_LEGACY_USER:-}"; fi
SCRIPT
cat > "$SANDBOX/mock-bin/sudo" <<'SCRIPT'
#!/bin/sh
printf 'sudo:%s\n' "$*" >> "$MOCK_SERVICE_LOG"
case "${1:-}" in
  loginctl)
    [ "${MOCK_SUDO_FAIL_LINGER:-0}" = 1 ] && exit 1
    exit 0
    ;;
  systemctl) exit 0 ;;
  cp|chown) exec "$@" ;;
  *) exec "$@" ;;
esac
SCRIPT
for unavailable in node npm; do
  cat > "$SANDBOX/mock-bin/$unavailable" <<'SCRIPT'
#!/bin/sh
echo "installer unexpectedly invoked this unavailable runtime" >&2
exit 97
SCRIPT
done
chmod +x "$SANDBOX/mock-bin/"*

run_installer() {
  local name=$1
  shift
  local home="$SANDBOX/home-$name"
  mkdir -p "$home"
  env -i \
    HOME="$home" USER="$(id -un)" PATH="$SANDBOX/mock-bin:/usr/bin:/bin" \
    MOCK_RELEASE_DIR="$SANDBOX" MOCK_SERVICE_LOG="$SANDBOX/$name.log" \
    MOCK_ARCH="${MOCK_ARCH:-x86_64}" MOCK_OS="${MOCK_OS:-Linux}" \
    MOCK_HEALTH_STATUS="${MOCK_HEALTH_STATUS:-200}" MOCK_LEGACY_USER="${MOCK_LEGACY_USER:-}" \
    MOCK_SUDO_FAIL_LINGER="${MOCK_SUDO_FAIL_LINGER:-0}" \
    AGRIDER_RELEASE_BASE=https://fixture.invalid/releases/latest/download \
    AGRIDER_HEALTH_ATTEMPTS=1 \
    "$@" sh "$ROOT/install.sh"
}

output=$(run_installer clean)
grep -F 'not currently on PATH' <<<"$output" >/dev/null
test -x "$SANDBOX/home-clean/.local/share/agrider/current/agrider"
test -L "$SANDBOX/home-clean/.local/bin/agrider"
grep -F 'ExecStart=' "$SANDBOX/home-clean/.config/systemd/user/agrider.service" | grep -F 'agrider serve' >/dev/null
grep -F 'sudo:loginctl enable-linger' "$SANDBOX/clean.log" >/dev/null
grep -F 'user:--user enable --now agrider.service' "$SANDBOX/clean.log" >/dev/null

if MOCK_SUDO_FAIL_LINGER=1 run_installer lingering >"$SANDBOX/lingering.out" 2>&1; then
  echo 'Linger permission failure unexpectedly installed.' >&2
  exit 1
fi
grep -F 'could not enable lingering' "$SANDBOX/lingering.out" >/dev/null
test ! -e "$SANDBOX/home-lingering/.local/share/agrider/current"

MOCK_ARCH=aarch64 run_installer arm >/dev/null
test -x "$SANDBOX/home-arm/.local/share/agrider/current/agrider"

if MOCK_ARCH=riscv64 run_installer unsupported >"$SANDBOX/unsupported.out" 2>&1; then
  echo 'Unsupported architecture unexpectedly installed.' >&2
  exit 1
fi
grep -F 'unsupported architecture: riscv64' "$SANDBOX/unsupported.out" >/dev/null

cp "$SANDBOX/checksums.txt" "$SANDBOX/checksums.good"
sed '1s/^[0-9a-f]*/0000000000000000000000000000000000000000000000000000000000000000/' \
  "$SANDBOX/checksums.good" > "$SANDBOX/checksums.txt"
if run_installer checksum >"$SANDBOX/checksum.out" 2>&1; then
  echo 'Checksum mismatch unexpectedly installed.' >&2
  exit 1
fi
grep -F 'checksum mismatch' "$SANDBOX/checksum.out" >/dev/null
test ! -e "$SANDBOX/checksum.log"
mv "$SANDBOX/checksums.good" "$SANDBOX/checksums.txt"

legacy="$SANDBOX/legacy"
legacy_env="$SANDBOX/legacy.env"
mkdir -p "$legacy/shared/data" "$legacy/shared/plugins" "$legacy/current"
printf '%s\n' saved-state > "$legacy/shared/data/state.txt"
printf '%s\n' local-app > "$legacy/shared/plugins/app.txt"
printf '%s\n' 'WEB_PORT=5199' "BROWSE_ROOT=$SANDBOX/browse" 'HERMES_TARGET=/usr/bin/hermes' \
  > "$legacy_env"
MOCK_LEGACY_USER="$(id -un)" run_installer migration \
  AGRIDER_LEGACY_ROOT="$legacy" AGRIDER_LEGACY_ENV="$legacy_env" >/dev/null
test "$(cat "$SANDBOX/home-migration/.local/share/agrider/shared/data/state.txt")" = saved-state
test "$(cat "$SANDBOX/home-migration/.local/share/agrider/shared/plugins/app.txt")" = local-app
grep -F 'AGENT_RIDER_PORT="5199"' "$SANDBOX/home-migration/.config/agrider/env" >/dev/null
grep -F 'sudo:systemctl stop agent-rider-web.service agent-rider-store.service' "$SANDBOX/migration.log" >/dev/null
grep -F 'sudo:systemctl disable agent-rider-web.service agent-rider-store.service' "$SANDBOX/migration.log" >/dev/null

if MOCK_LEGACY_USER=somebody-else run_installer mismatch \
  AGRIDER_LEGACY_ROOT="$legacy" AGRIDER_LEGACY_ENV="$legacy_env" >"$SANDBOX/mismatch.out" 2>&1; then
  echo 'Mismatched legacy user unexpectedly migrated.' >&2
  exit 1
fi
grep -F "rerun the installer while logged in as that user" "$SANDBOX/mismatch.out" >/dev/null

if MOCK_LEGACY_USER="$(id -un)" MOCK_HEALTH_STATUS=500 run_installer rollback \
  AGRIDER_LEGACY_ROOT="$legacy" AGRIDER_LEGACY_ENV="$legacy_env" >"$SANDBOX/rollback.out" 2>&1; then
  echo 'Failed migration health check unexpectedly succeeded.' >&2
  exit 1
fi
grep -F 'sudo:systemctl enable agent-rider-store.service agent-rider-web.service' "$SANDBOX/rollback.log" >/dev/null
grep -F 'sudo:systemctl start agent-rider-store.service agent-rider-web.service' "$SANDBOX/rollback.log" >/dev/null

echo 'rootless installer architecture, checksum, migration, and rollback tests passed'
