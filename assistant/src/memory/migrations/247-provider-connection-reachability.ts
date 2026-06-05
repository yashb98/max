import { type DrizzleDb, getSqliteFrom } from "../db-connection.js";

/**
 * Adds `reachable` (nullable BOOLEAN stored as INTEGER) and `last_seen_at`
 * (nullable ISO 8601 TEXT) columns to the `provider_connections` table.
 *
 * Both columns surface live reachability for connections whose underlying
 * endpoint is probeable (e.g. Ollama HTTP), letting the macOS app render
 * an `(offline)` badge in the inference profile picker without requiring
 * every client to re-probe the endpoint itself.
 *
 * NULL semantics: a NULL `reachable` means "never probed" — distinct from
 * `0` (false, "probed and unreachable"). This distinction matters for the
 * picker: a freshly-seeded connection that has not yet been ticked should
 * NOT be flagged offline.
 *
 * Idempotent: reads PRAGMA table_info before each ALTER so re-running on
 * a database that already has the columns is a no-op.
 */
export function migrateProviderConnectionReachability(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);

  const columns = raw
    .query(`PRAGMA table_info(provider_connections)`)
    .all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("reachable")) {
    raw.exec(`ALTER TABLE provider_connections ADD COLUMN reachable INTEGER`);
  }

  if (!columnNames.has("last_seen_at")) {
    raw.exec(`ALTER TABLE provider_connections ADD COLUMN last_seen_at TEXT`);
  }
}
