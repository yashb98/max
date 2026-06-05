# Kimi Agent SDK Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `kimi-agent` LLM provider that drives Moonshot's **Kimi Agent SDK** (`@moonshot-ai/kimi-agent-sdk` → the `kimi` Code CLI) as an in-process agentic runtime, mirroring the existing `claude-subscription` provider, while preserving every Vellum tool-execution security invariant.

**Architecture:** The Kimi Agent SDK runs its own agent loop inside the `kimi` CLI subprocess (same shape as `@anthropic-ai/claude-agent-sdk`). A new `KimiAgentProvider` implements Vellum's `Provider` interface: it creates a Kimi session, exposes each Vellum tool to the SDK as a Kimi **external tool** whose handler bridges back into Vellum's `ToolExecutor` (via the existing `SendMessageOptions.toolBridge` seam), and enforces isolation through the SDK's **approval gate** (`yoloMode: false` + reject every tool call that is not an allowlisted external tool — the analog of `claude-subscription`'s `canUseTool` deny). Streamed SDK events map onto Vellum's existing `ProviderEvent` union. This reuses 100% of the bridge plumbing (`agent/loop.ts` closure, `ProviderToolBridge`, `ToolBridgeResult`) that `claude-subscription` already established.

**Tech Stack:** TypeScript, Bun (`bun:test`), `@moonshot-ai/kimi-agent-sdk` (new dep), the `kimi` Code CLI (external binary, like `claude`), Vellum's provider/registry/feature-flag infrastructure.

**Reference implementation to mirror at every step:** `assistant/src/providers/claude-subscription/` and `assistant/docs/architecture/claude-subscription-bridge.md`. Where this plan says "mirror X", read X first and copy its structure.

---

## Key differences from `claude-subscription` (read before starting)

| Concern | `claude-subscription` (existing) | `kimi-agent` (this plan) |
|---|---|---|
| SDK | `@anthropic-ai/claude-agent-sdk` `query({prompt, options})` async-iterable | `@moonshot-ai/kimi-agent-sdk` `createSession(opts)` → `session.prompt(content)` → `Turn` (async-iterable of `StreamEvent`) |
| Auth | Claude Max OAuth in macOS Keychain (`cli-login`, keyless) | **Moonshot API key** — `api-key` setup mode. Key passed to the CLI via `env` / `~/.kimi/config.toml`. **NOT subscription-backed.** |
| External binary | `claude` (resolved via `which`) | `kimi` (resolved via `which`), passed as `executable` |
| Tool exposure | in-process MCP server (`type: "sdk"`) | `externalTools: ExternalTool[]` (handlers run in-proc — no MCP server needed) |
| Built-in tool isolation | `tools: []` strips built-ins | **No strip option** → must `reject` every non-allowlisted tool at `ApprovalRequest` time (`yoloMode: false`) |
| Account-level tool leak | `settingSources: []` | Kimi reads `~/.kimi/config.toml`; mitigate via clean `env` + approval-deny |
| System prompt replace | `systemPrompt: <string>` | `agentFile: <path>` (file-based persona) — **verify semantics in Phase 0** |
| Turn/cost cap | `maxTurns: 25` | No SDK option → host counts `StepBegin`/`TurnBegin` events and cancels the turn |
| Abort | `query({ options: { abortController } })` | `turn.cancel()` / `session.close()` — **confirm method names in Phase 0** |

The verified Kimi SDK surface (from `MoonshotAI/kimi-agent-sdk` `node/agent_sdk/schema.ts`):

```typescript
// SessionOptions
{ workDir: string; sessionId?: string; model?: string; thinking?: boolean;
  yoloMode?: boolean; executable?: string; env?: Record<string, string>;
  externalTools?: ExternalTool[]; agentFile?: string;
  clientInfo?: { name: string; version: string }; skillsDir?: string; shareDir?: string; }

// ExternalTool (wire shape — parameters is a raw JSON Schema object)
{ name: string; description: string; parameters: Record<string, unknown>; handler: ExternalToolHandler; }

// ApprovalResponse
"approve" | "approve_for_session" | "reject"

// ApprovalRequestPayload
{ id: string; tool_call_id: string; sender: string; action: string; description: string; display?: DisplayBlock[]; }

// ToolReturnValue (handler return)
{ is_error: boolean; output: string | ContentPart[]; message: string; display: DisplayBlock[]; extras?: Record<string, unknown>; }

// RunResult
{ status: "finished" | "cancelled" | "max_steps_reached"; steps?: number; }

// Wire events seen on the Turn async-iterator:
// TurnBegin, TurnEnd, StepBegin, StatusUpdate, SubagentEvent, ContentPart (text/think),
// ToolCall, ToolResult, ApprovalRequest
// Session API: session.prompt(content): Turn ; turn.approve(requestId, response): Promise<void> ;
//              turn[Symbol.asyncIterator]()
```

---

## File Structure

**Create:**
- `assistant/src/providers/kimi-agent/client.ts` — `KimiAgentProvider`, external-tool bridge, approval-deny isolation, event mapping, turn cap, abort. (Mirror `claude-subscription/client.ts`.)
- `assistant/src/providers/kimi-agent/errors.ts` — `KimiAgentBridgeError` + `classifyKimiAgentError`. (Mirror `claude-subscription/errors.ts`.)
- `assistant/src/__tests__/kimi-agent-provider.test.ts` — provider/bridge/isolation unit tests. (Mirror `claude-subscription-provider.test.ts`.)
- `assistant/src/__tests__/kimi-agent-concurrency.test.ts` — semaphore/lifecycle tests.
- `assistant/scripts/kimi-agent/spike-isolation.mjs` — Phase 0 throwaway probe (built-in-tool containment).
- `assistant/scripts/kimi-agent/spike-agentfile.mjs` — Phase 0 throwaway probe (persona replacement).
- `assistant/docs/architecture/kimi-agent-bridge.md` — findings + design record (seeded from the Phase 0 spike).
- `assistant/docs/runbook-kimi-agent.md` — Phase 3 ops runbook.

