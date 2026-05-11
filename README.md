<p align="center">
  <img src="docs/assets/aixlarity-icon.png" width="96" alt="Aixlarity icon">
</p>

<h1 align="center">Aixlarity IDE</h1>

<p align="center">
  <strong>開源 AI agent IDE。把每一次 AI 修改變成可審核、可回放、可驗證的工程工作流。</strong>
</p>

<p align="center">
  <a href="README.en.md">English README</a>
  ·
  <a href="https://aixlarity.com">Product website</a>
  ·
  <a href="https://github.com/voidful/Aixlarity/releases/latest">Download</a>
  ·
  <a href="#快速開始">Quick start</a>
</p>

<p align="center">
  <a href="https://aixlarity.com"><img src="https://img.shields.io/badge/Website-aixlarity.com-0f766e?style=for-the-badge" alt="Website"></a>
  <a href="https://github.com/voidful/Aixlarity/releases/latest"><img src="https://img.shields.io/badge/Download-macOS%20%7C%20Windows%20%7C%20Linux-334155?style=for-the-badge" alt="Download"></a>
  <a href="https://github.com/voidful/Aixlarity/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-2f855a?style=for-the-badge" alt="License"></a>
</p>

<p align="center">
  <img src="docs/assets/aixlarity-ide-mission-control.png" alt="Aixlarity IDE Mission Control screenshot">
</p>

## 產品定位

Aixlarity 是一個開源、可本機執行、可審核的 AI coding agent IDE。它的目標不是再做一個聊天側欄，而是做一個 **Antigravity-style agent workbench**：任務、權限、diff、terminal、browser、provider、memory rules 全部有狀態、有證據、有審核點。

如果 AI agent 要真的進入工程流程，它不能只回答「我改好了」。Aixlarity 要讓使用者看到：

| 產品賣點 | 使用者得到什麼 |
|----------|----------------|
| **Mission Control** | 多 workspace、多 task、多 agent 的長任務控制台，能 pause / resume / cancel / retry |
| **Artifact Review** | plan、task list、diff、test report、screenshot、browser recording 都變成可批准或退回的 artifact |
| **Visual Diff Review** | 像 JuxtaCode / Meld 一樣逐檔、逐 hunk、逐輪確認 AI 修改 |
| **Evidence-first Automation** | Terminal Replay 與 Browser Evidence 保留 command、cwd、stdout/stderr、exit code、DOM、console、network、video |
| **Provider Freedom** | OpenAI、Anthropic、Gemini、OpenRouter、本地模型可依 user/workspace scope 切換，API key 不進匯出檔 |
| **Knowledge Ledger** | continuous learning 可審核、可匯出、可關閉，不是黑箱記憶 |

## 為什麼值得關注

Aixlarity 同時是一個產品與一本打開的工程書。IDE 是使用者入口；Rust runtime、provider layer、tool system、trust model、artifact system 是可讀的實作。你可以直接使用它，也可以拆開學會如何打造自己的 AI agent harness。

| 差異化 | 說明 |
|--------|------|
| **Open-source Antigravity-style IDE** | 把商業 AI IDE 的核心工作流做成可研究、可驗證、可改造的開源版本 |
| **Apple-like product discipline** | 介面保持簡潔，只顯示核心決策：任務、證據、審核、模型、權限 |
| **Submission-ready gates** | `quality`、`contracts`、`ui`、`submission` 測試把產品品質變成門檻 |
| **Teaching by product** | 文件不是旁觀式教材，而是從真實 IDE 介面一路追到 runtime 原始碼 |
| **No vendor lock-in** | provider、model、scope、secret hygiene 都有明確 UI 與行為 contract |

## 產品網站

