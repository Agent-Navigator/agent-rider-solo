#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  GITHUB_TOKEN=github_pat_... SOURCE_GIT=git@github.com:OWNER/REPO.git bash scripts/pull-update.sh

Environment:
  SOURCE_GIT         SSH git remote used to resolve SOURCE_REF. Required, or arg 1.
  SOURCE_REF         Branch, tag, or commit to deploy. Default: master.
  GITHUB_TOKEN       GitHub token with read-only Contents access. Required.
  GITHUB_REPOSITORY  OWNER/REPO containing build-<full-sha> prereleases. By
                     default it is derived from SOURCE_GIT when that is GitHub.
  APP_DIR            Install root. Default: /opt/agent-rider.
  GIT_CACHE          Local mirror. Default: ~/.cache/agent-rider/source.git.
  WORK_DIR           Optional empty work directory. Default: fresh mktemp dir.
USAGE
}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then usage; exit 0; fi

SOURCE_GIT=${SOURCE_GIT:-${1:-}}
SOURCE_REF=${SOURCE_REF:-master}
APP_NAME=${APP_NAME:-agent-rider}
APP_DIR=${APP_DIR:-/opt/agent-rider}
WORK_DIR=${WORK_DIR:-}
cache_root=${XDG_CACHE_HOME:-${HOME:+$HOME/.cache}}
GIT_CACHE=${GIT_CACHE:-${cache_root:-/tmp}/agent-rider/source.git}

if [[ -z $SOURCE_GIT ]]; then usage >&2; exit 1; fi
if [[ -z ${GITHUB_TOKEN:-} ]]; then echo 'GITHUB_TOKEN with read-only Contents access is required.' >&2; exit 1; fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then echo 'Agent Rider release artifacts support Linux x86_64 only.' >&2; exit 1; fi

if [[ -n ${SSH_OPTS:-} && -z ${GIT_SSH_COMMAND:-} ]]; then export GIT_SSH_COMMAND="ssh $SSH_OPTS"; fi

