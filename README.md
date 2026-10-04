# TSMC supply chain and hybrid harness eval

這個 JavaScript 專案包含兩個可直接開啟的頁面：

- `/`：台灣半導體供應鏈入門頁，介紹五家公司的產業角色、股票代號與公司來源。
- `/harness`：Hybrid Harness Lab。用 mock 或設定好的 LLM API 建置候選頁面，展示 agent 的受限 tool call、程式化檢查、Slice A 核准硬停止，以及核准後新建 Slice B task。

內容是產業角色示意，不宣稱列出的公司之間有特定供貨關係，也不提供即時報價或投資建議。來源資料在 [`data/companies.json`](data/companies.json)。

## 需求與啟動

需要 Node.js 24 或以上；沒有 npm 相依套件。

```bash
npm run dev
```

開啟終端機顯示的 `http://127.0.0.1:4173` 和 `/harness`。啟動時會印出本機 owner token；在 Harness Lab 輸入 token 後即可用 mock 模式跑完整流程。也可以在啟動前設定 `OWNER_TOKEN`。

## 使用真實 LLM API

設定 `LLM_API_KEY`、`LLM_BASE_URL`（例如 OpenAI 相容 API 的 `/v1` 根路徑）與 `LLM_MODEL`，再於 Harness Lab 選擇 Live LLM API。金鑰只由 server 讀取，不傳給 agent 或瀏覽器。API adapter 使用 Chat Completions function tool calls；模型提出的 `write_asset` 參數仍須通過 runtime 驗證。此專案未附金鑰，因此真實模型的產出品質需在有權限的環境另跑 live eval。API 格式依 [OpenAI Chat API reference](https://developers.openai.com/api/reference/resources/chat)。

## 測試與 eval

```bash
npm test
npm run eval
```

`npm test` 驗證 hard gate、獨立 Slice B、重複核准、write-set、來源與 API adapter。`npm run eval` 執行四種可重現情境：正常建置、缺來源、越界寫檔、semantic uncertain。Mock provider 會用已完成的介紹頁作為可重現的通過基準；它驗證 runtime 的控制邊界，不能代表真實 LLM 的設計品質。

若要讓 merged PR 自動啟動後續檢查，設定 `GITHUB_WEBHOOK_SECRET`，把 GitHub 的 pull request webhook 指向 `/api/webhooks/github`。PR 需合併到 `main`，且描述包含 `Harness-Run: <Slice A run ID>`。Handler 驗證 HMAC 簽章、merge 狀態與 gate，並以 delivery ID/commit 去重。此本機 eval 沒有自動建立 GitHub PR；webhook 行為以程式測試驗證。

## 架構邊界

`src/runtime.js` 唯一負責狀態轉換；`src/agent.js` 呼叫外部模型與 brokered tools；`src/policy.js` 驗證寫入與候選頁品質；`src/store.js` 用 SQLite 保存結構化 run/event/manifest，並以本機檔案作 blob storage。這是獨立可跑的 eval 專案；若用於多使用者正式部署，需替換持久化與 job 執行層並補上身分驗證、租戶隔離、佇列與故障恢復。

左側的步驟順序在 Harness Lab 中可見。Slice A 完成 checks 後進入 `awaiting_approval`，此時沒有 Slice B run；owner 核准才建立新 run 並重新執行 deterministic checks。候選頁由 sandboxed iframe 預覽。
