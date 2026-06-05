/**
 * End-to-end tests for the `agent/loop.ts` bridge seam, driven through a
 * real `AgentLoop` with a fake `Provider`.
 *
 * Covers:
 *   - Phase 2.5 — `tool_output_chunk` events emitted by the provider
 *     (mid-bridge call) reach the outer-loop event consumer via the
 *     `ProviderEvent → AgentEvent` adapter at `loop.ts:~673`.
 *   - I-7 — A bridged tool's `sensitiveBindings` get merged into the
 *     per-run `substitutionMap` by the bridge closure, and subsequent
 *     `text_delta` events emitted by the provider are substituted in
 *     place before reaching the outer-loop consumer. This is the only
 *     site where bridge-flow tool results can carry placeholders out —
 *     the SDK consumed the tool_use block, so the outer loop's own
 *     tool-dispatch merge (`loop.ts:~1036`) never runs.
 *
 * The unit tests in `claude-subscription-provider.test.ts` exercise the
 * MCP-layer placeholder isolation; the integration test in
 * `daemon/__tests__/tool-executor-via-bridge.test.ts` exercises the
 * bridge → ToolExecutor → bindings handoff. This file closes the loop
 * by combining both into one `provider.sendMessage → AgentLoop`
 * end-to-end flow.
 */
import { describe, expect, test } from "bun:test";

import type { AgentEvent, LoopToolExecutor } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

const noTools: ToolDefinition[] = [];

