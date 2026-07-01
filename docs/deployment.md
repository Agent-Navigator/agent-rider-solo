# Agent Rider deployment

部署方式改為 **Tailscale private git remote**。Remote server 不再從 source
machine `scp` release tarball；它直接透過 SSH/Tailscale `git fetch` private
repo，從指定 commit 建立本機 release，然後套用。

## 保留內容

更新只替換程式 release；以下內容保留：

- `/opt/agent-rider/shared/data`：聊天紀錄、Conversation Card、版面狀態、App 排序/改名等 store 資料。
- `/opt/agent-rider/shared/plugins`：本地 Agent App plugins。
- `/opt/agent-rider/shared/backups/<timestamp>`：每次更新前的 data/plugins 備份。
- `/etc/default/agent-rider`：既有 port、browse root、Hermes target、allowed hosts 會沿用；環境變數可覆蓋。

## Source machine setup

在 source machine 建 private bare repo：

```bash
sudo mkdir -p /srv/git
sudo git init --bare /srv/git/agent-rider.git
sudo chown -R "$USER:$USER" /srv/git/agent-rider.git

cd /root/agent-work/DEV/agent-rider
git remote add tailnet /srv/git/agent-rider.git 2>/dev/null || git remote set-url tailnet /srv/git/agent-rider.git
git push tailnet master --tags
```

每次更新前，在 source machine commit 並 push：

```bash
git push tailnet master --tags
```

Remote server 只會看到 private git remote 裡已 push 的 commit。

## Remote install/update

在 remote server 執行一行。把 `source-tailnet-host` 換成 source machine 的
Tailscale hostname 或 Tailscale IP：

```bash
SOURCE_GIT=root@source-tailnet-host:/srv/git/agent-rider.git SOURCE_REF=master APP_DIR=/opt/agent-rider bash -lc 'command -v git >/dev/null || { sudo apt-get update && sudo apt-get install -y git; }; tmp=$(mktemp -d); git clone --depth=1 --branch "${SOURCE_REF:-master}" "$SOURCE_GIT" "$tmp/agent-rider"; bash "$tmp/agent-rider/scripts/pull-update.sh"'
```

第一次安裝和後續更新使用同一行。更新流程：

1. `pull-update.sh` 在 remote server 維護 `~/.cache/agent-rider/source.git` mirror。
2. Fetch `SOURCE_GIT`。
3. Resolve `SOURCE_REF`（branch/tag/commit，預設 remote `HEAD`）。
4. 用 `git archive` 從該 commit 建本機 release archive。
5. 執行 release 裡的 `install-remote.sh` 或 `update-remote.sh`。
6. 保留 shared data/plugins，重建 production build，切換 `/opt/agent-rider/current`。

## 固定命令

第一次安裝後，可以直接呼叫目前版本裡的 updater：

```bash
SOURCE_GIT=root@source-tailnet-host:/srv/git/agent-rider.git SOURCE_REF=master APP_DIR=/opt/agent-rider bash /opt/agent-rider/current/scripts/pull-update.sh
```

或建立固定 command：

```bash
sudo tee /usr/local/bin/agent-rider-git-update >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_GIT=${SOURCE_GIT:-root@source-tailnet-host:/srv/git/agent-rider.git}
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
STORE_PORT=5174
BROWSE_ROOT=/root
HERMES_TARGET=http://127.0.0.1:8789
VITE_ALLOWED_HOSTS=all
```

這些值會寫進遠端 `/etc/default/agent-rider`。如果改了這個檔案，重啟：

```bash
sudo systemctl restart agent-rider-store agent-rider-web
```

## Legacy SCP

`scripts/release.sh` 和 `scripts/deploy-scp.sh` 仍保留給不能用 Tailscale/git
remote 的環境。一般部署請使用 `scripts/pull-update.sh` 的 private git remote
流程。
