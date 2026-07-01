# Agent Rider

Agent Rider 是一個本機 workspace UI，前端使用 React + Vite，後端使用
Node store backend 保存本機狀態。

這份 README 以你的部署情境為主：**在 remote server 上執行 `scp`，從這台開發機
`/root/agent-work/DEV/agent-rider` 把 release 拉過去安裝或更新**。不需要 GitHub。

## 本機開發

在這台開發機：

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

## 部署模型

角色分工：

- Source machine：這台開發機，專案路徑是 `/root/agent-work/DEV/agent-rider`
- Remote server：正式執行 Agent Rider 的 server
- 傳輸方向：在 remote server 上執行 `ssh` / `scp`，從 source machine 把 release 拉到 remote

前提：

- Remote server 可以 SSH 到 source machine。
- Source machine 上已有這個 repo、`node_modules`、以及可執行 `scripts/release.sh`。
- Remote server 建議是 Ubuntu/Debian，並且可以使用 `sudo`。installer 會安裝必要套件與 Node.js 22+。

## 更新保留策略

更新時只替換程式 release，保留本地狀態：

- `/opt/agent-rider/shared/data`：SQLite 聊天紀錄、Conversation Card 狀態、版面設定、App 排序/改名等 store 資料。
- `/opt/agent-rider/shared/plugins`：本地 Agent App plugins，包括 `manifest.json`、`dist/`、以及 app source。
- `/etc/default/agent-rider`：既有 `WEB_PORT`、`STORE_PORT`、`BROWSE_ROOT`、`HERMES_TARGET`、`VITE_ALLOWED_HOSTS` 會沿用；命令列環境變數可覆蓋。
- `/opt/agent-rider/shared/backups/<timestamp>`：每次更新前會備份 data/plugins。

Release 只更新程式碼、Node dependencies、production build、systemd unit，以及第一方 build-time plugins。若 release 內有新的 App plugin 且 remote 尚未有同名資料夾，會初次帶入；既有同名 App plugin 不會覆蓋。

## 版號與 Git tag

正式打包 release 前，建議先把 `package.json` 的版本與 Git tag 對齊。慣例是：

- `package.json` 使用 semver，例如 `0.1.1`
- Git tag 使用 `v` prefix，例如 `v0.1.1`
- tag 指向的 commit 就是這次 release 的 source state

最短做法是在 source machine 上執行：

```bash
npm version patch -m "Release v%s"
```

這會自動：

- 將 `package.json` / `package-lock.json` 版本從例如 `0.1.0` 更新到 `0.1.1`
- 建立一個 release commit
- 建立對應 Git tag，例如 `v0.1.1`

如果要指定明確版本，而不是自動 patch：

```bash
npm version 0.1.1 -m "Release v%s"
```

如果只想先改版本、不立刻建立 tag，可以手動分兩步：

```bash
npm version 0.1.1 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release v0.1.1"
git tag v0.1.1
```

目前 `scripts/release.sh` 的 tarball 檔名仍使用 UTC 時間與 Git short SHA：

```text
agent-rider-YYYYMMDDTHHMMSSZ-<git-sha>.tar.gz
```

因此版號/tag 是 release 管理用的 source marker；實際部署流程仍照下面的
`scripts/release.sh` 與 `install/update` 流程執行。

## 第一次安裝

以下指令都在 **remote server** 上執行。

如果 remote server 可以 `scp` 到 source machine，可以用同一行完成第一次安裝或後續更新；script 會自動判斷是否已有 `/opt/agent-rider/current`：

```bash
SOURCE_SSH=root@source-machine SOURCE_DIR=/root/agent-work/DEV/agent-rider APP_DIR=/opt/agent-rider bash -lc 'tmp=$(mktemp -d); scp ${SSH_OPTS:-} "$SOURCE_SSH:$SOURCE_DIR/scripts/pull-update.sh" "$tmp/"; bash "$tmp/pull-update.sh"'
```

如果 source machine 的 SSH port 不是 22：

```bash
SOURCE_SSH=root@source-machine SOURCE_DIR=/root/agent-work/DEV/agent-rider SSH_OPTS='-p 2222' bash -lc 'tmp=$(mktemp -d); scp ${SSH_OPTS:-} "$SOURCE_SSH:$SOURCE_DIR/scripts/pull-update.sh" "$tmp/"; bash "$tmp/pull-update.sh"'
```

