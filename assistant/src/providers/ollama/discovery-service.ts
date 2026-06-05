import { copyFileSync } from "node:fs";

import { withConfigWriteLock } from "../../config/config-mutex.js";
import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import type { DrizzleDb } from "../../memory/db-connection.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceConfigPath } from "../../util/platform.js";
import {
  getConnection,
  listConnections,
  setConnectionReachability,
} from "../inference/connections.js";
import { extendProviderModels } from "../model-catalog.js";
import {
  describeAllModels,
  listOllamaModels,
} from "./api-client.js";
import { toCatalogModel } from "./capability-mapping.js";
import { migrateManualOllamaProfiles } from "./migration.js";
import { reconcile } from "./reconcile.js";

const log = getLogger("ollama-discovery");

/**
 * How often the service polls the Ollama endpoint. Sixty seconds matches
 * the spec — fast enough that a freshly-pulled tag shows up while the user
 * is still in the picker, slow enough that a paused-but-running Ollama
 * doesn't drown the daemon log.
 */
const TICK_INTERVAL_MS = 60_000;

/**
 * Fallback when no `baseUrl` is recoverable from the connection row. The
 * `provider_connections` table does not currently store a per-connection
 * base URL, so every Ollama connection uses the default loopback endpoint.
 * (Spec notes this gap; future schema change can plumb a custom URL through
 * the connection row's `auth` payload or a new metadata column.)
 */
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export type DiscoveryServiceHandle = {
  stop: () => void;
};

type Counters = Record<string, number>;

/**
 * Picked-up Ollama connection: the name (used for profile linkage and the
 * reachability stamp) plus the base URL to probe. `baseUrl` is always set
 * after `pickOllamaConnection`; the optional shape is just to allow future
 * connection rows that omit it.
 */
type OllamaConnectionPick = {
  name: string;
  baseUrl: string;
};

/**
 * Start the Ollama discovery service. Returns a handle whose `stop()` method
 * halts the tick timer and prevents any in-flight tick from doing further
 * work. The first tick is fired immediately so a fresh daemon boot doesn't
 * wait a full minute before discovering models.
 *
 * Never throws — discovery failures are caught at the tick boundary and
 * logged, never propagated, so a flaky Ollama endpoint can't take the
 * daemon down. This matches the CLAUDE.md daemon-startup philosophy.
 */
export function startOllamaDiscovery(db: DrizzleDb): DiscoveryServiceHandle {
  const counters: Counters = {};
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runOneTick(db, counters);
    } catch (err) {
      log.error({ err }, "ollama-discovery tick failed");
    }
  };

  // Kick off the first tick immediately so freshly-pulled models surface
  // without waiting a full interval. Fire-and-forget — `tick` itself
  // catches everything.
  void tick();
  timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

