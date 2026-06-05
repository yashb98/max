import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Create the `bridged_tool_call_events` table for per-tool-call telemetry
 * from the claude-subscription bridge.
 *
 * Schema mirrors the `bridgedToolCallEvents` Drizzle definition in
 * `memory/schema/infrastructure.ts`. Phase 3.1 in
 * `docs/architecture/claude-subscription-bridge.md`.
 *
 * Idempotent: uses `CREATE TABLE IF NOT EXISTS` so re-running on a
 * database that already has the table is a no-op.
 */
export function migrateBridgedToolCallEvents(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS bridged_tool_call_events (
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
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_bridged_tool_call_events_conversation_id
      ON bridged_tool_call_events (conversation_id)
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_bridged_tool_call_events_created_at
      ON bridged_tool_call_events (created_at)
  `);
}
