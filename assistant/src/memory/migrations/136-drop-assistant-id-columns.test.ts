import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../db-connection.js";
import * as schema from "../schema.js";
import { migrateDropAssistantIdColumns } from "./136-drop-assistant-id-columns.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

/**
 * Bootstrap exactly the tables migration 136 recreates indexes on (lines
 * 232–301), each with the columns those indexes reference — EXCEPT
 * actor_token_records / actor_refresh_token_records.
 *
 * This reproduces a fresh install: migrations 038/039 (which would create the
 * actor-token tables) are not wired into db-init, so on a clean DB those two
 * tables never exist. Migration 136 then trips on its unconditional
 * `CREATE INDEX ... ON actor_token_records` at the very end.
 *
 * Each real table carries an `assistant_id` column so the drop path also runs.
 */
function bootstrapFreshInstall(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE channel_guardian_verification_challenges (
      id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL DEFAULT 'self',
      channel TEXT, challenge_hash TEXT, status TEXT,
      expected_external_user_id TEXT, expected_chat_id TEXT,
      destination_address TEXT, bootstrap_token_hash TEXT
    );
    CREATE TABLE channel_guardian_rate_limits (
      id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL DEFAULT 'self',
      channel TEXT, actor_external_user_id TEXT, actor_chat_id TEXT
    );
    CREATE TABLE assistant_ingress_invites (
      id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL DEFAULT 'self',
      source_channel TEXT, status TEXT, expires_at INTEGER, created_at INTEGER
    );
    CREATE TABLE assistant_inbox_thread_state (
      id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL DEFAULT 'self',
      source_channel TEXT, external_chat_id TEXT, last_message_at INTEGER,
      has_pending_escalation INTEGER
    );
    CREATE TABLE notification_preferences (
      id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL DEFAULT 'self',
      priority INTEGER
    );
    CREATE TABLE notification_events (
      id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL DEFAULT 'self',
      source_event_name TEXT, created_at INTEGER, dedupe_key TEXT
    );
    CREATE TABLE notification_deliveries (
      id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL DEFAULT 'self',
      status TEXT
    );
    CREATE TABLE conversation_attention_events (
      id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL DEFAULT 'self',
      observed_at INTEGER
    );
    CREATE TABLE conversation_assistant_attention_state (
      id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL DEFAULT 'self',
      latest_assistant_message_at INTEGER, last_seen_assistant_message_at INTEGER
    );

    -- Intentionally NOT created: actor_token_records, actor_refresh_token_records
  `);
}

describe("136 drop assistant_id columns", () => {
  test("completes on a fresh install where actor-token tables were never created", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapFreshInstall(raw);

    expect(() => migrateDropAssistantIdColumns(db)).not.toThrow();

    // Checkpoint must record success ('1'), not 'failed'.
    const cp = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'migration_drop_assistant_id_columns_v1'`,
      )
      .get() as { value: string } | null;
    expect(cp?.value).toBe("1");

    // The real work still happened: assistant_id dropped from a real table.
    const cols = (
      raw.query(`PRAGMA table_info(notification_events)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).not.toContain("assistant_id");
  });
});
