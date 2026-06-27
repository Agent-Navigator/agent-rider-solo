# Agent Rider

Agent Rider 是一個本機 workspace UI，前端使用 React + Vite，後端使用
Node store backend 保存本機狀態。這個專案目前的部署流程不依賴 GitHub：
在本機打包 release，透過 `scp` 複製到遠端 server，然後在遠端執行安裝或更新腳本。

## 本機開發

安裝 dependencies：

```bash
npm ci
```

啟動 store backend 與 web UI：

```bash
npm run store
npm run dev
```

建立 production build：

```bash
npm run build
```

## 一鍵 scp 部署

目前建議先使用 `scp` release 流程：

```bash
scripts/deploy-scp.sh root@your-server
```

指定遠端安裝目錄：

```bash
scripts/deploy-scp.sh root@your-server /opt/agent-rider
```

指定 SSH port：

```bash
SSH_OPTS='-p 2222' scripts/deploy-scp.sh root@your-server
```

也可以用 npm wrapper：

```bash
npm run deploy:scp -- root@your-server
```

這個流程會自動完成：

1. 在本機執行 `scripts/release.sh`。
2. 執行 `npm run build` 產生 `dist/`。
3. 建立 `releases/agent-rider-*.tar.gz`。
4. 排除 `.git`、`node_modules`、`data`、`releases`。
5. 用 `scp` 上傳 release 與遠端腳本。
6. 遠端第一次部署時執行 install，之後執行 update。
7. 重啟遠端 systemd services。

## 手動安裝與更新

如果不想使用一鍵腳本，可以手動拆成三步。

本機建立 release：

```bash
scripts/release.sh
```

上傳 release 與遠端腳本：

```bash
scp releases/agent-rider-*.tar.gz scripts/install-remote.sh scripts/update-remote.sh root@your-server:/tmp/
```

遠端第一次安裝：

```bash
sudo APP_DIR=/opt/agent-rider bash /tmp/install-remote.sh /tmp/agent-rider-*.tar.gz
```

遠端更新既有安裝：

```bash
sudo APP_DIR=/opt/agent-rider bash /tmp/update-remote.sh /tmp/agent-rider-*.tar.gz
```

遠端目錄結構：

```text
/opt/agent-rider/releases/     # 每次部署的 versioned release
/opt/agent-rider/current       # 指向目前啟用版本的 symlink
/opt/agent-rider/shared/data   # SQLite 與 runtime data，更新時保留
```

## 遠端服務

遠端 installer 會建立兩個 systemd services：

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

## 不用 GitHub 的替代方案

`scp` 適合目前階段：簡單、只需要 SSH、不需要第三方 remote。缺點是每次會上傳完整 release tarball，不是增量同步。

如果上傳開始變慢，可以改用 `rsync` over SSH，只傳差異：

```bash
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude data \
  ./ root@your-server:/opt/agent-rider/current/
```

如果想保留清楚版本紀錄，但仍然不用 GitHub，建議下一步改成 git over SSH：

```bash
ssh root@your-server 'mkdir -p /srv/git && git init --bare /srv/git/agent-rider.git'
git remote add prod root@your-server:/srv/git/agent-rider.git
git push prod main
```

如果要做 P2P git clone，可以讓開發機和 server 都加入 Tailscale 或 ZeroTier，
再讓 server 直接從開發機 clone：

```bash
git clone ssh://your-user@your-tailnet-ip/path/to/agent-rider.git
```

P2P 的前提是開發機必須在線，且 SSH 權限與網路路由要先設定好。實務上建議先使用 `scp` release；部署變頻繁後，再升級成 private `git over SSH`。

更完整的部署說明在 [docs/deployment.md](docs/deployment.md)。