**Modify:**
- `assistant/package.json` — add `@moonshot-ai/kimi-agent-sdk` dependency.
- `assistant/src/providers/model-catalog.ts` — add `kimi-agent` `ProviderCatalogEntry`.
- `assistant/src/providers/inference/adapter-factory.ts` — add `kimi-agent` factory.
- `assistant/src/providers/registry.ts` — extend feature-flag gate to also skip `kimi-agent` when its flag is off.
- `assistant/src/providers/provider-availability.ts` — add `kimi-agent` availability branch (`kimi` CLI present + API key/config).
- `meta/feature-flags/feature-flag-registry.json` — add `kimi-agent-provider` flag (`defaultEnabled: false` until verified).
- `assistant/src/tools/terminal/safe-env.ts` — allowlist `MOONSHOT_API_KEY` (per `assistant/CLAUDE.md`).
- `clients/macos/vellum-assistant/Features/Chat/ComposerSettingsMenu.swift` — add picker group/mapping (Phase 3).

**Reuse unchanged:** `agent/loop.ts` (the `toolBridge` closure is provider-agnostic), `providers/types.ts` (`ProviderToolBridge`, `ToolBridgeResult`, `ProviderEvent`, `SendMessageOptions`), `RetryProvider`, `UsageTrackingProvider`.

---

## Phase 0 — Spike: verify the SDK's isolation & control surface (GATE)

**Why first:** The whole isolation model rests on assumptions the SDK docs do not confirm: (a) rejecting non-allowlisted tools at `ApprovalRequest` actually prevents built-in `bash`/`read`/`write` execution; (b) `agentFile` replaces the Kimi persona rather than appending; (c) external-tool handlers route correctly; (d) how to abort a turn and where the turn/step cap lives; (e) the exact `ToolReturnValue` the handler must return. The `claude-subscription` work proved (design doc §I-11) that the naive isolation config silently let the model run `id > /tmp/proof` on the host. **Do not build the provider until these are verified empirically.** This phase produces throwaway scripts, not shipped code.

**Prerequisites:** `kimi` CLI installed (`npm i -g @moonshot-ai/kimi-cli` or per Moonshot docs) and a Moonshot API key in `~/.kimi/config.toml` (`kimi /login`). If neither is available on this machine, STOP and tell the user — Phase 0 cannot be faked.

**Files:**
- Create: `assistant/scripts/kimi-agent/spike-isolation.mjs`
- Create: `assistant/scripts/kimi-agent/spike-agentfile.mjs`
- Create: `assistant/docs/architecture/kimi-agent-bridge.md`

- [ ] **Step 1: Install the SDK as a dependency**

Run:
```bash
cd assistant && bun add @moonshot-ai/kimi-agent-sdk
```
Expected: `package.json` gains `"@moonshot-ai/kimi-agent-sdk": "<version>"`; lockfile updates. Record the resolved version.

- [ ] **Step 2: Write the built-in-tool containment probe**

Create `assistant/scripts/kimi-agent/spike-isolation.mjs`:
```js
// Throwaway probe: confirm approval-deny contains built-in tools.
// Run with a real kimi CLI + Moonshot key configured.
import { createSession } from "@moonshot-ai/kimi-agent-sdk";
import { existsSync, rmSync } from "node:fs";

const PROOF = "/tmp/kimi-isolation-proof";
rmSync(PROOF, { force: true });

const session = createSession({
  workDir: "/tmp",
  model: process.env.KIMI_SPIKE_MODEL ?? "kimi-k2.6",
  yoloMode: false, // never auto-approve
  thinking: false,
});

// Allowlist is EMPTY — we expose no external tools, so EVERY tool call
// (all built-ins) must be rejected at approval.
const ALLOW = new Set();

const turn = session.prompt(
  `Run the shell command: id > ${PROOF}. Then read it back and tell me the contents.`,
);

let approvalCount = 0;
let rejectedCount = 0;
for await (const ev of turn) {
  if (ev.type === "ApprovalRequest") {
    approvalCount++;
    const name = ev.payload?.action ?? ev.payload?.description ?? "<unknown>";
    console.log("APPROVAL_REQUEST", JSON.stringify(ev.payload));
    await turn.approve(ev.payload.id, "reject");
    rejectedCount++;
    void name;
  } else if (ev.type === "ContentPart") {
    process.stdout.write(JSON.stringify(ev.payload) + "\n");
  } else {
    console.log("EVENT", ev.type);
  }
}

const leaked = existsSync(PROOF);
console.log(`VERDICT: ${leaked ? "❌ FAIL — proof file written (host reached)" : "✅ PASS — no host side effect"}`);
console.log(`approvals=${approvalCount} rejected=${rejectedCount}`);
process.exit(leaked ? 1 : 0);
```

- [ ] **Step 3: Run the containment probe and record the verdict**

Run:
```bash
node assistant/scripts/kimi-agent/spike-isolation.mjs
```
Expected (required to proceed): `VERDICT: ✅ PASS — no host side effect`, and at least one `APPROVAL_REQUEST` was logged (proving built-in tool calls surface as approvals we can reject). 

**Record in `kimi-agent-bridge.md`:** the exact `ApprovalRequestPayload` shape printed (which field carries the tool name — `action` vs `description`), and whether ANY built-in ran without an approval. If a built-in ran without surfacing an approval, **isolation via approval-deny is insufficient** — STOP and escalate to the user (fallback: Option B from the brainstorm, or a `workDir` jail + seccomp). Do not proceed past this gate on a FAIL.

- [ ] **Step 4: Write the persona-replacement probe**

