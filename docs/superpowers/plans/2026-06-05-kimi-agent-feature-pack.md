# Kimi-Agent Feature Pack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `kimi-agent` provider with real-browser automation in Max, a verified vision-in-the-loop demo, optional session continuity, per-profile effort knobs, and a kimi-CLI upgrade path.

**Architecture:** Five **independent** mini-projects (A–E), each independently shippable and testable. They build on the kimi-agent provider that ships K2.6 in a hybrid-isolated agentic loop (read/search built-ins only; Max tools bridged via `externalTools`; tool images bridged to the model via `ReadMediaFile`). Recommended order: **A → C → D → E → B** (B is higher-risk and goes last).

**Tech Stack:** TypeScript/Bun (assistant), `@moonshot-ai/kimi-agent-sdk`, the kimi Code CLI, kimi-webbridge daemon (HTTP at `127.0.0.1:10086`), Max skills (`skills/<name>/SKILL.md` + `scripts/`), bun:test.

**Pre-flight (run once before any project):**
```bash
cd /Users/yashbishnoi/Downloads/max-assistant-main
git checkout -b kimi-agent-feature-pack            # work off a branch, not master
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts | tail -3   # baseline: should pass
```

> **Context this plan assumes (verified 2026-06-04/05):**
> - Provider entry: `assistant/src/providers/kimi-agent/client.ts`; agent spec: `.../agent-file.ts`; catalog: `assistant/src/providers/model-catalog.ts`; factory: `assistant/src/providers/inference/adapter-factory.ts` (passes only `{apiKey, model, streamTimeoutMs}` to `new KimiAgentProvider(model, {streamTimeoutMs, apiKey})`).
> - `KIMI_MODE_CONFIG` in `client.ts` maps picker ids (`kimi-k2.6-instant/thinking/agent`) → `{realModel, thinking, maxTurns, systemNudge?}`.
> - macOS app must be rebuilt for client-facing changes: `cd clients/macos && ./build.sh` then relaunch via `./build.sh run &` **from a shell with `~/.local/bin` on PATH** (a Finder/`open` launch gets a restricted PATH and breaks `which kimi`). Stop the running app first with `pkill -f "max\.app/Contents/MacOS/"` (NOT the `Max.*` pattern) to avoid a code-signing SIGKILL of the live instance.
> - Client catalog JSON is generated: `cd assistant && bun scripts/sync-llm-catalog.ts` → `clients/shared/Resources/llm-provider-catalog.json` (then rebuild bundles it).

---

## Project A — kimi-webbridge as a Max tool (real-browser automation in Max)

**Goal:** Let any Max model (incl. kimi-agent) drive the user's real browser (their logged-in sessions) from chat, by exposing the running kimi-webbridge daemon as a Max skill.

**Why:** The webbridge daemon (real browser, port 10086) is live but only reachable from the kimi CLI / Claude Code, not Max. A Max skill bridges it in, gated by Max's permission layer. Pairs with the tool-image media bridge (screenshots become viewable by kimi-agent).

**Files:**
- Create: `skills/kimi-webbridge/SKILL.md`
- Create: `skills/kimi-webbridge/scripts/webbridge.ts`
- Modify: `skills/catalog.json` (regenerated, not hand-edited)

### Task A0: Verify the skill → model → kimi-agent path (investigation, no placeholder)

- [ ] **Step 1: Confirm the daemon is healthy**

Run: `~/.kimi-webbridge/bin/kimi-webbridge status`
Expected: JSON with `"running":true` and `"extension_connected":true`. If not, read `~/.kimi/skills/kimi-webbridge/references/operations.md`.

- [ ] **Step 2: Confirm how Max runs a skill's scripts and exposes them to the model**

Run: `cat skills/outlook/SKILL.md | head -40 && ls skills/outlook/scripts`
Read `assistant/src/tools/registry.ts` and `assistant/src/skills/` to confirm: a loaded skill's `scripts/` are runnable by the model via the terminal/bash tool, and that the kimi-agent provider bridges that terminal tool (it bridges all Max tools via `buildExternalTools`). Write a one-paragraph note in the PR description of the exact mechanism (skill-load → SKILL.md injected → model runs `bun scripts/webbridge.ts ...` via terminal). If skills instead register *structured* tools, adapt Task A2's SKILL.md to that convention.

### Task A1: webbridge CLI wrapper script

