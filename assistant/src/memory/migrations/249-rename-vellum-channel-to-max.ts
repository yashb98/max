import type { Database } from "bun:sqlite";

import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";
import { withCrashRecovery } from "./validate-migration-state.js";

/**
 * Column names (snake_case) that persist a ChannelId text value somewhere in the
 * daemon schema. The rename only rewrites cells whose value equals the migrated
 * channel id (see the WHERE clause in renameStoredChannel), so it is safe to
 * scan every table that happens to expose one of these column names — rows that
 * hold an unrelated value are never touched.
 *
 * Discovered dynamically rather than via a hard-coded table list because several
 * channel-bearing tables have been renamed since the comparable voice→phone
 * migration (e.g. assistant_inbox_thread_state → assistant_inbox_conversation_state
 * in migration 165); a static list would silently miss or crash on them.
 */
const CHANNEL_COLUMNS = new Set<string>([
  "channel",
  "source_channel",
  "destination_channel",
  "origin_channel",
  "origin_interface",
  "answered_by_channel",
  "last_seen_source_channel",
  "request_channel",
  "decision_channel",
  "execution_channel",
  "user_message_channel",
  "assistant_message_channel",
]);

function userTables(raw: Database): string[] {
  return (
    raw
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function tableColumns(raw: Database, table: string): string[] {
  // `table` originates from sqlite_master (not user input); escape quotes defensively.
  return (
    raw
      .query(`SELECT name FROM pragma_table_info('${table.replace(/'/g, "''")}')`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/**
 * Rewrite a stored ChannelId value across every channel-bearing column, plus the
 * channel/interface ids embedded in the messages.metadata JSON blob.
 *
 * Uses `UPDATE OR IGNORE` so a row that would collide on a UNIQUE index (e.g.
 * channel_guardian_rate_limits' (channel, actor_*) index) is skipped instead of
 * raising — withCrashRecovery marks a throwing migration permanently "failed"
 * and never retries it, so this must not throw on data it can't migrate.
 */
function renameStoredChannel(raw: Database, from: string, to: string): void {
  const tables = userTables(raw);
  for (const table of tables) {
    for (const column of tableColumns(raw, table)) {
      if (!CHANNEL_COLUMNS.has(column)) continue;
      raw
        .query(
          `UPDATE OR IGNORE "${table}" SET "${column}" = ? WHERE "${column}" = ?`,
        )
        .run(to, from);
    }
  }

  // messages.metadata stores channel/interface ids inside a JSON blob (e.g.
  // userMessageChannel, provenanceSourceChannel). messageMetadataSchema parses
  // these with z.enum(CHANNEL_IDS), so a stale value would fail validation of
  // historical rows. Rewrite the quoted JSON token in place, matching the
  // approach taken by the voice→phone migration (144).
  if (
    tables.includes("messages") &&
    tableColumns(raw, "messages").includes("metadata")
  ) {
    raw
      .query(
        `UPDATE messages SET metadata = REPLACE(metadata, ?, ?) WHERE metadata LIKE ?`,
      )
      .run(`"${from}"`, `"${to}"`, `%"${from}"%`);
  }
}

/**
 * One-shot migration: rename the desktop channel id stored as "vellum" to "max"
 * across all tables that persist channel identifiers as text.
 *
 * Aligns persisted data with the CHANNEL_IDS rename ("vellum" → "max"). Migration
 * 020 set the desktop channel to "vellum" for users upgrading from the legacy
 * macos/ios identifiers; this migration carries those rows (and anything written
 * under the "vellum" id since) forward to "max" so guardian routing and channel
 * classification keep matching the current code, which compares against "max".
 */
export function migrateRenameVellumChannelToMax(database: DrizzleDb): void {
  withCrashRecovery(
    database,
    "migration_rename_vellum_channel_to_max_v1",
    () => {
      renameStoredChannel(getSqliteFrom(database), "vellum", "max");
    },
  );
}

/**
 * Reverse the rename: change "max" channel values back to "vellum" across all
 * channel-bearing columns. Idempotent — safe to re-run.
 *
 * Note: the messages.metadata reversal rewrites the quoted token `"max"`, which
 * is a more common string than `"vellum"`; this down path is intended only for
 * explicit rollback, mirroring the blunt token replacement used by migration 144.
 */
export function downRenameVellumChannelToMax(database: DrizzleDb): void {
  renameStoredChannel(getSqliteFrom(database), "max", "vellum");
}