Create `assistant/scripts/kimi-agent/spike-agentfile.mjs`:
```js
import { createSession } from "@moonshot-ai/kimi-agent-sdk";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "kimi-spike-"));
const agentFile = join(dir, "agent.md");
// Probe content: a distinctive persona we can detect in the reply.
writeFileSync(
  agentFile,
  "You are VELLUM-PROBE. When asked your name, reply exactly 'I am VELLUM-PROBE'. You are not a coding assistant.",
);

const session = createSession({ workDir: dir, yoloMode: false, agentFile });
const turn = session.prompt("What is your name and what is your role?");
let text = "";
for await (const ev of turn) {
  if (ev.type === "ContentPart" && ev.payload?.type === "text") text += ev.payload.text ?? "";
}
console.log("REPLY:", text);
console.log(
  `VERDICT: ${/VELLUM-PROBE/.test(text) ? "✅ agentFile REPLACED persona" : "❌ persona NOT replaced — find another mechanism"}`,
);
```

- [ ] **Step 5: Run the persona probe; record the result**

Run:
```bash
node assistant/scripts/kimi-agent/spike-agentfile.mjs
```
Record the verdict in `kimi-agent-bridge.md`. If `agentFile` does not replace the persona, note the alternative discovered (e.g. a `systemPrompt` field that the published types omitted, or prepending instructions to the `prompt()` content) — the provider's "system prompt" handling in Phase 1 depends on this answer.

- [ ] **Step 6: Pin the remaining API facts from the installed package**

Run (inspect the actual shipped types, not the docs):
```bash
cd assistant && cat node_modules/@moonshot-ai/kimi-agent-sdk/dist/*.d.ts 2>/dev/null | sed -n '1,400p'
```
Record in `kimi-agent-bridge.md`, with the exact identifiers:
- The `Turn` abort/cancel method name (`cancel()`? `abort()`? `session.close()`?).
- The exact `ToolReturnValue` / external-tool handler return shape (`{ output, message }` vs `{ is_error, output, message, display }`).
- Whether `createExternalTool` requires a zod schema, or whether a plain `{ name, description, parameters: <JSON Schema>, handler }` object satisfies `ExternalTool`.
- Where the per-turn/step cap lives (`RunResult.status: "max_steps_reached"` implies a cap — config? env? agentFile?).
- The `StreamEvent` discriminator field name (`type`) and `ContentPart` text/think shape.

- [ ] **Step 7: Seed the design doc and commit the spike**

