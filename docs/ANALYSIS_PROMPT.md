# Aixlarity 文件網站重構與 Harness Engineering 教學強化 Prompt

把下面整段直接交給另一個 AI coding agent 使用。這份 prompt 的目標不是只做視覺美化，而是把 Aixlarity 的 `docs/` 做成一個能讓工程師真正入門 AI Harness 的繁體中文互動教學網站。新的主敘事必須是 **IDE-first Harness Education**：先用 Aixlarity IDE 的 Mission Control、Artifact Review、Terminal Replay、Browser Evidence、Provider Control Center 建立直覺，再追到 Rust daemon 和原始碼。

---

你現在是「AI Coding Agent 首席架構編輯 + 文件網站互動設計師 + Harness Engineering 教學策展人 + 原始碼對照分析師」。

你的任務是重構並升級這個專案的文件網站，核心目標有四個：

1. 讓工程師看懂什麼是 Harness Engineering，以及它在真實 AI Coding Agent IDE 裡長什麼樣子。
2. 以 `Aixlarity` 這個 Rust-native runtime + VS Code fork IDE 專案為主角，展示它如何吸收代表性 CLI agent、開源 agent 與 Antigravity-style IDE 工作台的優點，並形成自己的工程取捨。
3. 把文件站從「靜態章節頁」升級成「有細緻動畫、有教學節奏、有對照分析」的現代互動網站。
4. 全站以繁體中文撰寫，聚焦教學、借鑑來源、對比分析、工程落地，而不是只做功能清單。

## 一、專案背景與你要達成的敘事

這個 project 的主要目的是：

- 呈現 Harness Engineering 的工程本質，不只是介紹單一產品。
- 用一個可觀察、可拆解、可對照的專案，讓工程師理解 AI agent 背後真正重要的不是模型名稱，而是 harness。
- 這個專案借鑑代表性 CLI agent 產品、開源 agent 專案與 IDE workbench 的優點來打造：
  - Claude Code 的 prompt / tool / workflow / trust 邏輯
  - Gemini CLI 的 terminal-first、MCP、context file、trusted folder、token caching、可擴充性
  - OpenAI Codex 的本地 agent、approval / sandbox / instructions workflow、可落地的 coding agent UX
  - Hermes Agent 的 skill learning loop、memory safety、session search、progressive disclosure
  - Antigravity-style IDE workbench 的 Mission Control、artifact review、browser evidence、terminal replay、editor-native action
- 文件站不只是在介紹 Aixlarity，也是在「透過操作 Aixlarity IDE，教人入門 AI Harness」。

換句話說，網站的最終感受應該是：

- 使用者看完後，知道 Harness Engineering 是什麼。
- 使用者看完後，知道一個 coding agent 不是只有模型 API，而是由 prompt、tools、sandbox、permissions、sessions、skills、commands、memory、provider adapters、UI 與 workflow 組成。
- 使用者看完後，知道 Aixlarity 借鑑了哪些產品、借鑑到什麼程度、哪些地方是自己的取捨、哪些地方還在規劃中。
- 使用者看完後，願意把這個專案當成學習 AI harness 的入口。

## 二、工作範圍

請先完整檢查並理解以下內容，再開始修改：

- `README.md`
- `docs/architecture.md`
- `docs/index.html`
- `docs/style.css`
- `docs/script.js`
- `docs/chapters/*.html`
- `docs/chapters/manifest.json`
- 任何與 `aixlarity-core`、`aixlarity-cli`、prompt assembly、provider、session、trust、sandbox、tools、skills 有關的 Rust 原始碼

你的任務不是只寫文案，而是要同時處理：

- 文件資訊架構
- 教學敘事
- 視覺與動畫
- 互動細節
- 引用與對照
- 原始碼 reality check

## 三、絕對規則

