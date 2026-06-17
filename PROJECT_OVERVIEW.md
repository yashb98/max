# Vellum / Max Assistant — Project Overview

*A technical walkthrough for engineering interviews. Last verified against the working tree on 2026-06-16.*

---

## 0. How to read this document (attribution up front)

**This is not my project.** "Vellum / Max Assistant" is an open-source personal-AI-assistant product built by Vellum / Max AI (git remote `vellum-ai/vellum-assistant`). The overwhelming majority of the code — memory, the trust engine, the credential service, channels, the macOS app, the gateway — is **platform code I did not write**. I worked on a focused branch (`kimi-agent-feature-pack`) on top of it.

My own contributions are exactly three things, and the rest of this document keeps that line visible:

| What | Nature | Where |
|------|--------|-------|
| **`kimi-agent` provider** | **Authored from scratch** | `assistant/src/providers/kimi-agent/` (~1,200-line `client.ts` + `agent-file.ts` + `errors.ts` + `share-dir.ts`), ~2,030-line provider test, probe scripts, root-cause report |
| **`claude-subscription` bridge** | **Debugged & hardened** a pre-existing platform feature (799 lines) | 3 fixes in `assistant/src/providers/claude-subscription/client.ts` |
| **`kimi-webbridge` skill** | **Authored** | `skills/kimi-webbridge/{SKILL.md, scripts/webbridge.ts}` |

When this doc describes the platform, it says "the platform…". When it describes my work, it says "I…". I prefer that frame for both integrity and interview reasons: the strongest thing I can show is *exactly* what I touched and how deep I went, not a claim on a million lines I didn't write.

> **A note on provenance honesty:** the repository's git history is a single squashed import commit plus my 6 commits, so git authorship alone cannot *prove* the platform code is Vellum's. The platform attribution is inferred from naming (`@maxai/*` packages, Python-parity comments citing `django/.../oauth/`, internal JIRA ticket refs) and from the fact that my commits only ever touch the three areas above. I'll state that uncertainty rather than paper over it — it's the kind of thing an interviewer will (rightly) poke at.

---

## 1. What the product is (one paragraph)

Max is **"Personal Intelligence"**: a named, memory-bearing AI assistant that one person *owns* (the docs deliberately say **"creator,"** not "user"). It runs as a native macOS app (or headless on your own box), learns what matters about you into a structured memory graph, develops its own personality files, proactively checks in once an hour-ish, reaches you across Telegram/Slack/voice with shared memory, and runs every tool in a sandbox with a fail-closed trust model and credentials quarantined in a separate process. It is multi-provider (Anthropic primary; OpenAI/Gemini/Ollama; and — my work — Kimi and a Claude.ai-subscription bridge), with local ONNX embeddings by default. The Constitution even encodes its differentiation *as architecture* (counter-positioning against centralized assistants, universal assistants, and the SaaS model).

---

## 2. System at a glance

### 2.1 Topology

```
   macOS Swift app ──┐
   Chrome extension ─┤   HTTPS / SSE          internal HTTP / IPC
   Telegram/Slack/   ├──────────────►  GATEWAY ──────────────►  ASSISTANT DAEMON ("max-daemon")
   WhatsApp/Twilio   │  (single public      (edge JWT,            (agent loop, memory,
   webhooks ─────────┘   ingress)            webhook validate,     skills, channels, heartbeat)
                                             token exchange)            │
                                                                        ├──► CES (credential-executor)  ── separate process, RPC only
                                                                        ├──► Qdrant 1.13.2 (vector store)  ── sidecar
                                                                        └──► per-conversation egress proxy  ── tunnel / MITM-inject creds
```

- **Gateway** is the *only* public ingress; the daemon never faces the internet (enforced by a CI guard, `gateway-only-guard.test.ts`). Daemon runtime HTTP is `127.0.0.1:7821`; gateway is `7830`.
- The same daemon route handlers are **dual-exposed over HTTP and a Unix-socket IPC** from one declarative `ROUTES` table, so the gateway can call the daemon without a JWT exchange.
- **CES** (Credential Execution Service) is a hard process boundary — credentials live only in its memory and never reach the model.
- Local install runs all three as a **three-container Docker group** sharing one network namespace and a workspace volume (CES mounts it read-only).

### 2.2 Honest scale

The repo is large, but I want to characterize it precisely rather than inflate it:

| Surface | Product code | Test code |
|---|---:|---:|
| Backend (`assistant/src`, TypeScript / Bun) | **~390K** | ~493K |
| macOS app + shared (Swift, AppKit/SwiftUI) | **~358K** | ~135K |
| Gateway (TypeScript / Bun) | ~51K | — |
| CLI (TypeScript) | ~22K | — |
| Internal packages | ~8.5K | — |

≈ **830K lines of product code** platform-wide, with a very large test suite (~2,428 `*.test.ts` files mirroring the source tree, including a dedicated DB-migration suite). The web app (`apps/web`) is a deliberate ~150-line scaffold; the real chat UI lives in a non-public repo. **My contribution is ~1,200 lines of provider code, a ~2,030-line test file, three small `claude-subscription` patches, and a ~44-line skill CLI** — small, deep, and load-bearing for two of the four shipped model backends.

---

## 3. What I built (the part I can speak to end-to-end)

### 3.1 The `kimi-agent` provider — authored from scratch