Write `assistant/docs/architecture/kimi-agent-bridge.md` with: a TL;DR, the verified API facts from Steps 3/5/6, the isolation verdict, and a "Things not to change without re-running the probe" list (mirror the claude bridge doc's structure).

Run:
```bash
git add assistant/scripts/kimi-agent/ assistant/docs/architecture/kimi-agent-bridge.md assistant/package.json
git commit -m "spike: verify Kimi Agent SDK isolation + control surface"
```

---

## Phase 1 — Provider skeleton, external-tool bridge, approval-deny isolation

Goal: a working `KimiAgentProvider` behind a feature flag, isolated by construction, with unit tests that mock the SDK. Mirror `claude-subscription-provider.test.ts`'s `mock.module()` approach.

### Task 1: SDK mock + provider identity

**Files:**
- Create: `assistant/src/providers/kimi-agent/client.ts`
- Test: `assistant/src/__tests__/kimi-agent-provider.test.ts`

- [ ] **Step 1: Write the failing identity test with an SDK mock**

Create `assistant/src/__tests__/kimi-agent-provider.test.ts`:
```ts
import { describe, expect, mock, test } from "bun:test";

// Mock the Kimi SDK at import time. createSession returns a fake session
// whose prompt() yields a controllable async-iterable Turn.
function makeFakeTurn(events: unknown[]) {
  return {
    approve: mock(async () => {}),
    cancel: mock(() => {}),
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}
const createSession = mock(() => ({
  prompt: mock(() => makeFakeTurn([{ type: "TurnEnd", payload: {} }])),
  close: mock(() => {}),
}));
mock.module("@moonshot-ai/kimi-agent-sdk", () => ({
  createSession,
  createExternalTool: (def: unknown) => def,
}));

const { KimiAgentProvider } = await import("../providers/kimi-agent/client.js");

describe("KimiAgentProvider identity", () => {
  test("U-1: exposes name and anthropic-free token estimation", () => {
    const p = new KimiAgentProvider("kimi-k2.6", {});
    expect(p.name).toBe("kimi-agent");
    expect(p.tokenEstimationProvider).toBe("kimi");
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts -t "U-1"`
Expected: FAIL — `Cannot find module '../providers/kimi-agent/client.js'`.

- [ ] **Step 3: Write the minimal client skeleton**

Create `assistant/src/providers/kimi-agent/client.ts`:
```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createSession } from "@moonshot-ai/kimi-agent-sdk";

import { getLogger } from "../../util/logger.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../types.js";

const log = getLogger("kimi-agent-client");
const execFileAsync = promisify(execFile);

export interface KimiAgentOptions {
  streamTimeoutMs?: number;
  /** Moonshot API key forwarded to the kimi CLI subprocess via env. */
  apiKey?: string;
}

export class KimiAgentProvider implements Provider {
  readonly name = "kimi-agent";
  /** Kimi token estimation rules. */
  readonly tokenEstimationProvider = "kimi";

  constructor(
    private readonly model: string,
    private readonly opts: KimiAgentOptions = {},
  ) {}

  async sendMessage(
    _messages: Message[],
    _tools: ToolDefinition[] | undefined,
    _systemPrompt: string | undefined,
    _options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    void createSession;
    void log;
    void execFileAsync;
    throw new Error("not implemented");
  }
}
```

- [ ] **Step 4: Run it; verify it passes**

Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts -t "U-1"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assistant/src/providers/kimi-agent/client.ts assistant/src/__tests__/kimi-agent-provider.test.ts
git commit -m "feat(kimi-agent): provider skeleton + identity"
```

### Task 2: `kimi` CLI path resolution + session construction

**Files:**
- Modify: `assistant/src/providers/kimi-agent/client.ts`
- Test: `assistant/src/__tests__/kimi-agent-provider.test.ts`

- [ ] **Step 1: Write the failing session-options test**

Add to the test file:
```ts
describe("KimiAgentProvider session", () => {
  test("U-2: sendMessage creates a session with model, yoloMode:false, and the prompt", async () => {
    createSession.mockClear();
    const p = new KimiAgentProvider("kimi-k2.6", { apiKey: "sk-test" });
    await p.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
      undefined,
      {},
    );
    expect(createSession).toHaveBeenCalledTimes(1);
    const opts = createSession.mock.calls[0][0];
    expect(opts.model).toBe("kimi-k2.6");
    expect(opts.yoloMode).toBe(false);
    expect(opts.env?.MOONSHOT_API_KEY).toBe("sk-test");
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts -t "U-2"`
Expected: FAIL — `not implemented`.

- [ ] **Step 3: Implement CLI resolution + `sendMessageInner` session creation**

Replace the body of `sendMessage` and add helpers (use the abort/cancel method name confirmed in Phase 0 Step 6 — shown here as `turn.cancel()`):
```ts
let cachedKimiCliPath: string | null | undefined;
async function resolveKimiCliPath(): Promise<string | null> {
  if (cachedKimiCliPath !== undefined) return cachedKimiCliPath;
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", ["kimi"], { timeout: 2000 });
    const trimmed = stdout.trim();
    cachedKimiCliPath = trimmed.length > 0 ? trimmed : null;
  } catch {
    cachedKimiCliPath = null;
  }
  return cachedKimiCliPath;
}
```
And inside the class:
```ts
async sendMessage(messages, tools, systemPrompt, options) {
  const kimiCliPath = await resolveKimiCliPath();
  const env: Record<string, string> = {};
  if (this.opts.apiKey) env.MOONSHOT_API_KEY = this.opts.apiKey;
  const session = createSession({
    workDir: process.cwd(),
    model: this.model,
    yoloMode: false,
    thinking: false,
    ...(kimiCliPath ? { executable: kimiCliPath } : {}),
    env,
    externalTools: [], // populated in Task 4
  });
  const prompt = this.flattenForSdk(messages);
  const turn = session.prompt(prompt);
  let assistantText = "";
  for await (const ev of turn as AsyncIterable<{ type: string; payload?: any }>) {
    if (ev.type === "ContentPart" && ev.payload?.type === "text") {
      assistantText += ev.payload.text ?? "";
      options?.onEvent?.({ type: "text_delta", text: ev.payload.text ?? "" });
    }
  }
  void systemPrompt; void tools;
  return {
    content: assistantText ? [{ type: "text", text: assistantText }] : [],
    model: this.model,
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn",
  };
}

private flattenForSdk(messages: Message[]): string {
  // Mirror claude-subscription/client.ts flattenForSdk: header of prior
  // turns + the latest user message as focus. Copy that implementation.
  if (messages.length === 0) return "";
  // ... (copy the verified flattenForSdk + textOf helpers from claude-subscription) ...
}
```
> Copy `flattenForSdk` and `textOf` verbatim from `claude-subscription/client.ts:744-798` — they are provider-agnostic string flatteners.

- [ ] **Step 4: Run it; verify it passes**

Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts -t "U-2"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assistant/src/providers/kimi-agent/client.ts assistant/src/__tests__/kimi-agent-provider.test.ts
git commit -m "feat(kimi-agent): kimi CLI resolution + session construction"
```

### Task 3: Approval-deny isolation (the load-bearing security control)

**Files:**
- Modify: `assistant/src/providers/kimi-agent/client.ts`
- Test: `assistant/src/__tests__/kimi-agent-provider.test.ts`

- [ ] **Step 1: Write the failing isolation test**

```ts
describe("KimiAgentProvider isolation", () => {
  test("U-3: a tool NOT in the external-tool allowlist is rejected at approval", async () => {
    const fakeTurn = {
      approve: mock(async () => {}),
      cancel: mock(() => {}),
      async *[Symbol.asyncIterator]() {
        yield { type: "ApprovalRequest", payload: { id: "a1", tool_call_id: "t1", action: "bash", description: "run id" } };
        yield { type: "TurnEnd", payload: {} };
      },
    };
    createSession.mockReturnValue({ prompt: () => fakeTurn, close: mock(() => {}) } as any);
    const p = new KimiAgentProvider("kimi-k2.6", {});
    await p.sendMessage([{ role: "user", content: [{ type: "text", text: "run id" }] }], [], undefined, {});
    expect(fakeTurn.approve).toHaveBeenCalledWith("a1", "reject");
  });

  test("U-4: a tool that IS an allowlisted external tool is approved", async () => {
    const fakeTurn = {
      approve: mock(async () => {}),
      cancel: mock(() => {}),
      async *[Symbol.asyncIterator]() {
        yield { type: "ApprovalRequest", payload: { id: "a2", tool_call_id: "t2", action: "send_email", description: "" } };
        yield { type: "TurnEnd", payload: {} };
      },
    };
    createSession.mockReturnValue({ prompt: () => fakeTurn, close: mock(() => {}) } as any);
    const p = new KimiAgentProvider("kimi-k2.6", {});
    await p.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "email bob" }] }],
      [{ name: "send_email", description: "", input_schema: { type: "object" } } as any],
      undefined,
      { toolBridge: async () => ({ content: "ok" }) },
    );
    expect(fakeTurn.approve).toHaveBeenCalledWith("a2", "approve");
  });
});
```
> Confirm in Phase 0 Step 3 which `payload` field carries the tool name (`action` vs `description`). Adjust the field read below to match.

- [ ] **Step 2: Run; verify both fail**

Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts -t "U-3"`
Expected: FAIL (approve not called with reject).

- [ ] **Step 3: Implement the approval gate in the event loop**

Add an allowlist set built from the tool list, and handle `ApprovalRequest` in the `for await` loop:
```ts
const allowedToolNames = new Set((tools ?? []).map((t) => t.name));
// ... inside the for-await loop:
if (ev.type === "ApprovalRequest") {
  const toolName = String(ev.payload?.action ?? ""); // confirm field in Phase 0
  if (allowedToolNames.has(toolName)) {
    await turn.approve(ev.payload.id, "approve");
  } else {
    log.warn({ toolName }, "kimi-agent approval-deny rejected a non-allowlisted tool");
    await turn.approve(ev.payload.id, "reject");
  }
  continue;
}
```

- [ ] **Step 4: Run; verify both pass**

Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts -t "U-3 U-4"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(kimi-agent): approval-deny isolation (canUseTool analog)"
```

### Task 4: External-tool bridge → Vellum `ToolExecutor`

**Files:**
- Modify: `assistant/src/providers/kimi-agent/client.ts`
- Test: `assistant/src/__tests__/kimi-agent-provider.test.ts`

- [ ] **Step 1: Write the failing bridge test**

```ts
describe("KimiAgentProvider external-tool bridge", () => {
  test("U-5: each Vellum tool becomes an external tool whose handler calls the bridge", async () => {
    let captured: any;
    createSession.mockImplementation((opts: any) => {
      captured = opts;
      return { prompt: () => makeFakeTurn([{ type: "TurnEnd", payload: {} }]), close: mock(() => {}) };
    });
    const bridge = mock(async () => ({ content: "tool-output", isError: false }));
    const p = new KimiAgentProvider("kimi-k2.6", {});
    await p.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "x" }] }],
      [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } } } } as any],
      undefined,
      { toolBridge: bridge },
    );
    expect(captured.externalTools).toHaveLength(1);
    const t = captured.externalTools[0];
    expect(t.name).toBe("get_weather");
    expect(t.parameters).toEqual({ type: "object", properties: { city: { type: "string" } } });
    const ret = await t.handler({ city: "London" });
    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ toolName: "get_weather", input: { city: "London" } }));
    // ToolReturnValue shape confirmed in Phase 0 Step 6:
    expect(ret.is_error).toBe(false);
    expect(ret.output).toBe("tool-output");
  });
});
```

- [ ] **Step 2: Run; verify it fails**

Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts -t "U-5"`
Expected: FAIL — `externalTools` is `[]`.

- [ ] **Step 3: Implement `buildExternalTools`**

```ts
import type { ProviderToolBridge, ToolBridgeResult } from "../types.js";

private buildExternalTools(
  tools: ToolDefinition[],
  bridge: ProviderToolBridge,
): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema as Record<string, unknown>,
    handler: async (input: Record<string, unknown>) => {
      let result: ToolBridgeResult;
      try {
        result = await bridge({ toolName: t.name, input });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { is_error: true, output: `Bridge error: ${msg}`, message: msg, display: [] };
      }
      // Map ToolBridgeResult -> Kimi ToolReturnValue (shape from Phase 0 Step 6)
      return {
        is_error: result.isError ?? false,
        output: result.content,
        message: result.isError ? "tool error" : "ok",
        display: [],
      };
    },
  }));
}
```
Wire it into `sendMessage`: resolve the bridge (`options?.toolBridge ?? registryBridge ?? stubBridge` — mirror `claude-subscription` Task), then pass `externalTools: this.buildExternalTools(tools ?? [], bridge)` to `createSession`. Add `setVellumToolBridge` / `clearVellumToolBridge` / `stubBridge` by copying `claude-subscription/client.ts:88-201`.

- [ ] **Step 4: Run; verify it passes**

Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts -t "U-5"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(kimi-agent): external-tool bridge to ToolExecutor"
```

