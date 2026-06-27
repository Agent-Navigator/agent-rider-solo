# Agent Rider deployment

這份流程以 `scp` 為主，不需要 GitHub。核心想法是：

1. 在本機 build 成一個 release tarball。
2. 用 `scp` 把 tarball 和遠端腳本丟到 server。
3. 遠端腳本解壓成 versioned release，安裝 npm dependencies，建立 systemd services，重啟 app。
4. `data/` 放在 `/opt/agent-rider/shared/data`，更新時不覆蓋 SQLite runtime data。

## 最短路徑

第一次部署：

```bash
scripts/deploy-scp.sh root@your-server
```

指定遠端目錄：

```bash
scripts/deploy-scp.sh root@your-server /opt/agent-rider
```

指定 SSH port：

```bash
SSH_OPTS='-p 2222' scripts/deploy-scp.sh root@your-server
```

之後更新同一台 server 跑同一個指令即可。script 會偵測遠端是否已有 `/opt/agent-rider/current`，有的話走 update，沒有就走 install。

## 手動 scp 流程

本機建立 release：

```bash
scripts/release.sh
```

上傳：

```bash
scp releases/agent-rider-*.tar.gz scripts/install-remote.sh scripts/update-remote.sh root@your-server:/tmp/
```

遠端第一次安裝：

```bash
sudo APP_DIR=/opt/agent-rider bash /tmp/install-remote.sh /tmp/agent-rider-*.tar.gz
```

遠端更新：

```bash
sudo APP_DIR=/opt/agent-rider bash /tmp/update-remote.sh /tmp/agent-rider-*.tar.gz
```

## 服務

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

## scp 是否夠好

`scp` 夠適合目前階段：

- 不需要 GitHub 或任何第三方 remote。
- release tarball 會排除 `.git`、`node_modules`、`data`，不會把本機 runtime DB 帶上去。
- 遠端每次用新的 release 目錄，出問題時可以手動把 `/opt/agent-rider/current` 指回前一版。

缺點：

- 每次上傳完整 tarball，不是增量同步。
- 遠端第一次或 dependency 改變時要跑 `npm ci`。
- 多台機器時沒有中央版本紀錄。

## 下一階段選項

### rsync over SSH

如果上傳速度成為問題，`rsync` 會比 `scp` 好用，因為它只傳差異：

```bash
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude data \
  ./ root@your-server:/opt/agent-rider/current/
```

這適合單機開發、單機部署，但要小心 `--delete`，不要刪掉遠端想保留的檔案。

### git over SSH, no GitHub

不用 GitHub 也可以用 git。比較推薦這個方向作為 P2P/私有部署的下一步：

1. 在 server 建 bare repo：

```bash
ssh root@your-server 'mkdir -p /srv/git && git init --bare /srv/git/agent-rider.git'
```

2. 本機加 remote 並 push：

```bash
git remote add prod root@your-server:/srv/git/agent-rider.git
git push prod main
```

3. server 從自己的 bare repo checkout 或用 post-receive hook 觸發 deploy。

這個方式仍然只走 SSH，不需要 GitHub。更新頻繁、多人協作或需要清楚版本紀錄時，比純 `scp` 更穩。

### P2P git clone through Tailscale or ZeroTier

如果 server 能透過 Tailscale/ZeroTier SSH 回你的開發機，也可以讓 server 直接 clone 你的本機 repo：

```bash
git clone ssh://your-user@your-tailnet-ip/path/to/agent-rider.git
```

這是真正 P2P，但前提是你的開發機要在線、SSH 權限要處理好。實務上我會先用 `scp` release，等部署變頻繁後再換成 `git over SSH` 或 Tailscale 上的 private git remote。
