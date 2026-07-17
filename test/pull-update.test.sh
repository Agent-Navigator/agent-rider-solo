#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/agent-rider-updater-test.XXXXXX")
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/source/scripts" "$SANDBOX/assets/bin" "$SANDBOX/mock-bin"

cat > "$SANDBOX/source/scripts/install-remote.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
archive=$1
mkdir -p "$APP_DIR"
tar -tzf "$archive" | grep -F './bin/agent-rider-store' >/dev/null
printf '%s\n' "$AGENT_RIDER_DEPLOY_COMMIT" > "$APP_DIR/installed"
SCRIPT
cp "$SANDBOX/source/scripts/install-remote.sh" "$SANDBOX/source/scripts/update-remote.sh"
chmod +x "$SANDBOX/source/scripts/"*.sh
git -C "$SANDBOX/source" init -q
git -C "$SANDBOX/source" config user.email fixture@example.test
git -C "$SANDBOX/source" config user.name Fixture
git -C "$SANDBOX/source" add .
git -C "$SANDBOX/source" commit -qm fixture
git -C "$SANDBOX/source" branch -M master
commit=$(git -C "$SANDBOX/source" rev-parse HEAD)

printf '#!/usr/bin/env sh\necho fixture\n' > "$SANDBOX/assets/bin/agent-rider-store"
chmod +x "$SANDBOX/assets/bin/agent-rider-store"
asset=agent-rider-store-x86_64-unknown-linux-musl.tar.gz
tar -C "$SANDBOX/assets" -czf "$SANDBOX/$asset" bin/agent-rider-store
(cd "$SANDBOX" && sha256sum "$asset" > "$asset.sha256")
cat > "$SANDBOX/release.json" <<EOF
{"tag_name":"build-$commit","assets":[{"id":1,"name":"$asset"},{"id":2,"name":"$asset.sha256"}]}
EOF

cat > "$SANDBOX/mock-bin/curl" <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail
output=''
url=''
while (($#)); do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -H) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */releases/tags/*) cp "$MOCK_RELEASE_JSON" "$output" ;;
  */releases/assets/1) cp "$MOCK_ASSET" "$output" ;;
  */releases/assets/2) cp "$MOCK_CHECKSUM" "$output" ;;
  *) exit 22 ;;
esac
SCRIPT
cat > "$SANDBOX/mock-bin/sudo" <<'SCRIPT'
#!/usr/bin/env bash
if [[ ${1:-} == env ]]; then shift; exec env "$@"; fi
exec "$@"
SCRIPT
chmod +x "$SANDBOX/mock-bin/curl" "$SANDBOX/mock-bin/sudo"

run_update() {
  env PATH="$SANDBOX/mock-bin:$PATH" MOCK_RELEASE_JSON="$SANDBOX/release.json" \
    MOCK_ASSET="$SANDBOX/$asset" MOCK_CHECKSUM="$SANDBOX/$asset.sha256" \
    GITHUB_TOKEN=read-only-fixture GITHUB_REPOSITORY=fixture/repo \
    SOURCE_GIT="$SANDBOX/source" SOURCE_REF=master GIT_CACHE="$SANDBOX/cache-$1.git" \
    APP_DIR="$SANDBOX/app-$1" bash "$ROOT/scripts/pull-update.sh"
}

run_update success
[[ $(<"$SANDBOX/app-success/installed") == "$commit" ]]

printf '{"assets":[]}\n' > "$SANDBOX/release.json"
if run_update missing; then echo 'Missing artifact unexpectedly succeeded.' >&2; exit 1; fi
[[ ! -e "$SANDBOX/app-missing/installed" ]]

cat > "$SANDBOX/release.json" <<EOF
{"assets":[{"id":1,"name":"$asset"},{"id":2,"name":"$asset.sha256"}]}
EOF
printf '%064d  %s\n' 0 "$asset" > "$SANDBOX/bad.sha256"
MOCK_CHECKSUM="$SANDBOX/bad.sha256"
export MOCK_CHECKSUM
if env PATH="$SANDBOX/mock-bin:$PATH" MOCK_RELEASE_JSON="$SANDBOX/release.json" MOCK_ASSET="$SANDBOX/$asset" \
  MOCK_CHECKSUM="$SANDBOX/bad.sha256" GITHUB_TOKEN=read-only-fixture GITHUB_REPOSITORY=fixture/repo \
  SOURCE_GIT="$SANDBOX/source" SOURCE_REF=master GIT_CACHE="$SANDBOX/cache-checksum.git" APP_DIR="$SANDBOX/app-checksum" \
  bash "$ROOT/scripts/pull-update.sh"; then echo 'Bad checksum unexpectedly succeeded.' >&2; exit 1; fi
[[ ! -e "$SANDBOX/app-checksum/installed" ]]

echo 'artifact success, missing asset, and checksum failure tests passed'
