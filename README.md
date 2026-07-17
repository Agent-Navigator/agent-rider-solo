# Agent Rider

Agent Rider 是一個本機 workspace UI，前端使用 React + Vite，後端是單一
Rust binary `agent-rider-store`，直接保存狀態到既有 SQLite database。

部署以 private SSH git remote 解析 source commit，並從 GitHub private prerelease
取得 CI 建置的 backend binary；不再用 `scp` 傳 release tarball。

## 本機開發

在 source machine：

```bash
cd /root/agent-work/DEV/agent-rider
npm ci
npm run store
npm run dev
```

建立 production build：

```bash
npm run build
```

## 更新保留策略

更新時只替換程式 release，保留本地狀態：

- `/opt/agent-rider/shared/data`：SQLite 聊天紀錄、Conversation Card 狀態、版面設定、App 排序/改名等 store 資料。
- `/opt/agent-rider/shared/plugins`：本地 Agent Apps，包括 `manifest.json`、`dist/`、以及 app source；這是 runtime data，不屬於 Agent Rider source repo。
- `/etc/default/agent-rider`：既有 `WEB_PORT`、`STORE_PORT`、`BROWSE_ROOT`、`HERMES_TARGET`、`VITE_ALLOWED_HOSTS` 會沿用；命令列環境變數可覆蓋。
- 遠端 preview 預設只監聽 `127.0.0.1`，讓 `tailscale serve` 代理到本機而不是搶同一個 5173 介面。
- `/opt/agent-rider/shared/backups/<timestamp>`：每次更新前會備份 data/plugins。

Release 只更新程式碼、CI 建置的 Rust binary、Node frontend dependencies、production build、systemd unit，以及第一方 build-time plugins。Remote 不會安裝 Rust toolchain 或執行 Cargo build。

## Source Git Remote

Source of truth 是 GitHub private repo `ytk77/agent-rider-dev`：

```bash
git remote add origin git@github.com:ytk77/agent-rider-dev.git 2>/dev/null || git remote set-url origin git@github.com:ytk77/agent-rider-dev.git
git push origin master --tags
```

之後每次要讓 remote server 更新到最新程式，先在 source machine commit，然後 push：

```bash
git push origin master --tags
```

Remote server 要能讀這個 private repo，需要一把有權限的 SSH deploy key（放在 server 的
`~/.ssh/`，或用 `GIT_SSH_COMMAND` 指定）。若你仍在用舊的 Tailscale bare repo，
把下面指令的 `SOURCE_GIT` 換成 `root@YOUR-SOURCE-TAILNET-HOST:/srv/git/agent-rider.git` 即可。

Updater 另外需要 `GITHUB_TOKEN` 下載 private prerelease。Token 只需該 repo 的
**Contents: read** 權限；不要把 token 寫入 release、`/etc/default/agent-rider` 或
systemd unit。每個 push 的 GitHub Actions 完成後會建立 `build-<full-sha>` prerelease。

如果你使用的 branch 不是 `master`，下面 remote 指令的 `SOURCE_REF` 要一起改。
更新流程用 git commit 判斷，不使用 `package.json` 的 `version` 判斷是否需要更新。

## Remote 一行安裝/更新

以下指令在 **remote server** 上執行：

```bash
GITHUB_TOKEN=github_pat_READ_ONLY SOURCE_GIT=git@github.com:ytk77/agent-rider-dev.git SOURCE_REF=master APP_DIR=/opt/agent-rider bash -lc 'command -v git >/dev/null || { sudo apt-get update && sudo apt-get install -y git; }; tmp=$(mktemp -d); git clone --depth=1 --branch "${SOURCE_REF:-master}" "$SOURCE_GIT" "$tmp/agent-rider" && bash "$tmp/agent-rider/scripts/pull-update.sh"'
```

這一行可用於第一次安裝，也可用於之後更新。`pull-update.sh` 會：

