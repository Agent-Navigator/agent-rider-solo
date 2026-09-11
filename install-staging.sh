#!/bin/sh
set -eu

STAGING_REPOSITORY=${AGRIDER_STAGING_REPOSITORY:-Agent-Navigator/agent-rider-solo-dev}
STAGING_BRANCH=${AGRIDER_STAGING_BRANCH:-staging}
GITHUB_API_BASE=${AGRIDER_GITHUB_API_BASE:-https://api.github.com}
GITHUB_RAW_BASE=${AGRIDER_GITHUB_RAW_BASE:-https://raw.githubusercontent.com}

HOME_DIR=${HOME:?HOME is not set}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME_DIR/.config}
TOKEN_FILE=${AGRIDER_STAGING_GITHUB_TOKEN_FILE:-$CONFIG_HOME/agrider/staging-github-token}
CURL_CONFIG=${AGRIDER_STAGING_CURL_CONFIG:-}
TOKEN=${AGRIDER_STAGING_GITHUB_TOKEN:-}

fail() {
  printf 'Agent Rider staging install failed: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

case "$(uname -s 2>/dev/null || true)" in
  Linux) ;;
  *) fail 'only Linux is supported' ;;
esac

case "$(uname -m 2>/dev/null || true)" in
  x86_64|amd64) PLATFORM=linux-x86_64 ;;
  aarch64|arm64) PLATFORM=linux-aarch64 ;;
  *) fail "unsupported architecture: $(uname -m 2>/dev/null || printf unknown)" ;;
esac