describe("AgentLoop adapter forwards bridge tool_output_chunk events", () => {
  test("provider's tool_output_chunk reaches the outer AgentEvent stream", async () => {
    const provider: Provider = {
      name: "mock-bridged",
      async sendMessage(
        _messages: Message[],
        _tools: ToolDefinition[] | undefined,
        _systemPrompt: string | undefined,
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        // Mimics what `claude-subscription` does mid-call when a bridged
        // tool emits chunks: the provider surfaces them through its own
        // `onEvent`. The AgentLoop adapter is the only thing between
        // here and the outer-loop event consumer.
        options?.onEvent?.({
          type: "tool_output_chunk",
          toolUseId: "mcp-bridge-chunk-test-1",
          chunk: "alpha",
        });
        options?.onEvent?.({
          type: "tool_output_chunk",
          toolUseId: "mcp-bridge-chunk-test-1",
          chunk: "beta",
        });
        options?.onEvent?.({ type: "text_delta", text: "done" });
        return {
          content: [{ type: "text", text: "done" }],
          model: "mock-model",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };

    const loop = new AgentLoop(provider, "sys", {}, noTools);
    const outerEvents: AgentEvent[] = [];
    await loop.run([userMessage("hi")], (event) => {
      outerEvents.push(event);
    });

    // Both chunks should have reached the outer event stream with shape
    // and toolUseId preserved.
    const chunkEvents = outerEvents.filter(
      (e) => e.type === "tool_output_chunk",
    );
    expect(chunkEvents).toHaveLength(2);
    expect((chunkEvents[0] as { chunk: string }).chunk).toBe("alpha");
    expect((chunkEvents[1] as { chunk: string }).chunk).toBe("beta");
    expect((chunkEvents[0] as { toolUseId: string }).toolUseId).toBe(
      "mcp-bridge-chunk-test-1",
    );
    expect((chunkEvents[1] as { toolUseId: string }).toolUseId).toBe(
      "mcp-bridge-chunk-test-1",
    );
  });
});

describe("I-7 — bridged sensitiveBindings substituted in streamed text", () => {
  test("text_delta after a bridge call renders the real value, not the placeholder", async () => {
    // The placeholder must use a real `SensitiveOutputKind` prefix so
    // the streaming substitution's tail-buffering heuristic
    // (`PREFIX = "VELLUM_ASSISTANT_"` in
    // `sensitive-output-placeholders.ts`) treats it correctly.
    const placeholder = "VELLUM_ASSISTANT_INVITE_CODE_test-binding-xyz";
    const realValue = "real-secret-token-9f3a";

    // LoopToolExecutor that returns one sensitive binding. The bridge
    // closure in `loop.ts` will merge this into the per-run
    // substitutionMap *before* control returns to the provider.
    const toolExecutor: LoopToolExecutor = async () => ({
      content: `done`,
      isError: false,
      sensitiveBindings: [
        {
          kind: "invite_code" as const,
          placeholder,
          value: realValue,
        },
      ],
    });

    // Capture what the provider sees AFTER the bridge call so we can
    // confirm the placeholder was the actual value the SDK loop would
    // have received (security invariant: the secret value is never put
    // into `content` — only the placeholder is).
    let bridgeReturnContent = "";
    const provider: Provider = {
      name: "mock-bridged-sensitive",
      async sendMessage(
        _messages: Message[],
        _tools: ToolDefinition[] | undefined,
        _systemPrompt: string | undefined,
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        // 1. Invoke the bridge — this is where the AgentLoop's bridge
        //    closure merges `sensitiveBindings` into `substitutionMap`.
        const bridgeResult = await options!.toolBridge!({
          toolName: "credential_tool",
          input: {},
        });
        bridgeReturnContent = bridgeResult.content;

        // 2. Emit the placeholder embedded in normal assistant text.
        //    The adapter at `loop.ts:~676` should rewrite this into the
        //    real value before forwarding to the outer onEvent.
        options?.onEvent?.({
          type: "text_delta",
          text: `Your code is ${placeholder} — please use it.`,
        });
        return {
          content: [
            {
              type: "text",
              text: `Your code is ${placeholder} — please use it.`,
            },
          ],
          model: "mock-model",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };

    const loop = new AgentLoop(provider, "sys", {}, noTools, toolExecutor);
    const outerEvents: AgentEvent[] = [];
    await loop.run([userMessage("give me my code")], (event) => {
      outerEvents.push(event);
    });

    // The bridge returned the tool's content verbatim — sensitive value
    // never appears in the `content` field that crosses the SDK
    // boundary. This is the security invariant: only the placeholder is
    // visible to the model context.
    expect(bridgeReturnContent).toBe("done");
    expect(bridgeReturnContent).not.toContain(realValue);

    // The outer event stream should see the SUBSTITUTED text — the
    // real value, not the placeholder.
    const textDeltas = outerEvents.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    const joined = textDeltas
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(joined).toContain(realValue);
    expect(joined).not.toContain(placeholder);
  });

  test("without a binding the placeholder text passes through verbatim", async () => {
    // Discrimination: no bridge call → no binding → placeholder is emitted as-is.
    const placeholder = "VELLUM_ASSISTANT_INVITE_CODE_unbound-suffix";
    const provider: Provider = {
      name: "mock-no-binding",
      async sendMessage(
        _messages: Message[],
        _tools: ToolDefinition[] | undefined,
        _systemPrompt: string | undefined,
        options?: SendMessageOptions,
      ): Promise<ProviderResponse> {
        options?.onEvent?.({
          type: "text_delta",
          text: `Your code is ${placeholder} — please use it.`,
        });
        return {
          content: [
            {
              type: "text",
              text: `Your code is ${placeholder} — please use it.`,
            },
          ],
          model: "mock-model",
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      },
    };

    // No toolExecutor passed: the AgentLoop's bridge closure is null;
    // `substitutionMap` stays empty so the substitution code in the
    // adapter no-ops and the text reaches the outer stream verbatim.
    const loop = new AgentLoop(provider, "sys", {}, noTools);
    const outerEvents: AgentEvent[] = [];
    await loop.run([userMessage("hi")], (event) => {
      outerEvents.push(event);
    });

    const textDeltas = outerEvents.filter((e) => e.type === "text_delta");
    const joined = textDeltas
      .map((e) => (e as { text: string }).text)
      .join("");
    // The placeholder is verbatim in the outer stream because nothing
    // merged it into the substitutionMap. Confirms that the I-7 success
    // path above is genuinely measuring the bridge-driven merge, not a
    // global "always substitute" behavior.
    expect(joined).toContain(placeholder);
  });
});