- 在 remote server 的 `~/.cache/agent-rider/source.git` 維護 private git mirror。
- `git fetch` `SOURCE_GIT`。
- 將 `SOURCE_REF` resolve 成 exact full SHA。
- 從 `build-<full-sha>` private prerelease 下載 Linux x86_64 musl binary 並驗證 SHA-256；CI 尚未完成、asset 缺失或 checksum 不符時會在停止服務前中止。
- 自動選擇 `install-remote.sh` 或 `update-remote.sh`。
- 更新前備份並保留 `/opt/agent-rider/shared/data`。
- 更新前備份並保留 `/opt/agent-rider/shared/plugins`。
- 設定 `AGENT_RIDER_APPS_DIR=/opt/agent-rider/shared/plugins`，讓 `/apps/<slug>/` 使用獨立且能在升級間保留的本地 App 目錄。
- 沿用 `/etc/default/agent-rider` 既有設定。
- 解壓成新的 versioned release，執行 `npm ci` 與 `npm run build`，不在 remote build Rust。
- 將 `/opt/agent-rider/current` 指向新版本。
- 重啟服務並接受 `/store/state` 的 `200` 或 password gate 的 `401` 為健康；失敗會自動還原舊 symlink、unit 與環境檔。

安裝完成後會建立：

```text
/opt/agent-rider/releases/       # 每次部署的 versioned release
/opt/agent-rider/current         # 指向目前啟用版本的 symlink
/opt/agent-rider/current/.agent-rider-release # 實際部署的 commit/source/ref
/opt/agent-rider/current/bin/agent-rider-store # CI 建置的靜態 Rust backend
/opt/agent-rider/shared/data     # SQLite 與 runtime data，更新時保留
/opt/agent-rider/shared/plugins  # Local Agent Apps，更新時保留
/opt/agent-rider/shared/backups  # 更新前的 data/plugins 備份
```

## 固定 Remote 更新指令

第一次安裝完成後，也可以直接用 current 裡的 updater：

```bash
GITHUB_TOKEN=github_pat_READ_ONLY SOURCE_GIT=git@github.com:ytk77/agent-rider-dev.git SOURCE_REF=master APP_DIR=/opt/agent-rider bash /opt/agent-rider/current/scripts/pull-update.sh
```

建議在 remote server 放一個固定命令：

```bash
sudo tee /usr/local/bin/agent-rider-git-update >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_GIT=${SOURCE_GIT:-git@github.com:ytk77/agent-rider-dev.git}
SOURCE_REF=${SOURCE_REF:-master}
APP_DIR=${APP_DIR:-/opt/agent-rider}
: "${GITHUB_TOKEN:?set a read-only GitHub Contents token}"

if [[ -x "$APP_DIR/current/scripts/pull-update.sh" ]]; then
  exec bash "$APP_DIR/current/scripts/pull-update.sh"
fi

tmp=$(mktemp -d)
git clone --depth=1 --branch "$SOURCE_REF" "$SOURCE_GIT" "$tmp/agent-rider"
exec bash "$tmp/agent-rider/scripts/pull-update.sh"
SCRIPT

sudo chmod +x /usr/local/bin/agent-rider-git-update
```

之後更新只要：

```bash
agent-rider-git-update
```

指定不同 branch/tag/commit：

```bash
SOURCE_REF=v0.1.2 agent-rider-git-update
```

## 遠端服務管理

installer 會建立兩個 systemd services：

```bash
systemctl status agent-rider-store
systemctl status agent-rider-web
```

查看 logs：

```bash
journalctl -u agent-rider-store -f
journalctl -u agent-rider-web -f
```

重啟：

```bash
sudo systemctl restart agent-rider-store agent-rider-web
```

預設 ports：

- Web UI: `5173`
- Store backend: `127.0.0.1:5174`

遠端環境設定會寫入：

```text
/etc/default/agent-rider
```

常用設定：

```bash
WEB_PORT=5173
WEB_HOST=127.0.0.1
STORE_PORT=5174
BROWSE_ROOT=/root
# Rust store 直接啟動 Hermes ACP；預設從 PATH 尋找 hermes。
HERMES_TARGET=hermes
VITE_ALLOWED_HOSTS=all
```

修改 `/etc/default/agent-rider` 後，重啟服務：

```bash
sudo systemctl restart agent-rider-store agent-rider-web
```

手動 rollback 到已保留的 release：

```bash
sudo ln -sfn /opt/agent-rider/releases/<previous-release> /opt/agent-rider/current
sudo systemctl daemon-reload
sudo systemctl restart agent-rider-store agent-rider-web
```

## Legacy SCP

舊的 `scripts/release.sh`、`scripts/deploy-scp.sh`、`scripts/install-remote.sh`
仍保留，方便沒有 Tailscale/git remote 的環境使用。但目前推薦路徑是
`SOURCE_GIT=... scripts/pull-update.sh`。