**Files:** Create `skills/kimi-webbridge/scripts/webbridge.ts`

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env bun
// Thin CLI over the kimi-webbridge daemon (controls the user's REAL browser).
// Usage:
//   bun webbridge.ts status
//   bun webbridge.ts <action> '<jsonArgs>' [session]
// Actions (daemon /command): navigate, find_tab, snapshot, click, fill, evaluate,
//   screenshot, network, upload, save_as_pdf, list_tabs, close_tab, close_session.
const DAEMON = process.env.KIMI_WEBBRIDGE_URL ?? "http://127.0.0.1:10086";
const [, , action, argsJson, session] = process.argv;

async function main(): Promise<void> {
  if (!action) {
    console.log(JSON.stringify({ ok: false, error: "usage: webbridge <action> [jsonArgs] [session]" }));
    return;
  }
  if (action === "status") {
    const proc = Bun.spawnSync(["/Users/" + (process.env.USER ?? "") + "/.kimi-webbridge/bin/kimi-webbridge", "status"]);
    console.log(proc.stdout.toString().trim() || JSON.stringify({ ok: false, error: "status unavailable" }));
    return;
  }
  let args: unknown = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    console.log(JSON.stringify({ ok: false, error: "invalid JSON args" }));
    return;
  }
  const body = JSON.stringify({ action, args, session: session ?? "max" });
  try {
    const r = await fetch(`${DAEMON}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = await r.text();
    console.log(r.ok ? text : JSON.stringify({ ok: false, error: `daemon ${r.status}: ${text.slice(0, 200)}` }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `daemon unreachable: ${String(e)}` }));
  }
}
void main();
```

- [ ] **Step 2: Manually verify the wrapper drives the real browser**

Run:
```bash
cd skills/kimi-webbridge/scripts
bun webbridge.ts status
bun webbridge.ts navigate '{"url":"https://example.com","newTab":true,"group_title":"Max webbridge test"}' vtest
bun webbridge.ts snapshot '{}' vtest
bun webbridge.ts close_session '{}' vtest
```
Expected: `status` shows `running:true`; `navigate` returns `{"ok":true,"data":{"success":true,...}}`; `snapshot` returns a `data.tree` with `@e` refs; `close_session` returns `{"ok":true,...}`.

- [ ] **Step 3: Commit**

```bash
git add skills/kimi-webbridge/scripts/webbridge.ts
git commit -m "feat(skills): kimi-webbridge daemon CLI wrapper"
```

### Task A2: Max SKILL.md

**Files:** Create `skills/kimi-webbridge/SKILL.md`

- [ ] **Step 1: Write the SKILL.md** (Max frontmatter; adapt the verified `~/.kimi/skills/kimi-webbridge/SKILL.md` tool table — navigate/find_tab/snapshot/click/fill/evaluate/screenshot/network/upload/save_as_pdf/list_tabs/close_tab/close_session — to the `bun scripts/webbridge.ts <action> '<jsonArgs>' <session>` calling convention)

```markdown
---
name: kimi-webbridge
description: Control the user's REAL browser (their logged-in sessions) — navigate, read via accessibility snapshot, click, fill, screenshot, evaluate JS, save PDF. Use whenever a task needs a real browser or the user's existing logins. Precise: targets elements by stable @e refs from snapshot, not pixels.
compatibility: "Designed for Max personal assistants; requires the kimi-webbridge daemon + browser extension"
metadata:
  emoji: "🧭"
  max:
    display-name: "Web Bridge (real browser)"
    user-invocable: true
---

# Web Bridge — control the user's real browser

Drives the user's actual logged-in browser via a local daemon. ALWAYS health-check first:
`~/.kimi-webbridge/bin/kimi-webbridge status` → need `running:true` and `extension_connected:true`.
If not healthy, read `~/.kimi/skills/kimi-webbridge/references/operations.md`.

## Calling convention
Run every action through the wrapper (returns JSON `{ok,data}`):
`bun skills/kimi-webbridge/scripts/webbridge.ts <action> '<jsonArgs>' <session>`

- **One task = one `session` name** (a tab group). Pass it as the 3rd arg on every call; never change it mid-task.
- Loop: `navigate` → `snapshot` (read accessibility tree + `@e` refs) → `click`/`fill` by `@e` ref → `snapshot`/`screenshot` to confirm.

## Tools (action → args)
| action | args | notes |
|---|---|---|
| navigate | `{"url","newTab":true,"group_title"}` | first call opens a tab |
| snapshot | `{}` | accessibility tree with `@e` refs — use to read + locate elements |
| click | `{"selector":"@e123"}` | real DOM click |
| fill | `{"selector":"@e45","value":"..."}` | inputs/textarea/contenteditable |
| evaluate | `{"code":"..."}` | run JS (wrap in IIFE; compact `JSON.stringify`) |
| screenshot | `{"format":"png","path":"/tmp/x.png"}` | returns a file path; view with ReadMediaFile |
| save_as_pdf | `{"path":"/tmp/x.pdf"}` | render page → PDF |
| list_tabs / close_tab / close_session | `{}` | tab/session management |

## On screenshots (kimi-agent)
`screenshot` returns a file path. On the kimi-agent model, call `ReadMediaFile` with that
absolute path to SEE it (the provider's media bridge + native multimodal ingestion).

## Safety
This controls the user's real browser/logins. Confirm before any state-changing action
(posting, purchasing, sending). Read-only navigation/snapshot/screenshot is safe.
```

- [ ] **Step 2: Validate frontmatter parses like a real skill**

Run: `bun assistant/scripts/... ` — actually run the catalog generator (next task) which parses frontmatter; a parse error fails there.

- [ ] **Step 3: Commit**

```bash
git add skills/kimi-webbridge/SKILL.md
git commit -m "feat(skills): kimi-webbridge Max skill (real-browser automation)"
```

### Task A3: Register + verify end-to-end

- [ ] **Step 1: Regenerate the skills catalog**

Run: `node scripts/skills/generate-catalog.mjs`
Expected: `Generated .../skills/catalog.json with N skill(s).` and N increased by 1.

- [ ] **Step 2: Verify it registered + validates**

Run:
```bash
python3 -c "import json;d=json.load(open('skills/catalog.json'));print('kimi-webbridge' in [s['id'] for s in d['skills']])"
node scripts/skills/check-catalog.mjs
```
Expected: `True` and `skills/catalog.json is up to date.`

- [ ] **Step 3: Live e2e in Max** — rebuild the app (see Pre-flight), open a kimi-agent (K2.6 Agent) chat, ask: *"Use the web bridge skill to open example.com, snapshot it, and tell me the links."* Expected: the model runs `webbridge.ts navigate`/`snapshot` and reports the `@e` links. Then: *"screenshot it and describe what you see"* → expect a `ReadMediaFile` call + visual description (validates the media-bridge pairing).

- [ ] **Step 4: Commit**

```bash
git add skills/catalog.json
git commit -m "chore(skills): register kimi-webbridge in catalog"
```

---

## Project C — Vision web-automation (verification, no build)

**Goal:** Confirm the just-shipped tool-image media bridge lets the kimi-agent model SEE Max tool screenshots end-to-end (so visual web tasks work). This is a verification project; if it fails, file a bug — do not paper over it.

**Files:** none (verification only) — optionally add a default-skip probe later.

### Task C1: End-to-end vision check

- [ ] **Step 1: Confirm prerequisites**

Run: `cd assistant && grep -n "ReadMediaFile\|tool-media\|appendMediaReference" src/providers/kimi-agent/client.ts | head` — confirm the media bridge code is present.

- [ ] **Step 2: Drive a real vision-in-the-loop task** (needs Project A done, or `max-browser-use`). In a K2.6 Agent chat: *"Open example.com via the web bridge, screenshot it, then tell me the exact heading text and the link label you can SEE in the image."* Expected: the model calls screenshot → `ReadMediaFile` → reports "Example Domain" + "More information..." (content only obtainable by viewing the image, not the DOM text alone — to prove vision, not snapshot).

- [ ] **Step 3: Record the result** in the PR/notes. If the model cannot describe the image, capture the assistant log line (`grep -i "tool-media\|ReadMediaFile" <instance>/.max/workspace/data/logs/assistant-*.log`) and open an issue — the bridge or ingestion regressed.

---

## Project D — Session continuity (`sessionId`)

**Goal:** Reuse one kimi SDK session per Max conversation so kimi keeps its own working context across turns (continuity + prompt-cache reuse), instead of a fresh session each `sendMessage`.

**Files:**
- Modify: `assistant/src/providers/types.ts` (add an optional conversation key to `SendMessageOptions`)
- Modify: `assistant/src/providers/kimi-agent/client.ts` (thread `sessionId` into `createSession`)
- Modify: callers that build `SendMessageOptions` (the agent loop) to pass the conversation key
- Test: `assistant/src/__tests__/kimi-agent-provider.test.ts`

### Task D0: Decide the session-key source (investigation — REQUIRED first)

- [ ] **Step 1: Find where a stable per-conversation id exists**

`SendMessageOptions` (types.ts:309) has NO conversation/thread id today. Run:
```bash
cd assistant
grep -rn "sendMessage(" src/agent src/runtime --include="*.ts" | grep -v __tests__ | head
grep -rn "conversationId\|threadId\|conversation_id" src/agent/loop.ts | head
```
Determine the stable id available at the call site (conversation/thread id). If none is plumbed to the provider, the minimum-viable design is: add `conversationKey?: string` to `SendMessageOptions`, pass it from the agent loop, and derive `sessionId = "max-" + conversationKey`. Document the chosen source. **If no stable key is reachable without large refactors, STOP and ship D as "deferred" — do not fake it with a random id (that defeats continuity).**

### Task D1: Add the option + thread it (TDD)

- [ ] **Step 1: Write the failing test**

```ts
test("reuses a stable sessionId derived from conversationKey", async () => {
  const p = new KimiAgentProvider("kimi-k2.6-instant");
  await p.sendMessage([userText("hi")], [], undefined, { conversationKey: "conv-123" });
  expect(lastSessionOptions().sessionId).toBe("max-conv-123");
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test src/__tests__/kimi-agent-provider.test.ts -t "reuses a stable sessionId"`
Expected: FAIL (sessionId undefined).

- [ ] **Step 3: Implement** — add `conversationKey?: string` to `SendMessageOptions` (types.ts), then in `client.ts` `createSession({...})` add: `...(options?.conversationKey ? { sessionId: \`max-${options.conversationKey}\` } : {})`.

- [ ] **Step 4: Run it; verify it passes.** Then thread `conversationKey` from the agent loop call site found in D0.

- [ ] **Step 5: Commit**

```bash
git add src/providers/types.ts src/providers/kimi-agent/client.ts src/__tests__/kimi-agent-provider.test.ts
git commit -m "feat(kimi-agent): reuse a per-conversation SDK session"
```

> **Caveat to verify at execution:** the SDK creating a session with an existing `sessionId` resumes prior context. Confirm this does NOT double-count tokens or replay events in a way that conflicts with Max's own context management (Max already sends full history in the prompt). If it duplicates context, gate D behind a feature flag and default OFF.

---

## Project E — Per-profile effort / step-budget knobs

**Goal:** Let a profile tune `thinking` and `maxTurns` directly (independent of the Instant/Thinking/Agent presets), so power users can set e.g. thinking-on + 80 steps without a new catalog mode.

**Files:**
- Modify: `assistant/src/providers/inference/adapter-factory.ts` (forward profile extras)
- Modify: `assistant/src/providers/kimi-agent/client.ts` (`KimiAgentOptions` + override resolveKimiMode)
- Test: `assistant/src/__tests__/kimi-agent-provider.test.ts`

### Task E1: Forward optional overrides (TDD)

- [ ] **Step 1: Write the failing test**

```ts
test("explicit thinking/maxTurns options override the mode preset", async () => {
  const p = new KimiAgentProvider("kimi-k2.6-instant", { thinkingOverride: true, maxTurnsOverride: 80 });
  await p.sendMessage([userText("hi")], [], undefined);
  expect(lastSessionOptions().thinking).toBe(true); // instant preset is false; override wins
});
```

- [ ] **Step 2: Run it; verify it fails** (`thinkingOverride` not a known option).

- [ ] **Step 3: Implement** — add `thinkingOverride?: boolean; maxTurnsOverride?: number` to `KimiAgentOptions` in `client.ts`; after `const mode = resolveKimiMode(this.model)`, apply: `const thinking = this.opts.thinkingOverride ?? mode.thinking; const maxTurns = this.opts.maxTurnsOverride ?? mode.maxTurns;` and use `thinking`/`maxTurns` in `createSession`/the StepBegin cap. Then in `adapter-factory.ts`, read these from the profile config and pass them through (find how claude-subscription forwards per-profile extras for the pattern; if profiles don't carry arbitrary keys, add `thinkingOverride`/`maxTurns` to the profile schema first).

- [ ] **Step 4: Run it; verify it passes.**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(kimi-agent): per-profile thinking/step-budget overrides"
```

---

## Project B — Upgrade the kimi CLI (1.12.0 → latest) — HIGHER RISK, do LAST

**Goal:** Move off the Feb-2026 snapshot to unlock plan mode, background tasks, the new `Agent` tool, and (Wire 1.7) `PreToolUse` hooks — which could let us *gate* the ungated read-only built-ins instead of disabling them.

**Files:** none in-repo for the upgrade itself; possible follow-up in `agent-file.ts`/`client.ts` if hooks become usable.

> **⚠️ The entire hybrid-isolation fix assumed CLI 1.12.0 behavior.** A new CLI can change which built-ins emit `ApprovalRequest`, the agent-spec schema, and the Wire protocol. **Re-run the isolation probes after upgrading — do not trust the old PASS.**

### Task B1: Upgrade + re-verify isolation

- [ ] **Step 1: Record current state**

Run: `kimi --version && kimi info` (note version + wire protocol).

- [ ] **Step 2: Upgrade**

Run: `~/.local/bin/kimi --help | grep -i upgrade || uv tool upgrade kimi-cli` (confirm the upgrade path; the CLI may self-upgrade). Then `kimi --version`.

- [ ] **Step 3: Re-run the LOAD-BEARING isolation probes** (the hybrid spec disables write/exec/net built-ins; confirm still true)

Run:
```bash
cd assistant
node scripts/kimi-agent/isolation.mjs            # bare SDK: ReadFile may run ungated (expected)
bun scripts/kimi-agent/isolation-agentfile.mjs   # FIX: forbidden built-ins must stay unreachable
```
Expected: `isolation-agentfile.mjs` → `VERDICT: ✅ PASS` (write/exec/network built-ins + ambient MCP unreachable). **If it FAILS, the upgrade broke isolation — pin/rollback the CLI or fix the agent spec before shipping.**

- [ ] **Step 4: Re-run the kimi test suite + a live smoke test**

Run: `bun test src/__tests__/kimi-agent-provider.test.ts | tail -3` and a live `kimi --print "say OK"`.

- [ ] **Step 5: If `PreToolUse` hooks are now live** (`kimi info` shows wire ≥1.7, `createSession`/ProtocolClient forwards hooks), open a follow-up to gate read-only built-ins via a hook returning `{action:"block"}` — a stronger isolation than the current "leave them off the allowlist." Capture findings in `docs/architecture/kimi-agent-bridge.md`. (Do NOT attempt this if hooks remain absent — same dead-end as on 1.12.0.)

- [ ] **Step 6: Commit any in-repo changes** (e.g. updated probes/docs).

---

## Out of scope — rejected with reasons (do NOT chase)

- **K2.6 Agent Swarm:** no SDK/CLI lever (`SessionOptions` has no swarm/subagent-count field); the only local path is re-enabling kimi subagents, which **reopens the isolation hole** the provider closes. The 300-agent swarm is a kimi.com-hosted product. Use the `kimi` CLI directly if needed.
- **`steer()` mid-turn input:** requires Wire ≥1.4; installed CLI is Wire 1.3. Revisit only after Project B.
- **Ralph autonomous looping (`max_ralph_iterations`):** not a `SessionOptions` field; not settable through the SDK. Revisit only if a future SDK exposes it.

---

## Self-review

- **Spec coverage:** A (webbridge tool) ✓, B (CLI upgrade) ✓, C (vision demo) ✓, D (session continuity) ✓, E (effort knobs) ✓, rejected items documented ✓.
- **Investigation-first where uncertain:** A0 (skill→model wiring), D0 (session-key source), E1 (profile-extras plumbing), B (post-upgrade re-probe) — each has concrete commands, not placeholders.
- **Type/name consistency:** `KIMI_MODE_CONFIG`, `resolveKimiMode`, `KimiAgentOptions`, `SendMessageOptions.conversationKey`, `thinkingOverride`/`maxTurnsOverride` used consistently across D/E.
- **Risk flagged:** B re-probe is load-bearing; D may conflict with Max context mgmt (gate behind a flag if so).