### Task 5: System prompt via `agentFile`, usage aggregation, turn cap, abort

**Files:**
- Modify: `assistant/src/providers/kimi-agent/client.ts`
- Test: `assistant/src/__tests__/kimi-agent-provider.test.ts`

- [ ] **Step 1: Write failing tests for systemPrompt, usage, turn cap, abort**

```ts
describe("KimiAgentProvider control", () => {
  test("U-6: systemPrompt is written to a temp agentFile and passed to the session", async () => {
    let captured: any;
    createSession.mockImplementation((o: any) => { captured = o; return { prompt: () => makeFakeTurn([{ type: "TurnEnd" }]), close: mock(()=>{}) }; });
    await new KimiAgentProvider("kimi-k2.6", {}).sendMessage(
      [{ role: "user", content: [{ type: "text", text: "x" }] }], [], "BE VELLUM", {});
    expect(typeof captured.agentFile).toBe("string");
    const fs = await import("node:fs");
    expect(fs.readFileSync(captured.agentFile, "utf8")).toContain("BE VELLUM");
  });

  test("U-7: StatusUpdate token_usage aggregates into ProviderResponse.usage", async () => {
    createSession.mockReturnValue({ prompt: () => makeFakeTurn([
      { type: "StatusUpdate", payload: { token_usage: { input_other: 10, output: 5, input_cache_read: 2, input_cache_creation: 1 } } },
      { type: "TurnEnd" },
    ]), close: mock(()=>{}) } as any);
    const r = await new KimiAgentProvider("kimi-k2.6", {}).sendMessage(
      [{ role: "user", content: [{ type: "text", text: "x" }] }], [], undefined, {});
    expect(r.usage.inputTokens).toBe(13); // 10 + 2 + 1
    expect(r.usage.outputTokens).toBe(5);
  });

  test("U-8: exceeding the step cap cancels the turn and sets stopReason max_turns", async () => {
    const cancel = mock(() => {});
    const many = Array.from({ length: 30 }, () => ({ type: "StepBegin", payload: { n: 1 } }));
    createSession.mockReturnValue({ prompt: () => ({ approve: mock(async()=>{}), cancel, async *[Symbol.asyncIterator]() { for (const e of many) yield e; } }), close: mock(()=>{}) } as any);
    const r = await new KimiAgentProvider("kimi-k2.6", {}).sendMessage(
      [{ role: "user", content: [{ type: "text", text: "x" }] }], [], undefined, {});
    expect(cancel).toHaveBeenCalled();
    expect(r.stopReason).toBe("max_turns");
  });

  test("U-9: an already-aborted signal cancels the turn", async () => {
    const cancel = mock(() => {});
    createSession.mockReturnValue({ prompt: () => ({ approve: mock(async()=>{}), cancel, async *[Symbol.asyncIterator]() { yield { type: "TurnEnd" }; } }), close: mock(()=>{}) } as any);
    const ac = new AbortController(); ac.abort();
    await new KimiAgentProvider("kimi-k2.6", {}).sendMessage(
      [{ role: "user", content: [{ type: "text", text: "x" }] }], [], undefined, { signal: ac.signal });
    expect(cancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run; verify they fail**

Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts -t "U-6 U-7 U-8 U-9"`
Expected: FAIL.

