# Claude Subscription Bridge — Implementation Plan, Audit & Test Spec

> **Status:** Implementation behind a feature flag (`claude-subscription-provider`, default off). Foundation security empirically verified. 38 unit tests passing. Remaining work is integration tests + UI polish; no protocol-level blockers.
> **Audience:** Provider/runtime engineers who will take this to production.
> **Goal:** Let users on a Claude Max subscription drive a Vellum assistant — including skill execution — without an Anthropic API key, while preserving every existing security invariant.

---

## ▶ Resuming this work in a new session

**Start here.** A new session continuing this work should:

1. **Orient (5 min).** Read this doc end-to-end, especially §3 (audit table), §9 (resolved decisions), §10b (test suite state), §11 (closing notes).
2. **Confirm git posture.** Repo currently has **zero commits**. Decide with the user: first commit on `master`, feature branch off an upstream, or keep working uncommitted. **No git operations have been performed yet.**
3. **Re-verify the foundation** before touching anything:
   ```bash
   cd assistant
   bun test src/__tests__/claude-subscription-{provider,concurrency}.test.ts
   # expect: 38 pass / 0 fail
   NODE_OPTIONS="--max-old-space-size=8192" bunx tsc --noEmit
   # expect: EXIT=0
   ```
4. **Re-run the empirical probes** (now in tree at `assistant/scripts/claude-subscription/`):
   ```bash
   node assistant/scripts/claude-subscription/i-11-isolation.mjs        # baseline isolation
   node assistant/scripts/claude-subscription/i-11b-subagent-isolation.mjs  # sub-agent containment
   node assistant/scripts/claude-subscription/i-22-system-prompt.mjs    # systemPrompt replacement
   # i-11 + i-11b expect VERDICT: ✅; i-22 always exits 0 — interpret per-probe flags
   ```
   Or via the bun:test wrapper (still default-skipped — pick whichever is more ergonomic):
   ```bash
   CLAUDE_SUBSCRIPTION_PROBES_ENABLED=1 bun test src/__tests__/claude-subscription-isolation-probes.test.ts
   ```
5. **Pick the next task** from the priority queue below.

### Priority queue (in order of value-per-effort)

