# GemiClawDex (GCD)

> **高效能終端 AI 編碼代理** — 融合 Gemini CLI、OpenAI Codex 與 Claude Code 的設計精髓，以 Rust 打造。

## 特色

- 🦀 **Rust 原生** — 編譯為單一二進位檔 `gcd`，啟動迅速、記憶體安全
- 🤖 **Agent Loop** — 真正的 LLM 工具迴圈：送出 → 回覆 → 工具呼叫 → 執行 → 迴圈
- 🔧 **11 個內建工具** — read_file, write_file, list_dir, shell, search_files, fetch_url, apply_patch, spawn_agent, memory, skill_manager, session_search
- 🎯 **多供應商** — 同時支援 Gemini、OpenAI、Anthropic API（完整 Tool Calling）
- 🛡️ **Sandbox 策略** — 四級安全模型：off / read-only / workspace-write / container
- 🔒 **Permission Prompt** — 三級權限：suggest / auto-edit / full-auto（靈感來自 codex）
- 📡 **Streaming 輸出** — Gemini SSE 串流，逐字輸出不再等待
- 📊 **Token 追蹤** — 每次 session 自動追蹤 prompt/completion token 用量
- 🧠 **Context Window 管理** — 對話過長時自動壓縮 (compact) 歷史訊息
- 🔀 **Diff 預覽** — write_file 自動生成 unified diff，apply_patch 工具精準修改
- 📝 **Session 持久化** — 自動保存對話歷史，支援 resume / fork
- 🌐 **Web Fetch** — 內建 fetch_url 工具，直接在 agent 內抓取網頁內容
- 🧩 **批次協調器** — `spawn_agent` 支援 `tasks[]`、依賴 DAG、ready batch 平行執行與阻塞傳播
- 🔁 **Runtime 繼承** — sub-agent 會沿用父層 fallback providers、plugin tools 與協調上下文
- 👀 **協調事件證據** — session / replay 可見 coordinator batch、delegated task lifecycle 與聚合結果
- 🔄 **Git 整合** — `--git` 自動在 session 結束後 commit 變更
- 📋 **Planning 輸出** — `--plan` 產生 execution plan 與 prompt 預覽，方便人工確認
- 🧬 **雙重記憶系統** — MEMORY.md（環境知識）+ USER.md（使用者偏好），agent 可透過 `memory` 工具自主讀寫，含安全掃描防注入（Hermes-inspired）
- 🎓 **技能學習迴圈** — `skill_manager` 工具讓 agent 在成功完成任務後自動建立可重用 skill，支援 create/edit/patch/delete（Hermes-inspired）
- 🔍 **Session 搜尋** — `session_search` 工具搜尋過往對話紀錄，回溯類似問題的解法
- 📑 **Progressive Skill Disclosure** — 技能支援 YAML frontmatter，三層漸進載入（metadata → full body → linked files），節省 token
- 🛡️ **記憶安全掃描** — 寫入 MEMORY.md / USER.md / SKILL.md 前自動掃描 prompt injection 與 exfiltration pattern
- 💻 **互動式 REPL** — rustyline 行編輯，支援歷史記錄、Ctrl+R 搜尋

## 快速開始

```bash
# 編譯
cargo build --release

# 互動模式（直接啟動 REPL）
./target/release/gcd

# 執行單次任務
gcd exec "解釋這個 codebase 的架構"

# 指定供應商
gcd exec --provider gemini-env "寫一個測試"

# 使用 suggest 權限（寫入前需確認）
gcd exec --permission suggest "重構這個函數"

# 全自動模式
gcd exec --permission full-auto "修復所有編譯錯誤"

# 執行後自動 git commit
gcd exec --git "加入錯誤處理"

# 規劃模式：先產生 execution plan
gcd exec --plan "重新設計模組架構"

# 禁用 streaming
gcd exec --no-stream "列出所有 TODO"

# 檢視工作區概述
gcd overview

# 管理供應商
gcd providers list
gcd providers doctor

# JSON 輸出
gcd overview --json
```

## 環境變數

| 變數 | 說明 |
|------|------|
| `GEMINI_API_KEY` | Google Gemini API 金鑰 |
| `OPENAI_API_KEY` | OpenAI API 金鑰 |
| `ANTHROPIC_API_KEY` | Anthropic API 金鑰 |
| `GCD_PROVIDER` | 預設供應商 ID |
| `GCD_SANDBOX` | 預設 sandbox 策略 |

## Multi-Agent 協調補強

