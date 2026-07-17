#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/agent-rider-installer-test.XXXXXX")
trap 'rm -rf "$SANDBOX"' EXIT

mkdir -p "$SANDBOX/bin" "$SANDBOX/systemd-runtime" "$SANDBOX/systemd" "$SANDBOX/etc"
printf '200\n' > "$SANDBOX/health"

cat > "$SANDBOX/bin/npm" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ ${1:-} == run && ${2:-} == build ]]; then mkdir -p dist; printf '<html>fixture</html>\n' > dist/index.html; fi
SCRIPT
cat > "$SANDBOX/bin/systemctl" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_SYSTEMCTL_LOG"
SCRIPT
cat > "$SANDBOX/bin/curl" <<'SCRIPT'
#!/usr/bin/env bash
tr -d '\n' < "$MOCK_HEALTH_FILE"
SCRIPT
chmod +x "$SANDBOX/bin/npm" "$SANDBOX/bin/systemctl" "$SANDBOX/bin/curl"

make_archive() {
  local version=$1 fixture="$SANDBOX/fixture-$1" archive="$SANDBOX/agent-rider-$1.tar.gz"
  mkdir -p "$fixture/bin" "$fixture/plugins" "$fixture/scripts"
  printf '#!/usr/bin/env sh\necho %s\n' "$version" > "$fixture/bin/agent-rider-store"
  printf '#!/usr/bin/env sh\nexit 0\n' > "$fixture/scripts/run-preview.sh"
  chmod +x "$fixture/bin/agent-rider-store" "$fixture/scripts/run-preview.sh"
  printf '{"scripts":{"build":"fixture"}}\n' > "$fixture/package.json"
  printf '{}\n' > "$fixture/package-lock.json"
  tar -C "$fixture" -czf "$archive" .
  printf '%s\n' "$archive"
}

run_install() {
  env PATH="$SANDBOX/bin:$PATH" \
    MOCK_SYSTEMCTL_LOG="$SANDBOX/systemctl.log" MOCK_HEALTH_FILE="$SANDBOX/health" \
    AGENT_RIDER_TEST_MODE=1 AGENT_RIDER_SKIP_PREREQS=1 \
    APP_DIR="$SANDBOX/app" ENV_FILE="$SANDBOX/etc/agent-rider" \
    SYSTEMD_DIR="$SANDBOX/systemd" SYSTEMD_RUNTIME_DIR="$SANDBOX/systemd-runtime" \
    APP_USER="$(id -un)" APP_GROUP="$(id -gn)" BROWSE_ROOT="$SANDBOX" \
    bash "$ROOT/scripts/install-remote.sh" "$1"
}

first=$(make_archive first)
run_install "$first"
[[ $($SANDBOX/app/current/bin/agent-rider-store) == first ]]
grep -F "ExecStart=$SANDBOX/app/current/bin/agent-rider-store" "$SANDBOX/systemd/agent-rider-store.service"

printf '401\n' > "$SANDBOX/health"
second=$(make_archive second)
run_install "$second"
[[ $($SANDBOX/app/current/bin/agent-rider-store) == second ]]

printf '500\n' > "$SANDBOX/health"
failed=$(make_archive failed)
if run_install "$failed"; then
  echo 'Expected failed health check to roll back.' >&2
  exit 1
fi
[[ $($SANDBOX/app/current/bin/agent-rider-store) == second ]]
grep -F 'restart agent-rider-store.service agent-rider-web.service' "$SANDBOX/systemctl.log" >/dev/null

echo 'install/update/health rollback tests passed'
