# Agent Rider deployment

Remote server 透過 SSH `git fetch` private repo 解析 exact commit，再以 read-only
GitHub token 下載該 commit 的 CI-built static Rust backend。

## 保留內容

更新只替換程式 release；以下內容保留：

- `/opt/agent-rider/shared/data`：聊天紀錄、Conversation Card、版面狀態、App 排序/改名等 store 資料。
- `/opt/agent-rider/shared/plugins`：本地 Agent Apps；這是 runtime data，不屬於 Agent Rider source repo。
- `/opt/agent-rider/shared/backups/<timestamp>`：每次更新前的 data/plugins 備份。
- `/etc/default/agent-rider`：既有 port、browse root、Hermes target、allowed hosts 會沿用；環境變數可覆蓋。
- 遠端 preview 預設只監聽 `127.0.0.1`，避免和 `tailscale serve` 在同一個介面搶 `5173`。

## Source machine setup

Source of truth 是 GitHub private repo `ytk77/agent-rider-dev`：

```bash
git remote add origin git@github.com:ytk77/agent-rider-dev.git 2>/dev/null || git remote set-url origin git@github.com:ytk77/agent-rider-dev.git
git push origin master --tags
```

每次更新前，在 source machine commit 並 push：

```bash
git push origin master --tags
```

Remote server 只會看到已 push 到 GitHub 的 commit，而且需要一把可讀此 private repo 的
SSH deploy key。更新流程用 git commit 判斷，不使用 `package.json` 的 `version`
判斷是否需要更新。舊的 Tailscale bare repo 仍可用，只要把 `SOURCE_GIT` 換成
`root@YOUR-SOURCE-TAILNET-HOST:/srv/git/agent-rider.git`。

`GITHUB_TOKEN` 只需 private repo 的 Contents read 權限。GitHub Actions 會為每個
commit 建立 `build-<full-sha>` prerelease；等 workflow 完成後再更新。

## Remote install/update

在 remote server 執行一行：

```bash
GITHUB_TOKEN=github_pat_READ_ONLY SOURCE_GIT=git@github.com:ytk77/agent-rider-dev.git SOURCE_REF=master APP_DIR=/opt/agent-rider bash -lc 'command -v git >/dev/null || { sudo apt-get update && sudo apt-get install -y git; }; tmp=$(mktemp -d); git clone --depth=1 --branch "${SOURCE_REF:-master}" "$SOURCE_GIT" "$tmp/agent-rider" && bash "$tmp/agent-rider/scripts/pull-update.sh"'
```

第一次安裝和後續更新使用同一行。更新流程：

1. `pull-update.sh` 在 remote server 維護 `~/.cache/agent-rider/source.git` mirror。
2. Fetch `SOURCE_GIT`。
3. Resolve `SOURCE_REF`（branch/tag/commit，預設 `master`）。
4. 下載 `build-<full-sha>` 的 musl binary 與 checksum 並驗證。
5. 把 source 與 binary 組成 release archive，再執行 installer。
6. frontend build 與備份完成後才停止服務；health check 失敗會自動 rollback。

實際部署的 commit 會寫到：

```bash
cat /opt/agent-rider/current/.agent-rider-release
```

## 固定命令

第一次安裝後，可以直接呼叫目前版本裡的 updater：

```bash
GITHUB_TOKEN=github_pat_READ_ONLY SOURCE_GIT=git@github.com:ytk77/agent-rider-dev.git SOURCE_REF=master APP_DIR=/opt/agent-rider bash /opt/agent-rider/current/scripts/pull-update.sh
```

或建立固定 command：

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

之後更新：

```bash
agent-rider-git-update
```

部署 tag 或指定 commit：

```bash
SOURCE_REF=v0.1.2 agent-rider-git-update
SOURCE_REF=abc1234 agent-rider-git-update
```

## Services

遠端會建立兩個 systemd services：

```bash
systemctl status agent-rider-store
systemctl status agent-rider-web
journalctl -u agent-rider-store -f
journalctl -u agent-rider-web -f
```

預設 web port 是 `5173`，store backend 是 localhost `5174`。

可用環境變數：

```bash
WEB_PORT=5173
WEB_HOST=127.0.0.1
STORE_PORT=5174
BROWSE_ROOT=/root
AGENT_RIDER_APPS_DIR=/opt/agent-rider/shared/plugins
# Rust backend 直接執行此 ACP CLI；預設 hermes。
HERMES_TARGET=hermes
VITE_ALLOWED_HOSTS=all
```

這些值會寫進遠端 `/etc/default/agent-rider`。如果改了這個檔案，重啟：

```bash
sudo systemctl restart agent-rider-store agent-rider-web
```

手動 rollback：

```bash
sudo ln -sfn /opt/agent-rider/releases/<previous-release> /opt/agent-rider/current
sudo systemctl daemon-reload
sudo systemctl restart agent-rider-store agent-rider-web
```

## Legacy SCP

`scripts/release.sh` 和 `scripts/deploy-scp.sh` 仍保留給不能用 Tailscale/git
remote 的環境。一般部署請使用 `scripts/pull-update.sh` 的 private git remote
流程。
