import type { DiscoveredModel } from "./api-client.js";
import { toProfileDefaults } from "./capability-mapping.js";
import { ensureUniqueSlug, modelKey } from "./slugify.js";

const MISSING_TICKS_BEFORE_REMOVE = 2;

export type ProfileRecord = Record<string, Record<string, unknown>>;

export type ReconcileInputs = {
  profiles: ProfileRecord;
  profileOrder: string[];
  activeProfile: string;
  discoveredModels: DiscoveredModel[];
  ollamaConnectionName: string;
  missingSinceCounter: Record<string, number>;
};

export type ReconcileResult = {
  nextProfiles: ProfileRecord;
  nextProfileOrder: string[];
  nextActiveProfile: string;
  nextMissingSinceCounter: Record<string, number>;
  changed: boolean;
  events: ReconcileEvent[];
};

export type ReconcileEvent =
  | { kind: "add"; key: string; model: string }
  | { kind: "remove"; key: string; model: string }
  | { kind: "active-profile-cascade"; from: string; to: string };

function isAutoProfile(entry: Record<string, unknown>): boolean {
  return entry.source === "auto-ollama";
}

export function reconcile(input: ReconcileInputs): ReconcileResult {
  const events: ReconcileEvent[] = [];
  const next: ProfileRecord = { ...input.profiles };
  const discoveredByKey = new Map<string, DiscoveredModel>();
  const taken = new Set(Object.keys(next));

  // Build a map: tag → existing auto-profile key so we can re-use it (idempotence).
  const existingAutoByTag = new Map<string, string>();
  for (const [k, entry] of Object.entries(next)) {
    if (isAutoProfile(entry) && typeof entry.model === "string") {
      // First occurrence wins; collisions on the same tag are pathological.
      if (!existingAutoByTag.has(entry.model)) {
        existingAutoByTag.set(entry.model, k);
      }
    }
  }

  for (const m of input.discoveredModels) {
    const existingKey = existingAutoByTag.get(m.tag);
    if (existingKey !== undefined) {
      discoveredByKey.set(existingKey, m);
      continue;
    }
    const base = modelKey(m.tag);
    const key = ensureUniqueSlug(base, taken);
    taken.add(key);
    discoveredByKey.set(key, m);
  }

  // Add new
  for (const [key, model] of discoveredByKey) {
    if (next[key]) continue;
    next[key] = toProfileDefaults(
      model,
      input.ollamaConnectionName,
    ) as unknown as Record<string, unknown>;
    events.push({ kind: "add", key, model: model.tag });
  }

  // Track missing + remove after threshold
  const nextCounter: Record<string, number> = {};
  const discoveredKeys = new Set(discoveredByKey.keys());
  for (const [key, entry] of Object.entries(next)) {
    if (!isAutoProfile(entry)) continue;
    if (discoveredKeys.has(key)) {
      continue;
    }
    const prior = input.missingSinceCounter[key] ?? 0;
    if (prior + 1 >= MISSING_TICKS_BEFORE_REMOVE) {
      delete next[key];
      events.push({ kind: "remove", key, model: String(entry.model) });
    } else {
      nextCounter[key] = prior + 1;
    }
  }

  // profileOrder maintenance: keep order, append new auto keys, strip removed
  const nextOrder: string[] = [];
  const seen = new Set<string>();
  for (const k of input.profileOrder) {
    if (next[k] && !seen.has(k)) {
      nextOrder.push(k);
      seen.add(k);
    }
  }
  for (const k of Object.keys(next)) {
    if (!seen.has(k)) {
      nextOrder.push(k);
      seen.add(k);
    }
  }

  // activeProfile cascade only if reconcile itself removed the active profile.
  // If the active profile was already missing from `input.profiles` (e.g. the
  // configured default "balanced" hasn't been materialized into the profiles
  // map yet), do nothing — that's not our concern.
  let nextActive = input.activeProfile;
  const activeWasPresent = nextActive in input.profiles;
  if (activeWasPresent && !next[nextActive]) {
    const fallback =
      Object.keys(next).find((k) => k.startsWith("auto-ollama-")) ?? "balanced";
    if (fallback !== nextActive) {
      events.push({
        kind: "active-profile-cascade",
        from: nextActive,
        to: fallback,
      });
      nextActive = fallback;
    }
  }

  const changed = events.length > 0;

  return {
    nextProfiles: next,
    nextProfileOrder: nextOrder,
    nextActiveProfile: nextActive,
    nextMissingSinceCounter: nextCounter,
    changed,
    events,
  };
}