install_pull_tools() {
  local missing=() cmd
  for cmd in git tar gzip curl sha256sum python3; do command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd"); done
  (( ${#missing[@]} == 0 )) && return
  command -v apt-get >/dev/null 2>&1 || { echo "Missing required commands: ${missing[*]}" >&2; exit 1; }
  if [[ $EUID -eq 0 ]]; then apt-get update; apt-get install -y git tar gzip curl coreutils python3
  elif command -v sudo >/dev/null 2>&1; then sudo apt-get update; sudo apt-get install -y git tar gzip curl coreutils python3
  else echo "Missing required commands: ${missing[*]} and sudo is unavailable." >&2; exit 1; fi
}

resolve_commit() {
  local candidate
  for candidate in "$1" "refs/heads/$1" "refs/tags/$1"; do
    git -C "$GIT_CACHE" rev-parse --verify --quiet "$candidate^{commit}" 2>/dev/null && return
  done
  return 1
}

derive_repository() {
  local remote=$1 repository=''
  if [[ $remote == git@github.com:* ]]; then repository=${remote#git@github.com:}
  elif [[ $remote == https://github.com/* ]]; then repository=${remote#https://github.com/}; fi
  printf '%s\n' "${repository%.git}"
}

run_installer() {
  local installer=$1 archive=$2
  local installer_env=(APP_DIR="$APP_DIR" AGENT_RIDER_DEPLOY_COMMIT="$commit" AGENT_RIDER_DEPLOY_SHORT_SHA="$short_sha" AGENT_RIDER_SOURCE_GIT="$SOURCE_GIT" AGENT_RIDER_SOURCE_REF="$SOURCE_REF")
  local name
  for name in APP_USER APP_GROUP WEB_PORT STORE_PORT BROWSE_ROOT AGENT_RIDER_APPS_DIR VITE_ALLOWED_HOSTS ENV_FILE; do [[ -n ${!name+x} ]] && installer_env+=("$name=${!name}"); done
  if [[ $EUID -eq 0 ]]; then env "${installer_env[@]}" bash "$installer" "$archive"
  elif command -v sudo >/dev/null 2>&1; then sudo env "${installer_env[@]}" bash "$installer" "$archive"
  else env "${installer_env[@]}" bash "$installer" "$archive"; fi
}

install_pull_tools
GITHUB_REPOSITORY=${GITHUB_REPOSITORY:-$(derive_repository "$SOURCE_GIT")}
if [[ ! $GITHUB_REPOSITORY =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then echo 'Set GITHUB_REPOSITORY=OWNER/REPO; it could not be derived from SOURCE_GIT.' >&2; exit 1; fi

mkdir -p "$(dirname "$GIT_CACHE")"
if [[ -d $GIT_CACHE/objects ]]; then
  echo "Fetching $SOURCE_GIT into $GIT_CACHE..."
  git -C "$GIT_CACHE" remote set-url origin "$SOURCE_GIT"
  git -C "$GIT_CACHE" fetch --prune origin '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
else
  echo "Cloning mirror $SOURCE_GIT into $GIT_CACHE..."
  git clone --mirror "$SOURCE_GIT" "$GIT_CACHE"
fi

commit=$(resolve_commit "$SOURCE_REF" || true)
if [[ -z $commit ]]; then echo "Could not resolve SOURCE_REF '$SOURCE_REF' from $SOURCE_GIT." >&2; exit 1; fi
short_sha=$(git -C "$GIT_CACHE" rev-parse --short "$commit")

if [[ -n $WORK_DIR ]]; then
  mkdir -p "$WORK_DIR"
  if find "$WORK_DIR" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then echo "WORK_DIR must be empty: $WORK_DIR" >&2; exit 1; fi
else
  WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-rider-git-update.XXXXXX")
  trap 'rm -rf "$WORK_DIR"' EXIT
fi

asset=agent-rider-store-x86_64-unknown-linux-musl.tar.gz
release_json="$WORK_DIR/release.json"
api=https://api.github.com/repos/$GITHUB_REPOSITORY
echo "Resolving build-$commit release artifact..."
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$api/releases/tags/build-$commit" -o "$release_json" || { echo "CI prerelease build-$commit is not available yet." >&2; exit 1; }

download_asset() {
  local name=$1 output=$2 id
  id=$(python3 - "$release_json" "$name" <<'PY'
import json, sys
release = json.load(open(sys.argv[1]))
matches = [str(asset['id']) for asset in release.get('assets', []) if asset.get('name') == sys.argv[2]]
if len(matches) != 1:
    raise SystemExit(1)
print(matches[0])
PY
  ) || { echo "Release asset missing or duplicated: $name" >&2; exit 1; }
  curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H 'Accept: application/octet-stream' -H 'X-GitHub-Api-Version: 2022-11-28' "$api/releases/assets/$id" -o "$output"
}

download_asset "$asset" "$WORK_DIR/$asset"
download_asset "$asset.sha256" "$WORK_DIR/$asset.sha256"
(cd "$WORK_DIR" && sha256sum -c "$asset.sha256")
if [[ $(tar -tzf "$WORK_DIR/$asset") != bin/agent-rider-store ]]; then echo 'Backend archive has an unexpected layout.' >&2; exit 1; fi

package="$WORK_DIR/package"
mkdir -p "$package"
git -C "$GIT_CACHE" archive "$commit" | tar -x -C "$package"
tar -xzf "$WORK_DIR/$asset" -C "$package"
if [[ ! -x $package/bin/agent-rider-store ]]; then echo 'Backend binary is missing or not executable.' >&2; exit 1; fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$WORK_DIR/${APP_NAME}-${stamp}-${short_sha}.tar.gz"
tar -C "$package" -czf "$archive" .
installer="$package/scripts/install-remote.sh"
[[ -e $APP_DIR/current ]] && installer="$package/scripts/update-remote.sh"

echo "Resolved SOURCE_REF '$SOURCE_REF' to $commit and verified $asset."
run_installer "$installer" "$archive"
echo "Agent Rider update complete: $short_sha"
