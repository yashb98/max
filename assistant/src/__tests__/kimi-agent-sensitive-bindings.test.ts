/**
 * Task 12 (I-7 for kimi-agent) — end-to-end proof that the `kimi-agent`
 * provider participates in the provider-agnostic sensitive-output
 * substitution.
 *
 * The substitution itself lives in `agent/loop.ts` (the bridge closure
 * merges a tool's `sensitiveBindings` into the per-run `substitutionMap`,
 * and the `ProviderEvent → AgentEvent` adapter rewrites streamed
 * `text_delta`s in place). It is intentionally zero-code in the provider —
 * but the provider must still (a) call the loop's `toolBridge` from its
 * external-tool handler so the merge fires, and (b) emit the model's text
 * as `text_delta` so the adapter can substitute it. This test drives the
 * REAL `KimiAgentProvider` (with the SDK mocked) through a REAL `AgentLoop`
 * to confirm both halves connect.
 *
 * The generic version of this guarantee lives in
 * `loop-bridge-event-forwarding.test.ts`; this file pins it to the kimi
 * provider's actual handler + ContentPart streaming path.
 */
import { describe, expect, mock, test } from "bun:test";

import type { AgentEvent, LoopToolExecutor } from "../agent/loop.js";
import type { Message, ToolDefinition } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock node:child_process so `which kimi` resolves without spawning.
// ---------------------------------------------------------------------------

mock.module("node:child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: null, result: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout: "/usr/local/bin/kimi-fake\n", stderr: "" });
  },
}));

// ---------------------------------------------------------------------------
// Mock the Kimi SDK. The turn invokes the captured external-tool handler
// (driving the loop's bridge closure → sensitiveBindings merge) BEFORE it
// streams the placeholder text, so the substitutionMap is populated by the
// time the provider emits the corresponding `text_delta`.
// ---------------------------------------------------------------------------

const PLACEHOLDER = "MAX_ASSISTANT_INVITE_CODE_kimi-binding-xyz";

interface CapturedTool {
  handler: (params: Record<string, unknown>) => Promise<{ output: string; message: string }>;
}

const createSession = mock((opts: { externalTools?: CapturedTool[] }) => {
  const tools = opts.externalTools ?? [];
  return {
    prompt: mock(() => ({
      approve: mock(async () => {}),
      interrupt: mock(async () => {}),
      respondQuestion: mock(async () => {}),
      result: Promise.resolve({ status: "finished" as const }),
      async *[Symbol.asyncIterator]() {
        // 1. Run the registered Max tool through the handler. This calls
        //    the loop's bridge closure, which merges the tool's
        //    sensitiveBindings into the per-run substitutionMap.
        if (tools[0]) {
          await tools[0].handler({});
        }
        // 2. Stream the model's reply containing the placeholder. The
        //    provider turns this into a `text_delta`, which the loop adapter
        //    substitutes using the now-populated map.
        yield {
          type: "ContentPart",
          payload: { type: "text", text: `Your code is ${PLACEHOLDER} — use it.` },
        };
        yield { type: "TurnEnd", payload: {} };
      },
    })),
    close: mock(async () => {}),
  };
});

mock.module("@moonshot-ai/kimi-agent-sdk", () => ({
  createSession,
  createExternalTool: (d: unknown) => d,
  login: mock(async () => ({ success: true })),
}));

// Import provider AND AgentLoop AFTER the mocks so the provider's top-level
// `promisify(execFile)` captures the mocked child_process (not the real one).
const { KimiAgentProvider } = await import("../providers/kimi-agent/client.js");
const { AgentLoop } = await import("../agent/loop.js");

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

const tools: ToolDefinition[] = [
  { name: "credential_tool", description: "c", input_schema: { type: "object" } },
];

describe("Task 12 — kimi-agent inherits sensitive-output substitution", () => {
  test("placeholder streamed after a bridged tool renders the real value", async () => {
    const realValue = "real-secret-token-kimi-42";
    let bridgeReturnContent = "";

    const toolExecutor: LoopToolExecutor = async () => {
      bridgeReturnContent = "done";
      return {
        content: "done",
        isError: false,
        sensitiveBindings: [
          { kind: "invite_code" as const, placeholder: PLACEHOLDER, value: realValue },
        ],
      };
    };

    const provider = new KimiAgentProvider("kimi-k2");
    const loop = new AgentLoop(provider, "sys", {}, tools, toolExecutor);
    const outerEvents: AgentEvent[] = [];
    await loop.run([userMessage("give me my code")], (event) => {
      outerEvents.push(event);
    });

    // Security invariant: only the placeholder crosses the SDK boundary.
    expect(bridgeReturnContent).toBe("done");
    expect(bridgeReturnContent).not.toContain(realValue);

    // The outer stream must see the SUBSTITUTED text.
    const joined = outerEvents
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(joined).toContain(realValue);
    expect(joined).not.toContain(PLACEHOLDER);
  });
});
