/**
 * Zero-content persistence guard in `handleMessageComplete`.
 *
 * Root-caused 2026-06-05: agentic bridge providers (kimi-agent) can return a
 * turn with zero content blocks (e.g. after an approval denial ends the inner
 * turn without text). Without a guard, the handler persisted `"[]"` as a real
 * assistant row — the user saw a silent blank reply and no error anywhere.
 *
 * The guard replaces a truly-empty assistant message with a visible fallback
 * notice (and streams it via `assistant_text_delta`). It must NOT fire when
 * the turn produced anything at all: tool_use blocks, UI surfaces, or
 * attachment directives (whose text is stripped but which add attachments to
 * the message later).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    skills: {
      entries: {},
      load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
      install: { nodeManager: "npm" },
      allowBundled: null,
      remoteProviders: {
        skillssh: { enabled: true },
        clawhub: { enabled: true },
      },
      remotePolicy: {
        blockSuspicious: true,
        blockMalware: true,
        maxSkillsShRisk: "medium",
      },
    },
  }),
  loadConfig: () => ({}),
}));

interface AddMessageCall {
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}

const addMessageCalls: AddMessageCall[] = [];

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => {
    addMessageCalls.push({ conversationId, role, content, metadata });
    return { id: `mock-msg-${addMessageCalls.length}` };
  },
  getConversation: () => null,
  getMessageById: () => null,
  provenanceFromTrustContext: () => ({}),
  updateMessageContent: () => {},
}));

mock.module("../memory/llm-request-log-store.js", () => ({
  backfillMessageIdOnLogs: () => {},
  recordRequestLog: () => {},
}));

mock.module("../memory/memory-recall-log-store.js", () => ({
  backfillMemoryRecallLogMessageId: () => {},
}));

mock.module("../memory/memory-v2-activation-log-store.js", () => ({
  backfillMemoryV2ActivationMessageId: () => {},
}));

mock.module("../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));

import type { AgentEvent } from "../agent/loop.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleMessageComplete,
} from "../daemon/conversation-agent-loop-handlers.js";

const CONVERSATION_ID = "conv-empty-guard";

type EmittedEvent = { type: string; text?: string };

function makeDeps(
  emitted: EmittedEvent[],
  surfaces: unknown[] = [],
): EventHandlerDeps {
  return {
    ctx: {
      conversationId: CONVERSATION_ID,
      currentTurnSurfaces: surfaces,
      provider: { name: "kimi-agent" },
      traceEmitter: { emit: () => {} },
      trustContext: {
        sourceChannel: "max",
        trustClass: "guardian",
      },
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (e: unknown) => {
      emitted.push(e as EmittedEvent);
    },
    reqId: "req-empty-guard",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "max",
      assistantMessageChannel: "max",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    } as EventHandlerDeps["turnInterfaceContext"],
  };
}

function makeMessageCompleteEvent(
  content: Extract<
    AgentEvent,
    { type: "message_complete" }
  >["message"]["content"],
): Extract<AgentEvent, { type: "message_complete" }> {
  return {
    type: "message_complete",
    message: { role: "assistant", content },
  };
}

function lastAssistantRow(): AddMessageCall {
  const rows = addMessageCalls.filter((c) => c.role === "assistant");
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1];
}

describe("handleMessageComplete zero-content guard", () => {
  let state: EventHandlerState;
  let emitted: EmittedEvent[];

  beforeEach(() => {
    addMessageCalls.length = 0;
    emitted = [];
    state = createEventHandlerState();
    state.turnStartedAt = 1_700_000_000_000;
  });

  test("empty content array → fallback text block persisted instead of \"[]\"", async () => {
    await handleMessageComplete(state, makeDeps(emitted), makeMessageCompleteEvent([]));

    const row = lastAssistantRow();
    expect(row.content).not.toBe("[]");
    const blocks = JSON.parse(row.content) as Array<{
      type: string;
      text?: string;
    }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("wasn't able to generate a response");
  });

  test("empty content array → fallback streamed as assistant_text_delta so the live UI shows it", async () => {
    await handleMessageComplete(state, makeDeps(emitted), makeMessageCompleteEvent([]));

    const deltas = emitted.filter((e) => e.type === "assistant_text_delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((d) => d.text ?? "").join("")).toContain(
      "wasn't able to generate a response",
    );
  });

  test("text content persists unchanged (guard does not fire)", async () => {
    await handleMessageComplete(
      state,
      makeDeps(emitted),
      makeMessageCompleteEvent([{ type: "text", text: "all good" }]),
    );

    const blocks = JSON.parse(lastAssistantRow().content) as Array<{
      type: string;
      text?: string;
    }>;
    expect(blocks).toEqual([{ type: "text", text: "all good" }]);
  });

  test("tool_use-only content persists unchanged (guard does not fire)", async () => {
    await handleMessageComplete(
      state,
      makeDeps(emitted),
      makeMessageCompleteEvent([
        { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
      ]),
    );

    const blocks = JSON.parse(lastAssistantRow().content) as Array<{
      type: string;
    }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("tool_use");
  });

  test("directive-only message (text fully stripped) → no fallback injected", async () => {
    // The attachment directive is stripped from the persisted text, but the
    // turn DID produce something — an attachment is added to the message
    // later. Injecting "no response" here would be wrong.
    await handleMessageComplete(
      state,
      makeDeps(emitted),
      makeMessageCompleteEvent([
        { type: "text", text: '<max-attachment path="/tmp/chart.png" />' },
      ]),
    );

    const row = lastAssistantRow();
    expect(row.content).not.toContain("wasn't able to generate a response");
  });

  test("ui_surface-only turn → no fallback injected", async () => {
    await handleMessageComplete(
      state,
      makeDeps(emitted, [
        {
          surfaceId: "s1",
          surfaceType: "card",
          title: "T",
          data: {},
          actions: [],
          display: "inline",
        },
      ]),
      makeMessageCompleteEvent([]),
    );

    const row = lastAssistantRow();
    expect(row.content).not.toContain("wasn't able to generate a response");
    expect(row.content).toContain("ui_surface");
  });
});
