import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../db-connection.js";
import * as schema from "../schema.js";
import {
  downRenameVellumChannelToMax,
  migrateRenameVellumChannelToMax,
} from "./249-rename-vellum-channel-to-max.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/**
 * Bootstrap a representative slice of channel-bearing tables, a table whose
 * `type` column is NOT a channel id (to prove the scan is column-name scoped),
 * and memory_checkpoints (required by withCrashRecovery).
 */
function bootstrapTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      origin_channel TEXT,
      origin_interface TEXT
    );

    CREATE TABLE channel_guardian_bindings (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      user_message_channel TEXT,
      metadata TEXT
    );

    -- 'type' is intentionally NOT in the channel-column allowlist; its 'vellum'
    -- value must survive untouched.
    CREATE TABLE contact_channels (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL
    );

    -- selected_channels stores a JSON ARRAY of channel ids, so the desktop id
    -- appears as a quoted token inside the blob rather than the whole cell value.
    CREATE TABLE notification_decisions (
      id TEXT PRIMARY KEY,
      selected_channels TEXT NOT NULL DEFAULT '[]'
    );
  `);

  raw.exec(/*sql*/ `
    INSERT INTO conversations (id, origin_channel, origin_interface) VALUES
      ('c1', 'vellum', 'vellum'),
      ('c2', 'telegram', 'telegram');
    INSERT INTO channel_guardian_bindings (id, channel) VALUES
      ('b1', 'vellum'),
      ('b2', 'phone');
    INSERT INTO messages (id, user_message_channel, metadata) VALUES
      ('m1', 'vellum', '{"userMessageChannel":"vellum","note":"keep"}'),
      ('m2', 'telegram', '{"userMessageChannel":"telegram"}');
    INSERT INTO contact_channels (id, type) VALUES ('cc1', 'vellum');
    INSERT INTO notification_decisions (id, selected_channels) VALUES
      ('n1', '["vellum"]'),
      ('n2', '["telegram","vellum"]'),
      ('n3', '["telegram"]');
  `);
}

describe("249 rename vellum channel to max", () => {
  test("rewrites vellum channel ids to max across all channel columns", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapTables(raw);

    migrateRenameVellumChannelToMax(db);

    const conv = raw
      .query(`SELECT origin_channel, origin_interface FROM conversations WHERE id = 'c1'`)
      .get() as { origin_channel: string; origin_interface: string };
    expect(conv.origin_channel).toBe("max");
    expect(conv.origin_interface).toBe("max");

    const binding = raw
      .query(`SELECT channel FROM channel_guardian_bindings WHERE id = 'b1'`)
      .get() as { channel: string };
    expect(binding.channel).toBe("max");

    const msg = raw
      .query(`SELECT user_message_channel, metadata FROM messages WHERE id = 'm1'`)
      .get() as { user_message_channel: string; metadata: string };
    expect(msg.user_message_channel).toBe("max");
    expect(msg.metadata).toBe('{"userMessageChannel":"max","note":"keep"}');
  });

  test("rewrites the vellum token inside the selected_channels JSON array", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapTables(raw);

    migrateRenameVellumChannelToMax(db);

    const only = raw
      .query(`SELECT selected_channels FROM notification_decisions WHERE id = 'n1'`)
      .get() as { selected_channels: string };
    expect(only.selected_channels).toBe('["max"]');

    const mixed = raw
      .query(`SELECT selected_channels FROM notification_decisions WHERE id = 'n2'`)
      .get() as { selected_channels: string };
    expect(mixed.selected_channels).toBe('["telegram","max"]');

    // No desktop channel present → array must be left exactly as-is.
    const none = raw
      .query(`SELECT selected_channels FROM notification_decisions WHERE id = 'n3'`)
      .get() as { selected_channels: string };
    expect(none.selected_channels).toBe('["telegram"]');
  });

  test("leaves non-vellum channel values and non-channel columns untouched", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapTables(raw);

    migrateRenameVellumChannelToMax(db);

    const otherConv = raw
      .query(`SELECT origin_channel FROM conversations WHERE id = 'c2'`)
      .get() as { origin_channel: string };
    expect(otherConv.origin_channel).toBe("telegram");

    // 'type' is not a channel column — its 'vellum' value must be preserved.
    const cc = raw
      .query(`SELECT type FROM contact_channels WHERE id = 'cc1'`)
      .get() as { type: string };
    expect(cc.type).toBe("vellum");
  });

  test("is idempotent via checkpoint — re-running is a no-op", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapTables(raw);

    migrateRenameVellumChannelToMax(db);
    // A row that became "max" should not be mistaken for legacy data on re-run.
    migrateRenameVellumChannelToMax(db);

    const binding = raw
      .query(`SELECT channel FROM channel_guardian_bindings WHERE id = 'b1'`)
      .get() as { channel: string };
    expect(binding.channel).toBe("max");
  });

  test("down reverses max back to vellum", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapTables(raw);

    migrateRenameVellumChannelToMax(db);
    downRenameVellumChannelToMax(db);

    const binding = raw
      .query(`SELECT channel FROM channel_guardian_bindings WHERE id = 'b1'`)
      .get() as { channel: string };
    expect(binding.channel).toBe("vellum");
  });
});