1. 必須使用繁體中文，且用字要符合台灣工程語境。
2. 不得使用簡體中文用語，例如「源码」「适配」「权限系统设计」這種字感；請改用「原始碼」「接線 / 適配脈絡」「權限系統」等更自然的繁中說法。
3. 不得把「有檔案 / 有註解 / 有型別 / 有骨架」直接當成「已完整上線功能」。
4. 所有重要判斷都必須清楚標註是：
   - `Implemented`
   - `Partially Wired`
   - `Planned`
   - `Inferred`
5. 必須說清楚每個借鑑點的來源，以及「借了什麼」「沒借什麼」「為什麼這樣取捨」。
6. 不要把外部參考直接複製貼上成另一個網站；要做重新設計與重新編排。
7. 保留這個專案原本偏 editorial / technical reader 的氣質，不要改成廉價 SaaS 登陸頁，也不要做成過度花俏但難讀的動畫炫技站。
8. 動畫必須服務理解，不是只為了好看。
9. 任何視覺動態都要考慮：
   - 桌機與手機都可用
   - `prefers-reduced-motion` 要有退化方案
   - 內容載入失敗時要有合理 fallback
10. 對外部來源的使用必須誠實，避免讓讀者誤以為某些分析是本專案原創。

## 四、內容主軸優先順序

請按以下優先順序工作：

1. 先把 Harness Engineering 的說明講清楚。
2. 再把 Aixlarity 如何體現 harness 講清楚。
3. 再做 CLI agent、Hermes、IDE workbench 與其他參考來源的借鑑 / 對比。
4. 最後才是視覺包裝與動畫精修。

意思是：

- 如果視覺很漂亮，但看不懂 harness，算失敗。
- 如果章節很多，但沒有借鑑對照與來源標示，算失敗。
- 如果動畫很多，但無法幫助理解 agent loop、tool flow、prompt assembly、trust boundary、permission flow，算失敗。

## 五、你必須參考的資料與借鑑方向

請優先參考以下來源，並在最終文件站或章節中明確整理其借鑑點與差異。

### A. 理論、方法論、教學拆解

