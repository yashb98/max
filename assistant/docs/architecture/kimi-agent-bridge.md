# Kimi Agent SDK Bridge — Design Record & Phase 0 Findings

> **Status (2026-06-03): isolation breach found AND fixed.** The 2026-06-02 "PASS" below was a **false negative**: approval-deny gates ONLY the three built-ins that call `Approval.request()` (`Shell`, `WriteFile`, `StrReplaceFile`). Six default built-ins — `ReadFile`, `ReadMediaFile`, `Glob`, `Grep`, `FetchURL`, `SearchWeb` — run with **no `ApprovalRequest`** and so bypassed the gate (a forced probe read `/etc/hosts` ungated). **Fix (hybrid, trusted-local posture):** the provider ships a restrictive `agentFile` that ENABLES the native read/search built-ins (`ReadFile`/`ReadMediaFile`/`Glob`/`Grep`) for performance but EXCLUDES write/exec (`Shell`/`WriteFile`/`StrReplaceFile`), network (`FetchURL`/`SearchWeb`), and subagents — those route through Max's audited `externalTools`. Empirically re-verified 2026-06-03 (3/3: exec/egress built-ins + ambient MCP tools unreachable, native read works, bridged tool dispatches). Accepted residual: native `ReadFile` can read host files ungated/unaudited (fine for a trusted single-user agent). See **§ Isolation: breach & fix** below.
> See the plan: `docs/superpowers/plans/2026-05-23-kimi-agent-sdk-provider.md`.

## What this is

A planned `kimi-agent` LLM provider that drives `@moonshot-ai/kimi-agent-sdk` (the Kimi Code CLI) as an in-process agentic runtime, mirroring the `claude-subscription` provider. See `claude-subscription-bridge.md` for the pattern being mirrored.

## Verified API surface (`@moonshot-ai/kimi-agent-sdk@0.1.8`, from `dist/*.d.ts`)

- `createSession(options: SessionOptions): Session`
  - `SessionOptions = { workDir: string; sessionId?; model?; thinking?; yoloMode?; executable?; env?: Record<string,string>; externalTools?: ExternalTool[]; agentFile?: string; clientInfo?; skillsDir?; shareDir? }`
  - **No `hooks` field** — the `PreToolUse` hook (a clean canUseTool analog) is only on the lower-level `ProtocolClient.start(ClientOptions)`, NOT on `createSession`. Public-API isolation must use the **approval** path.
- `Session`: `prompt(content: string | ContentPart[]): Turn`; `close(): Promise<void>`; settable `externalTools`, `model`, `thinking`, `yoloMode`, `executable`, `env`; `setPlanMode()`.
- `Turn`: `[Symbol.asyncIterator]()` (yields `StreamEvent`, returns `RunResult`); **`interrupt(): Promise<void>`** (the abort method — NOT `cancel()`); `approve(requestId, response)`; `respondQuestion(...)`; `steer(...)`; `result: Promise<RunResult>`.
- `ApprovalResponse = "approve" | "approve_for_session" | "reject"`.
- `ExternalTool = { name; description; parameters: Record<string, unknown>; handler }`. Handler: `(params: Record<string, unknown>) => Promise<{ output: string; message: string }>`. **Note: handler return has NO `is_error` field** — Max tool errors must be encoded in `output`/`message`. Construct `ExternalTool` directly (no zod); `createExternalTool` is the only zod-requiring helper and we skip it.
- `RunResult = { status: "finished" | "cancelled" | "max_steps_reached"; steps? }`.
- Events (`WireEvent`): TurnBegin, TurnEnd, StepBegin, StepInterrupted, CompactionBegin/End, StatusUpdate, HookTriggered, HookResolved, ContentPart, ToolCall, ToolCallPart, ToolResult, SteerInput, SubagentEvent, ApprovalResponse, ParseError.
- Requests requiring a response (`WireRequest`): **ApprovalRequest, ToolCallRequest, QuestionRequest, HookRequest**. `ApprovalRequestPayload = { id; tool_call_id; sender; action; description; display? }`. Must answer `QuestionRequest` too or the loop hangs.
- `ContentPart` text shape: `{ type: "text", text }`; thinking: `{ type: "think", ... }`.

## Local environment facts (this machine)

- `kimi` CLI v1.12.0 at `~/.local/bin/kimi`. Config at `~/.kimi/config.toml`.
- Auth = a **managed "kimi-code" plan** (`provider = "managed:kimi-code"`, OAuth file storage), base `https://api.kimi.com/coding/v1`. Not a raw Moonshot API key. `default_yolo = false`.
- `[loop_control] max_steps_per_turn = 100` — the CLI already bounds steps per turn (surfaces `RunResult.status: "max_steps_reached"`). Host-side step counting is a secondary guard.