🌐 **[aixlarity.com](https://aixlarity.com)**

首頁就是 Aixlarity IDE 的產品 landing page。它先展示 IDE 的核心賣點，再把 Mission Control、Artifact Review、Browser Evidence、Terminal Replay、Provider Control、Knowledge Ledger 對回 harness engineering 概念。

### 進入路徑

| 時間 | 路徑 | 適合誰 |
|------|------|--------|
| 5 分鐘 | 首頁 → IDE Demo 工作坊 | 想快速看懂產品能做什麼 |
| 10 分鐘 | IDE Harness Lab → Aixlarity IDE | 想理解 agent workbench 的核心 UX |
| 30 分鐘 | Evidence → Provider → Trust → Knowledge Ledger | 想評估它是否可靠、可審核、可控 |
| 1 小時 | 對照章 → 原始碼 | 想 fork、改造或打造自己的 agent IDE |

## 下載 Aixlarity IDE

Release workflow 會在原生 runner 上產出 macOS、Windows、Linux x64/arm64 版本，並把所有 artifact 附上 SHA-256 checksum。最新版本統一從 **[GitHub Releases](https://github.com/voidful/Aixlarity/releases/latest)** 下載。

| 系統 | 下載 |
|------|------|
| macOS Apple silicon | [Aixlarity-darwin-arm64.dmg](https://github.com/voidful/Aixlarity/releases/latest/download/Aixlarity-darwin-arm64.dmg) |
| macOS Intel | [Aixlarity-darwin-x64.dmg](https://github.com/voidful/Aixlarity/releases/latest/download/Aixlarity-darwin-x64.dmg) |
| Windows x64 | [Aixlarity-win32-x64-user-setup.exe](https://github.com/voidful/Aixlarity/releases/latest/download/Aixlarity-win32-x64-user-setup.exe) |
| Windows arm64 | [Aixlarity-win32-arm64-user-setup.exe](https://github.com/voidful/Aixlarity/releases/latest/download/Aixlarity-win32-arm64-user-setup.exe) |
| Linux x64 | [deb](https://github.com/voidful/Aixlarity/releases/latest/download/Aixlarity-linux-x64.deb) · [rpm](https://github.com/voidful/Aixlarity/releases/latest/download/Aixlarity-linux-x64.rpm) · [tar.gz](https://github.com/voidful/Aixlarity/releases/latest/download/Aixlarity-linux-x64.tar.gz) |
| Linux arm64 | [deb](https://github.com/voidful/Aixlarity/releases/latest/download/Aixlarity-linux-arm64.deb) · [rpm](https://github.com/voidful/Aixlarity/releases/latest/download/Aixlarity-linux-arm64.rpm) · [tar.gz](https://github.com/voidful/Aixlarity/releases/latest/download/Aixlarity-linux-arm64.tar.gz) |

第一次開啟 unsigned preview build 時，系統可能需要你手動信任。下載後可用 [SHASUMS256.txt](https://github.com/voidful/Aixlarity/releases/latest/download/SHASUMS256.txt) 驗證檔案。

## 從哪個產品學了什麼

| 來源 | 學到的設計 | 對應原始碼 |
|------|-----------|-----------|
| **Claude Code** | Prompt 組裝、Tool trait、Trust 邊界、Skill 系統 | `prompt.rs`, `tools.rs`, `trust.rs`, `skills.rs` |
| **Gemini CLI** | Terminal-first REPL、MCP 客戶端、Token Caching、Streaming | `main.rs`, `mcp.rs`, `cache.rs`, `output.rs` |
| **OpenAI Codex** | Sandbox 分級、Permission 三級制、apply-patch | `tools/container.rs`, `agent/permissions.rs`, `tools/apply_patch.rs` |
| **Hermes Agent** | 技能學習迴圈、雙重記憶、記憶安全掃描、Session 搜尋 | `skills.rs`, `tools/memory_tool.rs`, `tools/skill_manager.rs` |
| **agent-skills** | Persona 定義、引擎級工具限制、多智能體協作 | `instructions.rs`, `coordinator.rs`, `.aixlarity/personas/` |

## 快速開始

```bash
# 編譯
git clone https://github.com/voidful/Aixlarity.git && cd Aixlarity
cargo build --release

# 設定 API 金鑰（至少一個）
export GEMINI_API_KEY="AIza..."      # 免費額度最高

# 啟動互動式 REPL
./target/release/aixlarity

# 或執行單次任務
aixlarity exec "解釋這個 codebase 的架構"
```

更多用法請參考教學網站的[安裝指南](https://aixlarity.com)和[互動模式指南](https://aixlarity.com)。

## 架構

```
crates/
├── aixlarity-core/          # 核心邏輯庫（~12,000 行）
│   ├── agent.rs       # Agent 執行迴圈 + Permission + Streaming + Memory
│   ├── tools/         # 11 個內建工具 + coordinator（930 行 DAG 排程）
│   ├── providers.rs   # 多供應商管理（Gemini / OpenAI / Anthropic）
│   ├── prompt.rs      # Prompt 組裝引擎
│   ├── session.rs     # Session 持久化
│   ├── trust.rs       # 三級信任模型
│   ├── skills.rs      # 技能系統 + YAML frontmatter + Progressive Disclosure
│   ├── instructions.rs # 規範檔載入 + Persona 載入 + 工具限制解析
│   ├── mcp.rs         # MCP 客戶端
│   └── hooks.rs       # PreToolUse / PostToolUse 生命週期鉤子
├── aixlarity-cli/           # CLI 入口
│   └── main.rs        # clap 4 + rustyline REPL
aixlarity-ide/               # 圖形化 IDE（VS Code fork）
├── src/vs/workbench/contrib/aixlarity/browser/
│   ├── aixlarity.contribution.ts  # 註冊 sidebar view + context tracker
│   ├── aixlarityView.ts           # Agent workbench shell
│   └── aixlarity*View.ts          # Artifact / Diff / Provider / Knowledge / Mission 模組
```

## Aixlarity IDE

基於 VS Code (Code - OSS) 的圖形化 IDE，透過 JSON-RPC over IPC 與 `aixlarity` daemon 通訊。它的目標是做一個開源、簡潔、可驗證的 Antigravity-style harness 工作台：

| 功能 | 說明 |
|------|------|
| Mission Control | 多 workspace / task / artifact / approval 控制台，支援 pause / resume / cancel / retry |
| Artifact Review | Implementation Plan、Task List、Diff、Test Report、Screenshot、Browser Recording、Terminal Transcript 結構化審核 |
| Visual Diff Review | side-by-side / unified、compare rounds、hunk review、review gate、anchored comments |
| Integrated Browser Agent | DOM、console、network、screenshot、video、action timeline 都能成為 evidence |
| Terminal Replay | command ownership、cwd、env 摘要、stdout/stderr、exit code、duration、危險命令 approval |
| Provider Control Center | user/workspace scope、preset、import/export bundle、API provider model 必填、secret 不進 bundle |
| Knowledge Ledger | rules / memory / workflow / MCP activation 可審核、可匯出、可關閉 |
| Editor-native Actions | diagnostic hover、Problems panel、selection、terminal output 都可送給 agent |
| Local History | 追蹤檔案變動、原生 diff editor、一鍵 revert |

### IDE 驗收指令

```bash
cd aixlarity-ide
npm run test-aixlarity-quality     # CI-safe P1/P2/source/docs product gate
npm run test-aixlarity-contracts   # behavior contracts for extracted IDE models
npm run test-aixlarity-submission  # release gate: quality + Electron artifact readiness
npm run test-aixlarity-ui          # 啟動 Electron 做操作煙測
npm run compile-check-ts-native
npm run compile
```

## Persona 系統

`.aixlarity/personas/` 目錄包含 8 個內建角色定義（Markdown + YAML frontmatter 格式）：

| Persona | 角色 | 工具限制 |
|---------|------|----------|
| 📐 Architect | 系統設計、ADR | 唯讀 + spawn_agent |
| 💻 Developer | 寫 production code | 無限制 |
| 🔍 CodeReviewer | 五軸 code review | 唯讀 + shell |
| 🧪 TestEngineer | 測試策略 | 無限制 |
| 🛡️ SecurityAuditor | 安全審計 | 唯讀 + shell + fetch |
| 🚀 DevOps | CI/CD、部署 | 無限制 |
| 📝 TechWriter | 文件撰寫 | 唯讀 + write_file |
| 📊 DataEngineer | 資料管線 | 無限制 |

多智能體協作指令：

```bash
/ship          # 三路平行：CodeReviewer + TestEngineer + SecurityAuditor → Ship/No-Ship 判定
/spec          # 兩步序列：Architect 設計 → Developer 實作
/audit         # 單一：SecurityAuditor 深度安全審計
```

## 內建技能

`.aixlarity/skills/` 目錄包含可重用的 agent 技能（YAML frontmatter 格式，與 Hermes Agent 相容）：

```
.aixlarity/skills/
├── code-review/SKILL.md           # 程式碼審查
├── systematic-debugging/SKILL.md  # 系統化除錯（四階段根因分析）
├── tdd/SKILL.md                   # 測試驅動開發（RED-GREEN-REFACTOR）
├── writing-plans/SKILL.md         # 實作計畫撰寫
├── security-audit/SKILL.md        # 安全性審計
├── refactoring/SKILL.md           # 重構指南
├── documentation-review/SKILL.md  # 文件審查（文實相符檢查）
├── git-workflow/SKILL.md          # Git 工作流（原子 commit）
├── performance-analysis/SKILL.md  # 效能分析（含 token 效率）
└── architecture-review/SKILL.md   # 架構審查（依賴方向、層次違反）
```

## Permission 模型

| 等級 | write_file | shell | apply_patch | 說明 |
|------|------------|-------|-------------|------|
| `suggest` | ⚠️ 需確認 | ⚠️ 需確認 | ⚠️ 需確認 | 最安全 |
| `auto-edit` | ✅ 自動 | ⚠️ 需確認 | ⚠️ 需確認 | 預設值 |
| `full-auto` | ✅ 自動 | ✅ 自動 | ✅ 自動 | 僅限信任環境 |

## 設計靈感

| 來源 | 採納特性 |
|------|---------|
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | REPL 互動、Streaming、MCP、Token Caching |
| [OpenAI Codex](https://github.com/openai/codex) | Sandbox 分級、Permission 模型、apply-patch |
| [Claude Code](https://github.com/roger2ai/Claude-Code-Compiled) | Trust 邊界、Session 分支、Skill 系統 |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | 技能學習迴圈、雙重記憶、記憶安全掃描、Session 搜尋、Progressive Skill Disclosure |
| [agent-skills](https://github.com/addyosmani/agent-skills) | Persona 定義、引擎級工具限制、多智能體協作 |

## 參考資源

- [Martin Fowler — Harness Engineering](https://martinfowler.com/articles/harness-engineering.html)
- [Anthropic — Effective harnesses for long-running agents](https://docs.anthropic.com)
- [OpenAI — Harness engineering: leveraging Codex](https://openai.com)

## 授權

Apache-2.0

---

<p align="center">
  <sub>Built by <a href="https://github.com/voidful">@voidful</a> as an open-source AI agent IDE for reviewable, evidence-first coding workflows.</sub>
</p>