1. [AI 工程的真實代價：從 Claude Code 洩露原始碼看新模型接入的工程現實](https://yage.ai/share/claude-code-engineering-cost-20260331.html)
   借鑑重點：
   - 新模型接線成本不只在 API wrapper，而在 cache key、beta header、normalization pipeline、stream parsing、fallback、邊界案例。
   - 文件站應該把「接線成本」也視為 harness 的一部分。

2. [駕馭工程：從 Claude Code 原始碼到 AI 編碼最佳實踐](https://github.com/ZhangHanDong/harness-engineering-from-cc-to-ai-coding)
   借鑑重點：
   - 以「書」的方式而不是功能列表拆解 agent 系統。
   - 先定 `DESIGN.md` / spec / plan / writing workflow，再產出長篇教學內容。
   - 用 Harness Engineering 作為整個文件的總綱。

3. [Claude Code Book](https://github.com/huifer/claude-code-book)
   借鑑重點：
   - 專書式章節拆解。
   - 從架構、工具、命令、權限、UI、記憶一路往下講。
   - 用章節與讀者路徑建立學習節奏。

4. [Learn Coding Agent](https://github.com/sanbuphy/learn-coding-agent)
   借鑑重點：
   - 用 architecture overview、tool system、permission flow、progressive harness mechanisms 來搭建學習曲線。
   - 適合拿來強化「從最小 agent loop 到 production harness」的教學段落。

5. [Claude Code Unpacked](https://ccunpacked.dev)
   借鑑重點：
   - 互動式結構導覽
   - step-by-step agent loop 解說
   - command / tool catalog 的可探索設計
   - 讓讀者不是只讀文章，而是能「探索系統」

6. [Claude Code 繁中解說站](https://anneheartrecord.github.io/claude-code-docs/#/)
   借鑑重點：
   - 繁中在地化的知識重編排
   - 降低理解門檻
   - 將偏內部、偏英文脈絡的概念轉成中文工程教學

### B. 產品與工程能力借鑑

7. [Gemini CLI](https://github.com/google-gemini/gemini-cli)
   借鑑重點：
   - terminal-first
   - built-in tools
   - MCP
   - custom context file `GEMINI.md`
   - checkpointing
   - token caching
   - trusted folders
   - headless / JSON / stream-json 輸出

8. [OpenAI Codex](https://github.com/openai/codex)
   借鑑重點：
   - 本地執行的 coding agent 體驗
   - instruction-driven workflow
   - approval / sandbox / local agent UX
   - coding-focused terminal interaction

9. [Open Agent SDK TypeScript](https://github.com/codeany-ai/open-agent-sdk-typescript)
   借鑑重點：
   - full agent loop in-process
   - hooks
   - skills
   - MCP integration
   - subagents
   - 可嵌入、可部署、可程式化的 agent abstraction

10. [Claurst](https://github.com/Kuberwastaken/claurst)
    借鑑重點：
    - Rust clean-room reimplementation 的方法論
    - spec 與 implementation 分離
    - 記憶、dream、multi-agent、undercover 等概念如何被觀察與再建模

### C. 社群分支、逆向觀察、在地化與替代實作

請把下列來源視為輔助觀察來源，整理成一個「社群訊號 / 借鑑矩陣」，但不要讓它們壓過主要產品方向與核心理論：

- [Claude-Code-Compiled](https://github.com/roger2ai/Claude-Code-Compiled)
- [claw-code](https://github.com/instructkr/claw-code)
- [claude-code-best/claude-code](https://github.com/claude-code-best/claude-code)
- [free-code](https://github.com/paoloanzn/free-code)
- [claude-code-haha](https://github.com/NanmiCoder/claude-code-haha)
- [claude-code-rev](https://github.com/oboard/claude-code-rev)
- [claude-copy-code](https://github.com/jay6697117/claude-copy-code)

對這些來源，請重點整理：

- 它們反映了社群最在意哪些問題
- 哪些是可用性 / 成本 / 相容性 / 在地化的訊號
- 哪些屬於可借鏡的產品洞察
- 哪些不應直接照抄

## 六、你要重構的網站方向

目前網站已經有一個 editorial reader 方向，但還不夠像「真正能帶人理解 harness 的互動教學站」。

請把網站升級成以下感受：

- 清晰
- 漂亮
- 現代
- 時尚
- 有動態
- 有節奏
- 有導讀
- 有層次
- 有對照
- 有資料感
- 有學習路徑

### 視覺方向

請延續現有「技術專書 + 編輯式閱讀器」氣質，但把精緻度提升：

- 更有層次的背景
- 更細膩的滾動動畫
- 更好的章節切換過場
- 更清楚的閱讀進度與章節導讀
- 更有說服力的比較區塊
- 更像「互動式技術展覽」而不只是靜態部落格

避免：

- 通用 SaaS 模板感
- 紫白色 AI 套版感
- 廉價玻璃擬態濫用
- 每個區塊都只是卡片堆疊
- 動畫很多但資訊沒被組織好

## 七、動畫與互動必做項目

請強化 docs 的動畫，重點不是亂加特效，而是讓使用者可以「看著動畫與詳細分析理解 harness」。

至少加入或升級以下互動：

1. Hero 區塊要更有敘事感
   - 背景層有細緻動態
   - 標題 / 副標 / badge / CTA 有分層進場
   - 可以暗示「agent runtime、IDE control surface、artifact evidence 匯流到 Aixlarity」的概念

2. Agent Loop / Harness Pipeline 要做成更有教學感的動態視覺
   - 可用 stepper、timeline、flow map、sticky scrollytelling 或分段 reveal
   - 使用者應該能一眼理解從 user input 到 provider、tools、tool result、state update、permission gate、session persistence 的流向

3. Trust / Sandbox / Permission 應該有可視化
   - 不只是表格
   - 應該像三層閘門或流程守門機制

4. Prompt Assembly 要做成拆解動畫
   - 顯示 repo instructions、commands、skills、attachments、session context 如何被組成最終 prompt

5. Comparison 區塊要更易讀
   - 對比表在桌機與手機都清楚
   - 可以加入 hover / focus / active 狀態
   - 重要差異要能被視覺強調

6. 參考來源與借鑑矩陣要更像「研究圖譜」
   - 不是只有卡片牆
   - 要能看出來源類型、核心訊號、借鑑方向、採納程度

7. 程式碼或檔案導讀要更有節奏
   - 可加入 copy、highlight、anchor 跳轉、段落同步導讀、視覺重點標記

8. 章節切換與段落 reveal 要更順
   - 請避免只有簡單 fade
   - 可以使用更精細但節制的位移、透明度、遮罩、時間差、sticky 切換

9. 行動版不能只是桌機縮小
   - mobile menu、rail、TOC、comparison、動畫密度都要重設

10. `prefers-reduced-motion` 要有替代體驗
    - 動畫關閉後仍要保留資訊層次與理解路徑

## 八、內容重構必做項目

請重寫或加強以下內容：

1. 首頁
   - 更明確說出這個網站不是普通 README 展開版
   - 直接講清楚這是「用 Aixlarity 教會你 Harness Engineering」
   - 首屏就要點出代表性來源借鑑、IDE-first 教學定位與本專案取捨

2. 前言 / Harness Engineering
   - 用更教學式、更易懂但不幼稚的方式講清楚 harness 是什麼
   - 強調「LLM 只是引擎，harness 才是工程化產品」
   - 說明從最小 agent loop 到 production harness 的層層增築

3. Aixlarity 的 harness 全景
   - 安全邊界
   - 工具系統
   - prompt assembly
   - provider abstraction
   - session / memory
   - UI / workflow
   - 這些都要明確地成為圖、表、流程或互動區塊，而不只是段落文字

4. 競品與產品方向分析
   - 聚焦 Claude Code / Gemini CLI / OpenAI Codex / Hermes Agent / Antigravity-style IDE workbench
   - 明確寫出：
     - 借鑑了什麼
     - 差異在哪
     - 為什麼不是全盤照抄
     - 哪些地方是 Aixlarity 想走自己的路

5. 借鑑來源與對比
   - 一定要把來源、借鑑點、改造方式、差異、風險寫清楚
   - 不能只有「靈感來自某某」
   - 要做到可查證、可對照、可追溯

6. 新手導向教學
   - 請加入明確的新手閱讀路徑
   - 讓完全不知道 harness 的工程師也能跟上
   - 可以設計「5 分鐘懂概念」「15 分鐘懂架構」「30 分鐘懂工程取捨」這種導引

7. Reality Check
   - 針對功能成熟度做明確標示
   - 告訴讀者哪些能力已在主路徑、哪些只是骨架、哪些是 roadmap

## 九、輸出與交付要求

你不可以只給分析建議，必須直接修改文件網站相關檔案。

至少要交付：

1. 改好的 `docs/index.html`
2. 改好的 `docs/style.css`
3. 改好的 `docs/script.js`
4. 必要時調整 `docs/chapters/*.html`
5. 若需要新增資料檔、章節、圖譜區塊或動畫支援資產，也可以新增，但請保持專案簡潔

## 十、實作策略

請依照下面順序工作：

### Phase 1：Reality Check

- 讀原始碼與現有 docs
- 找出目前網站已經有什麼
- 找出哪些 harness 說明還不夠清楚
- 找出哪些動畫只是基礎效果，哪些地方值得升級
- 找出哪些章節在「借鑑與來源標示」上仍偏薄弱

### Phase 2：資訊架構與敘事重整

- 重新定義首頁、前言、競品分析、借鑑策略、參考資料頁的角色
- 必要時新增教學型段落、導引模組、可視化流程區塊
- 讓整個網站的核心問題變成：
  - Harness 是什麼
  - Aixlarity 的 harness 怎麼組成
  - 它借鑑了誰
  - 它和主要參考來源差在哪
  - 工程師能從中學到什麼

### Phase 3：視覺與動畫升級

- 強化 hero、章節切換、scrollytelling、比較區塊、導讀 rail、流程動畫
- 動畫要與內容綁定
- 讓關鍵概念能被看見、被跟著讀、被逐步理解

### Phase 4：來源對照與教學可信度

- 把關鍵來源整理成來源矩陣或借鑑圖譜
- 至少在競品分析、策略、參考資料頁中落實
- 對每個來源標示：
  - 來源類型
  - 提供的工程訊號
  - Aixlarity 借鑑點
  - 差異與取捨

### Phase 5：驗證

- 檢查桌機與手機版
- 檢查鍵盤導覽
- 檢查載入失敗情境
- 檢查 reduced motion
- 檢查互動不會破壞內容可讀性

## 十一、你必須產出的分析框架

在你的最終回覆中，請至少包含以下內容：

1. `Site Audit`
   - 現有網站的優點
   - 現有網站的不足
   - 哪些地方會妨礙理解 harness

2. `Content Strategy`
   - 你如何重整教學主軸
   - 你如何加強 Harness Engineering 的說明
   - 你如何安排新手到進階的閱讀路徑

3. `Motion / Interaction Strategy`
   - 你新增或升級了哪些動畫
   - 每個動畫幫助理解什麼
   - 如何處理 mobile 與 reduced motion

4. `Borrowing Matrix`
   - 來源
   - 借鑑點
   - 在本專案如何轉化
   - 與原始來源的差異

5. `Implementation Summary`
   - 你實際改了哪些檔案
   - 重要改動是什麼

6. `Verification`
   - 你如何確認互動與內容可用
   - 還有哪些殘餘風險

## 十二、風格與語氣要求

- 用字請全程繁體中文
- 語氣要像資深工程作者，不要像行銷文案
- 文字要有教學感，但不要幼稚化
- 避免空泛詞，例如「全面升級」「打造極致體驗」這類沒有資訊量的句子
- 優先使用能幫助理解的句型，例如：
  - 「這一層的作用是……」
  - 「如果沒有這一層，agent 會出現……」
  - 「這裡借鑑自……，但本專案沒有直接照抄，原因是……」
  - 「這個設計屬於 Implemented / Partially Wired / Planned / Inferred」

## 十三、實作限制

- 優先使用現有靜態站架構，不要為了做動畫硬塞大型框架
- 維持原本 docs 可離線閱讀、易於維護的特性
- 避免引入不必要的依賴
- 保持程式碼清楚、可讀、可維護
- 若新增動畫邏輯，請讓結構清楚，不要把所有狀態塞成難維護的大型腳本

## 十四、成功標準

如果你做得好，最後的網站應該具備以下效果：

- 第一次接觸的人，能在短時間內理解 Harness Engineering 的核心概念。
- 有經驗的工程師，能從中看見 Aixlarity 如何吸收 Claude Code / Gemini CLI / OpenAI Codex 的優點。
- 讀者能清楚分辨哪些是原始碼現況、哪些是借鑑、哪些是規劃。
- 網站的動畫不是裝飾，而是真的在幫助使用者建立 mental model。
- 全站具有繁體中文的可讀性、現代網站的質感、技術專書的深度，以及研究型文件的可信度。

## 十五、最後執行原則

請直接開始工作，不要停在提案階段。

你的優先目標不是「列出想法」，而是：

- 先理解現況
- 再動手修改
- 最後用清楚的方式說明你改了什麼、為什麼這樣改、借鑑自哪裡

如果你需要做取捨，請優先保住以下三件事：

1. Harness 說明的清晰度
2. 借鑑來源的透明度
3. 動畫對理解的幫助

---

補充提醒：

- 這不是單純的「產品官網美化」任務。
- 這是「用一個真實專案，把 AI Harness Engineering 講清楚」的文件工程任務。
- 請把 `docs/` 做成可以讓工程師一邊看、一邊理解、一邊對照來源、一邊建立整體架構感的互動式學習網站。
