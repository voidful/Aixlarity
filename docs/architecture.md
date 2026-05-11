# Aixlarity Architecture

## Design Goal

Aixlarity is an open-source teaching project for Harness Engineering. Its goal is not to prove that one model is better than another; its goal is to show how an AI coding agent becomes a product when the harness around the model is explicit, inspectable, and testable.

The current architecture has two first-class surfaces:

1. **Aixlarity IDE** — a VS Code fork that teaches the human control surface: Mission Control, Artifact Review, Browser Evidence, Terminal Replay, Provider Control Center, and editor-native actions.
2. **Rust daemon / CLI** — the runtime that owns agent execution, prompt assembly, provider adapters, tool permissions, sessions, local history, mission state, and evidence persistence.

The IDE is the best teaching entry point. The Rust runtime is the source of truth.

## Core Product Bets

1. **IDE-first teaching, Rust-backed execution.** Use the IDE to make invisible harness concepts visible, then trace each behavior back into Rust code.
2. **Evidence-first agent work.** Agent claims should become artifacts, transcripts, screenshots, browser recordings, test reports, and review events.
3. **Human-in-the-loop by design.** Tool approval, hunk review, artifact approval, and provider scope decisions are product surfaces, not afterthoughts.
4. **Provider neutrality.** Gemini, OpenAI, Anthropic, OpenRouter, external CLIs, and local models should share one provider model where possible.
5. **Trust and sandbox policy are engine concerns.** Prompt-only restrictions are educational but insufficient; permissions and tool availability must be enforced by the harness.
6. **Offline inspectability.** Core logic and state formats should remain readable and testable without API keys or network access.

## Control Plane Overview

```text
┌──────────────────────────────────────────────────────────────┐
│ Aixlarity IDE (TypeScript / VS Code fork / Electron)          │
│                                                              │
│ Chat / Provider / Persona / Approval                         │
│ Mission Control / Artifact Review / Visual Diff              │
│ Browser Control / Terminal Replay / Studio Policy            │
│ Editor actions: hover, Problems, selection, terminal output   │
└──────────────────────┬───────────────────────────────────────┘
                       │ JSON-RPC over Electron IPC
┌──────────────────────▼───────────────────────────────────────┐
│ aixlarity daemon / CLI (Rust)                                 │
│                                                              │
│ App facade / prompt assembly / provider adapters              │
│ Agent loop / tools / permission gates / sandbox policy        │
│ Sessions / Mission Control / Local History / Evidence export  │
└──────────────────────────────────────────────────────────────┘
```

## Crates and Product Surfaces

### `aixlarity-core`

Owns the domain logic:

- workspace discovery and trust evaluation
- provider registry, scoped provider mutation, active-provider resolution
- prompt assembly with instructions, commands, skills, attachments, memory, and session context
- provider adapters and streaming normalization
- tool registry, tool permissions, sandbox policy, hooks, plugins, MCP tools
- dual-memory system: `MEMORY.md` + `USER.md`
- skill loading and progressive disclosure
- persona loading and engine-level tool filtering
- session persistence, checkpointing, resume, fork, replay
- Mission Control durable state: tasks, artifacts, audit log, workspace index, studio state
- evidence artifacts: code diff, terminal transcript, browser recording, screenshots, test reports

### `aixlarity-cli`

Owns command-line interaction and JSON-RPC daemon routing:

- `exec`, REPL, JSON / JSONL output
- `providers`, `trust`, `sessions`, `checkpoints`, `history`
- IDE daemon methods such as `agent_chat`, `mission_control/load`, `artifacts/list`, `artifacts/review`, `studio/save`
- approval request / response routing for IDE-driven tool permissions

### `aixlarity-ide`

Owns the graphical harness workbench:

- Chat view with streaming Markdown, think folding, attachments, provider/persona controls
- Mission Control for task state, pending approvals, review queue, audit events, workspace index
- Artifact System with review comments, approval/rejection, evidence export
- Visual Diff Review with side-by-side/unified modes, hunk review, compare rounds, review gate
- Integrated Browser Agent evidence playback: DOM, console, network, screenshot, video
- Terminal Replay with command ownership, cwd, env summary, stdout/stderr, exit code, duration
- Provider Control Center with user/workspace scope, presets, import/export bundle, model validation
- Editor-native agent actions for diagnostics, Problems panel, selection, and terminal output
- Local History with `aixlarity-history://`, native diff editor, and one-click revert

## Configuration Model

`Aixlarity` uses a blended filesystem layout:

- global home: `~/.aixlarity/`
- workspace config: `<repo>/.aixlarity/`
- provider profiles: `providers.conf`
- active provider pins: `active-provider.txt`
- saved sessions: `~/.aixlarity/sessions/<session-id>/`
- Mission Control state: `<repo>/.aixlarity/state/mission_control.json`
- artifact mirrors and evidence bundles: `<repo>/.aixlarity/artifacts/`
- audit log: `<repo>/.aixlarity/state/audit.jsonl`
- dual memory: `<repo>/.aixlarity/MEMORY.md` + `<repo>/.aixlarity/USER.md`
- user skills: `~/.aixlarity/skills/{name}/SKILL.md`
- repo instructions: `<repo>/AGENTS.md`
- optional persistent context: `<repo>/GEMINI.md`, `<repo>/CLAUDE.md`, `<repo>/AIXLARITY.md`
- agent personas: `<repo>/.aixlarity/personas/{name}.md`

## Execution Pipeline

1. IDE or CLI receives a task.
2. Workspace root is resolved; IDE additionally sends active editor context.
3. Trust state is evaluated before workspace instructions, commands, skills, and providers are loaded.
4. Provider profile is resolved from explicit request, conversation state, workspace pin, user pin, or default.
5. Prompt assembly combines task text, instructions, command expansion, skill context, attachments, memory, and session lineage.
6. Tool list is filtered by persona, sandbox, trust, and permission policy.
7. Agent loop calls the selected provider and executes tool calls through the registry.
8. High-risk actions request approval when policy requires it.
9. Tool results return to the model and are also recorded as events.
10. Code diffs, browser evidence, terminal transcripts, screenshots, and reports are mirrored into artifacts.
11. Session turns, Mission Control state, audit events, and local history are persisted.
12. IDE refreshes Mission Control and Artifact Review so the user can approve, reject, continue, or export evidence.

## Validation Model

The project keeps documentation promises tied to executable checks:

```bash
cargo test -p aixlarity-core
cargo test -p aixlarity

cd aixlarity-ide
npm run test-aixlarity-quality
npm run test-aixlarity-contracts
npm run test-aixlarity-p1
npm run test-aixlarity-p2
npm run test-aixlarity-submission
npm run test-aixlarity-ui
npm run compile-check-ts-native
npm run compile
```

`test-aixlarity-quality` is the CI-safe product gate for IDE source readiness, P1/P2 capability coverage, and docs homepage quality. `test-aixlarity-submission` is the release gate: it runs the product gate and then checks generated Electron artifact identity, including macOS bundle ID, URL protocol, icon resources, compiled entrypoints, and release agent binary availability.

## Teaching Path

Use this order when teaching the architecture:

1. Start in **Aixlarity IDE** and show approval, artifact review, terminal transcript, and browser recording.
2. Open `aixlarityView.ts` to show the control surface and JSON-RPC bridge.
3. Open `crates/aixlarity-cli/src/main.rs` to show daemon RPC routing.
4. Open `crates/aixlarity-core/src/app.rs` and `prompt.rs` to show pre-model harness preparation.
5. Open `agent.rs`, `tools/`, and `mission_control.rs` to show runtime execution and durable evidence.

The learning goal is simple: readers should leave understanding that an AI coding agent is not a model call. It is a product-shaped harness around model calls.