**What it is.** A real LLM-transport provider conforming to the platform's `Provider` interface that drives the **Kimi Code CLI/SDK** (`@moonshot-ai/kimi-agent-sdk`, Kimi K2.6, 256K context) as an *in-process agentic runtime* — structurally mirroring the platform's `claude-subscription` bridge. Auth is the managed **kimi-code OAuth** login (`~/.kimi/`), not a Moonshot API key. The hard part: **the SDK runs its own tool loop**, so I had to bridge its tool calls back into Max's `ToolExecutor` (via the SDK's `externalTools`) *and* re-establish Max's security boundary around an agent runtime that wasn't designed to be embedded.

**The isolation breach (the core security work).** The provider's only containment was originally an `ApprovalRequest`-deny gate. Reading the installed kimi-cli Python source, I found that **only 3 of 9 native built-ins** (`Shell`/`WriteFile`/`StrReplaceFile`) emit an `ApprovalRequest` — the other six (`ReadFile`/`ReadMediaFile`/`Glob`/`Grep`/`FetchURL`/`SearchWeb`) **ran completely ungated**, bypassing Max's allowlist/permission/audit pipeline (a forced probe read `/etc/hosts` ungated). It was a *false negative, not a regression*: the prior "isolation PASS" had only ever exercised `Shell`, which *is* gated.

The fix: **always write a restrictive `agent.yaml`** whose positive `tools:` allowlist disables built-ins *pre-execution* — kimi-cli builds its toolset from that allowlist, so an omitted tool returns `ToolNotFoundError` and never runs. The posture then **tightened over two iterations**, which I think is a good design story:

- **HYBRID** (early): native reads/search enabled for speed; only write/exec/network routed to Max.
- **MAX-NATIVE** (current, `agent-file.ts:42-47`): **only Kimi's *free* managed `SearchWeb` runs native** (to spare the creator's *paid* Max `web_search` quota); *everything else* — reads, glob, grep, shell, write, edit, fetch — routes through Max's audited tools. `subagents: {}` (no `Task`, because its default sub-spec wouldn't inherit the exclusions). The approval-deny gate is retained as defense-in-depth. I also fixed a latent bug where the system prompt was written as raw `.md` into a slot that expects a YAML spec (kimi renders prompts through Jinja2 `StrictUndefined`); it now writes a real `agent.yaml` + a sibling `system.md` wrapped in `{% raw %}`.

**Ambient-MCP suppression.** kimi-cli unconditionally loads `~/.kimi/mcp.json` (playwright/github/canva) into *every* session, independent of the `tools` allowlist — so the model could *see* `browser_navigate`, pick it, and get denied… and **a denied tool is turn-fatal in kimi-cli** (verified in source: `ToolRejectedError` → no re-inference). Fix (`share-dir.ts`): stage an ephemeral **MCP-free share dir** (`KIMI_SHARE_DIR`) where every entry symlinks back to the real `~/.kimi` *except* `mcp.json` (written `{"mcpServers":{}}`) and `kimi.json` (written as a real, rename-proof file so `Session.find` can resume). `credentials/`/`sessions/`/`logs/` stay directory symlinks so OAuth refresh and `context.jsonl` writes land in the real dir. **Live probe PASS**; staging failure falls back safely to the deny gate.

**The 126-agent root-cause investigation.** The provider misbehaved in live use ("interrupting turn," silent blank replies) while `claude-subscription` "runs for hours." I ran a 126-agent dynamic workflow (8 investigators → per-finding adversarial verification with independent lenses → completeness critic → second-round finders), **2,133 tool uses** over *primary sources* — the working-tree code, the SDK `dist`, the installed kimi-cli 1.12.0 Python source, and live daemon logs. Verdicts: **53 confirmed / 8 split / 23 refuted**. It decoupled what looked like one bug into **three independent defects**:

| # | Root cause | The insight | Fix |
|---|---|---|---|
| **RC#1** (primary) | The host-side 25-step cap counted every raw SDK `StepBegin` and force-`interrupt()`ed at step 26 | kimi-cli's *own* internal budget is ~100 steps/turn — Max was cutting at a **quarter** of that. 20 legitimate long turns (26–44 steps) hard-killed in one day; `claude-subscription` (whose `maxTurns:25` is an SDK *recursion* bound, not a raw-step count — one turn batched **138 tool calls**) tripped **0×** | Raised the cap (**25 → 80 committed → 100000 in the working tree**, deferring to the CLI's own budget) and decoupled it from the denial defect |
| **RC#2** (independent) | Visible-but-denied ambient MCP tools; a denial ends the turn | Proved in kimi-cli source that denial → `stop_reason:"tool_rejected"` → **no re-inference**. (Refuted the seductive "denials burn steps toward the cap" theory — impossible, since a denial *ends* the turn) | `shareDir` MCP suppression (above) |
| **RC#3** (structural) | "Say *continue* and I'll pick up" was a hollow promise | `sessionId` was only set from `conversationKey`, which **nothing ever set** — every turn rebuilt a fresh session from flattened, text-only history. "Continue" was a blind re-plan, not a resume | Thread `conversationKey` → one kimi session per conversation (`max-<key>-<bootEpoch>`); send only *new* user text on resume; seed `kimi.json` as a real file so `Session.find` works under ephemeral staged dirs |
| (downstream) | Silent blank assistant replies (9 msgs / 3 conversations) | A denied tool → text-less turn → `content:[]`; the empty-response guard required `toolUseTurns > 0`, which is **structurally 0** for a bridge whose tool calls happen *inside* the SDK | Recovery synthesis names the blocked tools; `max_turns`/`timeout` interrupts append an explanatory `[Stopped early…]` note; never persist empty content for an interrupted turn; a per-call `supportsEmptyTurnNudge` flag opens the nudge **only when resume is safe** (so a nudge can't re-execute side-effecting tools) |

**Other shipped work on the provider:** distinct `aborted` / `timeout` / `max_turns` stop reasons plumbed through the **ACP wire union and Swift `StopReason`** (so the macOS Sessions UI shows the real reason); per-step **token-usage summing** (kimi emits one usage block per step; the SDK-claude path pre-aggregates — now they report equivalent whole-call usage); a **truncation-safe media pointer** (tool-produced images/PDFs are saved to disk and a `ReadMediaFile` pointer is appended *after* truncation, so an oversized result can never eat the only pointer — this is what lets K2.6 *see* browser screenshots); the Instant/Thinking/Agent **mode picker**; and the **managed-plan-vs-API-key model duality** (on the OAuth plan the catalog id `kimi-k2.6` yields "LLM not set," so the provider omits `--model` and lets the CLI use its own default, while still forwarding an explicit model when a `MOONSHOT_API_KEY` is present).

**Verification.** ~2,030-line provider test plus `agent-file`/`errors`/`share-dir` tests; a live probe gauntlet (`isolation-agentfile.mjs`, `sharedir-probe.mjs`, `resume-probe.mjs`) **passing on both CLI 1.12.0 and 1.47.0**; `tsc` clean. Feature flag `kimi-agent-provider` is `defaultEnabled: true`.

> **What I'd flag honestly (and would say in an interview):** the working-tree cap is `100000` while nearby comments still say `80` / "under 100"; the schema comment says "clamp to 200" but the real bound is `1..100000`; and the `isolation-agentfile` probe header still describes the older HYBRID posture. These are stale-comment cleanups I'd land before merge — I'd rather name them than pretend the tree is pristine.

### 3.2 The `claude-subscription` bridge — debugged & hardened (not authored)

This is a **pre-existing platform** provider that lets Max drive Claude with the creator's `claude login` OAuth (no Anthropic API key) by running the **Claude Agent SDK**'s `query()` and bridging Max's tools back through an in-process MCP server (`max-skills`). The SDK is treated as untrusted: `settingSources: []`, `tools: ["Task"]`, and a `canUseTool` callback that hard-denies anything off the allowlist (the platform's lesson, which I leaned on: `settingSources:[]` is *necessary but not sufficient* — `canUseTool` is the seatbelt against account-level MCP servers the SDK auto-attaches). I shipped **three fixes**:

1. **`maxTurns` recursion bound: 25 → 50 → 100000.** I first raised it to 50 after seeing a 138-tool-call turn complete well within 25 — the cap bounds recursion *depth*, not *work*. Then, user-directed "run as long as it takes," to a high backstop (`100000`), demoting it to a pure runaway guard with the 30-min provider **stream timeout** as the operative wall-clock limit. (Tests re-pinned to a loose `<= 100000` bound.)
2. **Typed `ContextOverflowError`.** The CLI reports overflow as an error *result string* (`"Prompt is too long"`), which the bridge previously wrapped as a 500 — so `RetryProvider` treated it as transient and burned **3 futile retries**, each spawning a fresh `claude` that failed identically, before compaction could engage. I pattern-match the message and throw a typed, non-retryable `ContextOverflowError` (parsing token counts when present), so the loop routes **straight to deterministic compaction**.
3. **Per-call model resolution (the model-picker fix).** A caching-invariant bug with a ledger-proven blast radius: providers are cached **per connection**, and all subscription profiles (Opus 4.8/4.7, Sonnet 4.6, Haiku 4.5) share *one* connection. With `model` frozen at construction, the in-chat picker recorded an override the cached provider ignored — a conversation pinned to "Opus 4.7" actually **billed Sonnet 4.6** (proven in the usage ledger). The one-line fix reads `options.config.model` (already resolved per-call by `RetryProvider`) with a construction-time fallback.

### 3.3 The `kimi-webbridge` skill — authored

A thin (~44-line) Bun CLI (`skills/kimi-webbridge/scripts/webbridge.ts`) that drives the creator's **real, logged-in browser** by POSTing `{action, args, session}` to a separate local daemon at `127.0.0.1:10086/command`. It targets elements by **stable accessibility `@e` refs** (not pixel coordinates), health-checks the daemon first, defaults the session to `"max"`, and **fail-closes to `{ok:false}`** on bad args or an unreachable daemon. It deliberately does *not* reuse the in-repo CDP browser engine — it's an independent surface, and it pairs with the kimi-agent media bridge (a screenshot returns a path the model views via `ReadMediaFile`).

---

## 4. The agentic harness *(platform)*

The core loop is `AgentLoop.run()` in `assistant/src/agent/loop.ts` — a **`stop_reason`-driven tool-use cycle with no hard numeric step cap by design**. It sends messages + tools to the provider, filters the response for `tool_use` blocks, executes all tools concurrently (`Promise.all` raced against an `AbortSignal`), appends `tool_result` messages, and loops until the model returns no `tool_use` (or a tool yields to the user, the abort fires, or an orchestrator checkpoint says "yield"). The only numeric guards are an **empty-response nudge (×1)**, a **consecutive-tool-error nudge cap (×3)** so unrecoverable errors don't spin, and a **150 ms minimum inter-call interval** anti-spin throttle.

**Context management is two-tier and is the cleverest part:**
- *Proactive:* the orchestrator estimates tokens after each tool turn and **yields at 85% of the preflight budget**, runs LLM-summarized compaction, then re-enters — compacting *before* the provider can reject.
- *Reactive:* a typed `ContextOverflowError` (from any provider) routes straight to compaction; bounded by `overflowRecovery.maxAttempts = 3` and a **circuit breaker** that suspends compaction for 1 hour after 3 consecutive failures so a broken summarizer can't thrash.
- The `ContextWindowManager` compacts older turns when the estimate hits **80% of a 200K-token window**, targeting **30%**.