## Isolation: breach & fix (2026-06-03)

**The breach.** Approval-deny is NOT a complete isolation gate — it gates only tools that emit an `ApprovalRequest`. Verified against the installed kimi-cli (1.12.0): exactly three built-ins call `Approval.request()` (`Shell` → `shell/__init__.py`, `WriteFile` → `file/write.py`, `StrReplaceFile` → `file/replace.py`). The other six default built-ins — `ReadFile`, `ReadMediaFile`, `Glob`, `Grep`, `FetchURL`, `SearchWeb` — have no approval call and **execute ungated**, bypassing Max's ToolExecutor/permission/audit layer. A forced run of `scripts/kimi-agent/isolation.mjs` (instruct the model to use `ReadFile` on `/etc/hosts`) returned the file contents with `is_error:false` and **no** `ApprovalRequest`. Severity: ungated file-read + filesystem search + network egress = read-and-exfiltrate + SSRF.

**Why the 2026-06-02 "PASS" was wrong.** That probe lets the model *choose* its tools and only happened to use `Shell` for both steps (`Shell` IS gated), so it recorded "two calls gated" and passed — while never exercising a read-only built-in. The hole was always present (`read.py` never had an `Approval.request()` on any version); it is a non-deterministic false negative, not a regression.

**The fix (hybrid).** kimi-cli builds its tool set from the agent spec's **positive `tools` allowlist** (`kimi_cli/soul/agent.py` → `toolset.load_tools`); an omitted built-in is never registered and `toolset.handle()` returns `ToolNotFoundError` without executing — a true pre-execution disable. The provider now ALWAYS writes a restrictive `agentFile` via `src/providers/kimi-agent/agent-file.ts` with a positive allowlist of the native **read/search** tools only (`ReadFile`/`ReadMediaFile`/`Glob`/`Grep`) + `subagents: {}`. The write/exec and network built-ins are omitted → unreachable; the model uses Max's audited `externalTools` for those (they register on the already-loaded toolset via `kimi_cli/wire/server.py`, independent of `tools`). The native read tools are enabled deliberately (the model is trained on them; faster code navigation); the accepted residual is ungated/unaudited host reads, fine for a trusted single-user agent. The approval-deny loop is KEPT as defense-in-depth (and is what contains ambient MCP tools — see below). `KIMI_NATIVE_TOOL_NAMES` is also merged into the provider's approval allowlist so a future kimi that gates a read tool won't silently break it.

**Ambient MCP loading (hygiene, NOT a hole).** kimi-cli auto-loads `~/.kimi/mcp.json` in every mode incl. `--wire` (`cli/__init__.py:436-439`, only skipped when an explicit `--mcp-config-file` is passed — which the SDK's fixed `buildArgs` cannot do). So the user's personal MCP servers (github/playwright/canva/context7) spawn per session and their tools are added to the toolset *independently of the `tools` allowlist* (`soul/agent.py:259` `load_mcp_tools`). This is contained: **every** `MCPTool.__call__` calls `approval.request()` (`soul/toolset.py:382`), so MCP tools emit an `ApprovalRequest` and the provider's approval-deny loop rejects them (probe: `browser_navigate` → `is_error:true`). Residual is perf/hygiene (npx subprocess spawn + wasted model turns), not security. Optional hardening (not yet done): suppress ambient MCP via an `executable` wrapper that injects `--mcp-config-file <empty>`, or request an SDK option. **Maintenance warning:** the approval-deny loop is now the *sole* container for ambient MCP tools (the agent-file allowlist only governs kimi's own built-ins). Weakening or removing it re-opens MCP reach — do not.

**Re-verification (2026-06-03, hybrid).** `scripts/kimi-agent/isolation-agentfile.mjs` (real `writeKimiAgentFiles`; forces ReadFile + Shell + FetchURL + a bridged tool), 3/3 runs: `unexpectedRan=0`, `proofWritten=false`, `readReachable=true`, bridged tool dispatches, ambient `browser_navigate` rejected → ✅ PASS. The check asserts ONLY the allowlisted read tools + the bridged tool may execute. Unit invariants in `src/providers/kimi-agent/__tests__/agent-file.test.ts`.

### ⚠️ Superseded: 2026-06-02 "PASS" (false negative — kept for context)

