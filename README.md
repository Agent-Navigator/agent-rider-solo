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

## 第一次安裝

以下指令都在 **remote server** 上執行。

先設定 source machine 與安裝路徑：

```bash
export SOURCE_SSH=root@source-machine
export SOURCE_DIR=/root/agent-work/DEV/agent-rider
export APP_DIR=/opt/agent-rider
export WORK_DIR=/tmp/agent-rider-pull
```

如果 source machine 的 SSH port 不是 22：

```bash
export SSH_OPTS='-p 2222'
```

讓 source machine 先打包最新 release：

```bash
ssh ${SSH_OPTS:-} "$SOURCE_SSH" "cd '$SOURCE_DIR' && scripts/release.sh"
```

找出最新 release tarball：

```bash
RELEASE=$(ssh ${SSH_OPTS:-} "$SOURCE_SSH" "cd '$SOURCE_DIR' && ls -t releases/agent-rider-*.tar.gz | head -1")
echo "$RELEASE"
```

從 source machine 把 release 和遠端腳本拉到 remote server：

```bash
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

scp ${SSH_OPTS:-} "$SOURCE_SSH:$SOURCE_DIR/$RELEASE" "$WORK_DIR/"
scp ${SSH_OPTS:-} \
  "$SOURCE_SSH:$SOURCE_DIR/scripts/install-remote.sh" \
  "$SOURCE_SSH:$SOURCE_DIR/scripts/update-remote.sh" \
  "$WORK_DIR/"
```

執行第一次安裝：

```bash
sudo APP_DIR="$APP_DIR" bash "$WORK_DIR/install-remote.sh" "$WORK_DIR/$(basename "$RELEASE")"
```

安裝完成後會建立：

```text
/opt/agent-rider/releases/     # 每次部署的 versioned release
/opt/agent-rider/current       # 指向目前啟用版本的 symlink
/opt/agent-rider/shared/data   # SQLite 與 runtime data，更新時保留
```

預設 Web UI 會在 remote server 的 `5173` port：

```text
http://<remote-server>:5173
```

## 持續更新

之後每次要更新，也是在 **remote server** 上執行同一組 pull 流程。

先確定變數：

```bash
export SOURCE_SSH=root@source-machine
export SOURCE_DIR=/root/agent-work/DEV/agent-rider
export APP_DIR=/opt/agent-rider
export WORK_DIR=/tmp/agent-rider-pull
```

請 source machine 重新打包最新 release：

```bash
ssh ${SSH_OPTS:-} "$SOURCE_SSH" "cd '$SOURCE_DIR' && scripts/release.sh"
```

抓最新 release：

```bash
RELEASE=$(ssh ${SSH_OPTS:-} "$SOURCE_SSH" "cd '$SOURCE_DIR' && ls -t releases/agent-rider-*.tar.gz | head -1")

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

scp ${SSH_OPTS:-} "$SOURCE_SSH:$SOURCE_DIR/$RELEASE" "$WORK_DIR/"
scp ${SSH_OPTS:-} \
  "$SOURCE_SSH:$SOURCE_DIR/scripts/install-remote.sh" \
  "$SOURCE_SSH:$SOURCE_DIR/scripts/update-remote.sh" \
  "$WORK_DIR/"
```

執行更新：

```bash
sudo APP_DIR="$APP_DIR" bash "$WORK_DIR/update-remote.sh" "$WORK_DIR/$(basename "$RELEASE")"
```

`update-remote.sh` 目前會沿用 `install-remote.sh` 的 idempotent 流程：

- 解壓成新的 versioned release
- 執行 `npm ci`
- 執行 `npm run build`
- 將 `/opt/agent-rider/current` 指向新版本
- 保留 `/opt/agent-rider/shared/data`
- 重啟 `agent-rider-store` 和 `agent-rider-web`

## 建議放到 remote server 的更新腳本

可以在 remote server 建立一個固定指令，例如：

```bash
sudo tee /usr/local/bin/agent-rider-pull-update >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_SSH=${SOURCE_SSH:-root@source-machine}
SOURCE_DIR=${SOURCE_DIR:-/root/agent-work/DEV/agent-rider}
APP_DIR=${APP_DIR:-/opt/agent-rider}
WORK_DIR=${WORK_DIR:-/tmp/agent-rider-pull}

ssh ${SSH_OPTS:-} "$SOURCE_SSH" "cd '$SOURCE_DIR' && scripts/release.sh"
RELEASE=$(ssh ${SSH_OPTS:-} "$SOURCE_SSH" "cd '$SOURCE_DIR' && ls -t releases/agent-rider-*.tar.gz | head -1")

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

scp ${SSH_OPTS:-} "$SOURCE_SSH:$SOURCE_DIR/$RELEASE" "$WORK_DIR/"
scp ${SSH_OPTS:-} \
  "$SOURCE_SSH:$SOURCE_DIR/scripts/install-remote.sh" \
  "$SOURCE_SSH:$SOURCE_DIR/scripts/update-remote.sh" \
  "$WORK_DIR/"

if [[ -e "$APP_DIR/current" ]]; then
  sudo APP_DIR="$APP_DIR" bash "$WORK_DIR/update-remote.sh" "$WORK_DIR/$(basename "$RELEASE")"
else
  sudo APP_DIR="$APP_DIR" bash "$WORK_DIR/install-remote.sh" "$WORK_DIR/$(basename "$RELEASE")"
fi
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
