# Hermes ACP 整合待辦

> Agent Rider planning document.

`server/hermesAcp.mjs` 實作 ACP（Agent Client Protocol，見
https://hermes-agent.nousresearch.com/docs/user-guide/features/acp）的子集。
狀態更新於 2026-07-12（以 `hermes acp` v0.18.0 實測 ACP 流量後修訂）。

## 已完成

- [x] Thinking/reasoning 串流（`agent_thought_chunk`）→ SSE `thought` → 卡片 reasoning 折疊區
- [x] Tool call 更新（`tool_call` / `tool_call_update`）→ SSE `tool` → 卡片工具時間軸
      （依 `toolCallId` 合併：update 不帶 title/kind，只帶 status/content）
- [x] Plan/todo 更新（`plan`）→ SSE `plan` → 卡片 plan 清單
- [x] Session 生命週期（`session/new`、`session/load`、`session/prompt`、
      `session/set_model`、`session/cancel`）與純文字串流（`agent_message_chunk`）

## 不需要做（實測確認）

- [x] ~~`fs/read_text_file` / `fs/write_text_file`~~ — Hermes 用自己的檔案工具，
      整場對話從未向 client 發出 `fs/*` 請求。client capability 宣告 `false` 是正確的。
- [x] ~~`terminal/*`~~ — 同上，Hermes 自己執行指令（實測 `echo` 成功、exit 0），
      從未向 client 要求 `terminal/*`。不宣告此 capability 不影響任何功能。

## 未做（依優先序）

- [ ] MCP server passthrough — `session/new`/`session/load` 寫死空陣列 `[]`
      （2026-07-12 決議：暫不做）
- [ ] Image / 多模態內容區塊 — prompt 只送 `type: 'text'`；工具回傳的圖片/資源被過濾。
      Hermes 有宣告 `promptCapabilities.image: true`，但卡片尚無圖片上傳 UI，等 UI 有了再說。
- [ ] Available/slash commands — `available_commands_update` 已會自動送達
      （help/model/tools/context/reset/compact/steer/queue…），只差 UI。
- [ ] Context 用量顯示 — `usage_update` 會送 `{used, size}`（實測 11096/500000），目前丟棄。
- [ ] 真正的權限確認 UI（`session/request_permission`）— 目前自動選
      `allow_session`/`allow_once`（yolo 模式的刻意設計，非 bug）。
      實測中 Hermes 根本沒發出過權限請求，直接執行工具；工具時間軸即是事後稽核軌跡。

## 已知行為（實作時要留意）

- `tool_call` 初始事件**不帶 `status`**，而且不是每個 tool call 都會收到終結的
  `tool_call_update`（實測 2 個 tool_call 只有 1 個 update）。因此 UI 在 turn 結束時
  必須把仍是 `pending` 的工具收斂掉（見 `settleTools`），否則會永遠轉圈。

# Web app 自動更新通知

研究自 `../ref/hermes-webui/`（2026-07-13）。它的機制：後端輪詢 `git fetch` 比對
版本（`api/updates.py`），前端彈 banner，點下去觸發 `git pull` + `os.execv` 讓
process 原地換身重啟（同 PID 同 port，不經 ctl.sh），前端輪詢 `/health` 的
`server_started_at`，偵測到新 process 後自動 `location.reload()`——本質仍是一次
hard reload，只是自動觸發到感覺無縫，不是真正的 hot-swap。

Agent Rider 現有部署是每次建置一份新的 release 目錄
（`/opt/agent-rider/releases/agent-rider-<timestamp>-<hash>/`），跟 hermes-webui
「原地 git pull」的假設不同，套用時有兩個候選方案：

## 未做（待決議）

- [ ] 方案 A：仿 hermes-webui 原地更新 — store.mjs 偵測到新版本後直接
      `git pull` + process 自我重啟（Node 對應：`process.exit` 讓
      supervisor/systemd 重啟，或改寫啟動流程支援換身重啟）。前端輪詢
      `/health` 版本戳，偵測到新 process 後自動 reload。
      缺點：跟現有的 release 目錄建置流程不相容，需改動部署腳本本身。
- [ ] 方案 B：沿用現有 release 目錄結構 — 新 release 建置完成後，
      反向 proxy/store 把「當前 release」指標切到新目錄（類似 symlink swap），
      前端輪詢版本戳，偵測到切換後自動 reload。
      優點：不動現有建置/部署流程，只加「版本比對 + 通知 banner +
      reload polling」這層。
- [ ] 第一步建議：不論選哪個方案，都先只做「後端版本查詢 API + 前端更新
      通知 banner」（不做自動切換），讓使用者先有感知能力，之後再決定要不要
      做自動 release 切換。