case "$STAGING_REPOSITORY" in
  */*) ;;
  *) fail 'staging repository must use OWNER/REPOSITORY format' ;;
esac
case "$STAGING_BRANCH" in
  ''|*[!A-Za-z0-9._-]*) fail 'staging branch contains unsupported characters' ;;
esac

for command_name in curl python3 sha256sum tar gzip awk sed; do
  need "$command_name"
done

if [ -n "$CURL_CONFIG" ]; then
  [ -r "$CURL_CONFIG" ] || fail "curl configuration is not readable: $CURL_CONFIG"
elif [ -z "$TOKEN" ]; then
  [ -r "$TOKEN_FILE" ] || fail "GitHub staging token is required; set AGRIDER_STAGING_GITHUB_TOKEN or create $TOKEN_FILE"
  IFS= read -r TOKEN < "$TOKEN_FILE" || true
fi
case "$TOKEN" in
  '') [ -n "$CURL_CONFIG" ] || fail 'GitHub staging token is empty' ;;
  *"$(printf '\r')"*) fail 'GitHub staging token contains a carriage return' ;;
esac

github_download() {
  output=$1
  url=$2
  if [ -n "$CURL_CONFIG" ]; then
    curl --config "$CURL_CONFIG" -fsSL "$url" -o "$output"
  else
    curl -fsSL -H "Authorization: Bearer $TOKEN" "$url" -o "$output"
  fi
}

TMP_ROOT=${TMPDIR:-/tmp}
WORK_DIR=$(mktemp -d "$TMP_ROOT/agrider-staging-install.XXXXXX")
cleanup() {
  status=$?
  rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

ref_url=$GITHUB_API_BASE/repos/$STAGING_REPOSITORY/git/ref/heads/$STAGING_BRANCH
github_download "$WORK_DIR/ref.json" "$ref_url" \
  || fail "could not resolve staging branch $STAGING_REPOSITORY:$STAGING_BRANCH"
STAGING_COMMIT=$(python3 - "$WORK_DIR/ref.json" <<'PY'
import json, re, sys

try:
    value = json.load(open(sys.argv[1], encoding='utf-8'))['object']['sha']
except (KeyError, OSError, TypeError, ValueError):
    raise SystemExit(1)
if not isinstance(value, str) or not re.fullmatch(r'[0-9a-fA-F]{40}', value):
    raise SystemExit(1)
print(value.lower())
PY
) || fail 'GitHub returned an invalid staging branch commit'

RAW_BASE=${GITHUB_RAW_BASE%/}/$STAGING_REPOSITORY/$STAGING_COMMIT
github_download "$WORK_DIR/candidate.json" "$RAW_BASE/candidate.json" \
  || fail 'could not download staging candidate metadata'
set -- $(python3 - "$WORK_DIR/candidate.json" "$PLATFORM" <<'PY'
import json, re, sys

try:
    candidate = json.load(open(sys.argv[1], encoding='utf-8'))
    platform = sys.argv[2]
    assets = [asset for asset in candidate.get('assets', []) if asset.get('platform') == platform]
    asset = assets[0] if len(assets) == 1 else None
    version = candidate.get('version')
    commit = candidate.get('source_commit')
    archive = asset.get('archive') if asset else None
    digest = asset.get('sha256') if asset else None
except (OSError, ValueError, TypeError):
    raise SystemExit(1)

if candidate.get('schema') != 1:
    raise SystemExit(1)
if not isinstance(version, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?', version):
    raise SystemExit(1)
if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-fA-F]{40}', commit):
    raise SystemExit(1)
expected_archive = f'bundles/agrider-{platform}.tar.gz'
if archive != expected_archive:
    raise SystemExit(1)
if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', digest):
    raise SystemExit(1)
print(version)
print(commit.lower())
print(archive)
print(digest.lower())
PY
) || fail 'staging candidate metadata is invalid'
[ "$#" -eq 4 ] || fail 'staging candidate metadata is invalid'

VERSION=$1
SOURCE_COMMIT=$2
ARCHIVE_PATH=$3
EXPECTED_SHA=$4
ARCHIVE=$(basename "$ARCHIVE_PATH")

DATA_HOME=${XDG_DATA_HOME:-$HOME_DIR/.local/share}
DATA_ROOT=${AGRIDER_DATA_ROOT:-$DATA_HOME/agrider}
CURRENT_METADATA=$DATA_ROOT/current/release.json
if [ -f "$CURRENT_METADATA" ] && python3 - "$CURRENT_METADATA" "$SOURCE_COMMIT" <<'PY'
import json, sys
try:
    metadata = json.load(open(sys.argv[1], encoding='utf-8'))
except (OSError, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if metadata.get('source_commit') == sys.argv[2] else 1)
PY
then
  printf 'Agent Rider staging %s is already installed.\n' "${SOURCE_COMMIT%${SOURCE_COMMIT#????????????}}"
  exit 0
fi

github_download "$WORK_DIR/$ARCHIVE" "$RAW_BASE/$ARCHIVE_PATH" \
  || fail "could not download staging bundle: $ARCHIVE_PATH"
ACTUAL_SHA=$(sha256sum "$WORK_DIR/$ARCHIVE" | awk '{print tolower($1)}')
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || fail "checksum mismatch for $ARCHIVE"

python3 - "$WORK_DIR/$ARCHIVE" "$VERSION" "$SOURCE_COMMIT" "$PLATFORM" <<'PY' \
  || fail 'staging bundle is unsafe or does not match candidate metadata'
import json, pathlib, sys, tarfile

archive_path, version, commit, platform = sys.argv[1:]
with tarfile.open(archive_path, 'r:gz') as archive:
    release_member = None
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk():
            raise SystemExit(1)
        if path == pathlib.PurePosixPath('release.json'):
            release_member = member
    if release_member is None:
        raise SystemExit(1)
    source = archive.extractfile(release_member)
    if source is None:
        raise SystemExit(1)
    metadata = json.load(source)
expected = {'version': version, 'source_commit': commit, 'platform': platform}
raise SystemExit(0 if all(metadata.get(key) == value for key, value in expected.items()) else 1)
PY

github_download "$WORK_DIR/install.sh" "$RAW_BASE/install.sh" \
  || fail 'could not download the staging bootstrap installer'
chmod 700 "$WORK_DIR/install.sh"
printf '%s  %s\n' "$EXPECTED_SHA" "$ARCHIVE" > "$WORK_DIR/checksums.txt"

SHORT_COMMIT=${SOURCE_COMMIT%${SOURCE_COMMIT#????????????}}
printf 'Installing Agent Rider staging %s (%s) from %s...\n' \
  "$VERSION" "$SHORT_COMMIT" "$STAGING_COMMIT"
AGRIDER_RELEASE_BASE=file://$WORK_DIR \
AGRIDER_RELEASE_ID=$VERSION-$SHORT_COMMIT-staging \
AGRIDER_UPGRADE_COMMAND='rerun the install-staging.sh bootstrap for the latest staging candidate' \
sh "$WORK_DIR/install.sh"
