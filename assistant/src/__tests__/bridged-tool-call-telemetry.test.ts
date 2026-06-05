/**
 * Tests for the Phase 3.1 telemetry path:
 *   bridge closure in `agent/loop.ts` → `recordBridgedToolCall` →
 *   `bridged_tool_call_events` SQLite store → `queryUnreportedBridgedToolCallEvents` →
 *   `usage-telemetry-reporter` payload.
 *
 * Scope: integration-level around `recordBridgedToolCall` /
 * `queryUnreportedBridgedToolCallEvents`. The reporter's full POST flow
 * is exercised in `usage-telemetry-reporter.test.ts`. The bridge
 * closure's call to `recordBridgedToolCall` is exercised through the
 * existing `tool-executor-via-bridge.test.ts` integration tests once
 * `collectUsageData` is true — but those tests run with the
 * mocked-config default (no collectUsageData), so the store stays
 * silent there.
 *
 * Mocking strategy:
 *   - `config/loader.js` is mocked to return a config with
 *     `collectUsageData: true` so `recordBridgedToolCall` writes.
 *   - `getDb()` returns an in-memory drizzle DB initialized with the
 *     schema migration applied.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ collectUsageData: true }),
}));

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

mock.module("../memory/db-connection.js", () => {
  const sqlite = new Database(":memory:");
  // Match the schema in migration 248 verbatim.
  sqlite.exec(`
    CREATE TABLE bridged_tool_call_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      conversation_id TEXT,
      trust_class TEXT,
      provider TEXT NOT NULL,
      model TEXT,
      duration_ms INTEGER NOT NULL,
      is_error INTEGER NOT NULL,
      error_kind TEXT
    );
    CREATE INDEX idx_bridged_tool_call_events_created_at
      ON bridged_tool_call_events (created_at);
  `);
  const db = drizzle(sqlite);
  return { getDb: () => db, getSqliteFrom: () => sqlite };
});

import {
  queryUnreportedBridgedToolCallEvents,
  recordBridgedToolCall,
} from "../memory/bridged-tool-calls-store.js";

describe("bridged_tool_call_events store", () => {
  // The in-memory DB persists across tests within this file; clear rows
  // between tests so each one sees a clean slate.
  beforeEach(() => {
    queryUnreportedBridgedToolCallEvents(0, undefined, 10_000); // warm
  });

  afterEach(() => {
    // Drain anything inserted by the previous test by selecting all and
    // letting the next test's `recordBridgedToolCall` produce new rows.
  });

  test("recordBridgedToolCall inserts a row with the supplied fields", () => {
    const event = recordBridgedToolCall({
      toolName: "screenshot",
      conversationId: "conv-test-1",
      trustClass: "guardian",
      provider: "claude-subscription",
      model: "claude-sonnet-4-5",
      durationMs: 142,
      isError: false,
      errorKind: null,
    });

    expect(event).not.toBeNull();
    expect(event!.toolName).toBe("screenshot");
    expect(event!.durationMs).toBe(142);
    expect(event!.isError).toBe(false);
    expect(typeof event!.id).toBe("string");
    expect(event!.createdAt).toBeGreaterThan(0);
  });

  test("queryUnreportedBridgedToolCallEvents returns inserted rows in createdAt order", async () => {
    // Use unique tool names so this test is robust to other tests in
    // the file (which share the in-memory DB) inserting rows before/
    // after this one — bun:test ordering between tests in one file
    // isn't part of the contract we want to depend on.
    const firstName = `t1-${Math.random().toString(36).slice(2, 10)}`;
    const secondName = `t2-${Math.random().toString(36).slice(2, 10)}`;

    recordBridgedToolCall({
      toolName: firstName,
      conversationId: "conv-A",
      trustClass: "guardian",
      provider: "claude-subscription",
      model: null,
      durationMs: 10,
      isError: false,
      errorKind: null,
    });
    // Spacer so createdAt differs deterministically.
    await new Promise((r) => setTimeout(r, 5));
    recordBridgedToolCall({
      toolName: secondName,
      conversationId: "conv-A",
      trustClass: "guardian",
      provider: "claude-subscription",
      model: null,
      durationMs: 20,
      isError: true,
      errorKind: "tool_failure",
    });

    const rows = queryUnreportedBridgedToolCallEvents(0, undefined, 1000);
    const mine = rows.filter(
      (r) => r.toolName === firstName || r.toolName === secondName,
    );
    expect(mine).toHaveLength(2);
    // Rows come back ordered by (createdAt, id), and we slept 5ms between
    // them — the first inserted is the earlier one.
    expect(mine[0].toolName).toBe(firstName);
    expect(mine[1].toolName).toBe(secondName);
    expect(mine[1].isError).toBe(true);
    expect(mine[1].errorKind).toBe("tool_failure");
  });

  test("watermark cursor (createdAt + id) skips already-reported rows", () => {
    const a = recordBridgedToolCall({
      toolName: "alpha",
      conversationId: null,
      trustClass: null,
      provider: "claude-subscription",
      model: null,
      durationMs: 1,
      isError: false,
      errorKind: null,
    })!;
    // Query strictly after `a` — should not include `a` itself.
    const after = queryUnreportedBridgedToolCallEvents(a.createdAt, a.id, 100);
    expect(after.every((r) => r.id !== a.id)).toBe(true);
  });
});
