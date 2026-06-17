---
name: kimi-agent
description: Reference for Kimi K2.6 and the Kimi Code CLI / kimi-agent-sdk agentic runtime — model capabilities, built-in tools, CLI/SDK features, and how Max's kimi-agent provider uses them. Load when working with the kimi-agent provider.
compatibility: "Designed for Max personal assistants using the kimi-agent provider"
metadata:
  emoji: "🌙"
  max:
    display-name: "Kimi Agent SDK"
    user-invocable: true
---

# Kimi Agent SDK — capabilities & usage

Reference for using the **kimi-agent** provider in Max, which drives the **Kimi Code
CLI** (`kimi`, the `kimi_cli` Python runtime) via **`@moonshot-ai/kimi-agent-sdk`** over
Wire mode (JSON-RPC over stdio). The SDK spawns the local `kimi` binary and reuses its
config, tools, skills, and MCP servers.

> **Verified facts** are from the installed CLI/config on this machine and official
> sources (HF model card, kimi.ai docs/pricing, kimi-cli docs). Benchmark numbers keep
> their conditions — strip the qualifier and the number is wrong.

## The model: Kimi K2.6

- **Identity / id.** Kimi **K2.6** (Moonshot AI), open weights (Modified MIT). On this
  machine's **managed kimi-code coding plan** it is served as model id
  **`kimi-code/kimi-for-coding`** (display name **"Kimi-k2.6"**), base
  `https://api.kimi.com/coding/v1`, OAuth (no API key). **GA 2026-04-20.**
- **Architecture.** Mixture-of-Experts — **1T total params / 32B active per token**, 384
  experts (8+1), MLA attention, native-multimodal via a 400M MoonViT vision encoder.
- **Context window:** **262,144 tokens (256K).**
- **Multimodal:** text + images + **video** (`capabilities = thinking, video_in,
  image_in`; video input is experimental / official-API-oriented).
- **Thinking / reasoning:** hybrid model; thinking is **ON by default** in the CLI
  (`default_thinking = true`). Recommended sampling **temp 1.0 / top_p 1.0**.
- **Agentic:** long-horizon (marketed ~12-hour autonomous sessions). **Agent Swarm**
  scales to **300 sub-agents / ~4,000 coordinated steps** for K2.6 (the "100" figure is
  the older K2.5 number). *This swarm is a model/API capability — see the Max note
  below; it is not enabled through Max.*
- **Benchmarks (thinking mode, keep qualifiers):** SWE-Bench Verified 80.2 · SWE-Bench
  Pro 58.6 · LiveCodeBench v6 89.6 · Terminal-Bench 2.0 66.7 · AIME 2026 96.4 ·
  GPQA-Diamond 90.5 · BrowseComp 83.2 (86.3 w/ swarm). Head-to-head "beats GPT-5.4 /
  Opus 4.6 / Gemini 3.1 Pro" claims are secondary/marketing — lower confidence.
- **Pricing (official per-1M-token API):** input cache-hit $0.16 / cache-miss $0.95 /
  output $4.00. ⚠️ The **coding-plan subscription** price is a separate flat tier and was
  not retrievable — do not infer it from the API rates.

## The runtime: Kimi Code CLI + SDK

- **Two artifacts:** the **Kimi Code CLI** (`kimi`, Python `kimi_cli`) is the execution
  engine; **`@moonshot-ai/kimi-agent-sdk`** (Node/Python/Go) is a thin client that spawns
  it and talks **Wire mode** (JSON-RPC 2.0, one JSON object per line over stdio).
- **Node SDK (ground truth = `dist/index.d.ts`, not the README):** `createSession(opts)` /
  one-shot `prompt(content, opts)`. `SessionOptions`: `workDir` (required), `model?`,
  `thinking?`, `yoloMode?`, `executable?` (default `kimi`), `env?`, `externalTools?`,
  `agentFile?`, `skillsDir?`, `shareDir?`. A `Turn` is an async iterator of stream events
  with `interrupt()`, `approve()`, `respondQuestion()`, `steer()`. Custom tools via
  `createExternalTool({name, description, parameters: zod, handler})`.
- **Run modes:** interactive TUI · `--print` headless (implies `--yolo`) with
  `--output-format text|stream-json` · `kimi acp` (IDE integration) · `kimi term` (Toad
  TUI) · `kimi web` (browser UI) · `--wire` (experimental, used by the SDK).
- **Skills:** `SKILL.md` packages discovered from `~/.kimi/skills`, `~/.claude/skills`,
  `<wd>/.kimi/skills`, etc.; exposed as `/skill:<name>`. Built-ins: `skill-creator`,
  `kimi-cli-help`.
- **MCP:** `kimi mcp add/list/auth/test`; servers in `~/.kimi/mcp.json`; all MCP tool
  calls are approval-gated.
- **Context management:** auto-compaction (`reserved_context_size`, `/compact`); the
  `okabe` agent adds **D-Mail** (rewinds the agent's *context* to a checkpoint, never the
  filesystem).