**Per-turn context hygiene** (explicitly to keep TTFT from growing with step count in computer-use sessions): screenshots are seen once on capture then replaced with a text marker (`stripOldImageBlocks`); only the **last 2 AX-tree snapshots** survive (`MAX_AX_TREES_IN_HISTORY`); oversized tool results are truncated to `min(400K chars, ~30% of window)` keeping ≥2K; images are downscaled to 1568px JPEG q80 with a 500-entry content-addressed disk cache (matching Anthropic's server-side scaling, so it's lossless and dodges 413s). **Sensitive-output placeholders** are substituted only into streamed `text_delta` events, so real secrets never re-enter provider history or the persisted store.

**Sub-agents** are role-scoped child conversations (`general`/`researcher`/`coder`/`planner`) each with a tool allowlist and a **hard depth cap of 1** (no nested sub-agents).

### 4.1 The multi-provider model layer *(platform)*

A **decorator chain over one uniform `Provider.sendMessage()` interface**: `UsageTrackingProvider(RetryProvider(adapter))` at boot, with `CallSiteRoutingProvider` (always) and `RateLimitProvider` (opt-in) layered per conversation. One `PROVIDER_CATALOG` is the source of truth, and **two module-load invariant guards** throw at boot (not at user-call time) on any catalog↔factory id drift or any model-intent pointing at an absent model id.

- **Providers:** Anthropic (primary), OpenAI (split across a Responses transport for GPT-5-series reasoning/verbosity knobs and a shared Chat-Completions transport reused by Ollama/Fireworks/Kimi), Gemini, Ollama, Fireworks, OpenRouter (which forwards Anthropic-native thinking for `anthropic/*` models and translates to its unified `reasoning` param otherwise), plus my **kimi-agent** and the platform's **claude-subscription** bridges. A separate speech-to-text provider family (Deepgram/Whisper/Gemini-Live/xAI) lives alongside.
- **Credential waterfall:** user API key → managed platform proxy → keyless/CLI-login; the chosen surface drives behavior (managed-proxy routing attaches `X-Max-*` usage-attribution headers only when the platform is the billing party).
- **Config normalization:** `RetryProvider` strips knobs the target provider rejects (thinking for non-Anthropic/OpenRouter, effort/verbosity/speed per provider, `maxTurns` for everything but kimi-agent) and drops thinking under Anthropic's forced-tool-use / `temperature≠1` wire constraints.
- **Retry:** up to 3 retries (4 attempts) on 429/5xx/overloaded/stream-corruption/transport-abort/network errors, **equal-jitter exponential backoff** (base 1000 ms, `cap/2 + random(0..cap/2)`), honoring `Retry-After`, capped at 60 s. **Context overflow is checked *first* and is non-retryable** — an oversized prompt never burns retries.
- **Streaming deadline:** a linked `AbortController` that auto-aborts at 30 min (`providerStreamTimeoutSec`); Anthropic additionally passes the SDK `streamTimeoutMs + 60s` so the *inner* deadline always wins with a clearer message, and its catch-site disambiguates caller-cancel vs inner-timeout vs transport-abort (which the SDK collapses into one opaque "Request was aborted").

---

## 5. Memory, identity & proactivity *(platform)*

### 5.1 Memory — a decaying memory *graph*

Memory is a **typed graph** (`memory_graph_nodes` in SQLite + mirrored dense+sparse vectors in a self-managed **Qdrant** collection), not a flat key-value store. Eight `MemoryType` kinds (episodic/semantic/procedural/emotional/prospective/behavioral/narrative/shared); nodes carry emotional charge, fidelity, significance, stability, and reinforcement count, with typed edges (caused-by/contradicts/supersedes/…) and triggers.

- **Extraction:** an LLM reads a transcript + a candidate neighborhood and returns a *transactional* diff (create/update/reinforce/supersede), deduping **by model instruction** rather than content hashing, recording provenance (`sourceConversations[]` + `direct`/`inferred`/`observed`/`told-by-other`) on every node.
- **Hybrid retrieval:** dense (**local ONNX `bge-small-en-v1.5`, 384-dim** by default; fallback chain local→OpenAI→Gemini→Ollama) + an in-process **FNV-1a-hashed 30,000-slot sparse** channel, fused server-side by **Reciprocal Rank Fusion** (two 40-candidate prefetch stages), then re-scored with type-specific weight profiles blending semantic similarity, **Ebbinghaus-decayed significance** (`S₀·e^(−t/stability)`, 14-day default, ×1.5 per reinforcement, computed *at retrieval time*), a vivid-7d→clear-30d→faded-90d→gist-365d **fidelity ladder**, recency, time-of-day cyclic match, triggers, and **BFS activation-spread** over the graph (2 hops, 0.5 decay/hop, max-not-sum).
- **Provider-dimension reconciliation:** a single sentinel point stores the embedding-model identity; on a dim/model change the whole collection is torn down and rebuilt (cleanly tolerating 384/1536/3072-dim providers over one collection).
- **Trust-gated writes:** only non-untrusted (guardian) conversations extract memory — untrusted channels can never mutate long-term recall.

> *Verified honesty note:* `assistant/docs/architecture/memory.md` is heavily drifted (it describes two memory systems that were both **dropped** in migrations 189 and 203, including the "staleness windows per type" table). The code's *real* model is the Ebbinghaus/fidelity decay above. A newer **v2 concept-page** path is `enabled` by default and *suppresses* v1 graph extraction; the v1 hybrid retrieval is the fallback. I'd flag this drift to whoever owns the doc.