async function runOneTick(db: DrizzleDb, counters: Counters): Promise<void> {
  const config = loadRawConfig();
  const llm = readObject(config.llm) ?? {};

  // Feature flag — `autoOllamaDiscovery` defaults true at the schema level
  // but config.json may be pre-feature, so an explicit `false` is the only
  // value that disables the loop. Absent / undefined keeps it enabled.
  if (llm.autoOllamaDiscovery === false) {
    return;
  }

  const ollamaConn = pickOllamaConnection(db, llm);
  if (!ollamaConn) {
    log.debug("no ollama connection configured; skipping tick");
    return;
  }

  const tagsResult = await listOllamaModels(ollamaConn.baseUrl);
  const now = new Date().toISOString();

  // Stamp reachability regardless of outcome — the macOS app surfaces the
  // boolean in the picker, and the timestamp lets it render "last checked".
  if (!tagsResult.ok) {
    setConnectionReachability(db, ollamaConn.name, false, now);
    log.debug(
      { connection: ollamaConn.name, error: tagsResult.error },
      "ollama-discovery tick: endpoint unreachable",
    );
    return;
  }

  const allDiscovered = await describeAllModels(
    ollamaConn.baseUrl,
    tagsResult.value,
  );
  // Skip embedding-only models (e.g. bge-m3) — they can't chat, surfacing
  // them as picker entries would be a UX wart. They stay in Ollama and
  // can still be used by the embeddings pipeline directly.
  const discovered = allDiscovered.filter((m) =>
    m.capabilities.includes("completion"),
  );
  setConnectionReachability(db, ollamaConn.name, true, now);

  // Extend the runtime catalog BEFORE any profile write so downstream
  // consumers that consult `isModelInCatalog` during reconcile see the
  // discovered tags as first-class catalog entries.
  extendProviderModels(
    "ollama",
    discovered.map(toCatalogModel),
  );

  await withConfigWriteLock(async () => {
    // Re-read inside the lock — another writer may have moved on between
    // the outer `loadRawConfig()` and now (PATCH /v1/config, seeder, etc.).
    // Working from a fresh snapshot inside the critical section is the only
    // way to make the reconcile output coherent.
    const fresh = loadRawConfig();
    const freshLlm = readObject(fresh.llm) ?? {};

    const profiles = readObject(freshLlm.profiles) as
      | Record<string, Record<string, unknown>>
      | undefined;
    const profileOrder = Array.isArray(freshLlm.profileOrder)
      ? (freshLlm.profileOrder as string[])
      : [];
    const activeProfile =
      typeof freshLlm.activeProfile === "string" && freshLlm.activeProfile
        ? freshLlm.activeProfile
        : "balanced";

    let nextProfiles = profiles ?? {};
    let nextOrder = profileOrder;
    let nextActive = activeProfile;

    // Phase 1: one-shot manual-Ollama → auto-Ollama migration. Gated by
    // `autoOllamaMigratedAt` so a user who deliberately deletes auto
    // profiles after the first migration doesn't have them resurrected.
    const migratedAt =
      typeof freshLlm.autoOllamaMigratedAt === "string"
        ? freshLlm.autoOllamaMigratedAt
        : undefined;
    let migrationRan = false;
    if (!migratedAt && discovered.length > 0) {
      try {
        backupPreMigration();
      } catch (err) {
        // Refusing to migrate without a backup is the safer call —
        // the next tick will retry once the backup destination is
        // writable.
        log.warn(
          { err },
          "ollama-discovery: aborting migration — could not write backup",
        );
        return;
      }
      const m = migrateManualOllamaProfiles({
        profiles: nextProfiles,
        profileOrder: nextOrder,
        activeProfile: nextActive,
        discoveredModels: discovered,
        ollamaConnectionName: ollamaConn.name,
      });
      log.info(
        { migratedKeys: m.migratedKeys },
        "ollama-discovery: one-shot migration complete",
      );
      nextProfiles = m.nextProfiles;
      nextOrder = m.nextProfileOrder;
      nextActive = m.nextActiveProfile;
      freshLlm.autoOllamaMigratedAt = new Date().toISOString();
      migrationRan = true;
    }

    // Phase 2: steady-state reconcile against the discovered set.
    const r = reconcile({
      profiles: nextProfiles,
      profileOrder: nextOrder,
      activeProfile: nextActive,
      discoveredModels: discovered,
      ollamaConnectionName: ollamaConn.name,
      missingSinceCounter: counters,
    });

    // Persist the missing-since counters on the in-place map so they carry
    // into the next tick without leaking entries for keys that have come
    // back online.
    for (const k of Object.keys(counters)) delete counters[k];
    Object.assign(counters, r.nextMissingSinceCounter);

    // Skip the disk write only when reconcile produced no changes AND the
    // one-shot migration didn't fire this tick. Otherwise we must persist
    // — even a no-op reconcile after migration changed `migratedAt`.
    if (!r.changed && !migrationRan) {
      return;
    }

    freshLlm.profiles = r.nextProfiles;
    freshLlm.profileOrder = r.nextProfileOrder;
    freshLlm.activeProfile = r.nextActiveProfile;
    fresh.llm = freshLlm;
    // We already hold withConfigWriteLock here — pass withinLock so the
    // inner saveRawConfig doesn't try to re-enter the same mutex.
    await saveRawConfig(fresh, { withinLock: true });
    log.info(
      { events: r.events, migrationRan },
      "ollama-discovery: reconciled and saved",
    );
  });
}

/**
 * Choose which Ollama connection this tick should probe.
 *
 * Preference order:
 *   1. The connection named by `llm.default.provider_connection` (if it
 *      exists and its provider is "ollama").
 *   2. The lexicographically-first connection with `provider: "ollama"`.
 *
 * Returns `null` if no Ollama connection exists at all — the picker has
 * nothing meaningful to surface and the service falls silent until the
 * user creates one.
 *
 * NOTE: the connection row has no `baseUrl` / `metadata` column today —
 * every Ollama connection currently probes the default loopback endpoint.
 * If multi-host Ollama setups land later, plumb a URL through the row's
 * `auth` payload and read it here.
 */
function pickOllamaConnection(
  db: DrizzleDb,
  llm: Record<string, unknown>,
): OllamaConnectionPick | null {
  const defaultBlock = readObject(llm.default);
  const defaultConnName =
    defaultBlock != null && typeof defaultBlock.provider_connection === "string"
      ? defaultBlock.provider_connection
      : undefined;
  if (defaultConnName) {
    const c = getConnection(db, defaultConnName);
    if (c && c.provider === "ollama") {
      return { name: c.name, baseUrl: DEFAULT_OLLAMA_BASE_URL };
    }
  }

  const all = listConnections(db)
    .filter((c) => c.provider === "ollama")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (all.length === 0) return null;

  const first = all[0];
  // Narrow for the type checker; .length > 0 guarantees this is defined.
  if (!first) return null;
  return { name: first.name, baseUrl: DEFAULT_OLLAMA_BASE_URL };
}

/**
 * Write a sibling backup of `config.json` immediately before the one-shot
 * migration is allowed to mutate the file. Names the backup with a per-call
 * timestamp so successive migration attempts (e.g. failed → retried) do
 * not clobber each other's history.
 *
 * Throws on backup failure — `runOneTick` translates that into an aborted
 * migration so the next tick can retry against a writable disk.
 */
function backupPreMigration(): void {
  const path = getWorkspaceConfigPath();
  const bak = `${path}.bak-pre-auto-ollama-${Date.now()}`;
  copyFileSync(path, bak);
  log.info({ bak }, "ollama-discovery: wrote pre-migration backup");
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