- [ ] **Step 3: Implement agentFile, usage, MAX_TURNS cap, abort wiring**

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_TURNS = 25; // cost containment — analog of claude-subscription maxTurns

// systemPrompt -> temp agentFile (mechanism confirmed in Phase 0 Step 5)
let agentFile: string | undefined;
let agentDir: string | undefined;
if (systemPrompt) {
  agentDir = mkdtempSync(join(tmpdir(), "kimi-agent-"));
  agentFile = join(agentDir, "agent.md");
  writeFileSync(agentFile, systemPrompt);
}
// ...pass ...(agentFile ? { agentFile } : {}) into createSession...

// abort: cancel the turn on signal
const signal = options?.signal;
if (signal) {
  if (signal.aborted) turn.cancel();
  else signal.addEventListener("abort", () => turn.cancel(), { once: true });
}

// in the loop:
let stepCount = 0;
let stopReason = "end_turn";
const usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
// StepBegin -> count and enforce cap:
if (ev.type === "StepBegin") {
  if (++stepCount > MAX_TURNS) { turn.cancel(); stopReason = "max_turns"; break; }
  continue;
}
// StatusUpdate -> usage:
if (ev.type === "StatusUpdate" && ev.payload?.token_usage) {
  const u = ev.payload.token_usage;
  usage.inputTokens = (u.input_other ?? 0) + (u.input_cache_read ?? 0) + (u.input_cache_creation ?? 0);
  usage.outputTokens = u.output ?? 0;
  usage.cacheCreationInputTokens = u.input_cache_creation ?? 0;
  usage.cacheReadInputTokens = u.input_cache_read ?? 0;
  continue;
}
// cleanup in finally: if (agentDir) rmSync(agentDir, { recursive: true, force: true });
```
Return `usage` and `stopReason` in the `ProviderResponse`.

- [ ] **Step 4: Run; verify they pass**

Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts -t "U-6 U-7 U-8 U-9"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(kimi-agent): agentFile persona, usage, turn cap, abort"
```

### Task 6: Concurrency cap + semaphore (mirror claude-subscription)

**Files:**
- Modify: `assistant/src/providers/kimi-agent/client.ts`
- Test: `assistant/src/__tests__/kimi-agent-concurrency.test.ts`

- [ ] **Step 1: Write the failing semaphore lifecycle test**

Mirror `claude-subscription-concurrency.test.ts`: 100 sequential `sendMessage` calls leave `activeCallCount === 0` and no queued waiters. Add `_getKimiAgentSemaphoreStateForTests` / `_resetKimiAgentSemaphoreForTests` hooks.

- [ ] **Step 2: Run; verify it fails** — Run: `cd assistant && bun test src/__tests__/kimi-agent-concurrency.test.ts`. Expected: FAIL (hooks/semaphore absent).

- [ ] **Step 3: Implement** — copy the `MAX_CONCURRENT_CALLS = 4` semaphore block from `claude-subscription/client.ts:133-186`, wrap `sendMessage` body in `acquireSemaphore()` / `finally releaseSemaphore()`.

- [ ] **Step 4: Run; verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(kimi-agent): concurrency semaphore"`

### Task 7: Catalog entry

**Files:**
- Modify: `assistant/src/providers/model-catalog.ts`
- Test: `assistant/src/providers/__tests__/` (catalog parity is enforced at module load by the factory guard in Task 8)

- [ ] **Step 1: Add the `kimi-agent` `ProviderCatalogEntry`**