### 5.2 Identity & personality — personality is *data, not code*

There's no deterministic "observe the user and write a personality" algorithm. The platform ships templates (`SOUL.md`, `IDENTITY.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`), re-reads them **every turn** into the dynamic (post-cache-boundary) prompt block so edits land on the next message, and the **model itself** performs the observation and `file_edit`/`file_write`. `BOOTSTRAP.md` is a one-shot first-run ritual (after ~2 turns, write one communication observation into `SOUL.md`, choose name/emoji/tagline, then **delete `BOOTSTRAP.md` as the durable "onboarding complete" signal**). `NOW.md` is an ephemeral present-tense scratchpad injected on the first turn / post-compaction (kept "under 10 lines"); the per-user **journal** is append-only and graph-extracted (never injected verbatim). A tone correction is treated as a signal that `SOUL.md` is stale, to be rewritten *the same turn*.

### 5.3 Proactivity & heartbeat — reach out, but never interrupt

A singleton `HeartbeatService` fires on a timer (**default every 30 min**, or a cron expression), **only inside 08:00–22:00** local active hours, with disk-pressure / first-message / overlap guards. It runs the guardian persona against the `HEARTBEAT.md` checklist (re-read `NOW.md`, look for follow-ups, notice due-soon items) and the model ends with `HEARTBEAT_OK` or `HEARTBEAT_ALERT` — **only an ALERT emits a notification** (silent-OK is enforced by withholding the signal; the conversation is still created so the sidebar updates). Two independent **don't-interrupt** layers: (1) any guardian interaction `resetTimer()`s the next beat a full interval out; (2) the notification engine hard-blocks an alert when you're already viewing the source context (`visibleInSourceNow`) and within a 1-hour dedupe window — **fail-closed and not overridable by the LLM**. Missed beats (crash/offline) are reconciled at startup into a single deduped notification. A separate one-shot **proactive-artifact** job (once per new creator, between messages 4–10, claimed via an atomic `wx` guard file) builds a small personalized app or markdown doc in the background.

---

## 6. Security: trust, credentials, sandbox *(platform)*

Three concentric, fail-closed layers, each enforced in **code, not prompts**.

### 6.1 Trust engine — fail-closed actor identity

Every inbound sender is resolved **once at ingress** to exactly one class — `guardian`, `trusted_contact`, or `unknown` (`resolveActorTrust`), keyed on a *canonicalized* identity (E.164 for phone) and on `actorExternalId`, **never** the delivery address. Fail-closed is *structural*: `isUntrustedTrustClass(undefined) === true`, and that single predicate is reused at every gate so policy can't drift between call sites. Untrusted actors are blocked from memory recall, host shell/file execution, scheduling, and background analysis; **conversation history is provenance-isolated** (an untrusted actor literally cannot load guardian-authored messages or summaries). Escalation paths bridge a trusted-contact request to the guardian and route unknown senders through an assistant-anchored access request. Guardian approvals arrive via inline buttons, Slack reactions, a deterministic ≤40-char NL parser (conf. 0.95), or an LLM classifier that **fails closed** and mints only **single-use, tool-signature-scoped, 5-minute** grants consumed atomically *after* all later gates pass. Decision tokens are explicitly **non-authoritative** audit metadata (unsigned, never decoded for enforcement) — a deliberate avoidance of the "decodeable token mistaken for a capability" trap. Anti-social-engineering guidance is injected into the prompt for non-guardian actors ("never infer guardian status from tone…").

### 6.2 Credential Execution Service (CES) — secrets never touch the model

A **separate process** is the only thing allowed to materialize a secret. The assistant talks to it **only over newline-delimited JSON-RPC** (stdio child locally; Unix socket in managed mode) with a versioned handshake — and there are **no direct source imports** between `assistant/` and `credential-executor/` (a package-boundary test guards it). CES exposes exactly **three** tools:
- `run_authenticated_command` — injects creds (env-var / temp-file / `credential_process` adapters) into a subprocess whose env explicitly does **not** inherit the CES env;
- `make_authenticated_request` — strips caller auth headers, injects the credential, re-checks grant policy on **every** redirect hop (max 5), then scrubs secrets from the body and error strings (a locked ADR forbids routing creds through `curl` precisely to avoid that injection surface);
- `manage_secure_command_tool` — HTTPS-only, size/time-capped download into an immutable toolstore with SHA-256 digest verification.

The assistant only ever receives `{exitCode, stdout, stderr}` (or a sanitized body) plus a token-free `auditId`. Authorization is fail-closed two-tier (persistent `always_allow` + temporary `once`/`10m`/`conversation` grants), with `grantId` re-validated against the request's credential+command to block replay. CES **structurally denies interpreter/HTTP-client trampolines** (`curl`/`wget`/`bash`/`python`/`node`/…) at both registration and execution, with realpath symlink-escape containment. At rest: **AES-256-GCM** with a random per-install `store.key` (UID-independent so a managed sidecar can decrypt a shared volume — this replaced a v1 PBKDF2-from-username scheme that broke when assistant and CES ran as different OS users). 30-day token-free audit logs; recursive log redaction; ingress secret detection that steers the creator to a secure prompt; and a `SAFE_ENV_VARS` allowlist that strips credentials from every agent-spawned child.

### 6.3 Sandbox & egress

