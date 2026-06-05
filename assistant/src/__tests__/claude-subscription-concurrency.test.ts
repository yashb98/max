/**
 * Concurrency-cap (D-7) test. Lives in its own file so the SDK mock can
 * be designed specifically for observing parallelism, without interacting
 * with the other provider tests.
 *
 * Verifies the semaphore in `claude-subscription/client.ts` never lets
 * more than MAX_CONCURRENT_CALLS query() invocations be mid-stream at
 * the same time.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// SDK mock that blocks each call on a manual gate so we can measure peak
// concurrency.
// ---------------------------------------------------------------------------

let inFlight = 0;
let peakInFlight = 0;
let releaseQueue: Array<() => void> = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    return (async function* () {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        yield {
          type: "system",
          subtype: "init",
          model: "claude-sonnet-4-5",
          session_id: "test",
        };
        // Block until the test releases this call.
        await new Promise<void>((resolve) => releaseQueue.push(resolve));
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "ok" }] },
        };
        yield {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      } finally {
        inFlight--;
      }
    })();
  },
}));

import {
  _getClaudeSubscriptionSemaphoreStateForTests,
  _resetClaudeSubscriptionSemaphoreForTests,
  ClaudeSubscriptionProvider,
} from "../providers/claude-subscription/client.js";

beforeEach(() => {
  inFlight = 0;
  peakInFlight = 0;
  releaseQueue = [];
  _resetClaudeSubscriptionSemaphoreForTests();
});

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

describe("D-7 concurrency cap", () => {
  test("peak parallelism is bounded by MAX_CONCURRENT_CALLS (4)", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");

    // Fire 10 calls concurrently. We don't await them yet.
    const promises = Array.from({ length: 10 }, () =>
      p.sendMessage([userText("hi")], [], "sys"),
    );

    // Let microtasks process so blocked calls can register on releaseQueue.
    // Drain in waves: release one call, wait, release the next, etc.
    // Cap is 4, so at any point only up to 4 are in flight; releasing one
    // should let the next queued call proceed.
    for (let i = 0; i < 10; i++) {
      // Wait until at least one call is waiting on releaseQueue.
      while (releaseQueue.length === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
      const release = releaseQueue.shift()!;
      release();
      // Let the released call settle and the next queued call (if any)
      // grab the semaphore slot.
      await new Promise<void>((r) => setImmediate(r));
    }

    await Promise.all(promises);

    expect(peakInFlight).toBeGreaterThan(0);
    expect(peakInFlight).toBeLessThanOrEqual(4);
  });

  test("sequential calls (one at a time) work normally", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    for (let i = 0; i < 3; i++) {
      const callPromise = p.sendMessage([userText("hi")], [], "sys");
      while (releaseQueue.length === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
      releaseQueue.shift()!();
      await callPromise;
    }
    expect(peakInFlight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.3 — Subprocess / semaphore lifecycle under sustained load.
//
// The Agent SDK spawns a `claude` subprocess per `sendMessage` call. The
// provider's only durable state across calls is the concurrency
// semaphore (`activeCallCount` + `semaphoreWaitQueue` in `client.ts`).
// If any code path forgot to release the semaphore on a happy or error
// exit, sustained sequential load would eventually deadlock at
// `MAX_CONCURRENT_CALLS + 1` calls.
//
// Mocking strategy: the per-call MCP server, AbortController, and SDK
// stream are all per-call ephemeral — they're GC-eligible once
// `sendMessage` returns. There's no further hermetic assertion we can
// make about subprocess file-descriptor leaks (those live in the real
// SDK, not our code). What we CAN assert is:
//   1. N back-to-back calls all complete cleanly (no hang, no throw).
//   2. The semaphore returns to its initial idle state with no leaked
//      active count and no queued waiters.
//   3. A fresh call after the load batch still completes (proves the
//      semaphore can still admit a new call — caught any "permit leak"
//      that would otherwise reduce capacity over time).
// ---------------------------------------------------------------------------

describe("Phase 3.3 — semaphore lifecycle under sustained sequential load", () => {
  test("100 sequential sendMessages leave the semaphore in an idle state", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");

    for (let i = 0; i < 100; i++) {
      const callPromise = p.sendMessage([userText(`call-${i}`)], [], "sys");
      // Each scripted SDK call pushes one releaser; drain it so the
      // call can complete cleanly. Wait for it to actually appear.
      while (releaseQueue.length === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
      releaseQueue.shift()!();
      await callPromise;
    }

    // Semaphore returned to fully idle: no permits leaked, no waiters
    // queued. If the `finally` block in `sendMessage` ever forgets to
    // release on a code path, this assertion catches it.
    const state = _getClaudeSubscriptionSemaphoreStateForTests();
    expect(state.activeCallCount).toBe(0);
    expect(state.queuedWaiterCount).toBe(0);

    // Fresh call after the load batch still completes within the
    // semaphore. If permits had leaked, this would block once the
    // pool ran dry. The bounded test timeout would surface that.
    const finalCall = p.sendMessage([userText("after-load")], [], "sys");
    while (releaseQueue.length === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    releaseQueue.shift()!();
    await finalCall;

    // Final state still idle.
    const finalState = _getClaudeSubscriptionSemaphoreStateForTests();
    expect(finalState.activeCallCount).toBe(0);
    expect(finalState.queuedWaiterCount).toBe(0);
  });
});
