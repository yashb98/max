# Kimi Agent SDK vs Claude Agent SDK — Full Cause Inventory & Root Cause

**Date:** 2026-06-05 · **Method:** 126-agent dynamic workflow (8 primary investigators → per-finding adversarial verification with 1–2 independent lenses → completeness critic → second-round finders), 2,133 tool uses over primary sources (working-tree code, `@moonshot-ai/kimi-agent-sdk` dist, installed kimi-cli 1.12.0 Python source, live daemon logs).
**Verdicts:** 53 confirmed · 8 split/uncertain · 23 refuted.
**Question:** Why does the `kimi-agent` provider misbehave in live use while `claude-subscription` (Claude Agent SDK) "runs pretty well — for hours"?

> ⚠️ **Code moved during the investigation.** A concurrent session shipped partial fixes at ~22:23 (see §7), so line numbers below are cited per the state each agent verified. Key symbols: `MAX_TURNS`, `KIMI_MODE_CONFIG`, the `StepBegin` guard, `combineBridgeOutput` in `assistant/src/providers/kimi-agent/client.ts`.

---

## 1. The actual symptoms (measured, 2026-06-05 log)

| Symptom | Count | Notes |
|---|---|---|
| `kimi-agent exceeded max turns; interrupting turn` | **20** (not 9 — two batches, pids 11745 / 33927 / 67087 / 81225) | every one logs `stepCount: 26 / maxTurns: 25`; turn wall-clock 147–741 s |
| `ApprovalRequest denied for non-allowlisted sender` | **10**, all `browser_navigate` / `browser_tabs` | ambient playwright MCP from `~/.kimi/mcp.json` |
| Silent blank assistant replies | 9 msgs / 3 conversations (prior session's scan, corroborated) | denial → text-less turn → `content: []` persisted |
| `Kimi API error (429) … suspended` | many | **OUT OF SCOPE** — plain `kimi` chat provider on the suspended `ak-…` key (billing), not the SDK provider |
| claude-subscription "session limit" errors | 70 lines | **all** from background features (reply-suggestion chip ×14 stacks, conversation-starters, compaction summary) — **zero** from agentic turns; not comparable to kimi's interrupts |

---

## 2. ROOT CAUSE #1 (primary): the 25-step host cap counts the wrong unit

- kimi-agent enforces the cap **host-side**: it counts every SDK `StepBegin` and force-`interrupt()`s at step 26 (`client.ts` StepBegin guard; `MAX_TURNS = 25` for Instant/Thinking and the default fallback; Agent mode = 50). kimi-cli's **own internal budget is 100 steps/turn** — Vellum cuts at a quarter of that.
- claude-subscription passes `maxTurns: 25` **into the SDK** (`claude-subscription/client.ts:425`), where it bounds agent-loop *recursion* (assistant↔tool round-trips incl. subagents). One claude turn can batch dozens of tool calls and never approach the bound.
- **Quantified, same conversation (`2c689c41`, the JobPulse pipeline):** across the whole day claude cap-trips = **0**, kimi = **20**. kimi drove 264 bridged tool calls there and tripped its cap **7×**; claude later drove 157 bridged calls including a **single 138-tool-call turn (~30 min) that ended cleanly with `end_turn`** — possible under `maxTurns:25` because claude turns batch parallel tool calls and `Task` subagent child-loops don't count against the parent's turn budget (kimi has `subagents: {}`).
- **All 20 kimi interrupts were genuinely long, denial-free, legitimate tasks** (jobpulse pipeline runs, Notion API debugging, bash-heavy ops; conversation-scoped bridged-call counts cluster 24–44, median 25). Adversarial re-keying by requestId proved **zero denials occurred inside any interrupted turn**.
- Aggravator: every interrupted session ran in **Instant/Thinking mode (cap 25)** — Agent mode (cap 50 + autonomy nudge) was never used for exactly the workloads it exists for.

**Fix lever:** raise/replumb the step cap (per-profile knobs = plan Gap E), route heavy work to Agent mode, and/or count meaningful units rather than raw `StepBegin`s. The interrupt should also not pretend the work can resume (see RC#3).

## 3. ROOT CAUSE #2 (independent): visible-but-denied ambient MCP tools

- kimi-cli **unconditionally** loads `~/.kimi/mcp.json` (playwright/github/canva/context7) into every session; the agent-spec `tools:` positive allowlist gates only **native built-ins**, never MCP (`cli/__init__.py:436-439`, `soul/agent.py`).
- The model therefore *sees* `browser_navigate`/`browser_tabs` — a perfect-looking match for the user's browser tasks — chooses them, and gets denied at runtime (`client.ts` ApprovalRequest deny).
- **A denied approval ENDS the kimi turn after one step** — verified in kimi-cli source: rejection → `ToolRejectedError` (`toolset.py:383`) → `StepOutcome(stop_reason="tool_rejected")` (`kimisoul.py:425`) → `TurnOutcome` returned, **no re-inference** (`kimisoul.py:365-375`). Log confirms: every denial → "Agent loop run completed" within ~40 ms.
- Downstream this produced the **silent blank replies**: text-less turn → `content: []` + `stopReason:"end_turn"` → (pre-fix) the outer empty-response guard required `toolUseTurns > 0`, structurally 0 for kimi → blank message persisted.
- **Crucially decoupled from RC#1:** a max-turns turn is by construction denial-free (denial would have ended it). Two distinct defects, two distinct fixes. (The earlier "denials burn steps toward the cap" theory is **refuted**.)
- claude-subscription suppresses config-sourced MCP **pre-advertisement** (`settingSources: []` + `tools:` allowlist + only the in-process bridge MCP server) — unavailable tools are *invisible*, so Claude never wastes a turn or dies on one.
- **Unused fix lever exists in the SDK:** `SessionOptions.shareDir` → `KIMI_SHARE_DIR` env (sdk `index.mjs:1281`; kimi-cli `share.py:9-12`, `cli/mcp.py:12-14`). Pointing `shareDir` at a staged dir with an empty `mcp.json` (+ the OAuth credential carried over) makes ambient MCP invisible — mirroring claude's isolation. Not a zero-side-effect drop-in: managed-plan login state must resolve under the relocated dir; verify before shipping.

## 4. ROOT CAUSE #3 (structural): "continue" cannot actually continue

- On interrupt the client now appends *“Say "continue" and I'll pick up where I left off”* — but the promise is **structurally hollow**:
  - Session resume is dead in production: `sessionId` is only set from `options.conversationKey`, which **nothing in the daemon ever sets** — every Vellum turn is a brand-new kimi session rebuilt from flattened history.
  - The persisted assistant message is **text-only** (no `tool_use` blocks); bridged `tool_result`s are persisted but **orphaned** (no matching `tool_use` anchor), and native read/search results vanish entirely (`ToolResult` events hit the `default: break`).
  - So "continue" forces a blind re-plan with no record of what the model already did — re-execution, not resumption. Claude has the same per-message session freshness but lands complete turns, so it rarely needs to resume mid-task.

## 5. Why Claude "works for hours" — the verified asymmetry table

| Dimension | claude-subscription | kimi-agent |
|---|---|---|
| Cap semantics | `maxTurns:25` **inside** SDK = recursion bound; 138 tool calls in one turn observed; **0 trips/day** | host-side raw `StepBegin` count, hard `interrupt()` at 26; **20 trips/day** |
| Unavailable tools | **invisible** (`tools` allowlist, `settingSources:[]`) | **visible-but-denied** ambient MCP; deny is turn-fatal |
| Deny semantics | `canUseTool` deny = recoverable tool-result, model reroutes in-session | `ToolRejectedError` ends the turn, no re-inference |
| Subagents | `Task` enabled — subagent work multiplies per-turn capacity | `subagents: {}` (deliberate isolation) |
| Cap behavior | SDK-graceful `error_max_turns` result | abortive mid-flight `interrupt()` |
| Tool presentation | in-process MCP server, full JSON-Schema, structured text+image results | `externalTools` string-only returns; media via save-to-disk + file_read hop |
| Recovery layer | empty-response nudge reachable | (pre-fix) structurally unreachable → blank messages |

Note: claude is **not** immune to truncation — it simply never got close (0 `error_max_turns`). And its "session limit" failures that day were background-feature-only.

## 6. Contributing causes & latent bugs (confirmed)

1. **Mode mismatch** — heavy agentic ops ran under Instant/Thinking (25); Agent mode (50) never engaged.
2. **No steering** — generated `system.md` is the Vellum prompt verbatim; never tells K2.6 which native/MCP tools are unavailable or that bridged `bash`/`web_fetch` are the sanctioned path; bridged tool descriptions forwarded verbatim, no browser-automation mention; kimi-webbridge skill never advertised as a callable tool (curl-over-bash convention is opaque).
3. **Token usage undercount** — `StatusUpdate.token_usage` is per-step but treated as cumulative (last-write-wins).
4. **stopReason mapping** — external abort / streamTimeout leave `stopReason:"end_turn"`, indistinguishable from clean completion.
5. **Media-pointer truncation (latent)** — `truncateToolResultText` can cut the "You MUST call ReadMediaFile…" pointer off the end of a bridged result, silently dropping tool media.
6. **Error mapping asymmetry** — SDK errors raised off the async-iterator path (e.g. 402 in a readline callback) can escape the catch boundary.
7. **Per-turn overhead** — fresh SDK session + full-history reserialization every message (Gap D); observed up to ~113 s to first tool call, though mostly model latency (MCP npx spawn cost not proven dominant).
8. **CLI age** — installed 1.12.0 vs latest 1.47.0; PreToolUse hooks landed in 1.28.0 (would enable pre-advertisement gating = Gap B).
9. **Doc drift** — live agent-file posture is **SearchWeb-only native** (everything else, including reads, routes through Vellum) — memory/flag-registry still describe the older HYBRID read/search posture. The 20:17+ window confirms current working-tree code was live for evening failures.
10. *(was-real, fixed 22:23)* StepBegin guard read `mode.maxTurns`, ignoring `maxTurnsOverride` (latent — override was never set by the factory).

**Split/uncertain (verifiers disagreed):** whether the deny message's "rejected by the user" wording materially misleads the model; how much wasted steps from denied/media hops drain the *effective* budget; exact phrasing of the tool-visibility "PRIME" conjunct (the mechanism itself is confirmed via RC#2).

**Refuted (don't re-chase):** denials accumulate toward the cap (impossible — denial ends the turn); claude truncated the same workload via session limits (background features only); 1 bridged bash = 1 step (~1.5 actions/step measured; multiple ToolCalls ride one StepBegin); webbridge lacks batching as a primary driver.

## 7. Fixed in the working tree mid-investigation (concurrent session, ~22:23) — NOT yet deployed

> **The running daemon is still the pre-fix bundle.** These are working-tree edits, unit/integration-tested against a mocked SDK, not exercised live. The app must be rebuilt before any of this changes observed behavior — until then the live app still interrupts and (for the old bundle) still blanks. **And the primary root cause (RC#1, the step cap) is NOT among these fixes** — neither is shareDir MCP suppression. §8 is the real outstanding work.

- `empty-response.ts:80` — guard now `(toolUseTurns > 0 || bridgedToolCalls > 0)` → blank-reply layer 3 closed (gated behind a `supportsEmptyTurnNudge` capability flag no provider declares yet, since a nudge on a non-resuming bridge would re-execute side-effecting tools).
- `client.ts` — denial now synthesizes explanatory text; max-turns interrupt appends the step-limit note and **never returns empty content**; guard honors the local override-aware `maxTurns`.
- Zero-content persistence guard in `handleMessageComplete` + tests (`message-complete-empty-content-guard.test.ts`, `empty-response-pipeline.test.ts`).
- Timeline note: several workflow "refutations" (e.g. "interrupt gives no explanation", "blank turn silently accepted") were **true pre-22:23** and refuted only because verifiers read the post-fix file — they are *fixed*, not *wrong*, and are listed here rather than under "refuted".

## 8. Remaining fixes, ranked by impact — STATUS as of 2026-06-05 ~23:55

1. ✅ **Step cap raised** (RC#1): `MAX_TURNS` 25→**80**, Agent mode 50→**95** — both host-primary *under* kimi-cli's internal 100-step limit so the graceful "[Stopped early…]" note still fires before unobserved CLI-limit behavior. Covers every observed legit task (26–44 steps) with ~2× headroom. Full Gap E (per-profile knobs) still open; `maxTurnsOverride`/`thinkingOverride` are accept-ready on the provider.
2. ✅ **Ambient MCP suppressed via `shareDir` staging** (RC#2): new `share-dir.ts` stages a share dir under the session temp dir — every entry symlinked to the real `~/.kimi` EXCEPT `mcp.json`, written `{"mcpServers":{}}`. **Live probe PASS** (`scripts/kimi-agent/sharedir-probe.mjs`): managed-plan auth works through symlinked `credentials/`, model reports `browser_navigate` as missing (zero ApprovalRequests, no MCP load), bridge dispatches, real `~/.kimi` byte-identical. Approval-deny gate retained as defense-in-depth; staging failure falls back to prior behavior.
3. ✅ **Steering**: `agent-file.ts` now appends a tool-environment block to every system.md — names the disabled built-ins and MCP families (`browser_*` etc.), says a rejected tool may end the turn, and points to the bridged tools. (With #2, MCP tools are also invisible — double cover.)
4. ✅ **Cumulative token accounting**: per-step `StatusUpdate` usage is now summed (kimi emits one per kosong step; claude's SDK pre-aggregates — providers now report equivalent whole-call usage).
5. ✅ **Truncation-safe media pointer**: media `file_read` refs are collected separately and appended AFTER truncation (`assembleHandlerOutput`) — an oversized tool result can no longer eat the pointer.
6. ❌ **Make "continue" truthful** (RC#3 / Gap D): still open — thread `conversationKey` → `sessionId` AND fix `flattenForSdk` double-context before flipping `supportsEmptyTurnNudge`.
7. ❌ **CLI upgrade to ≥1.28** for PreToolUse hooks (Gap B; re-run all three isolation probes after).
8. ❌ Distinct stopReason for abort/timeout (deferred deliberately — needs a sweep of all `stopReason` consumers first); doc/flag drift (SearchWeb-only posture wording in flag registry).

**Verification:** 71/71 provider tests, 7/7 agent-file, 4/4 share-dir, all other kimi files green in isolation; `tsc` clean; live probes `isolation-agentfile.mjs` PASS + `sharedir-probe.mjs` PASS. **The running app is still the pre-fix bundle — a rebuild is required before any of this changes live behavior.**
