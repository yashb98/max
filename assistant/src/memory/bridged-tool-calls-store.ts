/**
 * Per-tool-call telemetry store for the claude-subscription bridge.
 *
 * Mirrors `lifecycle-events-store.ts`'s shape: write-once on every
 * bridge-flow tool execution, then `usage-telemetry-reporter` drains
 * batches to the platform via a watermark cursor. Phase 3.1 in
 * `docs/architecture/claude-subscription-bridge.md`.
 *
 * `recordBridgedToolCall` is a no-op when `collectUsageData` is
 * disabled (matches the rest of the telemetry stores).
 */
import { and, asc, eq, gt, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";

import { getConfig } from "../config/loader.js";
import { getDb } from "./db-connection.js";
import { bridgedToolCallEvents } from "./schema.js";

export interface BridgedToolCallRecord {
  toolName: string;
  conversationId: string | null;
  trustClass: string | null;
  provider: string;
  model: string | null;
  durationMs: number;
  isError: boolean;
  /** Short error kind for grouping (`"allowlist_denied"`, `"tool_failure"`, …). Null on success. */
  errorKind: string | null;
}

export interface BridgedToolCallEvent extends BridgedToolCallRecord {
  id: string;
  createdAt: number;
}

/**
 * Insert one bridged tool-call telemetry row. Returns `null` when usage
 * data collection is disabled in config — that branch must be cheap
 * (one config read, no allocation) because the bridge calls this on
 * every tool execution.
 */
export function recordBridgedToolCall(
  record: BridgedToolCallRecord,
): BridgedToolCallEvent | null {
  if (!getConfig().collectUsageData) return null;
  const db = getDb();
  const event: BridgedToolCallEvent = {
    id: uuid(),
    createdAt: Date.now(),
    ...record,
  };
  db.insert(bridgedToolCallEvents)
    .values({
      id: event.id,
      createdAt: event.createdAt,
      toolName: event.toolName,
      conversationId: event.conversationId,
      trustClass: event.trustClass,
      provider: event.provider,
      model: event.model,
      durationMs: event.durationMs,
      isError: event.isError,
      errorKind: event.errorKind,
    })
    .run();
  return event;
}

/**
 * Query bridged tool-call events that haven't been reported yet.
 * Compound cursor (`createdAt` + `id`) matches the watermark protocol
 * the other telemetry stores use — see `lifecycle-events-store.ts`.
 */
export function queryUnreportedBridgedToolCallEvents(
  afterCreatedAt: number,
  afterId: string | undefined,
  limit: number,
): BridgedToolCallEvent[] {
  const db = getDb();
  const rows = db
    .select({
      id: bridgedToolCallEvents.id,
      createdAt: bridgedToolCallEvents.createdAt,
      toolName: bridgedToolCallEvents.toolName,
      conversationId: bridgedToolCallEvents.conversationId,
      trustClass: bridgedToolCallEvents.trustClass,
      provider: bridgedToolCallEvents.provider,
      model: bridgedToolCallEvents.model,
      durationMs: bridgedToolCallEvents.durationMs,
      isError: bridgedToolCallEvents.isError,
      errorKind: bridgedToolCallEvents.errorKind,
    })
    .from(bridgedToolCallEvents)
    .where(
      afterId
        ? or(
            gt(bridgedToolCallEvents.createdAt, afterCreatedAt),
            and(
              eq(bridgedToolCallEvents.createdAt, afterCreatedAt),
              gt(bridgedToolCallEvents.id, afterId),
            ),
          )
        : gt(bridgedToolCallEvents.createdAt, afterCreatedAt),
    )
    .orderBy(
      asc(bridgedToolCallEvents.createdAt),
      asc(bridgedToolCallEvents.id),
    )
    .limit(limit)
    .all();
  return rows;
}