### Built-in tools (default agent)
| Tool | Status in Max |
|---|---|
| `ReadFile`, `ReadMediaFile`, `Glob`, `Grep` | routed through Max's audited tools (`file_read`, `file_list`) |
| `Shell` (timeout ≤300s), `WriteFile`, `StrReplaceFile` | routed through Max's audited tools (`bash`, `file_write`, `file_edit`) |
| `SearchWeb` | **enabled natively** — kimi's free managed search (included in the kimi-code plan); Max's paid `web_search` is dropped so searches use this |
| `FetchURL` | disabled (SSRF) — URL fetching routes through Max's audited `web_fetch` |
| `Task` (spawn `coder` subagent), `SetTodoList` | subagents disabled; `SetTodoList` not applicable |

## How Max's kimi-agent provider uses it

- **Mode picker (`K2.6 Instant / Thinking / Agent`):** the catalog exposes three selectable
  "models" (like claude-subscription's model list). A `KIMI_MODE_CONFIG` table in
  `client.ts` maps each picker id to a real model + flags: **Instant** = `thinking:false`;
  **Thinking** = `thinking:true` (reasoning streams to the UI); **Agent** = `thinking:true`
  + 2× step budget (50) + an autonomy system-prompt nudge. The fabricated picker id is
  never forwarded to `createSession({model})` (it maps to `kimi-k2.6`).
- **Model:** on the managed plan the provider **omits `--model`** so the CLI uses its
  `default_model` (`kimi-code/kimi-for-coding`); it forwards the real `kimi-k2.6` only when
  `MOONSHOT_API_KEY` is set (api.moonshot.ai mode).
- **Tool isolation (full Max native):** the provider ships a restrictive agent spec with
  **zero native built-ins enabled** (`tools: []`). ALL tool calls — read, write, exec, and
  network — route through **Max's** audited `externalTools` bridge so every call goes
  through the full allowlist → permission → approval → audit pipeline. Subagents are
  disabled (`subagents: {}`).
- **Tool-produced images reach the model:** the SDK handler return is string-only, so the
  provider saves tool images/PDF/video to a temp file and instructs the model to load them
  within the same turn via Max's `file_read` tool (which handles images). Prior-turn
  tool media still flows via the prompt.
- **No Agent Swarm** through Max — subagents are off (`subagents: {}`), so the 300-agent
  swarm is not reachable here, and re-enabling subagents would reopen the isolation hole.
  (Use the `kimi` CLI directly for the swarm.)

## Usage tips
- For news/docs/release-note lookups on the coding plan, `SearchWeb`/`FetchURL` work with
  no extra key (managed endpoints). (Within Max these route through Max tooling.)
- Keep thinking ON for hard coding/reasoning if you drive the CLI directly; toggle off
  for latency-sensitive "instant" replies.
- For automation, use `--print`/`stream-json`, but note `--print` auto-approves (YOLO).
- Reference the model by its real id `kimi-code/kimi-for-coding` on the coding plan;
  `kimi-k2.6` is only a display name there.

## Gotchas
- **Installed CLI is 1.12.0** (a Feb-2026 snapshot); latest is ~1.46.0. Features added
  later are **NOT present locally**: plan mode (1.19), background bash + `/task` (1.23),
  plugins + the new `Agent` tool with coder/explore/plan types (1.25), `/undo` `/fork`
  (1.31), `/afk` (1.40). Don't assume them.
- This machine's `~/.kimi/config.toml` carries keys **not in the 1.12.0 schema**
  (`default_plan_mode`, `theme`, `hooks`, `merge_all_available_skills`, a `[background]`
  table, `compaction_trigger_ratio`). 1.12.0 **silently ignores** them — so background
  tasks / plan mode / hooks are not functional on the installed build.
- **Agent Swarm = 300 sub-agents / 4,000 steps (K2.6)** is a model/API capability and is
  unrelated to the CLI's local `[background] max_running_tasks=4`.
- **Two different "kimi" providers in Max:** `kimi-agent` (this — the agentic SDK on
  the managed OAuth plan) vs the plain **`kimi`** chat provider (OpenAI-compatible, uses a
  Moonshot **API key**). Different credentials, base URLs, and model ids.
- Name collision: the **Rust `kimi-agent`** kernel (repo `kimi-agent-rs`) is a different
  artifact from `@moonshot-ai/kimi-agent-sdk`; this provider rides on the latter.

## Sources
- Installed `~/.kimi/config.toml`, `kimi --version` (1.12.0), `kimi info` (wire 1.3) — primary, verified.
- HF model card: https://huggingface.co/moonshotai/Kimi-K2.6
- API pricing/context: https://platform.kimi.ai/docs/pricing/chat-k26
- CLI docs: https://moonshotai.github.io/kimi-cli/ (+ release-notes/changelog)
- SDK: https://github.com/MoonshotAI/kimi-agent-sdk · npm `@moonshot-ai/kimi-agent-sdk` (`dist/index.d.ts` is authoritative)
- GA corroboration: https://developers.cloudflare.com/changelog/post/2026-04-20-kimi-k2-6-workers-ai/