Tools run inside the container group; agent-originated outbound HTTP(S) is steered through a **per-conversation forward proxy** (`HTTP_PROXY`/`HTTPS_PROXY`, 5-min idle auto-stop, ≤3 sessions/conversation). The proxy is **tunnel-first, MITM-only-when-needed**: a `CONNECT` is plain-tunneled unless a credential-injection template matches the host, in which case it terminates TLS with an on-the-fly leaf cert, lets a policy engine inject the credential (or 403), applies anti-request-smuggling rules, and re-originates — so the secret **never enters the agent's environment**. Skill scripts run from a per-run temp dir, reject path-escaping executors, are version-hash-gated, spawn detached with a 30 s timeout + process-group SIGKILL, and cap output at 50K chars.

> *Verified honesty note:* the `docker run` arrays carry **no** `--memory`/`--cpus`/`--security-opt`/`--cap-drop`, and the image ends `USER root` — so rootless / no-new-privileges / CPU-RAM limits are expected from the **deployment runtime** (Kata/gVisor/K8s `securityContext`), not the local CLI. The native OS-sandbox backend described in `ARCHITECTURE.md` (sandbox-exec/bwrap) is **aspirational** — no runtime code wires it. The effective boundary today is the container/VM plus sanitized-env subprocess isolation.

---

## 7. Capabilities *(platform, except the kimi-webbridge skill)*

### 7.1 Skills & plugins
Manifest-driven, **progressively loaded**: a skill is a folder with `SKILL.md` (YAML frontmatter + body) and optional `TOOLS.json`. The model calls `skill_load` to pull a skill's body + tool schemas into context *on demand*, then invokes tools through a single `skill_execute` dispatcher — **tools are not exposed up front**, keeping the live surface small. Five merged sources (`bundled`/`managed`/`workspace`/`extra`/`plugin`): ~18 bundled (all with `TOOLS.json`), a network catalog of ~67 prompt-and-script skills auto-installed on demand, plus plugin-contributed skills (ref-counted). Activation is **anti-spoofing** (only `<loaded_skill>` markers inside `skill_load` tool-results count), and version-hashed so edits take effect mid-conversation. *(My `kimi-webbridge` is one of the workspace skills — §3.3.)*

### 7.2 Tools & MCP
A global origin-namespaced registry (`core`/`skill`/`plugin`/`mcp`) with strict collision precedence (core always wins) and refcounting for hot-reload. The `ToolExecutor` runs each call through an **untimed** plugin pipeline (so permission waits don't race the tool budget), then a permission/risk check, then races *only the real call* against a per-tool timeout (120 s default, 600 s max for shell, with a +5 s executor buffer so the shell's own SIGKILL fires first). Built-ins span sandbox + host filesystem, shell, `web_search` (Brave/Perplexity/Tavily BYOK with fallback) / `web_fetch`, memory, scheduling, documents, sub-agent spawn, and the three CES tools. **MCP** connects external servers over stdio/SSE/streamable-HTTP, **never crashes the daemon on a bad server** (non-auth failures → `lastError`, auth failures → `connected:false`), caps tools (20/server, 50 global), namespaces them `mcp__<server>__<tool>` (risk defaults high), supports OAuth, and **hot-reloads without evicting sessions** (the loop re-reads MCP tool definitions each turn).

### 7.3 Browser automation
Drives a real browser over CDP through a **three-tier backend chain** (your real Chrome via extension/host-proxy → `cdp-inspect` on `:9222` → a sacrificial local Playwright Chromium against a *dedicated* profile, never your logins), with **sticky asymmetric failover** (transport errors fail over; CDP protocol errors propagate). Pages are read via the **accessibility tree** (`getFullAXTree` → 15 interactive roles → stable `e1..eN` ids → CDP `backendNodeId`s), so there's no selector engine and prompts referencing "element e5" stay valid. **Layered SSRF/DNS-rebind defense** (pre-nav hostname+DNS checks, a redirect-time route interceptor, and a *post-redirect* URL re-validation). Credential fills go through a broker closure with `Input.insertText` so the plaintext never reaches tool output. (Notably, the 17 operations are exposed **only via the `assistant browser` CLI**, not as model-facing tools — locked by regression tests.)

