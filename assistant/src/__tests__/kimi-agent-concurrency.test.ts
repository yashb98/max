/**
 * Concurrency-cap (D-7) test for the `kimi-agent` provider. Lives in its own
 * file so the SDK mock can be designed specifically for observing that
 * sequential sendMessage calls properly release the semaphore.
 *
 * Verifies that 100 sequential calls leave the semaphore in its idle state
 * (no leaked permits, no queued waiters) and that a fresh call after the
 * batch still completes — proving the semaphore never drifts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// SDK mock — resolves immediately to a minimal happy stream.
// ---------------------------------------------------------------------------

const createSession = mock(() => ({
  prompt: mock(() => ({
    approve: mock(async () => {}),
    interrupt: mock(async () => {}),
    respondQuestion: mock(async () => {}),
    result: Promise.resolve({ status: "finished" as const }),
    async *[Symbol.asyncIterator]() {
      yield { type: "TurnEnd", payload: {} };
    },
  })),
  close: mock(async () => {}),
}));

mock.module("@moonshot-ai/kimi-agent-sdk", () => ({
  createSession,
  createExternalTool: (d: unknown) => d,
  login: mock(async () => ({ success: true })),
}));

// ---------------------------------------------------------------------------
// Import provider AFTER mock.
// ---------------------------------------------------------------------------

const {
  KimiAgentProvider,
  _getKimiAgentSemaphoreStateForTests,
  _resetKimiAgentSemaphoreForTests,
} = await import("../providers/kimi-agent/client.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

beforeEach(() => {
  createSession.mockClear();
  _resetKimiAgentSemaphoreForTests();
});

// ---------------------------------------------------------------------------
// Phase 3.3 — Semaphore lifecycle under sustained sequential load.
// ---------------------------------------------------------------------------

describe("Phase 3.3 — kimi-agent semaphore lifecycle under sustained sequential load", () => {
  test("100 sequential sendMessages leave the semaphore in an idle state", async () => {
    const p = new KimiAgentProvider("kimi-k2");

    for (let i = 0; i < 100; i++) {
      await p.sendMessage([userText(`call-${i}`)], [], undefined);
    }

    // The semaphore must return to fully idle: no leaked active slots, no
    // queued waiters. If the `finally` block in `sendMessage` ever fails
    // to release on any code path, this assertion catches it.
    const state = _getKimiAgentSemaphoreStateForTests();
    expect(state.activeCallCount).toBe(0);
    expect(state.queuedWaiterCount).toBe(0);

    // A fresh call after the load batch must still complete. If permits
    // had leaked, the semaphore pool would eventually be exhausted and
    // this call would block (the test timeout would surface that).
    await p.sendMessage([userText("after-load")], [], undefined);

    const finalState = _getKimiAgentSemaphoreStateForTests();
    expect(finalState.activeCallCount).toBe(0);
    expect(finalState.queuedWaiterCount).toBe(0);
  });
});