如果你已經把 `scripts/pull-update.sh` 複製到 remote server，也可以直接：

```bash
SOURCE_SSH=root@source-machine SOURCE_DIR=/root/agent-work/DEV/agent-rider APP_DIR=/opt/agent-rider bash pull-update.sh
```

安裝完成後會建立：

```text
/opt/agent-rider/releases/     # 每次部署的 versioned release
/opt/agent-rider/current       # 指向目前啟用版本的 symlink
/opt/agent-rider/shared/data   # SQLite 與 runtime data，更新時保留
/opt/agent-rider/shared/plugins # App plugins，更新時保留
/opt/agent-rider/shared/backups # 更新前的 data/plugins 備份
```

預設 Web UI 會在 remote server 的 `5173` port：

```text
http://<remote-server>:5173
```

## 持續更新

之後每次要更新，也是在 **remote server** 上執行同一個 pull update：

```bash
SOURCE_SSH=root@source-machine SOURCE_DIR=/root/agent-work/DEV/agent-rider APP_DIR=/opt/agent-rider bash -lc 'tmp=$(mktemp -d); scp ${SSH_OPTS:-} "$SOURCE_SSH:$SOURCE_DIR/scripts/pull-update.sh" "$tmp/"; bash "$tmp/pull-update.sh"'
```

`pull-update.sh` 會：

- 在 source machine 執行 `scripts/release.sh`
- 用 `scp` 拉最新 release tarball 與 remote installer
- 自動選擇 `install-remote.sh` 或 `update-remote.sh`
- 更新前備份並保留 `/opt/agent-rider/shared/data`
- 更新前備份並保留 `/opt/agent-rider/shared/plugins`
- 沿用 `/etc/default/agent-rider` 既有設定
- 解壓成新的 versioned release，執行 `npm ci` 與 `npm run build`
- 將 `/opt/agent-rider/current` 指向新版本
- 重啟 `agent-rider-store` 和 `agent-rider-web`

## 建議放到 remote server 的更新腳本

可以在 remote server 建立一個固定指令，例如：

```bash
sudo tee /usr/local/bin/agent-rider-pull-update >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_SSH=${SOURCE_SSH:-root@source-machine}
SOURCE_DIR=${SOURCE_DIR:-/root/agent-work/DEV/agent-rider}
tmp=$(mktemp -d)
scp ${SSH_OPTS:-} "$SOURCE_SSH:$SOURCE_DIR/scripts/pull-update.sh" "$tmp/"
SOURCE_SSH="$SOURCE_SSH" SOURCE_DIR="$SOURCE_DIR" APP_DIR="${APP_DIR:-/opt/agent-rider}" SSH_OPTS="${SSH_OPTS:-}" bash "$tmp/pull-update.sh"
SCRIPT

sudo chmod +x /usr/local/bin/agent-rider-pull-update
```

之後更新只要在 remote server 執行：

```bash
SOURCE_SSH=root@source-machine agent-rider-pull-update
```

如果需要指定 SSH port：

```bash
SOURCE_SSH=root@source-machine SSH_OPTS='-p 2222' agent-rider-pull-update
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
STORE_PORT=5174
BROWSE_ROOT=/root
HERMES_TARGET=http://127.0.0.1:8789
VITE_ALLOWED_HOSTS=all
```

修改 `/etc/default/agent-rider` 後，重啟服務：

```bash
sudo systemctl restart agent-rider-store agent-rider-web
```

## 不用 GitHub 的下一步選項

目前這個 pull-based `scp` 流程適合單台 remote server，優點是簡單、只需要 SSH、不需要任何第三方 remote。

如果之後更新頻率變高，可以考慮：

- `rsync` over SSH：只傳差異，適合檔案變多、tarball 上傳變慢時。
- git over SSH：在 remote server 建 private bare repo，不用 GitHub，但有完整版本紀錄。
- Tailscale / ZeroTier + git clone：source machine 和 remote server 做 P2P 連線，server 可直接從 source machine clone 或 pull。

更完整的 push-based 部署說明仍保留在 [docs/deployment.md](docs/deployment.md)。