參考 [open-multi-agent](https://github.com/JackChen-me/open-multi-agent) 後，GCD 的 `spawn_agent` 不再只是單一子任務委派，而是可以在同一個工具呼叫裡處理一組帶依賴的工作：

```json
{
  "tasks": [
    { "name": "scan", "task": "掃描目前模組缺口並列出要改的檔案" },
    { "name": "design", "task": "提出最小可行設計", "depends_on": ["scan"] },
    { "name": "implement", "task": "依設計實作變更", "depends_on": ["design"] },
    { "name": "review", "task": "檢查回歸風險與測試缺口", "depends_on": ["implement"] }
  ],
  "strategy": "parallel",
  "max_concurrency": 2,
  "shared_context": "保持 core crate 輕量、不要引入不必要依賴"
}
```

這個協調器現在具備：

- 依賴驗證與 cycle detection
- ready task batch 的平行執行
- failed / blocked task 的明確狀態回傳
- 聚合 token usage 與子任務摘要
- 繼承父層 fallback provider、plugin tools、sandbox / permission 與上層 prompt context
- 在 `sessions replay` / JSONL 事件流中留下 coordinator started / batch started / task started / task blocked / task completed / coordinator completed 證據

## 架構

```
crates/
├── gcd-core/      # 核心邏輯庫
│   ├── agent.rs   # Agent 執行迴圈
│   │              #   ├─ Permission Prompt (3-level)
│   │              #   ├─ Streaming (Gemini SSE)
│   │              #   ├─ Context Window 管理 (auto-compact)
│   │              #   ├─ Token 用量追蹤
│   │              #   ├─ Git 自動 commit
│   │              #   ├─ Planning 模式
│   │              #   └─ Memory 系統
│   ├── tools.rs   # Tool trait + 11 個內建工具
│   │              #   ├─ read_file, write_file (含 diff 預覽)
│   │              #   ├─ list_dir, shell (10KB 輸出截斷)
│   │              #   ├─ search_files (rg/grep)
│   │              #   ├─ fetch_url (web 抓取)
│   │              #   ├─ apply_patch (unified diff 修補)
│   │              #   ├─ spawn_agent (coordinator 子任務委派)
│   │              #   ├─ memory (雙重記憶: MEMORY.md + USER.md)
│   │              #   ├─ skill_manager (技能學習迴圈: create/edit/patch/delete)
│   │              #   └─ session_search (過往對話搜尋)
│   ├── providers.rs   # 多供應商管理
│   │                  #   ├─ Gemini (完整 functionCall)
│   │                  #   ├─ OpenAI (完整 tool_calls)
│   │                  #   └─ Anthropic (完整 tool_use)
│   ├── prompt.rs      # Prompt 組裝引擎
│   ├── session.rs     # Session 持久化
│   ├── trust.rs       # 工作區信任邊界
│   ├── config.rs      # 路徑檢測與偏好設定
│   ├── commands.rs    # 自訂命令
│   ├── skills.rs      # 技能系統 (SKILL.md + YAML frontmatter + progressive disclosure)
│   ├── hooks.rs       # PreToolUse / PostToolUse 生命週期鉤子
│   ├── plugins.rs     # Plugin JSON 工具擴充
│   ├── mcp.rs         # MCP (Model Context Protocol) Client
│   ├── app.rs         # 命令路由 facade
│   ├── output.rs      # 輸出渲染
│   ├── workspace.rs   # 工作區探測
│   ├── cache.rs       # Token cache (hash-based, TTL 過期)
│   ├── worktree.rs    # Git worktree 執行隔離
│   └── instructions.rs # AGENTS.md / GEMINI.md / CLAUDE.md / GCD.md 載入
├── gcd-cli/       # CLI 入口 → 二進位名稱: gcd
│   └── main.rs    # clap 4 + rustyline REPL + colored 輸出
```

## Permission 模型

| 等級 | write_file | shell | apply_patch | 說明 |
|------|-----------|-------|-------------|------|
| `suggest` | ⚠️ 需確認 | ⚠️ 需確認 | ⚠️ 需確認 | 最安全，適合不熟悉的 codebase |
| `auto-edit` | ✅ 自動 | ⚠️ 需確認 | ⚠️ 需確認 | 預設值，寫檔自動但 shell 需批准 |
| `full-auto` | ✅ 自動 | ✅ 自動 | ✅ 自動 | 完全自動，僅限信任的工作區 |

## 設計靈感

| 來源 | 採納特性 |
|------|----------|
| [gemini-cli](https://github.com/google-gemini/gemini-cli) | REPL 互動、Streaming、MCP、Token Caching |
| [openai/codex](https://github.com/openai/codex) | Sandbox 分級、Permission 模型、apply-patch |
| [Claude Code](https://github.com/roger2ai/Claude-Code-Compiled) | Trust 邊界、Session 分支、Skill 系統 |
| [claurst](https://github.com/Kuberwastaken/claurst) | Rust 重寫方法論、Dream 記憶系統、Coordinator |
| [open-agent-sdk](https://github.com/codeany-ai/open-agent-sdk-typescript) | Agent SDK 抽象層設計 |
| [hermes-agent](https://github.com/NousResearch/hermes-agent) | 技能學習迴圈、雙重記憶系統、記憶安全掃描、Session 搜尋、Progressive Skill Disclosure |

## 授權

Apache-2.0
