import type { DiscoveredModel } from "./api-client.js";
import { toProfileDefaults } from "./capability-mapping.js";
import type { ProfileRecord } from "./reconcile.js";
import { modelKey } from "./slugify.js";

export type MigrationInputs = {
  profiles: ProfileRecord;
  profileOrder: string[];
  activeProfile: string;
  discoveredModels: DiscoveredModel[];
  ollamaConnectionName: string;
};

export type MigrationResult = {
  nextProfiles: ProfileRecord;
  nextProfileOrder: string[];
  nextActiveProfile: string;
  migratedKeys: Array<{ from: string[]; to: string }>;
};

const CARRY_OVER_FIELDS = [
  "effort",
  "maxTokens",
  "thinking",
  "contextWindow",
  "description",
] as const;

function isManualOllama(entry: Record<string, unknown>): boolean {
  return entry.provider === "ollama" && entry.source !== "auto-ollama";
}

export function migrateManualOllamaProfiles(
  input: MigrationInputs,
): MigrationResult {
  const next: ProfileRecord = { ...input.profiles };
  const orderIndex = new Map(input.profileOrder.map((k, i) => [k, i]));
  const migratedKeys: Array<{ from: string[]; to: string }> = [];

  for (const m of input.discoveredModels) {
    const autoKey = modelKey(m.tag);
    const matches = Object.entries(next)
      .filter(([, e]) => isManualOllama(e) && e.model === m.tag)
      .map(([k]) => k);

    if (matches.length === 0) {
      // No manual ancestor — defer to reconcile to add via defaults.
      continue;
    }

    matches.sort((a, b) => {
      const ai = orderIndex.get(a) ?? -1;
      const bi = orderIndex.get(b) ?? -1;
      if (ai !== bi) return ai - bi; // latest in profileOrder wins → sort then take last
      return a.localeCompare(b);
    });
    const winnerKey = matches[matches.length - 1];
    const winner = next[winnerKey];

    const carried: Record<string, unknown> = {};
    for (const f of CARRY_OVER_FIELDS) {
      if (f in winner) carried[f] = winner[f];
    }

    const defaults = toProfileDefaults(m, input.ollamaConnectionName);
    next[autoKey] = {
      ...defaults,
      ...carried,
    } as unknown as Record<string, unknown>;

    for (const k of matches) delete next[k];
    migratedKeys.push({ from: matches, to: autoKey });
  }

  // profileOrder: replace the first occurrence of any migrated manual key
  // with its auto-key; drop subsequent occurrences.
  const replacementMap = new Map<string, string>();
  for (const { from, to } of migratedKeys) {
    for (const k of from) replacementMap.set(k, to);
  }
  const nextOrder: string[] = [];
  const seen = new Set<string>();
  for (const k of input.profileOrder) {
    const target = replacementMap.get(k) ?? k;
    if (!next[target]) continue;
    if (seen.has(target)) continue;
    nextOrder.push(target);
    seen.add(target);
  }
  for (const k of Object.keys(next)) {
    if (!seen.has(k)) {
      nextOrder.push(k);
      seen.add(k);
    }
  }

  // activeProfile cascade: if active was migrated, point to its auto-key
  let nextActive = input.activeProfile;
  if (replacementMap.has(nextActive)) {
    nextActive = replacementMap.get(nextActive)!;
  } else if (!next[nextActive]) {
    nextActive =
      Object.keys(next).find((k) => k.startsWith("auto-ollama-")) ?? "balanced";
  }

  return {
    nextProfiles: next,
    nextProfileOrder: nextOrder,
    nextActiveProfile: nextActive,
    migratedKeys,
  };
}