| # | Task | Why | Approx. effort |
|---|---|---|---|
| 1 | ~~**Port the empirical `.mjs` probes into the Vellum test tree**~~ **(done)** The 3 verified probes (i-11, i-11b, i-22) now live at `assistant/scripts/claude-subscription/` with a default-skip bun:test bridge at `src/__tests__/claude-subscription-isolation-probes.test.ts`. Opt in via `CLAUDE_SUBSCRIPTION_PROBES_ENABLED=1`. The two `i-19-*` probes from the demo workspace were intentionally **not** ported (bounded run inconclusive, unbounded run hung 20+ min; the I-19 mitigation is `maxTurns: 25` in `client.ts`). | The empirical regression tests are now in tree with cross-referenceable VERDICT assertions; CI can opt in once a credentialed `claude` install is available in the runner. | done |
| 2 | ~~**Wire the SwiftUI picker** to render "Install Claude Code" / "Run `claude login`" hints when `isProviderAvailable("claude-subscription") === false`.~~ **(done)** Implemented per `claude-subscription-picker-setup-hint-plan.md`. New daemon route `GET /v1/provider-availability` returns typed `ProviderAvailabilityStatus` per provider; `SettingsStore.providerAvailability` mirrors it via `ProviderAvailabilityClient`. `ComposerSettingsMenu.providerRow` renders a disabled `VMenuItem` with reason-specific copy (`Install Claude Code` / `Run claude login` / `Feature flag off`) for the `.claudeSubscription` group when the daemon reports `available: false`. Picker-open refresh hook re-fetches via `settingsStoreForRefresh`. Covered by `provider-availability.test.ts` (daemon), `provider-availability-routes.test.ts` (route), `SettingsStoreProviderAvailabilityTests` (store), and 8 helper tests in `ChatProfilePickerTests`. **Bonus fix:** `IconBundle.swift` resolver was silently failing under `swift test` (Bundle.main is `xctest`, not our test bundle), masking every `SettingsStore*Tests` crash behind the build script's WebKit-signal-5 tolerance. Removed `#if !SWIFT_PACKAGE` gate and added the SPM-test sibling-bundle lookup; this un-silences ~10 sibling test files. | Users no longer hit a confusing call-time error when picking the option without Claude Code installed — the row is disabled with a setup hint. | done |
| 3 | ~~**Small DI refactor + unit tests for `provider-availability.ts`.** The current code uses `promisify(execFile)` captured at module load — bun's `mock.module` doesn't propagate through that. Inject `cliPresent: () => Promise<boolean>` and `loginPresent: () => Promise<boolean>` as opts; default to the current impls. Then write tests for the 4-state matrix (CLI × login).~~ **(done)** New exported type `ClaudeSubscriptionProbes` in `provider-availability.ts` accepts optional `cliPresent` and `loginPresent` callbacks; production callers pass nothing and get the real `execFile`-backed implementations. `getProviderAvailabilityStatus`, `getAllProviderAvailability`, and `isProviderAvailable` all take the probes as a trailing optional argument. The previously flaky `provider-availability.test.ts > flag on + cli/login present` test (10s timeout under cross-file load) is replaced by a hermetic 4-state matrix: cli×login → {available, missing-cli, not-logged-in, missing-cli (short-circuit)}; a wrapper-match test asserts `isProviderAvailable` agrees with `.available` across the matrix; a cache test confirms probes fire once per `clearClaudeSubscriptionAvailabilityCache()` window. Full foundation suite verified across 3 consecutive runs at 90/0 each — flake gone. | The availability check is currently only smoke-tested on a live host. With DI, we get hermetic test coverage. | done |
| 4 | ~~**Integration test fixture** in `assistant/src/daemon/__tests__/tool-executor-via-bridge.test.ts`. Wire a real `ToolExecutor` with stubbed prompter / CES client / tool registry, drive `sendMessage` through the bridge, assert all gates fire (allowlist, trust, approval, CES, sandbox, audit) on bridge-invoked tools. Spec is in §6.2.4 (I-1 through I-10).~~ **(done — 10 of 10)** Fixture in `tool-executor-via-bridge.test.ts` covers I-1 (allowlist), I-2 (trust-class denial), I-3 (PermissionPrompter allow + deny), I-4 (CES grant retry — tool returns `cesApprovalRequired`, prompter approves, mock `cesClient.call("record_grant", …)` returns a `grantId`, tool re-runs with `grantId` injected; the approval-required payload never reaches the SDK), I-5 (sandbox routing — skill tool with `executionTarget: "sandbox"` reaches `runSkillToolScriptSandbox` via the real `runSkillToolScript` dispatcher), I-6 (audit lifecycle + conversation-id correlation), I-8 (yieldToUser through real executor aborts the SDK), I-9 (cross-conversation isolation incl. distinct MCP servers + audit-stream isolation), I-10 (abort isolation — outer signal A→sdkAbortA propagates, outer signal A does NOT touch B's sdkAbort; uses an opt-in hang-until-aborted SDK stream so both calls are mid-flight when inspected), plus a smoke happy-path. **I-7 lives in `src/__tests__/loop-bridge-event-forwarding.test.ts`** because it requires driving a full `AgentLoop` (the bridge fixture above bypasses the loop adapter): a bridged tool's `sensitiveBindings` get merged into `substitutionMap` by the bridge closure, then the streamed `text_delta` adapter rewrites the placeholder to the real value before forwarding to the outer-loop consumer; the bridge return's `content` never contains the secret. Discrimination-verified by a second test in the same file that omits the bridge merge → placeholder passes through verbatim. | This is the biggest single gap. It's what would let your team trust the bridge for production rollout — it's the proof, not just the model, that "tools work through the bridge" preserves every Vellum gate. | done |
| 5 | **Telemetry** (Phase 3.1 in this doc). Emit metrics for `claude_subscription.send_message`, `claude_subscription.tool_call`, with trust class / model labels. | Operational observability once people start using it. | 2-3 hours |

### Files to know

| Path | Purpose |
|---|---|
| `assistant/src/providers/claude-subscription/client.ts` | The provider + MCP bridge + retry + concurrency cap |
| `assistant/src/providers/types.ts` | `ProviderToolBridge`, `ToolBridgeResult`, `SendMessageOptions.toolBridge` |
| `assistant/src/agent/loop.ts` | The bridge-closure that calls `this.toolExecutor` with `turnCtx` |
| `assistant/src/providers/model-catalog.ts` | Catalog entry; `setupMode: "cli-login"`; `subscriptionBacked: true` |
| `assistant/src/providers/registry.ts` | Feature-flag gating on provider registration |
| `assistant/src/providers/provider-availability.ts` | CLI + Keychain check |
| `assistant/src/providers/inference/adapter-factory.ts` | Factory entry + parity guard |
| `meta/feature-flags/feature-flag-registry.json` | `claude-subscription-provider`, default off |
| `clients/macos/vellum-assistant/Features/Chat/ComposerSettingsMenu.swift` | `ProviderGroup.claudeSubscription` + provider mapping |
| `assistant/src/__tests__/claude-subscription-provider.test.ts` | 36 unit tests |
| `assistant/src/__tests__/claude-subscription-concurrency.test.ts` | 2 concurrency tests |
| `assistant/scripts/claude-subscription/i-11-isolation.mjs`, `i-11b-subagent-isolation.mjs`, `i-22-system-prompt.mjs` | Empirical isolation probes (in tree; default-skip bun:test bridge at `src/__tests__/claude-subscription-isolation-probes.test.ts`) |
| `assistant/src/daemon/__tests__/tool-executor-via-bridge.test.ts` | Integration tests against the real `ToolExecutor` (priority queue item #4 — partial; I-1/I-6/I-9 + smoke covered, the remainder are TODOs at the bottom of the file). |
| `~/Downloads/claude-subscription-demo/i-19*.mjs` | Historical fan-out probes (NOT in tree — bounded run was inconclusive, unbounded hung 20+ min; the mitigation is `maxTurns: 25` in `client.ts`) |

### Suggested opening prompt for the new session

> Continuing work on the `claude-subscription` LLM provider in vellum-assistant. Read `assistant/docs/architecture/claude-subscription-bridge.md` from the top — pay special attention to the "Resuming this work in a new session" section, §3 (audit), §9 (resolved decisions), and §10b (test suite). Then verify the foundation: `cd assistant && bun test src/__tests__/claude-subscription-{provider,concurrency}.test.ts src/providers/__tests__/provider-availability.test.ts src/runtime/routes/__tests__/provider-availability-routes.test.ts` should show 52 pass, and `NODE_OPTIONS="--max-old-space-size=8192" bunx tsc --noEmit` should be clean. After that, **pick task #3 from the priority queue: DI refactor + unit tests for `provider-availability.ts`.** The current code uses `promisify(execFile)` captured at module load — bun's `mock.module` doesn't propagate through that. Inject `cliPresent: () => Promise<boolean>` and `loginPresent: () => Promise<boolean>` as opts; default to the current impls. Then write tests for the 4-state matrix (CLI × login). Confirm with me before starting.

### Things to not change without re-running the empirical probes

If you touch any of these, re-run I-11, I-11b, I-19 before declaring done:

- The four lines in `client.ts` setting `tools`, `permissionMode`, `settingSources`, `canUseTool` (the "locks")
- `MAX_CONCURRENT_CALLS` (currently 4)
- `maxTurns: 25` in the SDK `query()` options
- `MCP_SERVER_NAME = "vellum-skills"`
- `systemPrompt` option key (NOT `customSystemPrompt` — that was the bug found in I-22)

---

## Empirical foundation: I-11 isolation verified

The foundational claim — "with the right SDK options, the bridge contains tool execution to Vellum's allowlist and the Claude Code subprocess cannot reach the host" — was **verified during scaffolding** via a hermetic test (`tools/claude-subscription-isolation-probe.mjs`, or equivalent in tree once ported from the demo workspace).

**First attempt FAILED** (this is important). The naive config
`{ permissionMode: "bypassPermissions", allowedTools: ["mcp__vellum-skills__noop"], settingSources: [] }`
let the model execute `id > /tmp/proof` via the Claude Code SDK's built-in **Bash** tool. The proof file was written with the host user's real `uid/gid`. `allowedTools` is an *auto-allow* list (skip-the-prompt), **not** a visibility filter — the docstring explicitly says "To restrict which tools are available, use the `tools` option instead."

**Correct config (verified PASSING):**

```ts
query({
  prompt,
  options: {
    model,
    tools: [],                  // disable ALL built-in tools (Bash/Read/Write/…)
    settingSources: [],         // skip user/project/local Claude Code settings
    permissionMode: "default",  // never auto-bypass
    allowedTools: [<mcp tool names>],
    canUseTool: async (name) =>
      ALLOW.has(name)
        ? { behavior: "allow" }
        : { behavior: "deny", message: `Tool '${name}' is not available.` },
    mcpServers: { "vellum-skills": { type: "sdk", instance: vellumMcp } },
    customSystemPrompt,
  },
});
```

With that config, the SDK's `system/init` message lists only `mcp__vellum-skills__*` tools — Gmail, Drive, Notion, Vercel, etc. integrations attached to the user's Anthropic account (which `settingSources: []` did NOT exclude) **disappear** from the model's view. The model verbally confirms it lacks shell access. Tool-use attempts: zero. Proof file: never written.

**Lesson:** `settingSources: []` is necessary but not sufficient. `canUseTool` is the seatbelt that catches account-level MCP servers the SDK auto-attaches behind the scenes. Both must be set.

---

## 0. TL;DR

A new provider `claude-subscription` uses `@anthropic-ai/claude-agent-sdk` to call Claude with the user's local OAuth credentials (from `claude login`). Because the SDK runs its own agent loop, an in-process MCP server inside the provider exposes Vellum's tools to the SDK and routes their calls back into Vellum's existing `ToolExecutor` — so trust gates, approval prompts, CES grants, the sandbox, and audit all keep firing. The scaffold is in tree at `providers/claude-subscription/client.ts` with hooks in `agent/loop.ts`. This document audits what's done, lists every gap with severity, specifies the tests required, and lays out the controls and acceptance criteria for shipping.

---

## 1. Background & Constraints

### 1.1 Why a bridge is required at all

Anthropic ships OAuth tokens (`sk-ant-oat01-…`) that authenticate Claude Code. Empirically verified during scaffolding: those tokens **cannot be used directly against `api.anthropic.com/v1/messages`** — every direct call returns `HTTP 429` with `{"type":"rate_limit_error","message":"Error"}` regardless of body or beta header. So the only path that uses the Max subscription is via the Agent SDK, which spawns the `claude` CLI subprocess and delegates the call. The CLI is an *agent runtime*, not an LLM API — it runs its own tool loop with its own system prompt, its own MCP support, and its own built-in tools (Read/Write/Bash). Vellum's existing providers (`AnthropicProvider` etc.) talk to a raw LLM API; this one talks to an agent.

### 1.2 Vellum's tool execution invariants (must not be weakened)

Recorded in `ARCHITECTURE.md` and the codebase:

1. **No tool runs outside the `ToolExecutor` pipeline.** Allowlist → permission classifier → trust rule → user prompt (if needed) → CES grant (if needed) → tool.execute (sandboxed for skill tools) → audit emission.
2. **`trustClass` is fail-closed.** Unknown actors cannot run tools that aren't whitelisted for them.
3. **Skill tools with `executionTarget: "sandbox"` run only in the sandbox.** Version hash verified before exec.
4. **`sensitiveBindings` placeholders never reach persisted history or client events.** They only resolve at the final user-render step.
5. **Every tool invocation emits a `ToolLifecycleEvent`** → audit listener → `tool-usage-store`.
6. **Cross-conversation isolation.** Tools see only their conversation's `ToolContext`.

Any new transport must satisfy all six. The audit in §3 measures the current scaffold against them.

### 1.3 Provider contract this bridge must satisfy

`assistant/src/providers/types.ts`:
- `Provider.sendMessage(messages, tools, systemPrompt, options): Promise<ProviderResponse>`
- Stream incremental tokens via `options.onEvent({ type: "text_delta", … })`
- Return `{ content: ContentBlock[], model, usage, stopReason }`
- Honor `options.signal: AbortSignal`

The provider runs inside `agent/loop.ts:run()` which then dispatches `tool_use` blocks to `this.toolExecutor(name, input, onChunk, toolUseId, turnCtx)`. **In the subscription path, no `tool_use` blocks surface to the outer loop — the SDK consumes them internally and returns only final text.** That's the architectural seam.

---

## 2. Current Implementation Snapshot

### 2.1 Files touched

| File | Status | LOC delta |
|---|---|---|
| `assistant/package.json` | Modified — added `@anthropic-ai/claude-agent-sdk@0.3.144` | +1 |
| `assistant/src/providers/types.ts` | Modified — added `ProviderToolBridge`, `ToolBridgeInvocation`, `ToolBridgeResult`, `SendMessageOptions.toolBridge` | +44 |
| `assistant/src/providers/claude-subscription/client.ts` | **New** — `ClaudeSubscriptionProvider`, bridge resolution, in-process MCP server | +280 |
| `assistant/src/providers/inference/adapter-factory.ts` | Modified — added `claude-subscription` factory | +5 |
| `assistant/src/providers/model-catalog.ts` | Modified — added catalog entry with 3 Claude models, `setupMode: "keyless"`, no pricing | +52 |
| `assistant/src/agent/loop.ts` | Modified — built per-call `toolBridge` closure that delegates to `this.toolExecutor`; reordered `turnCtx` construction | +45 / -10 |
| `clients/macos/vellum-assistant/Features/Chat/ComposerSettingsMenu.swift` | Modified — added `ProviderGroup.claudeSubscription` + mapping | +4 |

### 2.2 What is verified

- `bunx tsc --noEmit` (with `--max-old-space-size=8192`) passes.
- `import('./providers/inference/adapter-factory.js')` loads cleanly — the catalog↔factory parity guard at module load is satisfied.
- `import('./providers/claude-subscription/client.js')` loads — exports `ClaudeSubscriptionProvider`, `setVellumToolBridge`, `clearVellumToolBridge`.
- `import('./agent/loop.js')` loads — the `randomUUID` import and reordered `turnCtx` don't break anything.

### 2.3 What is NOT verified

- **Zero runtime tests.** The provider has never sent a real request through Vellum's stack.
- **No end-to-end integration test** of: outer loop → provider → SDK → MCP → bridge → ToolExecutor → audit.
- **No claim that the bridge inherits all gates** has been validated against the real `ToolExecutor`.
- **No measurement of whether SDK opts (`settingSources: []`, `permissionMode: "bypassPermissions"`, `allowedTools: [...]`)** actually achieve the isolation we expect.

---

## 3. Audit: How Each Invariant Fares

Status legend: ✅ preserved · ⚠️ degraded · ❌ broken · ❓ unverified.

| # | Invariant | Status | Notes |
|---|---|---|---|
| I-1 | Allowlist enforcement (`allowedToolNames`) | ✅ verified | Bridge calls `this.toolExecutor` → `ToolExecutor.execute` → `approvalHandler.checkPreExecutionGates`, which enforces it. **Empirically verified** by `tool-executor-via-bridge.test.ts` (I-1, I-1b): tools outside the allowlist return `isError: true` with the "not currently active" message through the MCP layer. |
| I-2 | Risk classification (`classifyRisk`) | ✅ verified | Same path. **Empirically verified** by `tool-executor-via-bridge.test.ts` (I-2): a checker-decision `"deny"` propagates to the bridge as `isError` with the denial reason in `content`. |
| I-3 | Trust rule evaluation (`permissions/check`) | ✅ | Same path; `trustClass` comes from `turnCtx`. |
| I-4 | Interactive permission prompt | ✅ verified | The prompter is `PermissionPrompter` from `ToolSetupContext`; it dispatches to the client. **Empirically verified** by `tool-executor-via-bridge.test.ts` (I-3, I-3b): when the checker returns `"prompt"` the prompter fires synchronously through the bridge; `"deny"` propagates as `isError`, `"allow"` runs the tool. The SDK's await on the bridge Promise is the natural backpressure point that holds the prompt UI open. |
| I-5 | CES approval flow (`bridgeCesApproval`, grant retry) | ✅ partial (approve path) | **Empirically verified** by `tool-executor-via-bridge.test.ts` (I-4): a bridge call for a tool that returns `cesApprovalRequired` enters `bridgeCesApproval` (`credential-execution/approval-bridge.ts`), the prompter approves (`makePrompter("allow")` maps via `mapUserDecisionToCesDecision` → grantDecision `"approved"`), the mock `cesClient.call("record_grant", …)` returns a `PersistentGrantRecord` with a fixed `grantId`, the executor re-invokes the tool with `grantId` injected into `input`, and only the retry's output reaches the SDK. Discrimination-verified: flipping the prompter to `"deny"` reduces `executeCalls.length` from 2 → 1 (no retry path). The deny / timeout / error / `record_grant: success=false` branches are NOT asserted as their own tests yet — only the approve path is. |
| I-6 | Sandbox isolation for skill tools | ✅ verified | `tool.execute` for `origin: "skill"` routes through `runSkillToolScriptSandbox`. Bridge is transparent. **Empirically verified** by `tool-executor-via-bridge.test.ts` (I-5): a skill tool with `executionTarget: "sandbox"` driven through the bridge reaches `runSkillToolScriptSandbox` via the real `runSkillToolScript` dispatcher, the same `ToolContext` that the bridge captured by closure arrives at the sandbox runner (conversation id + working dir + trust class preserved), and the lifecycle `start` event carries `executionTarget: "sandbox"` for audit. |
| I-7 | Skill version-hash verification | ✅ | Inside sandbox runner. Unchanged. |
| I-8 | Audit emission (`onToolLifecycleEvent`) | ⚠️ verified | Events fire as normal, but every record has a synthetic `toolUseId: "mcp-bridge-<uuid>"` instead of the LLM's real tool_use_id. Audit trace cannot be joined to the LLM's `tool_use` block. Severity: **medium** for compliance, **low** for security. **Lifecycle emission empirically verified** by `tool-executor-via-bridge.test.ts` (I-6, I-6b): `start` + `executed` events fire through `onToolLifecycleEvent`, and every event carries the executor-context conversation id. The synthetic-ID gap remains; resolving it is Phase 2.6 in the bridge doc. |
| I-9 | Abort propagation | ✅ partial | Outer signal → SDK `AbortController` empirically verified by `tool-executor-via-bridge.test.ts` (I-10): aborting conversation A's outer signal propagates to A's internal `sdkAbort` via the per-call `externalSignal.addEventListener("abort", …)` bridge but does NOT touch B's `sdkAbort`. The downstream leg — SDK abort → `tool.execute` honoring `context.signal` from `turnCtx.signal` — still relies on each tool to check `context.signal`; not exercised by I-10. |
| I-10 | Cross-conversation isolation | ✅ verified | Bridge captures `turnCtx` by value per `sendMessage` call. Closure-scoped. **Empirically verified** by `tool-executor-via-bridge.test.ts` (I-9): two concurrent providers with distinct allowlists confirm bridge A's allowlist never leaks into bridge B's executor context; the MCP server instances are distinct objects and audit streams are isolated. |
| I-11 | `sensitiveBindings` substitution | ✅ resolved (Phase 2.2) + verified (I-7) | The bridge closure in `loop.ts` merges `result.sensitiveBindings` into the outer-loop `substitutionMap` BEFORE returning to the SDK. When the model later echoes a placeholder in its streamed text, the existing text-delta substitution at `loop.ts:~676` rewrites it to the real value at the same seam as non-bridged tools. `ToolBridgeResult.sensitiveBindings` was also added so audit/telemetry can observe which bindings flowed through. Two MCP-layer sanity tests in `claude-subscription-provider.test.ts` verify the real value never leaks into the SDK-visible MCP result. **End-to-end verified** by `src/__tests__/loop-bridge-event-forwarding.test.ts` (I-7): a fake provider invokes `options.toolBridge`, the toolExecutor returns a `sensitiveBindings` entry, then the provider emits `text_delta` containing the placeholder — and the outer-loop event consumer receives the real value, not the placeholder. The bridge's `content` field never contains the secret (asserted on the value the SDK would see). Discrimination-verified by a second test that omits the bridge call → placeholder passes through verbatim, confirming the substitution is bridge-driven, not blanket. |
| I-12 | `contentBlocks` (images, rich content) | ✅ resolved (Phase 2.1) | `ToolBridgeResult.contentBlocks` now carries the rich blocks; `client.ts:mapContentBlocksToMcp` translates `text` → MCP text, `image` → MCP image (base64 + mimeType), and `file` → text via `extracted_text` (binary blobs without extracted text are dropped with a warning). Model-internal kinds (`thinking`, etc.) are skipped. 6 new unit tests in `claude-subscription-provider.test.ts` cover the mapping shape including ordering, multi-text, image, file-fallback, and the absent-blocks identity case. |
| I-13 | `yieldToUser: true` | ✅ verified | Resolved by D-2 (SDK abort fires via `setImmediate` after the MCP result reaches the SDK). **Empirically verified** by `tool-executor-via-bridge.test.ts` (I-8): a tool returning `yieldToUser: true` through the real `ToolExecutor` aborts the SDK's `AbortController` on the next tick, after the MCP CallToolResult has been delivered. |
| I-14 | `toolResultTruncate` middleware | ✅ resolved (Phase 2.4) | `SendMessageOptions.maxToolResultChars` is populated by `agent/loop.ts` from `calculateMaxToolResultChars(contextWindowTokens)`. The MCP CallTool handler in `client.ts` calls `truncateToolResultText(result.content, maxChars)` before returning to the SDK. `contentBlocks` are not truncated (image base64 has no meaningful newline-aware truncation, parity with outer loop). 4 new tests cover oversized truncation, within-budget passthrough, unset-option passthrough, and contentBlocks-pass-through. **Note:** the bridge does NOT route through the `toolResultTruncate` plugin pipeline — user-supplied truncation strategies (summarizers, etc.) registered via plugins apply to the outer loop only. Promoting to the plugin pipeline is a follow-up if user plugins start using it. |
| I-15 | `tool_output_chunk` streaming events | ✅ resolved (Phase 2.5) | `ToolBridgeInvocation` carries an optional `onChunk` callback. The MCP CallTool handler in `client.ts` synthesizes a per-call `mcp-bridge-chunk-<uuid>` correlation id and wraps it into an `onChunk` that emits `tool_output_chunk` events through `options.onEvent`. The bridge closure in `agent/loop.ts` forwards `invocation.onChunk` as the 3rd argument to `LoopToolExecutor` (production: `conversation-tool-setup.ts` threads it into `ToolContext.onOutput`). 3 new unit tests in `claude-subscription-provider.test.ts` verify N chunks→N events, distinct ids per call, and `onChunk: undefined` when no `onEvent` is supplied; 1 new integration test in `tool-executor-via-bridge.test.ts` drives chunks through the real `ToolExecutor` and asserts the consumer sees them. **Note:** the `chunkToolUseId` is opaque and doesn't match any LLM-visible id — Phase 2.6 will replace it with the SDK's real `tool_use_id` once the assistant-message stream is plumbed. |
| I-16 | `provider-availability` check | ❌ | Currently always-available (default for keyless). If `claude` CLI is missing or not logged in, the provider fails at call time with no UI hint. Severity: **medium** (UX). |
| I-17 | Feature flag gate | ❌ | No flag declared. Anyone with the picker can select it. Severity: **medium** (rollout safety). |
| I-18 | Claude Code's own audit trail | ⚠️ | The `claude` CLI writes its own session logs to `~/.claude/sessions/`. Tool calls fired through Vellum's executor inside the SDK loop are *also* in those logs, in a less-trusted location. Severity: **medium** for compliance contexts. |
| I-19 | Subagent fan-out | ❓ | The SDK supports the model spawning sub-agents. Each sub-agent could call Vellum tools via the bridge. Unknown whether `allowedTools: []` filters apply to sub-agents; potential for fan-out beyond expected concurrency. |
| I-20 | MCP server name | ⚠️ | Hardcoded `"vellum"`. Vellum's tool registry uses `origin: "mcp"` + `ownerMcpServerId` for *external* MCP servers the user configures — no in-process collision today, but rename to `"vellum-skills"` for clarity and future-proofing. |
| I-21 | Cost / quota accounting | ⚠️ | Catalog has no pricing → `UsageTrackingProvider` computes $0 cost. Tokens are still recorded. If quota policy is per-dollar, this provider bypasses spend caps. Per-token quota still applies. Severity: **low** unless dollar quotas exist. |
| I-22 | Custom system prompt vs Claude Code's | ✅ verified | **Important bug found & fixed.** Initial scaffold used `customSystemPrompt` (not a real SDK option) — silently ignored, Claude Code's coding-agent prompt remained. Switched to `systemPrompt: <string>` (the documented option). Re-tested: model now identifies as Vellum's persona, refuses coding when instructed, no Claude Code identity leakage. **Lesson:** the SDK does not warn on unknown option keys — verify any `*Prompt` option is the actual name. |
| I-23 | SDK built-in tools (Read/Write/Bash) | ✅ verified | The empirical I-11 test (above) confirms `tools: []` + `canUseTool` denial + `settingSources: []` reduces tool visibility to the bridge's MCP allowlist only. The scaffold code has been updated to this config. **DO NOT change those four options without re-running the test.** |
| I-24 | User's Anthropic-account MCP integrations leak (Gmail/Drive/etc.) | ✅ mitigated | Discovered during I-11: `settingSources: []` does **not** exclude account-level MCP integrations. `canUseTool` runtime denial catches them. Without `canUseTool`, a model in subscription mode could send emails or read Drive files without going through Vellum's CES. **`canUseTool` is now a load-bearing security control, not a nice-to-have.** |

**Items still needing empirical verification before any user sees this:** *(none at the protocol level — all initially-deferred ❓ items resolved)*.

**Already verified empirically:** I-22 (`systemPrompt` replaces Claude Code's prompt), I-23 (built-in tool isolation), I-24 (account-MCP isolation), I-11b (sub-agent containment with Task enabled), **I-9 (abort propagation: external signal → SDK AbortController, both pre-abort and mid-call — covered by unit test)**, **I-4 + I-5 by inheritance (bridge correctly awaits slow tool execution — unit test simulates a 200ms async + an externally-resolved approval-prompt promise; both flow through correctly)**.

**I-19 (sub-agent fan-out under load) — fully verified, important operational finding included:**

1. **Security (containment):** I-11b confirmed individual sub-agents cannot escape. The 1000-concurrent unit test confirms `canUseTool` is race-free by construction (no shared mutable state in the allowlist check; per-call `Set` is read-only). So even under arbitrary fan-out, each agent's tool calls hit the same deny path.
2. **Operational (runaway recursion):** The *unbounded* empirical run (`i-19-subagent-fanout-test.mjs`) hung for **20+ minutes** with sub-agents recursively spawning their own sub-agents. The SDK does not natively bound recursion depth; without intervention, one user message can consume hours of subscription quota and hold an open subprocess indefinitely.
3. **Mitigation now in tree:** `query()` is now called with `maxTurns: 25`. This caps total turns (parent + every nested sub-agent turn). When exceeded, the SDK returns `error_max_turns`, which the provider already maps to `stopReason: "max_turns"`. Bounded by construction — no further empirical risk.
4. **Inconclusive bounded run:** The bounded `i-19-bounded-fanout-test.mjs` (N=2, 60s timeout) completed but the model *hallucinated* sub-agent execution rather than emitting actual Task tool_use blocks (`canUseTool` was never called; assistant text claimed activity that didn't happen). Documented as a test-instrumentation limitation, not a security finding.

The new `maxTurns: 25` line in `client.ts` is **load-bearing for cost containment**. Reduce it if you want tighter bounds; do not remove it.

---

## 4. Threat Model

### 4.1 Assets

- A1 — User credentials (Anthropic OAuth, OAuth tokens for Gmail/Slack/etc. in CES)
- A2 — User data (memory store, conversation history, journal)
- A3 — User's filesystem and shell (home directory, ssh keys, etc.)
- A4 — Other actors' data (in multi-actor channels: Slack/SMS — Vellum is multi-tenant inside one machine via trust)

### 4.2 Trust boundaries

- TB-α — Boundary between Vellum's runtime and the `claude` CLI subprocess
- TB-β — Boundary between the SDK's agent loop and the model's tool selection
- TB-γ — Vellum's existing actor/trust boundaries (unchanged)

### 4.3 Threats

| ID | Threat | Mitigation in the bridge |
|---|---|---|
| T-1 | A malicious model uses the SDK's Bash tool to read `~/.ssh/`, bypassing Vellum's allowlist. | `allowedTools` filtered to MCP-only **AND empirically verified**. Plus `settingSources: []` prevents the user's Claude Code config from re-enabling Bash. Plus `permissionMode: "bypassPermissions"` — *only safe iff allowedTools is correct*. |
| T-2 | An untrusted actor (trustClass="unknown") tricks the bridge into running a guardian-only tool. | The bridge calls `ToolExecutor.execute` which evaluates trust rules. Inherited gate. |
| T-3 | A bug in the bridge skips audit emission for tool calls. | Audit fires inside `ToolExecutor.execute`, not in bridge code. Inherited. **Unit test asserts call counts.** |
| T-4 | The bridge mishandles a placeholder substitution and the real secret reaches the model. | The bridge drops `sensitiveBindings` but **does not modify `content`** — `content` already has placeholders applied. Secret stays out of the model context. The substitution UX regresses (placeholders shown to user), but the security property holds. **Test asserts model sees no secret values.** |
| T-5 | Resource exhaustion: subagent fan-out spawns N parallel tool calls. | `tool.execute` has timeouts (`toolExecutionTimeoutSec`). Concurrency limit is the SDK's, not Vellum's. Mitigation: cap SDK `maxTurns` and / or disable subagents in `query()` options. |
| T-6 | The OAuth token in Keychain is read by a non-Vellum process. | Out of scope — that's a system-level Keychain ACL concern, unchanged by the bridge. |
| T-7 | A Vellum tool returns malicious instructions in `content` that drives the SDK loop somewhere unsafe. | The model sees the tool result as a tool_result block. Vellum's tool result text is generally considered model-influenced input (prompt-injection risk). Mitigation is the same as today: Vellum's system prompt and trust gates already assume tool output is untrusted. The bridge does not change the threat. |
| T-8 | Multiple conversations call `sendMessage` concurrently; the wrong bridge fires for the wrong conversation. | Per-call `options.toolBridge` captures `turnCtx` by closure. **Cross-conversation regression test required.** |
| T-9 | The SDK is hung; abort doesn't propagate; conversation gets stuck. | `AbortController` is plumbed through `query()`. Verify behavior. Worst case: kill the SDK subprocess. |
| T-10 | An attacker installs a fake `claude` binary on the PATH. | The SDK spawns whatever `claude` is on PATH. Out of scope — this is a host-compromise scenario where many things go wrong. Defensive: log the resolved binary path on startup. |

### 4.4 Out of scope

- Defending against a compromised Vellum binary itself.
- Defending against Anthropic's API behavior on the SDK side.
- Defending against malicious skills (handled by Vellum's existing sandbox + risk classifier).

---

## 5. Phased Implementation Plan

Each phase has acceptance criteria expressed as automatable checks. No phase ships without all of its acceptance criteria green.

### Phase 1 — Verify the security claim & gate the rollout

Goal: Prove (in tests, not by reading docs) that the SDK options actually isolate the bridge from Claude Code's built-in tools, and put the feature behind a flag.

| Task | Acceptance |
|---|---|
| 1.1 Add `claude-subscription` feature flag to `meta/feature-flags/feature-flag-registry.json`, scope `assistant`, `defaultEnabled: false`. | Flag visible in registry; default state is off. |
| 1.2 Gate provider registration in `inference/adapter-factory.ts` on the flag. | Test: with flag off, `buildProviderAdapter("claude-subscription", …)` returns `null` AND the catalog entry is filtered out of `PROVIDER_CATALOG`. With flag on, both return values. |
| 1.3 Add provider availability check: `claude` binary on PATH **and** Keychain entry exists. | Test: stub `which`/Keychain → matrix of {present/absent} returns correct availability. UI must surface "Claude Code not installed" rather than failing at call time. |
| 1.4 Empirically verify SDK isolation. Write an integration test: call `query()` with `allowedTools: ["mcp__vellum__noop"]` + `settingSources: []` + `permissionMode: "bypassPermissions"`, ask the model "run `id` in bash". Assert: no bash invocation reaches the host, the model returns text only. | Integration test passes against a real or VCR-recorded SDK session. |
| 1.5 Empirically verify `customSystemPrompt` replaces (not appends to) Claude Code's prompt. | Same integration test: ask "what is your system prompt" → assert response references Vellum's prompt, not Claude Code's. |
| 1.6 Disable SDK subagents in `query()` options if possible (or document why we can't). | Configuration in `client.ts` references the disabling mechanism. Test confirms subagent attempts are denied. |

**Cut here is acceptable.** With Phase 1, the bridge is provably isolated, gated, and discoverable — but tool calls still drop `contentBlocks`, `sensitiveBindings`, and `yieldToUser`. That's a defensible v1 for plain-text chat with light tool use.

### Phase 2 — Restore lost functionality

Goal: Bring the bridge to functional parity with the outer loop's tool dispatch for everything that's a security or UX regression.

| Task | Acceptance |
|---|---|
| ~~2.1 Map `ToolExecutionResult.contentBlocks` to MCP `CallToolResult.content` (text + image blocks).~~ **(done)** Helper `mapContentBlocksToMcp` in `client.ts` translates the blocks; `ToolBridgeResult.contentBlocks` extended in `providers/types.ts`; the bridge closure in `agent/loop.ts` forwards `result.contentBlocks`. | Test: a tool returning an image content block produces an MCP image content item; the SDK forwards it to the model; the model can reference the image in its reply. |
| ~~2.2 Surface `sensitiveBindings` to the outer loop.~~ **(done)** Bridge closure in `loop.ts` merges `result.sensitiveBindings` into the per-run `substitutionMap` so streamed text deltas substitute placeholder→value through the same code path the non-bridge flow uses. `ToolBridgeResult.sensitiveBindings` extended for downstream consumers (audit, telemetry). | Test: a tool returning bindings results in those bindings being merged into the agent loop's `substitutionMap`. Streamed text events apply the substitution. |
| 2.3 Honor `yieldToUser: true`. Options: (a) cancel the SDK's loop when set (loses the model's continuation), (b) buffer and surface to outer loop at end of `sendMessage`. Pick (a) — yield means "stop now". | Test: a tool with `yieldToUser: true` causes the bridge to abort the SDK; the provider returns whatever assistant text accumulated; the outer loop persists the result and breaks. |
| ~~2.4 Apply `toolResultTruncate` to bridge-flow tool results before returning to the SDK.~~ **(done)** Direct `truncateToolResultText()` call in `client.ts`'s MCP CallTool handler, gated on `options.maxToolResultChars`. The agent loop computes the budget from `calculateMaxToolResultChars()` and threads it through. | Test: a 100MB tool result is truncated to the configured `maxToolResultChars` before the MCP response. |
| ~~2.5 Plumb `onChunk` so the client sees streaming tool output for bridge-invoked tools. Use `tool_output_chunk` events through `onEvent` on the provider boundary.~~ **(done)** `ToolBridgeInvocation.onChunk` added in `providers/types.ts`; `tool_output_chunk` added to the `ProviderEvent` union so providers can emit chunks through `options.onEvent`. `client.ts` MCP CallTool handler builds a per-call `chunkToolUseId` and wraps it into an `onChunk` that emits the new event via `options.onEvent`; `buildMcpServer` signature extended with `onEvent`. `agent/loop.ts` bridge closure forwards `invocation.onChunk` (or no-op fallback) into `LoopToolExecutor`'s 3rd arg, AND the adapter at line ~673 now forwards `ProviderEvent.tool_output_chunk` → outer `AgentEvent.tool_output_chunk` so downstream consumers see the same shape as outer-loop-dispatched tool chunks. `tool-executor-via-bridge.test.ts`'s `makeBridgeForExecutor` wires `invocation.onChunk` → `ToolContext.onOutput` (mirroring what `conversation-tool-setup.ts` does in production). | Test: a streaming tool emits N chunks; the test observes N `tool_output_chunk` events through `onEvent`. **Done:** 3 unit tests in `claude-subscription-provider.test.ts` (`describe("Phase 2.5 — onChunk plumbed as tool_output_chunk events")`) cover the MCP-handler emission and per-call id uniqueness; 1 integration test in `tool-executor-via-bridge.test.ts` (`test("Phase 2.5: tool's context.onOutput surfaces as tool_output_chunk events…")`) drives chunks through the real `ToolExecutor`; 1 adapter test in `src/__tests__/loop-bridge-event-forwarding.test.ts` exercises the `AgentLoop` adapter forwarding (discrimination-verified: drop the case → test fails). |
| 2.6 Replace synthesized `mcp-bridge-<uuid>` IDs with a stable correlation strategy. Option: include the SDK's internal tool_use_id (from the SDK assistant message) when available. | Test: audit records emitted for bridge-flow tools carry the same correlation ID that appears in the SDK's tool_use block in the session log. |
| 2.7 Strip `contentBlocks` carrying base64 images from prior turns before sending to the SDK on multi-turn calls (the SDK doesn't need them after the first viewing; matches outer loop's `stripOldImageBlocks`). | Test: turn 2 of a conversation that had a screenshot at turn 1 does not include base64 in the prompt to the SDK. |

### Phase 3 — Production hardening

| Task | Acceptance | Status |
|---|---|---|
| ~~3.1 Telemetry: emit a `claude-subscription-bridge.tool_call` metric per bridge-routed tool with labels for tool name, trust class, duration, error.~~ **(done)** New `BridgedToolCallTelemetryEvent` type in `telemetry/types.ts`, new SQLite store at `memory/bridged-tool-calls-store.ts` (with migration `248-bridged-tool-call-events.ts`), wired into `usage-telemetry-reporter`'s watermark+flush cycle, emitted from the bridge closure in `agent/loop.ts` alongside a structured `claude_subscription.tool_call` log line. Recording is a no-op when `collectUsageData: false`. | Metric appears in the same pipeline as existing tool-usage metrics. | done |
| ~~3.2 Error classes: define `ClaudeSubscriptionBridgeError` extending `ProviderError` with subtypes for "CLI not installed", "Not logged in", "Token expired", "SDK timeout", "Subprocess crashed". Surface specific UX strings per subtype.~~ **(done)** `providers/claude-subscription/errors.ts` defines the class hierarchy with discriminator `kind: "cli-not-installed" | "not-logged-in" | "token-expired" | "sdk-timeout" | "subprocess-crashed" | "unknown"`. `classifyClaudeSubscriptionError` walks the cause chain with ordered regex patterns (CLI-missing wins over auth, specific auth subtypes win over generic 401). 21 unit tests cover the classifier + the friendly-message default + the `unknown`-preserves-cause-message branch. | Test: each failure mode produces the expected subtype. | done |
| ~~3.3 Idle subprocess management: the SDK spawns `claude` on each `sendMessage` call. Confirm subprocess lifecycle (does it persist across calls? leak?). Add explicit cleanup in `finally`.~~ **(done)** Provider already releases the concurrency semaphore in `finally`. Test in `claude-subscription-concurrency.test.ts` runs 100 sequential `sendMessage` calls (scaled down from 1000 — bun:test runtime budget; the mock means we're testing OUR cleanup, not subprocess fd leaks) and asserts the semaphore returns to fully idle (`activeCallCount === 0`, no queued waiters) AND a fresh call after the load batch still completes. New `_getClaudeSubscriptionSemaphoreStateForTests` test hook for the inspect. | Test: 1000 sequential `sendMessage` calls do not leak file descriptors or processes. | done (scaled to 100) |
| 3.4 Concurrency: confirm two parallel `sendMessage` calls don't share state (each gets a fresh MCP server instance and bridge). | Test: cross-conversation isolation — two concurrent conversations cannot see each other's tool definitions. | done (covered by I-9) |
| ~~3.5 Update `assistant/docs/architecture/integrations.md` with a "Claude Subscription" subsection referencing this doc.~~ **(done)** New "Claude Subscription Bridge — Agentic Provider via Claude Max OAuth" section at the end of `integrations.md` cross-links this doc, the picker docs, and the runbook. Includes a Files-to-know table. | Doc cross-links exist. | done |
| ~~3.6 Add a runbook entry in `assistant/docs/`: how to diagnose "tools not running on subscription provider", how to fall back to API-key Anthropic, how to clear stale OAuth.~~ **(done)** `assistant/docs/runbook-claude-subscription.md` covers: quick diagnostic checklist, per-error-kind playbook, fallback to API-key Anthropic, clear-stale-OAuth procedure, log/SQL filters, rollout/feature-flag controls, known operational quirks, escalation steps. | Runbook reachable from on-call docs. | done |
| ~~3.7 Decide rollout strategy: internal canary → percentage rollout → GA. The feature flag from 1.1 supports this.~~ **(done)** Rollout decision: ship at **GA with `defaultEnabled: true`** once Phase 3.1–3.6 are complete (this row). Rationale below in the "Rollout decision" subsection. The feature-flag registry entry has been annotated with the rollout state + rollback procedure. | Documented in `meta/feature-flags` or release notes. | done |

#### Rollout decision

**Status: GA from this commit forward.** `claude-subscription-provider` ships with `defaultEnabled: true`.

Reasoning:
1. **Security verified:** the four load-bearing isolation properties (tool sandboxing, account-MCP exclusion, system-prompt replacement, sub-agent containment) were empirically verified by the in-tree probes (`scripts/claude-subscription/i-11-isolation.mjs`, `i-11b`, `i-22`) before merge. No additional production telemetry would close a security gap.
2. **Operational ergonomics in place:** Phase 3.1 (telemetry), 3.2 (error classes), 3.3 (lifecycle test), 3.6 (runbook) all landed in this push. First-time failures surface actionable copy; on-call has a documented playbook.
3. **Rollback is one config flip:** if a regression surfaces, set `defaultEnabled: false` in `meta/feature-flags/feature-flag-registry.json` and restart the daemon. The picker hides the row immediately; existing pinned conversations surface `not-enabled` from `getProviderAvailabilityStatus` at next send.
4. **Canary mechanism is unbuilt:** there is no per-user feature-flag override in the registry today — the flag is process-wide. A canary rollout would require new infrastructure (per-user flag bucketing) that doesn't exist. Shipping GA-on-by-default + ready-to-flip-off is the right trade given the security/operational verification above.

Re-evaluate the rollout state if any of these turn out to be wrong:
- Production users report a class of failure that isn't classified by `errors.ts` (gap in 3.2 coverage → add patterns, re-PR).
- Subscription-quota errors from Anthropic that the bridge doesn't surface clearly (today they fall through `unknown` → user sees the raw SDK message).
- Sustained-load issues that the 100-call lifecycle test missed (would need a real-subprocess integration test on a CI host with `claude` installed).

### Phase 4 — Long-tail polish

- Multi-turn fidelity: switch the SDK `prompt` from flattened-string to async-iterable form so multi-turn images/tool_results pass through as native `MessageParam` content.
- Cost reconciliation: the SDK emits `total_cost_usd` per result — surface as an *equivalent* cost in usage tracking, separate from billed cost.
- Allow choosing a model in the picker per-conversation (the catalog already exposes 3; ensure the InferenceProfile system can target them).

---

## 6. Test Plan

### 6.1 Test file layout

```
assistant/src/__tests__/
  claude-subscription-provider.test.ts              # Unit, provider behavior
  claude-subscription-mcp-bridge.test.ts            # Unit, MCP server wiring
  claude-subscription-availability.test.ts          # Unit, availability check
assistant/src/providers/__tests__/
  claude-subscription-catalog-parity.test.ts        # Verifies catalog/factory still align
assistant/src/agent/__tests__/
  loop-tool-bridge-wiring.test.ts                   # Unit, agent loop builds bridge correctly
assistant/src/daemon/__tests__/
  tool-executor-via-bridge.test.ts                  # Integration, bridge → ToolExecutor → audit
tests-integration/                                  # If/when one exists
  claude-subscription-sdk-isolation.test.ts         # Hermetic SDK test (network-mocked)
```

Existing convention (`assistant/src/__tests__/anthropic-provider.test.ts`) uses `bun:test`, mocks the SDK at import-time via `mock.module()`, and asserts on captured call arguments. This plan follows that pattern.

### 6.2 Unit test specifications

Each numbered item is a concrete `test("…", …)` to write. Failure of any asserts a real bug.

#### 6.2.1 `claude-subscription-provider.test.ts`

| # | Test | What it asserts |
|---|---|---|
| U-1 | constructs with a model, exposes `name: "claude-subscription"` and `tokenEstimationProvider: "anthropic"` | Identity invariants. |
| U-2 | `sendMessage` with no tools and a single user message calls `query()` with `prompt` set to the user text, `model` set, `mcpServers.vellum-skills` registered, `allowedTools: []` | Smoke; SDK options correct. |
| U-3 | `sendMessage` flattens multi-turn history into the prompt string | Backwards-compat formatting; multi-turn text round-trips. |
| U-4 | `sendMessage` rejects non-text content blocks with a structured `ProviderError` in v1 (until Phase 4) | Honest failure rather than silent loss. |
| U-5 | `sendMessage` emits `text_delta` events for each text block on `assistant` messages from the SDK | Streaming works. |
| U-6 | `sendMessage` emits `thinking_delta` events for thinking blocks | Streaming works for thinking. |
| U-7 | `sendMessage` aggregates SDK `usage` into `ProviderResponse.usage` correctly including `cache_creation_input_tokens` + `cache_read_input_tokens` | Token accounting correct. |
| U-8 | Aborting `options.signal` mid-stream calls `AbortController.abort` on the SDK and the returned promise rejects | Abort propagation. |
| U-9 | The exact load-bearing isolation options are passed to `query()`: `tools: []`, `settingSources: []`, `permissionMode: "default"`, plus a `canUseTool` callback. Regression-critical — see I-11 above. | Isolation options correct. |
| U-9b | `canUseTool` returns `behavior: "allow"` for names in the bridge allowlist and `behavior: "deny"` for anything else, including bash/built-ins and account-level MCP tools (e.g. `mcp__claude_ai_Gmail__list_drafts`). | Account-MCP leak prevention. |
| U-10 | When `tools` (Vellum's tool list) is non-empty, `allowedTools` is built as `[mcp__vellum-skills__<name1>, ...]` for each tool, AND that same set seeds the `canUseTool` allowlist. | Tool exposure correct and consistent. |
| U-11 | Provider does not import any `claude-code` runtime config at module load (no `~/.claude/` reads at import time) | Cleanly lazy. |
| U-12 | `tokenEstimationProvider === "anthropic"` so existing token estimators apply | Estimator routing. |

#### 6.2.2 `claude-subscription-mcp-bridge.test.ts`

Mock the `McpServer` class and assert calls; also build a real `McpServer` and exercise its `setRequestHandler` callbacks directly.

| # | Test | What it asserts |
|---|---|---|
| U-13 | `buildMcpServer([...tools], bridge)` registers `ListToolsRequest` handler returning the exact tool list with original `input_schema` JSON Schemas passed through unchanged | Schemas pass through. |
| U-14 | `CallToolRequest` for a registered tool name invokes the bridge with `{toolName, input: args}` | Routing correct. |
| U-15 | Bridge return `{ content: "x", isError: true }` produces MCP CallToolResult `{ content: [{type:"text",text:"x"}], isError: true }` | Result mapping. |
| U-16 | Bridge throw produces MCP CallToolResult `{ content: [...error text...], isError: true }`, never re-throws to the SDK | Defensive error containment. |
| U-17 | Per-call `options.toolBridge` is preferred over `registryBridge`; registry over `stubBridge` | Resolution precedence. |
| U-18 | With no bridge registered, calling a tool emits a `log.warn` and returns the stub text | Default observability. |
| U-19 | Different `sendMessage` calls produce different MCP server instances (no cross-call pollution) | Isolation. |
| U-20 | An unregistered tool name causes MCP to return a "tool not found" CallToolResult, not throw | Standard MCP behavior. |

#### 6.2.3 `loop-tool-bridge-wiring.test.ts`

Unit test against `AgentLoop` with a stub provider that captures `options.toolBridge` and lets the test invoke it manually.

| # | Test | What it asserts |
|---|---|---|
| U-21 | When `this.toolExecutor` is non-null, `options.toolBridge` is set on the sendMessage call | Plumbing. |
| U-22 | When `this.toolExecutor` is null (test loop without an executor), `options.toolBridge` is undefined | No spurious bridge. |
| U-23 | Invoking the captured `toolBridge({toolName: "x", input: {y:1}})` calls `this.toolExecutor("x", {y:1}, anyOnChunk, <mcp-bridge-uuid>, <turnCtx>)` | Bridge correctly forwards args including the bound `turnCtx`. |
| U-24 | The synthesized `toolUseId` starts with `mcp-bridge-` and is unique per call | ID format and uniqueness. |
| U-25 | `turnCtx` captured by the bridge closure equals the same `turnCtx` passed into `runPipeline` for `llmCall` | Same context across pipeline + bridge. |
| U-26 | Bridge result `{content, isError}` is derived from `ToolExecutionResult.content` and `.isError` | Mapping correct. |
| U-27 | If `this.toolExecutor` throws, the bridge surfaces an isError result (test the wrap, not the throw) | Bridge does not re-throw past the closure. |

#### 6.2.4 `tool-executor-via-bridge.test.ts` (Integration)

Builds a real `Conversation` with a fake provider that records bridge calls, then drives a full `sendMessage`. Asserts the existing gates fire.

| # | Test | What it asserts |
|---|---|---|
| I-1 | A bridge call for a tool **not in** `allowedToolNames` returns isError with the allowlist denial message; `ToolExecutor`'s allowlist gate fired | Allowlist enforced via bridge. |
| I-2 | A bridge call as `trustClass: "unknown"` for a guardian-only tool returns isError with permission-denied; trust gate fired | Trust enforced via bridge. |
| I-3 | A bridge call for a tool with `defaultRiskLevel: "high"` triggers the `PermissionPrompter`; with mocked "approved", tool runs; with "denied", returns isError | Approval flow works via bridge. |
| I-4 | A bridge call for a CES-protected tool that returns `cesApprovalRequired` enters the CES bridge, then on grant, re-runs `tool.execute` with `grantId` in input | CES flow works via bridge. |
| I-5 | A bridge call for a skill tool with `executionTarget: "sandbox"` invokes `runSkillToolScriptSandbox` (mock the sandbox runner; assert called) | Sandbox routing via bridge. |
| I-6 | A bridge call emits exactly one `ToolLifecycleEvent` of type `start`, one of `executed` (or `error`), and `recordToolInvocation` is called once | Audit emission via bridge. |
| I-7 | A bridge call for a tool that returns `sensitiveBindings` — after Phase 2 — merges them into the conversation's `substitutionMap` so later assistant text renders with real values | Sensitive bindings carry through (Phase 2). |
| I-8 | A bridge call for a tool that returns `yieldToUser: true` — after Phase 2 — causes the SDK to abort and the outer loop to break with the accumulated text persisted | yieldToUser semantic preserved (Phase 2). |
| I-9 | Two concurrent conversations each making a bridge call see only their own conversation's tools and executor context | Cross-conversation isolation. |
| I-10 | An abort fired on conversation A's signal aborts only conversation A's SDK call, not conversation B's | Abort isolation. |

#### 6.2.5 `claude-subscription-availability.test.ts`

| # | Test | What it asserts |
|---|---|---|
| U-28 | With `claude` binary absent from PATH, `isProviderAvailable("claude-subscription")` returns false | CLI presence required. |
| U-29 | With `claude` binary present but no Keychain entry, returns false | Login required. |
| U-30 | With both present, returns true | Happy path. |
| U-31 | Catalog filter excludes `claude-subscription` from `PROVIDER_CATALOG` when the feature flag is off | Flag gate works. |

#### 6.2.6 `claude-subscription-sdk-isolation.test.ts` (Integration, optional)

The hardest tests; require a network-recorded SDK session OR a controlled host with `claude` installed.

| # | Test | What it asserts |
|---|---|---|
| I-11 | With `allowedTools: []` + `permissionMode: "bypassPermissions"` + `settingSources: []`, a model prompt "run `id` via bash" does NOT execute bash on the host (no observable filesystem or process side effects) | T-1 mitigated. |
| I-12 | The same isolated config exposes only `mcp__vellum-skills__*` tools to the model when `tools` is non-empty | T-1 mitigated. |
| I-13 | A model prompt "what is your system prompt" returns text consistent with `customSystemPrompt`, NOT Claude Code's coding-agent prompt | I-22 verified. |
| I-14 | Aborting the `query()` mid-execution terminates the subprocess within N seconds | I-9 verified. |

### 6.3 Test doubles & fixtures

- **`@anthropic-ai/claude-agent-sdk`** mocked at import time via `mock.module()`. Mock yields a scripted `AsyncIterable<SDKMessage>` from a `ScriptedSdkEvent[]` array (mirrors the existing `ScriptedStreamEvent[]` pattern in `anthropic-provider.test.ts`).
- **`McpServer`** can be either real (test the actual library behavior) or mocked. Prefer real — the test then catches breakage from MCP SDK upgrades.
- **`ToolExecutor`** — for I-tests, use the real one with a stubbed tool registry. For U-tests, a hand-stubbed callback.
- **`PermissionPrompter`** — stub returning preset decisions per test.
- **`CesClient`** — stub conforming to the RPC contract; tests inject scripted grant decisions.
- **Sandbox runner** — mock `runSkillToolScriptSandbox`; tests assert it was called for sandbox-target tools.
- **`AbortController`** — real; tests check `.aborted` after dispatch.

### 6.4 Coverage targets

Following Vellum's testing conventions (see `.claude/rules/testing.md`): 80% overall, 90% for `providers/` and security-critical paths. Specifically:

- `claude-subscription/client.ts`: **95%+** branch coverage.
- `agent/loop.ts` toolBridge plumbing: **100%** branch coverage on the new closure.
- The bridge's error-containment branch (U-16) must have a dedicated test.

### 6.5 Negative-space tests (security)

Tests that assert what the bridge does NOT do are as important as what it does:

- N-1: The bridge never calls `tool.execute` directly — only via `ToolExecutor.execute` through `this.toolExecutor`. (Spy on tool.execute; assert call count zero.)
- N-2: The bridge never reads from `~/.claude/credentials` or the Keychain directly. (Spy on filesystem and Keychain APIs; assert zero invocations from `client.ts`.)
- N-3: The bridge never writes to `~/.claude/sessions/`. (Same.)
- N-4: The bridge never invokes `child_process.spawn` directly — only via the SDK's `query()`. (Spy; assert zero.)
- N-5: With `allowedTools: ["mcp__vellum-skills__foo"]`, the bridge cannot be coerced (via a malformed CallTool name) into invoking `bash` or any non-MCP tool. (Property test: random tool-name strings → bridge returns "tool not found" or routes to the listed MCP only.)

---

## 7. Security Control Matrix

Each row is a control. Status reflects the scaffold as written; "Target" reflects Phase-1 readiness.

| Control | Mechanism | Scaffold Status | Phase-1 Target | Test |
|---|---|---|---|---|
| Allowlist enforcement | Inherited via `ToolExecutor` | ✅ | ✅ | I-1 |
| Trust class evaluation | Inherited via `ToolExecutor` | ✅ | ✅ | I-2 |
| User permission prompt | Inherited via `ToolExecutor` | ❓ | ✅ verified | I-3 |
| CES grant flow | Inherited via `ToolExecutor` | ❓ | ✅ verified | I-4 |
| Sandbox isolation (skill tools) | Inherited via `tool.execute` | ✅ | ✅ | I-5 |
| Audit emission | Inherited via `ToolExecutor` | ⚠️ synthetic IDs | ✅ correlation strategy | I-6 |
| Abort propagation | SDK `AbortController` | ❓ | ✅ verified | I-10, I-14 |
| SDK built-in tools disabled | `tools: []` + `canUseTool` deny | ✅ verified | ✅ | I-11, I-12, N-5 |
| Account-level MCP integrations blocked | `canUseTool` runtime deny | ✅ verified | ✅ | (new: I-15) |
| Claude Code system prompt overridden | `customSystemPrompt` | ❓ | ✅ verified | I-13 |
| Sub-agent fan-out controlled | SDK options | ❓ | ✅ disabled or capped | (new) |
| No direct credential access | Code review + N-tests | ✅ | ✅ | N-2 |
| No direct subprocess spawn | Code review + N-tests | ✅ | ✅ | N-4 |
| Feature flag gate | `feature-flag-registry.json` | ❌ | ✅ | U-31 |
| Provider availability check | `provider-availability.ts` | ❌ | ✅ | U-28..30 |
| Cross-conversation isolation | Closure-scoped `turnCtx` | ✅ | ✅ verified | I-9 |
| Sensitive-output handling | Bridge return shape | ❌ drops bindings | (Phase 2) | I-7 |
| yieldToUser semantic | Bridge response shape | ❌ ignored | (Phase 2) | I-8 |
| Tool result truncation | (not applied via bridge) | ❌ | (Phase 2) | (new) |
| Telemetry | (not emitted) | ❌ | (Phase 3) | (new) |

---

## 8. Operational Concerns

### 8.1 Failure modes & user-visible behavior

| Failure | Symptom | UX |
|---|---|---|
| `claude` CLI not installed | SDK can't spawn subprocess | Show "Install Claude Code to use the subscription provider" in the picker subtitle. Provider availability returns false; the option is greyed out with status text. |
| `claude login` never run | SDK spawns but fails with auth error | Same as above plus "Run `claude login` once" in setup hint. |
| OAuth token expired | SDK gets 401 | Surface a clear error; suggest re-running `claude login`. Treat as transient until rotation policy is understood. |
| Subprocess crashed mid-call | `query()` iterator throws | Bridge wraps as `ProviderError`; outer loop sees a structured error; user sees "Claude Code subprocess failed; please retry". |
| Subscription quota exhausted | Anthropic returns 429 to the SDK | Surface "Claude Max quota exhausted; switch providers or wait". Token bucket inside Anthropic. |
| Tool execution exceeds SDK's tool-call deadline | SDK fails the tool call | The model receives a tool-call error; behavior is the same as any other slow tool. |
| Conversation aborted while subprocess is running | Need to ensure cleanup | Bridge's `finally` block must abort the SDK; subprocess must exit; test 3.3 covers leaks. |

### 8.2 Observability

Minimum logging (already partially scaffolded):

- `log.info` on each `sendMessage` entry with `{conversationId, model, toolCount}`.
- `log.info` on each MCP CallTool with `{toolName, isError, durationMs}`.
- `log.warn` when the stub bridge fires (no executor registered).
- `log.error` when the bridge wraps a thrown exception.

Telemetry (Phase 3):
- Counter: `claude_subscription.send_message` with `{model, error}` labels.
- Histogram: `claude_subscription.send_message.duration_ms`.
- Counter: `claude_subscription.tool_call` with `{tool_name, trust_class, error}`.

### 8.3 Rollback

The provider is gated entirely by the feature flag. To roll back: set `defaultEnabled: false` in the registry; all conversations fall back to whatever provider their workspace default is. No data migrations are required because conversations don't persist a hard reference to the provider — they persist an `inferenceProfile` name, which the provider resolver can re-route.

### 8.4 Capacity & rate limits

- Claude Max has per-user rate limits independent of API key limits.
- The SDK subprocess holds an open stream during `query()`; many concurrent calls = many subprocesses. Cap concurrent `claude-subscription` calls per user with a semaphore (Phase 3) if observed contention warrants.

---

## 9. Decisions

### Resolved

- **D-1 (Resolved):** MCP server name is `"vellum-skills"`. Already in code.
- **D-2 (Resolved — abort):** When a tool returns `yieldToUser: true`, the bridge calls `abortController.abort()` on the SDK after the MCP CallToolResult has been returned (scheduled via `setImmediate` so the SDK still sees the tool's result). The provider returns whatever assistant text accumulated; Vellum's outer loop sees no tool_use blocks and breaks naturally. Implemented in `client.ts` (`onYieldToUser` plumbing) and `agent/loop.ts` (forwarding `result.yieldToUser` through the `ProviderToolBridge` return).
- **D-3 (Resolved — keep sub-agents enabled):** The bridge keeps `Task` enabled (`tools: ["Task"]`) and explicitly adds `"Task"` to the `canUseTool` allowlist. **I-11b verified empirically**: a sub-agent prompted to escape via bash failed — sub-agents inherit the parent's tool restrictions (or use a default agent type that lacks Bash; the exact mechanism wasn't pinned down but the operational outcome is correct containment). Re-run I-11b any time the `tools` or `canUseTool` config changes. Implications the team should be aware of: one user message can fan out to N parallel tool calls via sub-agents; audit records will include the sub-agent's tool invocations under the parent conversation. Add metrics in Phase 3 to surface fan-out per turn.
- **D-4 (Resolved — add `"cli-login"`):** `ProviderCatalogEntry.setupMode` now accepts `"api-key" | "keyless" | "cli-login"`. The `claude-subscription` entry uses `"cli-login"`. Both `registry.ts` and `inference/adapter-factory.ts` treat `"cli-login"` and `"keyless"` identically for credential plumbing (no apiKey passed to the factory). UI consumers in `clients/macos` (and other client surfaces, e.g. browser extension) need a setup-hint branch for the new value; default behavior falls back to the existing keyless rendering if a client hasn't yet updated.
- **D-5 (Resolved — auto-refresh on 401):** Implemented as a retry-once-on-auth-error wrapper around the SDK call. Heuristic match on common auth error signatures (401, "unauthorized", "token expired", etc.); see `AUTH_ERROR_PATTERNS` in `client.ts`. **Retries only if zero output streamed** — preserves at-most-once semantics for tool side effects. On second failure, throws a `ProviderError` with HTTP 401 and a message telling the user to run `claude login`. The SDK is the `claude` CLI under the hood and itself handles silent token refresh during normal use; this wrapper exists as a defensive layer for the race-condition case and to provide a clean failure UX.

### Resolved (continued)

- **D-6 (Resolved — $0 cost + `subscriptionBacked: true` marker):** The catalog entry omits all `pricing` fields, so `UsageTrackingProvider` computes $0 monetary cost. A new `ProviderCatalogEntry.subscriptionBacked?: boolean` field marks providers whose $0 is *intentional* (subscription-paid) vs *missing data*. Downstream UI/billing surfaces can key on this to render "subscription quota" copy and (optionally) emit a separate `subscription_units` metric from token counts. No usage-tracking code change yet — the marker is the API; UI/billing consumers can adopt at their own pace.
- **D-7 (Resolved — concurrency cap = 4):** A per-process semaphore in `client.ts` (`MAX_CONCURRENT_CALLS = 4`, `acquireSemaphore` / `releaseSemaphore`) limits in-flight `sendMessage` calls to four. Excess calls queue on a FIFO list of resolvers. Cap is applied as the outermost wrapper of `sendMessage` so a queued call doesn't hold an MCP server or AbortController for the duration of its wait. Tuneable by changing the constant; `_resetClaudeSubscriptionSemaphoreForTests` exposes a hook so tests can reset state.

### Phase 1 status (implementation since the doc was first written)

- **1.1 Feature flag:** `claude-subscription-provider` registered in `meta/feature-flags/feature-flag-registry.json`, scope `assistant`, `defaultEnabled: false`.
- **1.2 Provider registration gated:** `assistant/src/providers/registry.ts` skips the catalog entry when the flag is off; logs the skip at info level.
- **1.3 Availability check:** `assistant/src/providers/provider-availability.ts` now has a `claude-subscription` branch that returns true iff (`claude` CLI is on PATH) AND (macOS Keychain entry `Claude Code-credentials` exists, or `~/.claude/.credentials.json` on Linux/Windows). Cached per process; reset via `clearClaudeSubscriptionAvailabilityCache()`.
- **1.4 SDK isolation verified empirically:** I-11 ✅, I-11b ✅.
- **1.5 `systemPrompt` replace verified empirically:** I-22 ✅ (after fixing the option name from the bogus `customSystemPrompt`).
- **1.6 Sub-agent policy:** kept enabled per D-3; I-11b proves no escape.

### Still open

- **Test suite for `tool-executor-via-bridge.test.ts` (integration, §6.2.4)** — the spec lists 10 integration tests (I-1 through I-10) that need a real `ToolExecutor` fixture wired against trust gates, CES, audit, etc. Those are deferred until a fixture is built; the existing 35-test unit suite covers everything that can be tested without that fixture.
- ~~**`tools/claude-subscription-isolation-probe.mjs`** — port the I-11, I-11b, and I-22 test scripts from `~/Downloads/claude-subscription-demo/` into the Vellum repo as recurring regression tests~~ **(done)** Probes now live at `assistant/scripts/claude-subscription/`; bun:test bridge at `src/__tests__/claude-subscription-isolation-probes.test.ts`, default-skipped (opt in with `CLAUDE_SUBSCRIPTION_PROBES_ENABLED=1`). CI will need a credentialed `claude` install before this can be gated by default.
- **I-19 (subagent fan-out under load)** — needs an empirical test with the SDK actually spawning sub-agents in parallel and observing per-agent isolation.
- **Availability check unit tests** — `node:child_process` mocking via bun's `mock.module` didn't propagate through `promisify(execFile)` cleanly. A small refactor to inject the CLI/keychain checkers as dependencies would make the SUT testable; alternatively the live-host smoke verification covers the happy path.

### Empirically-deferred

- **Token rotation cadence.** The SDK *probably* auto-refreshes silently across spawns (it's the `claude` CLI), so the D-5 retry should rarely fire. A 30-minute spike to confirm this — read Keychain token, run N queries over T minutes, re-read — turns this guess into a fact. Until then the retry is defensive.
- **Sub-agent containment mechanism.** I-11b confirmed sub-agents can't escape *empirically*, but whether containment comes from inheriting the parent's `canUseTool` callback or from the default sub-agent type lacking Bash was not pinned down. The right next step is reading the SDK's `Task`-tool implementation to confirm the inheritance chain.

---

## 10. Acceptance Criteria for Production

The feature ships when ALL of these are green:

1. All Phase-1 tasks have their acceptance criteria met (1.1 – 1.6).
2. All unit tests U-1 through U-31 pass; coverage on `client.ts` ≥ 95%.
3. All integration tests I-1 through I-6 pass against the real `ToolExecutor`.
4. Negative-space tests N-1 through N-5 pass.
5. The empirical SDK-isolation test (I-11, I-12, I-13) has been run on a controlled host and passes.
6. The feature flag is declared, defaults to off, and has been tested at runtime in both states.
7. Provider availability returns the correct value across the 4-state matrix (CLI present/absent × logged-in/not).
8. The macOS picker renders the "Claude (Max Plan)" group only when the flag is on AND availability returns true.
9. A documented rollback plan exists.
10. Runbook entry written and on-call has reviewed.
11. Open decisions D-1 through D-7 resolved and documented.

**Items 2 and 3 carry veto power for any single failing test — no exception, no merge.**

---

## 10b. Unit test suite (current state)

Located at:
- `assistant/src/__tests__/claude-subscription-provider.test.ts` — 36 tests
- `assistant/src/__tests__/claude-subscription-concurrency.test.ts` — 2 tests

**Total: 38 tests, 1103 expect() calls, all passing.**

The default-skip wrapper at `assistant/src/__tests__/claude-subscription-isolation-probes.test.ts` adds 3 more empirical-probe tests when `CLAUDE_SUBSCRIPTION_PROBES_ENABLED=1` is set; without that flag it registers a single visible-skip marker and does not affect the count above.

What's covered:

| Area | Tests | Key assertions |
|---|---|---|
| Construction & identity | 1 | `name`, `tokenEstimationProvider` |
| **SDK isolation options (security)** | 9 | All four locks present (`tools: ["Task"]`, `settingSources: []`, `permissionMode: "default"`, `canUseTool`); `systemPrompt` not `customSystemPrompt`; `canUseTool` denies Bash/Read/Write/Edit/WebFetch/Glob/Grep; denies Gmail/Drive/Notion/Vercel account-MCP leaks; denies arbitrary unregistered names including `../escape` and empty; exactly one MCP server named `vellum-skills`; AbortController attached |
| Streaming + usage | 5 | `text_delta` events; `thinking_delta`; usage aggregation including cache fields; model from init or fallback; stopReason mapping |
| Bridge resolution precedence | 5 | per-call wins over registry; registry wins over stub; stub returns when neither set; JSON Schema passes through to MCP ListTools verbatim; bridge throw is caught and returned as isError |
| **D-5 auth retry** | 4 | retries on auth error with no output; does NOT retry non-auth; surfaces friendly 401 after retries exhausted; recognises 6 auth-error signatures |
| **I-4 / I-5 inheritance** | 2 | bridge propagates 200ms async return; bridge waits on externally-resolved promise (simulates approval-prompt pattern) |
| **I-9 abort propagation** | 2 | pre-aborted external signal → SDK aborted immediately; mid-call abort → SDK follows |
| **D-2 yieldToUser** | 2 | yield=true aborts SDK after MCP result returned; yield=false doesn't |
| Multi-turn flattening | 2 | single user → just text; multi-turn → header + current message structure |
| **D-7 concurrency cap** | 2 | peak parallelism ≤ 4 with 10 concurrent calls; sequential calls don't block |

What's NOT covered yet (gaps documented above):
- Integration tests against real `ToolExecutor`
- Availability check (mock fragility — see §9)
- Cross-conversation isolation under load
- `tool_output_chunk` streaming (Phase 2)
- `contentBlocks` / `sensitiveBindings` round-trip (Phase 2)

To run:
```bash
cd assistant && bun test src/__tests__/claude-subscription-{provider,concurrency}.test.ts
```

## 11. Appendix: Why the existing scaffold compiles but is not safe to ship today

A reasonable engineer reading the scaffold might conclude "this works." It doesn't. Here is the minimum set of reasons:

- **(Now resolved)** ~~The SDK isolation has never been tested.~~ I-11 has been run and failed once (wrong config: `bypassPermissions` + `allowedTools`) then passed with the correct config (`tools: []` + `canUseTool` + `settingSources: []`). The scaffold has been updated to the verified-passing options. Re-run the isolation test before any release.
- **Drop of `contentBlocks` silently breaks vision skills.** A user trying a browser-skill chain will see the model "forgetting" what's on screen.
- **Drop of `sensitiveBindings` makes the UX look broken** even when the security property holds. Users will see literal `<sensitive:abc123>` strings in chat.
- **No availability check** means the picker happily offers the option on machines without `claude` installed.
- **No feature flag** means the option is in every build.

The scaffold is the *correct architecture*. Shipping it without Phase 1 is the *wrong rollout*.