Insert after the `kimi` entry. Use real Kimi model metadata (cross-check against the existing `kimi` catalog entry's models):
```ts
{
  id: "kimi-agent",
  displayName: "Kimi (Agent SDK)",
  subtitle:
    "Kimi K2.6 driven through the Kimi Code CLI's agentic runtime. Tool calls route through an external-tool bridge to Vellum's skill runner. Requires the kimi CLI + a Moonshot API key.",
  setupMode: "api-key",
  envVar: "MOONSHOT_API_KEY",
  setupHint:
    "Install the Kimi Code CLI (`npm i -g @moonshot-ai/kimi-cli`), then run `kimi /login` once with your Moonshot API key.",
  credentialsGuide: {
    description: "Install the Kimi Code CLI and sign in once with your Moonshot API key.",
    url: "https://platform.moonshot.ai/",
    linkLabel: "Open Moonshot Platform",
  },
  models: [
    { id: "kimi-k2.6", displayName: "Kimi K2.6 (agent)", contextWindowTokens: 256000, maxOutputTokens: 32768, supportsThinking: true, supportsCaching: false, supportsVision: true, supportsToolUse: true },
  ],
  defaultModel: "kimi-k2.6",
}
```
> Match the exact `CatalogModel` field names used by the existing `kimi` entry (read it first). Do not add `pricing` if the model is billed per-token via the API key — actually it IS API-key billed, so include the same `pricing` block the existing `kimi` entry uses for `kimi-k2.6`.

- [ ] **Step 2: Verify catalog loads** — Run: `cd assistant && bunx tsc --noEmit` (with `NODE_OPTIONS=--max-old-space-size=8192`). Expected: clean (the factory parity guard will fail at runtime until Task 8 adds the factory — that's expected; tsc only checks types here).

- [ ] **Step 3: Commit** — `git commit -am "feat(kimi-agent): model-catalog entry"`

### Task 8: Adapter factory wiring + parity guard

**Files:**
- Modify: `assistant/src/providers/inference/adapter-factory.ts`

- [ ] **Step 1: Write the failing factory test**

Add `assistant/src/providers/inference/__tests__/kimi-agent-factory.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { buildProviderAdapter } from "../adapter-factory.js";

describe("kimi-agent factory", () => {
  test("builds a KimiAgentProvider for the kimi-agent id", () => {
    const p = buildProviderAdapter("kimi-agent", { apiKey: "sk-x", model: "kimi-k2.6", streamTimeoutMs: 1000, useNativeWebSearch: false });
    expect(p?.name).toBe("kimi-agent");
  });
});
```

- [ ] **Step 2: Run; verify it fails** — Expected: FAIL (factory returns null, and/or `PROVIDER_CATALOG_FACTORY_PARITY` throws at import because the catalog has `kimi-agent` but no factory).

- [ ] **Step 3: Add the factory entry**

In `adapter-factory.ts`, import `KimiAgentProvider` and add:
```ts
import { KimiAgentProvider } from "../kimi-agent/client.js";
// ...in ADAPTER_FACTORIES:
"kimi-agent": ({ apiKey, model, streamTimeoutMs }) =>
  new KimiAgentProvider(model, { streamTimeoutMs, apiKey }),
```

- [ ] **Step 4: Run; verify it passes** — Expected: PASS, and the module-load parity guard no longer throws.

- [ ] **Step 5: Commit** — `git commit -am "feat(kimi-agent): adapter factory wiring"`

### Task 9: Feature flag + registry gate + availability + safe-env

**Files:**
- Modify: `meta/feature-flags/feature-flag-registry.json`
- Modify: `assistant/src/providers/registry.ts`
- Modify: `assistant/src/providers/provider-availability.ts`
- Modify: `assistant/src/tools/terminal/safe-env.ts`
- Test: `assistant/src/providers/__tests__/provider-availability.test.ts`

- [ ] **Step 1: Add the feature flag**

Append to the `flags` array in `meta/feature-flags/feature-flag-registry.json`:
```json
{
  "id": "kimi-agent-provider",
  "scope": "assistant",
  "key": "kimi-agent-provider",
  "label": "Kimi Agent SDK Provider",
  "description": "Enable the `kimi-agent` LLM provider. Drives the Kimi Code CLI (@moonshot-ai/kimi-agent-sdk) as an in-process agentic runtime; bridges its tool calls to Vellum's ToolExecutor via external tools and isolates built-ins via approval-deny. Requires the kimi CLI + a Moonshot API key. Default off until empirically validated. See assistant/docs/architecture/kimi-agent-bridge.md.",
  "defaultEnabled": false
}
```

- [ ] **Step 2: Extend the registry gate**

In `registry.ts`, generalise the flag-skip block (currently `entry.id === "claude-subscription"`) to also skip `kimi-agent`:
```ts
const FLAG_GATED_PROVIDERS: Record<string, string> = {
  "claude-subscription": "claude-subscription-provider",
  "kimi-agent": "kimi-agent-provider",
};
const gateFlag = FLAG_GATED_PROVIDERS[entry.id];
if (gateFlag && !isAssistantFeatureFlagEnabled(gateFlag, flagConfig)) {
  log.info({ providerId: entry.id }, `Skipping provider registration — feature flag ${gateFlag} is off`);
  continue;
}
```

- [ ] **Step 3: Add availability branch**

In `provider-availability.ts`, add a `kimi-agent` branch to `getProviderAvailabilityStatus` and `isProviderAvailable`: feature-flag check → `kimi` CLI on PATH (`which kimi`) → Moonshot key present (`getProviderKeyAsync("kimi-agent")` OR a key in `~/.kimi/config.toml`). Reuse the `ClaudeSubscriptionProbes` DI pattern (add a parallel `kimiCliPresent` probe) so it's hermetically testable. Reason on failure: `"not-enabled"` / `"missing-cli"` / `"no-api-key"`.

- [ ] **Step 4: Allowlist the env var**

In `assistant/src/tools/terminal/safe-env.ts`, add `MOONSHOT_API_KEY` to the allowlist (per `assistant/CLAUDE.md` — it IS credential material, so confirm whether it should be allowlisted for child processes or kept isolated to CES; default per CLAUDE.md is "omit if credential material" — so likely DO NOT allowlist, and instead pass it only via the SDK `env`. Decide and document.).

- [ ] **Step 5: Write + run availability tests** — mirror the 4-state matrix tests for `claude-subscription` (CLI × key). Run: `cd assistant && bun test src/providers/__tests__/provider-availability.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(kimi-agent): feature flag, registry gate, availability check"`

### Task 10: Phase 1 verification gate

- [ ] **Step 1: Typecheck** — Run: `cd assistant && NODE_OPTIONS="--max-old-space-size=8192" bunx tsc --noEmit`. Expected: EXIT 0.
- [ ] **Step 2: Full new-suite run** — Run: `cd assistant && bun test src/__tests__/kimi-agent-provider.test.ts src/__tests__/kimi-agent-concurrency.test.ts src/providers/inference/__tests__/kimi-agent-factory.test.ts src/providers/__tests__/provider-availability.test.ts`. Expected: all PASS.
- [ ] **Step 3: Use superpowers:verification-before-completion** before claiming Phase 1 done. Paste the actual command output.

---

## Phase 2 — Restore tool-call functionality parity

Mirror the claude-subscription bridge's Phase 2 (design doc §5). Each restores a capability the minimal Phase 1 bridge drops. Reuse the SAME `ProviderEvent`/`ToolBridgeResult` fields — they already exist in `types.ts`.

- [ ] **Task 11 — `contentBlocks`:** map `ToolBridgeResult.contentBlocks` (text/image/file) into the external-tool handler's `output: ContentPart[]` return (Kimi `ContentPart` supports `text` + `image_url`). Test: a tool returning an image block produces an `image_url` ContentPart. Mirror `mapContentBlocksToMcp` in `claude-subscription/client.ts:235-270`, but target Kimi `ContentPart`s.
- [ ] **Task 12 — `sensitiveBindings`:** the `agent/loop.ts` bridge closure already merges `result.sensitiveBindings` into the run's `substitutionMap` — confirm `kimi-agent` inherits it (it uses the same `toolBridge` seam, so this should work with zero new code). Add a test in `loop-bridge-event-forwarding.test.ts` style proving the placeholder→value substitution fires for a `kimi-agent` provider.
- [ ] **Task 13 — `yieldToUser`:** when `ToolBridgeResult.yieldToUser` is true, cancel the turn after the handler returns (mirror the `setImmediate(() => turn.cancel())` pattern so the tool result reaches the SDK first). Test: a tool returning `yieldToUser: true` aborts the turn; accumulated text is returned.
- [ ] **Task 14 — `maxToolResultChars` truncation:** in the external-tool handler, call `truncateToolResultText(result.content, options.maxToolResultChars)` before returning. Mirror `claude-subscription/client.ts:699-717`. Test: oversized result truncated; within-budget passes through.
- [ ] **Task 15 — `onChunk` streaming + `tool_use` correlation events:** thread `invocation.onChunk` into the handler and emit `tool_output_chunk`; emit `tool_use_preview_start` / `bridged_tool_committed` / `bridged_tool_result` from the SDK `ToolCall`/`ToolResult` events so the composer renders tool cards (mirror `claude-subscription/client.ts:471-540` + `724-729`). Use the SDK `tool_call_id` as the real correlation id. Tests mirror claude-subscription Phase 2.5/2.6.

---

## Phase 3 — Production hardening

- [ ] **Task 16 — Error classes:** create `kimi-agent/errors.ts` with `KimiAgentBridgeError` + `classifyKimiAgentError` (subtypes: `cli-not-installed`, `not-logged-in`/`no-api-key`, `auth-failed`, `sdk-timeout`, `subprocess-crashed`, `unknown`). Wrap SDK errors in `sendMessage`'s catch. Mirror `claude-subscription/errors.ts`; write the classifier unit tests.
- [ ] **Task 17 — In-tree isolation probe:** port `spike-isolation.mjs` → `assistant/scripts/kimi-agent/isolation.mjs` with a `VERDICT:` assertion, plus a default-skip `bun:test` bridge (`KIMI_AGENT_PROBES_ENABLED=1`) mirroring `claude-subscription-isolation-probes.test.ts`.
- [ ] **Task 18 — Integration test via real `ToolExecutor`:** mirror `tool-executor-via-bridge.test.ts` — drive `KimiAgentProvider.sendMessage` with a fake SDK but a REAL `ToolExecutor`, assert allowlist/trust/approval/CES/sandbox/audit all fire on bridged tools (the gates live in `ToolExecutor`, so this largely reuses the existing fixture with the kimi provider swapped in).
- [ ] **Task 19 — Telemetry:** emit `kimi_agent.tool_call` / `kimi_agent.send_message` metrics. The bridge-closure telemetry in `agent/loop.ts` is provider-labeled, so confirm it tags `kimi-agent` correctly; add a provider label if missing.
- [ ] **Task 20 — Runbook:** write `assistant/docs/runbook-kimi-agent.md` (diagnose "tools not running", fall back to the OpenAI-compatible `kimi` chat provider, clear stale `~/.kimi/config.toml`). Cross-link from `kimi-agent-bridge.md`.
- [ ] **Task 21 — macOS picker:** add a `ProviderGroup` mapping for `kimi-agent` in `ComposerSettingsMenu.swift` with availability-driven setup hints ("Install kimi CLI" / "Run kimi /login"). Mirror the `claudeSubscription` group.

---

## Phase 4 — Long-tail polish

- [ ] Multi-turn fidelity: switch `prompt()` content from flattened string to native `ContentPart[]` so prior-turn images/tool_results pass through (mirror claude-subscription Phase 4).
- [ ] Cost reconciliation: surface Kimi's reported usage as billed cost (it IS API-key billed, unlike the subscription provider — wire real `pricing` into `UsageTrackingProvider`).
- [ ] Per-conversation model selection in the picker.

---

## Self-Review (completed against the spec)

- **Spec coverage:** every element of "the way claude-subscription is set up" is mapped — SDK wrapper (Tasks 1-5), tool bridge (Task 4), isolation (Task 3 + Phase 0 probe + Task 17/18), availability (Task 9), catalog/factory/flag (Tasks 7-9), parity restore (Phase 2), hardening + runbook + picker (Phase 3). ✅
- **Isolation risk surfaced as a hard gate** (Phase 0) — matches how the claude bridge proved I-11 before shipping. ✅
- **Type consistency:** `KimiAgentProvider`, `KimiAgentOptions`, `buildExternalTools`, `resolveKimiCliPath`, `_getKimiAgentSemaphoreStateForTests` used consistently across tasks. Provider id `kimi-agent` and flag `kimi-agent-provider` used consistently. ✅
- **Known unknowns flagged for Phase 0 confirmation** (not placeholders): `turn.cancel()` name, `ApprovalRequestPayload` tool-name field, `ToolReturnValue` shape, `agentFile` persona semantics. Each has a concrete probe + a "adjust to match" instruction. ✅
- **Open decision left to implementer + documented:** whether `MOONSHOT_API_KEY` belongs in `safe-env.ts` (Task 9 Step 4) — per `assistant/CLAUDE.md` the safe default is to NOT allowlist credential material and pass it only via the SDK `env`.
