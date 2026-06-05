import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Named provider connections.
 *
 * Each row is a named auth-config instance for a code-defined provider.
 * Profiles in config.json reference connections by `name` via the
 * `provider_connection` field.
 *
 * Created by migration 243.
 */
export const providerConnections = sqliteTable(
  "provider_connections",
  {
    name: text("name").primaryKey(),
    provider: text("provider").notNull(),
    auth: text("auth").notNull(),
    status: text("status").notNull().default("active"),
    label: text("label"),
    /**
     * Last-known reachability of the connection's underlying endpoint.
     * Updated on every tick of the Ollama discovery service (and similar
     * health probes for future providers). Nullable: a NULL value means
     * "we have not probed this connection yet" — distinct from `false`
     * which means "we probed and the endpoint did not respond".
     * Added by migration 247.
     */
    reachable: integer("reachable", { mode: "boolean" }),
    /**
     * ISO 8601 timestamp of the most recent reachability probe. Updated
     * on every probe regardless of the probe's outcome so clients can
     * surface "last checked 5 minutes ago" alongside the boolean status.
     * Added by migration 247.
     */
    lastSeenAt: text("last_seen_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_provider_connections_provider").on(table.provider),
  ],
);

export type ProviderConnectionRow = typeof providerConnections.$inferSelect;
export type NewProviderConnectionRow = typeof providerConnections.$inferInsert;