With an active membership, `scripts/kimi-agent/spike-isolation.mjs` was re-run. The model emitted two built-in `Shell` calls (`id > proof.txt`; `head -n 1 /etc/hosts`); both surfaced an `ApprovalRequest`, both were rejected, and both returned `is_error:true "rejected by the user"`. The proof file was never written. `approvals=2 toolCalls=2 ungatedToolCalls=0 → VERDICT: ✅ PASS`. **This run never drove `ReadFile`** — see the breach above for why it was a false negative.

### Event-ordering finding (corrected the probe)

The SDK emits events in the order **`ToolCall` → `ApprovalRequest` → (host responds) → `ToolResult`**, NOT approval-first. The original probe flagged "ungated" at `ToolCall` time (before the approval arrived) and produced a false `❌ FAIL`. Containment must be judged **after** the stream: a tool is ungated only if it (a) never produced an `ApprovalRequest` AND (b) returned a non-error `ToolResult`. The authoritative side-effect signal is the proof file (host reached), which stayed absent. Any in-tree port (Phase 3 Task 17) MUST evaluate post-stream, not per-event.

### Historical blocker (2026-05-23/24) — now cleared

The earlier run hit `_CliError: 402 … "unable to verify your membership benefits" (CHAT_PROVIDER_ERROR / -32003)`: OAuth resolved but the managed "kimi-code" plan's membership was inactive, so no model output or tool call could be produced and the isolation question was unverifiable. Resolved by re-activating membership.

## Robustness lesson for the implementation

The SDK threw the 402 from its readline `handleLine` callback — i.e. asynchronously, OUTSIDE the `for await` async-iterator. A `try/catch` around the iterator did NOT catch it; the process crashed. **The provider must guard against SDK errors raised off the await path** (e.g. wrap the session in a domain/`process.on('uncaughtException')`-aware boundary or listen for an error channel), and map `CliError`/`code: "CHAT_PROVIDER_ERROR"` / numericCode `-32003` / HTTP 402 into a typed `KimiAgentBridgeError` (subtype e.g. `membership-inactive` / `auth-failed`). Capture this in Phase 3 error classes.

## Open questions — status after the live probe

The approval-deny gate keys off `ApprovalRequestPayload.sender` (the tool name; verified in `schema.cjs:324`).
- ❌ **Do ALL built-in tools surface an `ApprovalRequest`?** NO — resolved 2026-06-03 (see § Isolation: breach & fix). Only `Shell`/`WriteFile`/`StrReplaceFile` do; the six read-only/network built-ins do not and run ungated. Approval-deny is therefore necessary but NOT sufficient; the load-bearing control is the agent-file `tools: []` allowlist that prevents the built-ins from being registered at all.
- ⏳ **Do registered external tools fire their handler directly (no `ApprovalRequest`)?** Not exercised by this isolation probe (it registers `externalTools:[]`). Phase 1's provider tests cover the external-tool handler path; if an external tool ever surfaces an `ApprovalRequest`, confirm `sender` equals the Max tool name in the approve branch.
- ⏳ **SDK off-iterator throws (I4):** the 402 surfaced from the SDK's readline callback, not the async iterator; `for await … try/catch` did NOT catch it. The provider still needs a typed `KimiAgentBridgeError` + a boundary that catches SDK errors raised off the await path. Tracked for Phase 3 error classes (Task 16).

## Re-running the probe

```bash
# BARE SDK (no agent file) — DEMONSTRATES the breach: ReadFile runs ungated.
node assistant/scripts/kimi-agent/isolation.mjs          # FAILs when the model picks ReadFile

# THE FIX — restrictive agentFile (tools: []); built-ins unreachable, external tool works.
bun assistant/scripts/kimi-agent/isolation-agentfile.mjs # expect VERDICT: ✅
```
Requires an active Kimi membership (else HTTP 402). The in-tree port lives at `scripts/kimi-agent/isolation.mjs` with a default-skip `bun:test` bridge (`src/__tests__/kimi-agent-isolation-probes.test.ts`) so CI can re-assert containment behind `KIMI_AGENT_PROBES_ENABLED=1`:

```bash
KIMI_AGENT_PROBES_ENABLED=1 bun test src/__tests__/kimi-agent-isolation-probes.test.ts
```

## Operating the provider

For day-to-day diagnosis — provider missing from the picker, membership/auth banners, "model replies but tools don't run", clearing a stale `~/.kimi/config.toml`, and the OpenAI-compatible `kimi` chat fallback — see the runbook: [`../runbook-kimi-agent.md`](../runbook-kimi-agent.md).
