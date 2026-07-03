# Agent Rider

Agent Rider 是一個本機 workspace UI，前端使用 React + Vite，後端使用
Node store backend 保存本機狀態。

目前部署模型改成 **Tailscale 上的 private git remote**：source machine 把
Agent Rider repo push 到只有 tailnet 內可達的 SSH git remote，remote server
直接 `git fetch` 那個 private remote 來更新程式，不再需要 GitHub，也不再需要
用 `scp` 傳 release tarball。

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
- `/opt/agent-rider/shared/plugins`：本地 Agent App plugins，包括 `manifest.json`、`dist/`、以及 app source。
- `/etc/default/agent-rider`：既有 `WEB_PORT`、`STORE_PORT`、`BROWSE_ROOT`、`HERMES_TARGET`、`VITE_ALLOWED_HOSTS` 會沿用；命令列環境變數可覆蓋。
- 遠端 preview 預設只監聽 `127.0.0.1`，讓 `tailscale serve` 代理到本機而不是搶同一個 5173 介面。
- `/opt/agent-rider/shared/backups/<timestamp>`：每次更新前會備份 data/plugins。

Release 只更新程式碼、Node dependencies、production build、systemd unit，以及第一方 build-time plugins。若 git release 內有新的 App plugin 且 remote 尚未有同名資料夾，會初次帶入；既有同名 App plugin 不會覆蓋。

## Source Git Remote

在 source machine 建立一個只有 Tailscale/SSH 能碰到的 bare repo：

```bash
sudo mkdir -p /srv/git
sudo git init --bare /srv/git/agent-rider.git
sudo chown -R "$USER:$USER" /srv/git/agent-rider.git

cd /root/agent-work/DEV/agent-rider
git remote add tailnet /srv/git/agent-rider.git 2>/dev/null || git remote set-url tailnet /srv/git/agent-rider.git
git push tailnet master --tags
```

之後每次要讓 remote server 更新到最新程式，先在 source machine commit，然後 push：

```bash
git push tailnet master --tags
```

如果你使用的 branch 不是 `master`，下面 remote 指令的 `SOURCE_REF` 要一起改。
更新流程用 git commit 判斷，不使用 `package.json` 的 `version` 判斷是否需要更新。

## Remote 一行安裝/更新

以下指令在 **remote server** 上執行。`SOURCE_GIT` 請換成 source machine 的
Tailscale hostname 或 Tailscale IP。

```bash
SOURCE_GIT=root@YOUR-SOURCE-TAILNET-HOST:/srv/git/agent-rider.git SOURCE_REF=master APP_DIR=/opt/agent-rider bash -lc ': "${SOURCE_GIT:?replace YOUR-SOURCE-TAILNET-HOST with the actual Tailscale host}"; command -v git >/dev/null || { sudo apt-get update && sudo apt-get install -y git; }; tmp=$(mktemp -d); git clone --depth=1 --branch "${SOURCE_REF:-master}" "$SOURCE_GIT" "$tmp/agent-rider" && bash "$tmp/agent-rider/scripts/pull-update.sh"'
```

這一行可用於第一次安裝，也可用於之後更新。`pull-update.sh` 會：

- 在 remote server 的 `~/.cache/agent-rider/source.git` 維護 private git mirror。
- `git fetch` `SOURCE_GIT`。
- 將 `SOURCE_REF` 對應的最新 commit 打包成本機 release archive。
- 自動選擇 `install-remote.sh` 或 `update-remote.sh`。
- 更新前備份並保留 `/opt/agent-rider/shared/data`。
- 更新前備份並保留 `/opt/agent-rider/shared/plugins`。
- 沿用 `/etc/default/agent-rider` 既有設定。
- 解壓成新的 versioned release，執行 `npm ci` 與 `npm run build`。
- 將 `/opt/agent-rider/current` 指向新版本。
- 重啟 `agent-rider-store` 和 `agent-rider-web`。

安裝完成後會建立：

```text
/opt/agent-rider/releases/       # 每次部署的 versioned release
/opt/agent-rider/current         # 指向目前啟用版本的 symlink
/opt/agent-rider/current/.agent-rider-release # 實際部署的 commit/source/ref
/opt/agent-rider/shared/data     # SQLite 與 runtime data，更新時保留
/opt/agent-rider/shared/plugins  # App plugins，更新時保留
/opt/agent-rider/shared/backups  # 更新前的 data/plugins 備份
```

## 固定 Remote 更新指令

第一次安裝完成後，也可以直接用 current 裡的 updater：

```bash
SOURCE_GIT=root@YOUR-SOURCE-TAILNET-HOST:/srv/git/agent-rider.git SOURCE_REF=master APP_DIR=/opt/agent-rider bash /opt/agent-rider/current/scripts/pull-update.sh
```

建議在 remote server 放一個固定命令：

```bash
sudo tee /usr/local/bin/agent-rider-git-update >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_GIT=${SOURCE_GIT:-root@YOUR-SOURCE-TAILNET-HOST:/srv/git/agent-rider.git}
SOURCE_REF=${SOURCE_REF:-master}
APP_DIR=${APP_DIR:-/opt/agent-rider}

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
HERMES_TARGET=http://127.0.0.1:8789
VITE_ALLOWED_HOSTS=all
```

修改 `/etc/default/agent-rider` 後，重啟服務：

```bash
sudo systemctl restart agent-rider-store agent-rider-web
```

## Legacy SCP

舊的 `scripts/release.sh`、`scripts/deploy-scp.sh`、`scripts/install-remote.sh`
仍保留，方便沒有 Tailscale/git remote 的環境使用。但目前推薦路徑是
`SOURCE_GIT=... scripts/pull-update.sh`。