### 7.4 Channels & messaging
One assistant across **Telegram / Slack / WhatsApp / email / the macOS app** (Twilio is a *voice/verification* transport, not a peer text channel). The gateway normalizes every transport into one channel-discriminated `GatewayInboundEvent` and routes any conversation to a single `assistantId`. Identities unify across channels via a **contacts/contact-channels graph** (a `principalId` groups a person's channels and forces them to share one persona + journal). Per-channel isolation (Slack channel tool/trust profiles; per-transport UX hints; guardian-vs-interactive approval routing). Verification is hardened (SHA-256-hashed codes, 5-attempts/15-min/30-min-lockout via an atomic SQL upsert, **anti-oracle identical errors**). A separate `MessagingProvider` abstraction lets the assistant operate Slack/Gmail/Outlook/WhatsApp/Telegram *on your behalf*. Slack uses outbound **Socket Mode** with dedup, jittered reconnect, and watermark-based catch-up (with one honestly-documented "genuinely lost" edge case).

### 7.5 Voice
Provider-agnostic, catalog-driven. Telephony switches on one catalog field between **ConversationRelay-native** (Deepgram/Google offload STT+TTS to Twilio) and **custom media-stream** (Whisper/xAI transcribed server-side), degrading to a Deepgram fallback so a call is never silent. In-app **live-voice** is a full-duplex loop (client PCM → Deepgram realtime WS with 5 s KeepAlives to beat its ~10 s server close → LLM turn under an `AbortController` → speakable-segment TTS with **real barge-in**). Audio is normalized at the edges (8 kHz mu-law/G.711 for Twilio, 16 kHz PCM for providers). Per-turn latency is **runtime-measured** (p50/p95), not a fixed constant.

### 7.6 Scheduling, tasks, integrations
A single **15-second tick** multiplexes due schedules → watchers → sequences, each in its own try/catch. Schedules are claimed via **SQLite optimistic compare-and-set** (not an in-process mutex, so even a second process can't double-fire), with dual cron + RFC-5545 RRULE recurrence and four modes (notify/script/wake/execute). A shared `runBackgroundJob` gives eight background producers one timeout policy, one error taxonomy, and one `activity.failed` dedupe path; the **watcher** engine ingests attacker-controllable external data (Gmail subjects, Linear titles) through an *"assistant sandwich"* (untrusted content wrapped as a prior assistant message between two trusted user messages) to neutralize prompt injection. **Integrations**: a declarative, SQLite-backed OAuth2 framework for **16 providers** (PKCE S256 always; BYO-vs-platform-managed connections; proactive refresh with a circuit breaker + dedup; best-effort revoke) where adding a provider is pure data entry.

---

## 8. Clients & infrastructure *(platform; my ACP touch noted)*

### 8.1 macOS Swift app
An AppKit-hosted SwiftUI menu-bar app with a single `AppServices` DI container (no ambient singletons). A stateless `GatewayHTTPClient` with **dual route modes** (local/remote bearer + flat `/v1/` vs managed `X-Session-Token` + `assistants/{id}/` prefix); a long-lived **SSE** `EventStreamClient` (1→30 s doubling backoff, reset on success) and a `GatewayConnectionManager` (15 s health check, `[3,5,10,15]s` reconnect schedule, 60 s auto-wake cooldown, generation-counter to invalidate stale loops). **On-host computer use** via CGEvent injection / AXUIElement enumeration / ScreenCaptureKit, gated by a pure-Swift `ActionVerifier` (50-step cap, sliding-window loop detection, sensitive-data/destructive-key blocks). Wire decoders fall back to `.unknown` for forward-compat. *My footprint here:* the kimi-agent `max_turns`/`aborted`/`timeout` stop reasons and session continuity in `ACPMessages.swift` / `ACPSessionStore.swift` (commit `55fa707d`), in service of the assistant-side provider.

### 8.2 Gateway
A Bun/TS edge service: single-header **HS256 edge JWT** with named scope profiles and **policy-epoch revocation** (blocklist-free), an **edge→daemon token exchange** minting 60 s daemon-audience tokens so only the gateway can prove origin, per-IP auth-failure rate limiting (10/60 s), a **module-global circuit breaker** (5 fails → 30 s open → one half-open probe), per-provider webhook signature validation, Telegram replay-proof dedup, and an outbound **Velay** WebSocket relay (with a 4-entry path allowlist) that gives NAT'd/self-hosted instances a public URL. It owns the auth/trust/contacts SQLite schema (on a gateway-only security volume the daemon can't touch) and data-driven bash/web risk classifiers feeding auto-approve thresholds.

### 8.3 Web, Chrome extension, CLI
The web app (`apps/web`) and `clients/web` are explicit **pre-product scaffolds**. The substantial browser surface is the **MV3 Chrome extension** (SSE inbound + HTTP-POST outbound — despite docs saying "WebSocket relay" — driving CDP over `chrome.debugger` with Chrome-125+ flat-session routing and deterministic per-call cancellation). The **`max` CLI** (Bun-built, 26 commands) provisions assistants locally or on cloud VMs (`max hatch --remote gcp` → an `e2-standard-4`), and manages the full lifecycle (wake/sleep/ps, terminal/exec/ssh, backup/restore/teleport).

---

## 9. Latency & performance engineering *(measured vs. designed)*

Almost every number below is a **code constant** (a deliberate design choice), not a benchmark. I mark the few that are *measured at runtime*. I'm careful here because an interviewer will (correctly) push on whether a number is a target or an observation.

**Request path & streaming**
- Provider stream deadline: **30 min** (`providerStreamTimeoutSec`, inner `AbortController`); Anthropic gets SDK timeout `+60 s` so the inner deadline wins with a clear message.
- SSE: **7 s** keep-alive heartbeat, **16-deep** ReadableStream queue, backpressure shedding when `desiredSize<=0`, **100-subscriber** hub cap (LRU-evict oldest); event-loop-delay percentiles in shed logs are *measured*.
- `/v1/*` rate limits: **300** authenticated / **20** unauthenticated requests per 60 s.

**Timeouts, retries, backoff**
- LLM retry: **3 retries / 4 attempts**, equal-jitter exponential backoff (base 1000 ms), `Retry-After`-aware, **60 s** cap. Context overflow → non-retryable (checked first).
- Gateway→runtime: **30 s** timeout, **2** retries, `500ms·2^(n-1)`; circuit breaker **5 fails → 30 s open**.
- Tool execution: **120 s** default / **600 s** shell max (+5 s executor buffer). Permission wait: **300 s**.

**Step / turn / recursion bounds**
- Main agent loop: **no hard step cap** by design (stop-reason driven); empty-response nudge ×1; consecutive-error nudge ×3; 150 ms anti-spin.
- kimi-agent host step backstop *(my area)*: **80** committed / **100000** working tree (defers to kimi-cli's ~**100**-step internal budget — that ~100 is a *measured* external CLI fact); concurrency cap **4**; 30-min wall-clock guard.
- claude-subscription SDK recursion bound *(my fix)*: **100000** (25→50→100000); concurrency cap **4**.
- Sub-agents: depth cap **1**.

**Context & compaction**
- 200K-token window; compact at **80%**, target **30%**; mid-loop pre-emptive yield at **85%** of preflight budget; overflow recovery **3 attempts**; compaction circuit breaker **3 fails → 1 h** cooldown. Tool-result truncation `min(400K chars, ~30% window)`, keep ≥2K; images 1568px / JPEG q80 / 500-entry cache.

**Embeddings, memory, caching**
- Local **ONNX bge-small-en-v1.5 (384-dim)** by default; cloud fallback chain. Hybrid prefetch **40**/channel fused by RRF; 30,000-slot sparse vocab. Ebbinghaus stability **14 d** (×1.5/reinforcement); fidelity ladder 7/30/90/365 d. Background jobs: decay hourly, consolidation 4 h, pattern daily, narrative weekly; adaptive **1.5 s→30 s** poll. **32 MB** in-memory embedding LRU + SQLite cache. Qdrant **1.13.2**.

**Proactivity, scheduling, voice, channels**
- Heartbeat **30 min** default (08:00–22:00 only); notification dedupe **1 h**; decision LLM **15 s** timeout.
- Scheduler tick **15 s**; schedule retries **3**, `min(base·2^n, 30min)` ±20% jitter (base 60 s); backups every **6 h** (off by default), retain **3**.
- Voice: silence endpointing **800 ms**, max turn **30 s**, Deepgram connect 10 s / inactivity 30 s / KeepAlive 5 s; mu-law **160-byte/20 ms** frames; **per-turn voice latency is measured (p50/p95)**.
- Slack reconnect backoff base 1 s→**30 s** cap +0–50% jitter; verification **5 attempts/15-min/30-min lockout**.

**Client (macOS)**
- Health check **15 s**; reconnect `[3,5,10,15]s`; SSE backoff 1→30 s; ACP session log cap **500** events; computer-use **50-step** cap, **10**-action loop window.

---

## 10. Cross-cutting engineering maturity

These are the themes a recruiter cares about that aren't a single "subsystem" — surfaced by a completeness pass over the codebase.

- **Testing:** ~**2,428 `*.test.ts`** files mirroring the source tree, including a dedicated DB-migration suite (rollback, connection-isolation, proxy-transaction, fork-lineage). My own work added a ~2,030-line provider test plus a live multi-CLI **probe gauntlet**, which is the kind of integration testing that actually catches the SDK-boundary bugs unit tests miss.
- **CI/CD & release:** **24 GitHub Actions workflows** with a per-component PR/CI split (assistant, gateway, credential-executor, macOS, web, CLI, chrome-extension, skills), plus `release.yml`, release-branch creation, cherry-pick-to-release, perf CI, and Linear release sync.
- **Observability:** Sentry wired with **PII scrubbing at the edge** (email/card/SSN regex in `beforeSend`), per-conversation tags cleared in `finally`; a 5-min **batched usage-telemetry** flusher (500-row batches); per-actor cost attribution.
- **Data storage:** one **SQLite** database (via `memory/db-connection` + an IPC `db-proxy` with connection isolation and transactions) with migrations split across **three owners** (memory/workspace/runtime), plus the **Qdrant** vector store.
- **Provider abstraction as a first-class invariant:** LLM SDKs never appear in feature code — everything routes through the `Provider` interface, which is *exactly* why I could add a whole new model backend (kimi-agent) without touching call sites.
- **Subsystems this overview compresses** (real, just not expanded): live-call telephony control plane (`calls/`, ~15K LOC — call state machine, leasing, relay, speaker ID, guardian-on-a-call), watchers (6 third-party event pollers feeding background followups), drip **sequences**, the app **package→sign→deploy** pipeline (`bundler/` + Vercel), AI **image generation** (`media/`), avatar rendering, relationship-tier state (`home/`), and the in-process secret-scanner/redaction layer (`security/`, distinct from CES).

---

## 11. Interview talking points (the 60-second version)

- **"Walk me through what you actually built."** I added a fourth model backend to a mature personal-AI platform by embedding an agentic CLI (Kimi Code) as an in-process provider, and the hard part wasn't the happy path — it was re-establishing the platform's security boundary around a runtime that runs its *own* tool loop, and root-causing why it misbehaved in production.
- **"Tell me about a hard bug."** A provider that "interrupted turns" and went silent looked like one bug. A 126-agent adversarial investigation over primary sources (the CLI's own Python source, the SDK dist, live logs) decoupled it into **three independent defects** — a host step-cap counting the wrong unit at ¼ of the CLI's real budget, ambient MCP tools that were visible-but-turn-fatal, and a "continue" that structurally couldn't resume — and I shipped probe-verified fixes for each, plus the empty-reply synthesis that closed the silent-blank path.
- **"How do you reason about security?"** The platform's model taught me a lot, and I applied it: I found native built-ins running *ungated* (a false-negative test, not a regression), and fixed it with a positive allowlist that disables tools *pre-execution* rather than relying on a runtime deny — defense-in-depth, with the egress tools routed back through the audited pipeline so an injected "read my SSH key" has no way *out*.
- **"How do you handle uncertainty / honesty?"** I'd point at this very doc: where the code contradicts its own comments (the stale `maxTurns` constants), where a doc describes a dropped system (the memory drift), and where "platform-authored" can't be proven from git — I name all of it rather than smooth it over.

---

*Generated from a verified, file-line-grounded survey of the codebase (22 subsystem clusters, adversarially cross-checked against source). Where this document cites a constant, it was read out of the working tree; where it cites a latency value as "measured," that value is computed at runtime and not a fixed number in the code.*
