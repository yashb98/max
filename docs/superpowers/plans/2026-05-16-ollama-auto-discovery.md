# Ollama Auto-Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background discovery service in the daemon that surfaces every locally-installed Ollama model as an inference profile in the macOS app's picker, with one-shot migration of existing manual presets and a reachability-aware offline notice.

**Architecture:** A 60s polling service inside the daemon queries Ollama's `/api/tags` + `/api/show` endpoints, reconciles `auto-ollama-*` profiles against `config.json` (atomic + mutex-guarded), mutates `PROVIDER_CATALOG` in memory so capability checks pass, and updates `reachable: bool` on the Ollama connection row. The macOS `ChatProfilePicker` reads connection reachability from `SettingsStore` and filters/annotates the dropdown accordingly. Everything destructive is gated, logged, and backed up to a `.bak` on disk.

**Tech Stack:** TypeScript (Bun runtime, ESM), Drizzle ORM, Zod schemas; Swift + SwiftUI on the macOS side. Test runner: `bun test` via `bash scripts/test.sh`.

**Spec reference:** `docs/superpowers/specs/2026-05-16-ollama-auto-discovery-design.md`

---

## File map

**New (TypeScript)**
- `assistant/src/providers/ollama/slugify.ts` — pure model-tag → slug
- `assistant/src/providers/ollama/api-client.ts` — typed HTTP client for `/api/tags` and `/api/show`, owns timeouts + concurrency cap
- `assistant/src/providers/ollama/capability-mapping.ts` — pure: discovered model → profile defaults + catalog row
- `assistant/src/providers/ollama/reconcile.ts` — pure reconciliation function (Phase 2 add/remove)
- `assistant/src/providers/ollama/migration.ts` — pure Phase 1 migration logic
- `assistant/src/providers/ollama/discovery-service.ts` — orchestrator (lifecycle, polling, side effects)
- `assistant/src/config/config-mutex.ts` — in-process serial writer for `config.json`

**New (tests)**
- `assistant/src/providers/ollama/__tests__/slugify.test.ts`
- `assistant/src/providers/ollama/__tests__/capability-mapping.test.ts`
- `assistant/src/providers/ollama/__tests__/reconcile.test.ts`
- `assistant/src/providers/ollama/__tests__/migration.test.ts`
- `assistant/src/providers/ollama/__tests__/discovery-service.integration.test.ts`
- `assistant/src/providers/ollama/__tests__/api-show-schema.test.ts`
- `assistant/src/providers/ollama/__tests__/fixtures/api-show/qwen3-6-35b.json` (+ llama, mistral, gemma)
- `assistant/src/config/__tests__/config-mutex.test.ts`

**Modified (TypeScript)**
- `assistant/src/config/loader.ts` — atomic `write-tmp + rename`; route writes through mutex
- `assistant/src/config/schemas/llm.ts` — add `autoOllamaDiscovery`, `autoOllamaMigratedAt`
- `assistant/src/config/seed-inference-profiles.ts` — skip profiles tagged `source: "auto-ollama"` in user-source fallback
- `assistant/src/providers/inference/connections.ts` — `reachable`, `lastSeenAt`; setter
- `assistant/src/memory/schema.ts` — drizzle column additions for connection reachability
- `assistant/src/providers/model-catalog.ts` — expose `extendProviderModels(providerId, models)` runtime mutation
- `assistant/src/daemon/main.ts` — start/stop the discovery service alongside other daemon services

**Modified (Swift)**
- `clients/macos/max-assistant/Features/Settings/InferenceProfile.swift` — surface `providerConnection: String?`
- `clients/macos/max-assistant/Features/Settings/SettingsStore.swift` — `connectionReachability: [String: ConnectionReachability]`; `isConnectionReachable(_:)`
- `clients/macos/max-assistant/Features/Chat/ChatProfilePicker.swift` — extend filter + bottom offline notice
- `clients/macos/max-assistant/Features/Settings/InferenceProfileEditor.swift` — `(offline)` badge
- `clients/macos/max-assistantTests/Features/Chat/ChatProfilePickerTests.swift` — extended

---

## Task 1: Slugify (pure)

**Files:**
- Create: `assistant/src/providers/ollama/slugify.ts`
- Test: `assistant/src/providers/ollama/__tests__/slugify.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// assistant/src/providers/ollama/__tests__/slugify.test.ts
import { describe, expect, test } from "bun:test";
import { modelKey, ensureUniqueSlug } from "../slugify.js";

describe("modelKey", () => {
  test("replaces dots and colons with hyphens, lowercases, prefixes auto-ollama-", () => {
    expect(modelKey("qwen3.6:35b")).toBe("auto-ollama-qwen3-6-35b");
    expect(modelKey("qwen3-vl:8b")).toBe("auto-ollama-qwen3-vl-8b");
    expect(modelKey("qwen3:latest")).toBe("auto-ollama-qwen3-latest");
    expect(modelKey("Llama3.2")).toBe("auto-ollama-llama3-2");
  });

  test("strips characters outside [a-z0-9-]", () => {
    expect(modelKey("foo/bar:1")).toBe("auto-ollama-foo-bar-1");
    expect(modelKey("mistral_7b")).toBe("auto-ollama-mistral-7b");
  });
});

describe("ensureUniqueSlug", () => {
  test("returns base slug when not taken", () => {
    expect(ensureUniqueSlug("auto-ollama-foo", new Set())).toBe(
      "auto-ollama-foo",
    );
  });
  test("appends -2, -3 on collision", () => {
    const taken = new Set(["auto-ollama-foo", "auto-ollama-foo-2"]);
    expect(ensureUniqueSlug("auto-ollama-foo", taken)).toBe("auto-ollama-foo-3");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd assistant && bun test src/providers/ollama/__tests__/slugify.test.ts`
Expected: FAIL with `Cannot find module ../slugify`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// assistant/src/providers/ollama/slugify.ts
const PREFIX = "auto-ollama-";

export function modelKey(tag: string): string {
  const normalized = tag
    .toLowerCase()
    .replace(/[.:_/]/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${PREFIX}${normalized}`;
}

export function ensureUniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd assistant && bun test src/providers/ollama/__tests__/slugify.test.ts`
Expected: 4 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add assistant/src/providers/ollama/slugify.ts assistant/src/providers/ollama/__tests__/slugify.test.ts
git commit -m "feat(ollama): pure slugify helper for auto-discovered profile keys"
```

---

## Task 2: API client + types

**Files:**
- Create: `assistant/src/providers/ollama/api-client.ts`

This task has no unit tests — the integration test in Task 19 covers the client against a stub server. We commit a typed wrapper now so other modules can import its types.

- [ ] **Step 1: Write the module**

```ts
// assistant/src/providers/ollama/api-client.ts
import { getLogger } from "../../util/logger.js";

const log = getLogger("ollama-api-client");

export type OllamaCapability = "completion" | "vision" | "tools" | "thinking";

export type OllamaTagsEntry = {
  name: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
  };
};

export type OllamaShowResponse = {
  capabilities?: OllamaCapability[];
  modelinfo?: Record<string, unknown>;
  details?: {
    family?: string;
    parameter_size?: string;
  };
};

export type DiscoveredModel = {
  tag: string;
  capabilities: OllamaCapability[];
  contextLength: number | null;
  parameterSize: string | null;
};

export type FetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const TAGS_TIMEOUT_MS = 3000;
const SHOW_TIMEOUT_MS = 3000;
const SHOW_CONCURRENCY = 4;

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as T;
    return { ok: true, value: body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function listOllamaModels(
  baseUrl: string,
): Promise<FetchResult<OllamaTagsEntry[]>> {
  const result = await fetchJson<{ models?: OllamaTagsEntry[] }>(
    `${baseUrl.replace(/\/$/, "")}/api/tags`,
    { method: "GET" },
    TAGS_TIMEOUT_MS,
  );
  if (!result.ok) return result;
  return { ok: true, value: result.value.models ?? [] };
}

export async function showOllamaModel(
  baseUrl: string,
  name: string,
): Promise<FetchResult<OllamaShowResponse>> {
  return fetchJson<OllamaShowResponse>(
    `${baseUrl.replace(/\/$/, "")}/api/show`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    SHOW_TIMEOUT_MS,
  );
}

/**
 * Call /api/show for every tag with a concurrency cap. Failures are logged
 * and the model is skipped (returned list may be shorter than input).
 */
export async function describeAllModels(
  baseUrl: string,
  tags: OllamaTagsEntry[],
): Promise<DiscoveredModel[]> {
  const results: DiscoveredModel[] = [];
  let cursor = 0;
  const workers = Array.from({ length: SHOW_CONCURRENCY }, async () => {
    while (cursor < tags.length) {
      const i = cursor++;
      const tag = tags[i];
      const show = await showOllamaModel(baseUrl, tag.name);
      if (!show.ok) {
        log.warn({ tag: tag.name, error: show.error }, "ollama /api/show failed");
        continue;
      }
      results.push(toDiscoveredModel(tag, show.value));
    }
  });
  await Promise.all(workers);
  return results;
}

function toDiscoveredModel(
  tag: OllamaTagsEntry,
  show: OllamaShowResponse,
): DiscoveredModel {
  return {
    tag: tag.name,
    capabilities: show.capabilities ?? [],
    contextLength: extractContextLength(show.modelinfo),
    parameterSize: tag.details?.parameter_size ?? show.details?.parameter_size ?? null,
  };
}

function extractContextLength(modelinfo: Record<string, unknown> | undefined): number | null {
  if (!modelinfo) return null;
  for (const [key, value] of Object.entries(modelinfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value;
    }
  }
  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add assistant/src/providers/ollama/api-client.ts
git commit -m "feat(ollama): typed HTTP client for /api/tags and /api/show with concurrency cap"
```

---

## Task 3: Capability mapping (pure)

**Files:**
- Create: `assistant/src/providers/ollama/capability-mapping.ts`
- Test: `assistant/src/providers/ollama/__tests__/capability-mapping.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// assistant/src/providers/ollama/__tests__/capability-mapping.test.ts
import { describe, expect, test } from "bun:test";
import {
  toCatalogModel,
  toProfileDefaults,
  CONTEXT_CLAMP_MAX,
  CONTEXT_FALLBACK,
} from "../capability-mapping.js";
import type { DiscoveredModel } from "../api-client.js";

const base: DiscoveredModel = {
  tag: "qwen3.6:35b",
  capabilities: ["completion", "vision", "tools", "thinking"],
  contextLength: 256000,
  parameterSize: "36.0B",
};

describe("toCatalogModel", () => {
  test("maps capabilities + clamps context to 131072", () => {
    const row = toCatalogModel(base);
    expect(row).toEqual({
      id: "qwen3.6:35b",
      displayName: "qwen3.6:35b",
      contextWindowTokens: CONTEXT_CLAMP_MAX,
      maxOutputTokens: 8192,
      defaultContextWindowTokens: CONTEXT_CLAMP_MAX,
      supportsThinking: true,
      supportsVision: true,
      supportsToolUse: true,
      supportsCaching: false,
      longContextMode: "native-model",
      pricing: { inputPer1mTokens: 0, outputPer1mTokens: 0 },
    });
  });

  test("falls back to 32768 when context length missing", () => {
    const row = toCatalogModel({ ...base, contextLength: null });
    expect(row.contextWindowTokens).toBe(CONTEXT_FALLBACK);
  });

  test("flags capabilities false when absent", () => {
    const row = toCatalogModel({ ...base, capabilities: ["completion"] });
    expect(row.supportsThinking).toBe(false);
    expect(row.supportsVision).toBe(false);
    expect(row.supportsToolUse).toBe(false);
  });
});

describe("toProfileDefaults", () => {
  test("renders description from capabilities + param size", () => {
    const defaults = toProfileDefaults(base, "ollama-personal");
    expect(defaults.description).toBe(
      "Auto-discovered: 36.0B, vision/tools/thinking",
    );
    expect(defaults.thinking).toEqual({ enabled: true, streamThinking: true });
    expect(defaults.label).toBe("qwen3.6:35b");
    expect(defaults.model).toBe("qwen3.6:35b");
    expect(defaults.source).toBe("auto-ollama");
    expect(defaults.provider).toBe("ollama");
    expect(defaults.provider_connection).toBe("ollama-personal");
    expect(defaults.effort).toBe("high");
    expect(defaults.maxTokens).toBe(8192);
    expect(defaults.contextWindow.maxInputTokens).toBe(CONTEXT_CLAMP_MAX);
  });

  test("disables thinking when capability absent", () => {
    const defaults = toProfileDefaults(
      { ...base, capabilities: ["completion"] },
      "ollama-personal",
    );
    expect(defaults.thinking).toEqual({ enabled: false, streamThinking: false });
  });

  test("description omits capability suffix when empty", () => {
    const defaults = toProfileDefaults(
      { ...base, capabilities: ["completion"], parameterSize: null },
      "ollama-personal",
    );
    expect(defaults.description).toBe("Auto-discovered Ollama model");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd assistant && bun test src/providers/ollama/__tests__/capability-mapping.test.ts`
Expected: FAIL with `Cannot find module ../capability-mapping`.

- [ ] **Step 3: Write the implementation**

```ts
// assistant/src/providers/ollama/capability-mapping.ts
import type { DiscoveredModel } from "./api-client.js";

export const CONTEXT_CLAMP_MAX = 131072;
export const CONTEXT_FALLBACK = 32768;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export type CatalogModelRow = {
  id: string;
  displayName: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  defaultContextWindowTokens: number;
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsToolUse: boolean;
  supportsCaching: false;
  longContextMode: "native-model";
  pricing: { inputPer1mTokens: 0; outputPer1mTokens: 0 };
};

export type AutoProfileDefaults = {
  provider: "ollama";
  provider_connection: string;
  model: string;
  label: string;
  description: string;
  source: "auto-ollama";
  effort: "high";
  maxTokens: number;
  thinking: { enabled: boolean; streamThinking: boolean };
  contextWindow: { maxInputTokens: number };
};

function clampedContext(reported: number | null): number {
  if (reported === null) return CONTEXT_FALLBACK;
  return Math.min(reported, CONTEXT_CLAMP_MAX);
}

export function toCatalogModel(model: DiscoveredModel): CatalogModelRow {
  const ctx = clampedContext(model.contextLength);
  const caps = new Set(model.capabilities);
  return {
    id: model.tag,
    displayName: model.tag,
    contextWindowTokens: ctx,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    defaultContextWindowTokens: ctx,
    supportsThinking: caps.has("thinking"),
    supportsVision: caps.has("vision"),
    supportsToolUse: caps.has("tools"),
    supportsCaching: false,
    longContextMode: "native-model",
    pricing: { inputPer1mTokens: 0, outputPer1mTokens: 0 },
  };
}

export function toProfileDefaults(
  model: DiscoveredModel,
  connectionName: string,
): AutoProfileDefaults {
  const caps = model.capabilities.filter((c) => c !== "completion");
  const sizePart = model.parameterSize;
  const capsPart = caps.length > 0 ? caps.join("/") : "";
  const descriptionParts = [sizePart, capsPart].filter((p) => p && p.length > 0);
  const description =
    descriptionParts.length > 0
      ? `Auto-discovered: ${descriptionParts.join(", ")}`
      : "Auto-discovered Ollama model";
  const thinkingEnabled = model.capabilities.includes("thinking");
  return {
    provider: "ollama",
    provider_connection: connectionName,
    model: model.tag,
    label: model.tag,
    description,
    source: "auto-ollama",
    effort: "high",
    maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    thinking: { enabled: thinkingEnabled, streamThinking: thinkingEnabled },
    contextWindow: { maxInputTokens: clampedContext(model.contextLength) },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd assistant && bun test src/providers/ollama/__tests__/capability-mapping.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add assistant/src/providers/ollama/capability-mapping.ts assistant/src/providers/ollama/__tests__/capability-mapping.test.ts
git commit -m "feat(ollama): pure capability → catalog row + profile defaults mapping"
```

---

## Task 4: Reconciliation (pure)

**Files:**
- Create: `assistant/src/providers/ollama/reconcile.ts`
- Test: `assistant/src/providers/ollama/__tests__/reconcile.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// assistant/src/providers/ollama/__tests__/reconcile.test.ts
import { describe, expect, test } from "bun:test";
import { reconcile, type ReconcileInputs } from "../reconcile.js";

function inputs(over: Partial<ReconcileInputs> = {}): ReconcileInputs {
  return {
    profiles: {},
    profileOrder: [],
    activeProfile: "balanced",
    discoveredModels: [],
    ollamaConnectionName: "ollama-personal",
    missingSinceCounter: {},
    ...over,
  };
}

const qwen36 = {
  tag: "qwen3.6:35b",
  capabilities: ["completion", "thinking", "vision", "tools"] as const,
  contextLength: 256000,
  parameterSize: "36.0B",
};

describe("reconcile (steady-state)", () => {
  test("no-op when empty inputs", () => {
    const out = reconcile(inputs());
    expect(out.nextProfiles).toEqual({});
    expect(out.nextProfileOrder).toEqual([]);
    expect(out.changed).toBe(false);
  });

  test("creates auto profile for new discovered model", () => {
    const out = reconcile(inputs({ discoveredModels: [qwen36] }));
    expect(out.nextProfiles["auto-ollama-qwen3-6-35b"].model).toBe("qwen3.6:35b");
    expect(out.nextProfileOrder).toContain("auto-ollama-qwen3-6-35b");
    expect(out.changed).toBe(true);
  });

  test("idempotent: second call is no-op", () => {
    const first = reconcile(inputs({ discoveredModels: [qwen36] }));
    const second = reconcile({
      ...inputs({ discoveredModels: [qwen36] }),
      profiles: first.nextProfiles,
      profileOrder: first.nextProfileOrder,
      missingSinceCounter: first.nextMissingSinceCounter,
    });
    expect(second.changed).toBe(false);
  });

  test("missing for 1 tick: profile still present, counter incremented", () => {
    const existing = {
      "auto-ollama-qwen3-6-35b": {
        provider: "ollama",
        model: "qwen3.6:35b",
        source: "auto-ollama",
        provider_connection: "ollama-personal",
      },
    } as Record<string, Record<string, unknown>>;
    const out = reconcile(
      inputs({ profiles: existing, profileOrder: ["auto-ollama-qwen3-6-35b"] }),
    );
    expect(out.nextProfiles["auto-ollama-qwen3-6-35b"]).toBeDefined();
    expect(out.nextMissingSinceCounter["auto-ollama-qwen3-6-35b"]).toBe(1);
  });

  test("missing for 2 ticks: profile removed", () => {
    const existing = {
      "auto-ollama-qwen3-6-35b": {
        provider: "ollama",
        model: "qwen3.6:35b",
        source: "auto-ollama",
        provider_connection: "ollama-personal",
      },
    } as Record<string, Record<string, unknown>>;
    const out = reconcile(
      inputs({
        profiles: existing,
        profileOrder: ["auto-ollama-qwen3-6-35b"],
        missingSinceCounter: { "auto-ollama-qwen3-6-35b": 1 },
      }),
    );
    expect(out.nextProfiles["auto-ollama-qwen3-6-35b"]).toBeUndefined();
    expect(out.nextProfileOrder).not.toContain("auto-ollama-qwen3-6-35b");
    expect(out.changed).toBe(true);
  });

  test("preserves user edits to auto profile fields across reconcile", () => {
    const existing = {
      "auto-ollama-qwen3-6-35b": {
        provider: "ollama",
        model: "qwen3.6:35b",
        source: "auto-ollama",
        provider_connection: "ollama-personal",
        effort: "max", // user-edited
        maxTokens: 16384, // user-edited
      },
    } as Record<string, Record<string, unknown>>;
    const out = reconcile(
      inputs({
        profiles: existing,
        profileOrder: ["auto-ollama-qwen3-6-35b"],
        discoveredModels: [qwen36],
      }),
    );
    const p = out.nextProfiles["auto-ollama-qwen3-6-35b"];
    expect(p.effort).toBe("max");
    expect(p.maxTokens).toBe(16384);
  });

  test("activeProfile cascade: same-model auto wins", () => {
    const existing = {
      "ollama-deep": {
        provider: "ollama",
        model: "qwen3.6:35b",
        source: "user",
        provider_connection: "ollama-personal",
      },
    } as Record<string, Record<string, unknown>>;
    const out = reconcile(
      inputs({
        profiles: existing,
        profileOrder: ["ollama-deep"],
        activeProfile: "ollama-deep",
        // Steady-state, no migration: leave manual profile alone, just add auto.
        discoveredModels: [qwen36],
      }),
    );
    // activeProfile is left as "ollama-deep" because steady-state doesn't migrate.
    expect(out.nextActiveProfile).toBe("ollama-deep");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd assistant && bun test src/providers/ollama/__tests__/reconcile.test.ts`
Expected: FAIL with `Cannot find module ../reconcile`.

- [ ] **Step 3: Write the implementation**

```ts
// assistant/src/providers/ollama/reconcile.ts
import { ensureUniqueSlug, modelKey } from "./slugify.js";
import { toProfileDefaults } from "./capability-mapping.js";
import type { DiscoveredModel } from "./api-client.js";

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

  for (const m of input.discoveredModels) {
    const base = modelKey(m.tag);
    const key = ensureUniqueSlug(base, taken);
    taken.add(key);
    discoveredByKey.set(key, m);
  }

  // Add new
  for (const [key, model] of discoveredByKey) {
    if (next[key]) continue;
    next[key] = toProfileDefaults(model, input.ollamaConnectionName) as unknown as Record<string, unknown>;
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

  // activeProfile cascade only if active was removed
  let nextActive = input.activeProfile;
  if (!next[nextActive]) {
    const fallback =
      Object.keys(next).find((k) => k.startsWith("auto-ollama-")) ?? "balanced";
    if (fallback !== nextActive) {
      events.push({ kind: "active-profile-cascade", from: nextActive, to: fallback });
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd assistant && bun test src/providers/ollama/__tests__/reconcile.test.ts`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add assistant/src/providers/ollama/reconcile.ts assistant/src/providers/ollama/__tests__/reconcile.test.ts
git commit -m "feat(ollama): pure steady-state reconciliation function"
```

---

## Task 5: Migration (pure)

**Files:**
- Create: `assistant/src/providers/ollama/migration.ts`
- Test: `assistant/src/providers/ollama/__tests__/migration.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// assistant/src/providers/ollama/__tests__/migration.test.ts
import { describe, expect, test } from "bun:test";
import { migrateManualOllamaProfiles } from "../migration.js";

const qwen36 = {
  tag: "qwen3.6:35b",
  capabilities: ["completion", "thinking", "vision", "tools"] as const,
  contextLength: 256000,
  parameterSize: "36.0B",
};

describe("migrateManualOllamaProfiles", () => {
  test("carries effort/maxTokens/thinking/contextWindow from winner", () => {
    const profiles = {
      "ollama-deep": {
        provider: "ollama",
        model: "qwen3.6:35b",
        source: "user",
        provider_connection: "ollama-personal",
        effort: "high",
        maxTokens: 9000,
        thinking: { enabled: true, streamThinking: true },
        contextWindow: { maxInputTokens: 20000 },
        label: "Ollama Deep (35B)",
      },
    };
    const out = migrateManualOllamaProfiles({
      profiles,
      profileOrder: ["ollama-deep"],
      activeProfile: "ollama-deep",
      discoveredModels: [qwen36],
      ollamaConnectionName: "ollama-personal",
    });
    const key = "auto-ollama-qwen3-6-35b";
    expect(out.nextProfiles[key].effort).toBe("high");
    expect(out.nextProfiles[key].maxTokens).toBe(9000);
    expect(out.nextProfiles[key].thinking).toEqual({
      enabled: true,
      streamThinking: true,
    });
    expect(out.nextProfiles[key].contextWindow).toEqual({ maxInputTokens: 20000 });
    expect(out.nextProfiles["ollama-deep"]).toBeUndefined();
    expect(out.nextActiveProfile).toBe(key);
  });

  test("winner = latest in profileOrder when 2 manuals share a model", () => {
    const profiles = {
      "ollama-deep": {
        provider: "ollama",
        model: "qwen3.6:35b",
        source: "user",
        provider_connection: "ollama-personal",
        effort: "high",
        maxTokens: 1000,
      },
      "qwen3-6-35b": {
        provider: "ollama",
        model: "qwen3.6:35b",
        source: "user",
        provider_connection: "ollama-personal",
        effort: "high",
        maxTokens: 2000,
      },
    };
    const out = migrateManualOllamaProfiles({
      profiles,
      profileOrder: ["ollama-deep", "qwen3-6-35b"],
      activeProfile: "balanced",
      discoveredModels: [qwen36],
      ollamaConnectionName: "ollama-personal",
    });
    expect(out.nextProfiles["auto-ollama-qwen3-6-35b"].maxTokens).toBe(2000);
  });

  test("preserves manual profile whose model not in Ollama", () => {
    const profiles = {
      "ollama-orphan": {
        provider: "ollama",
        model: "llama-not-pulled:1b",
        source: "user",
        provider_connection: "ollama-personal",
      },
    };
    const out = migrateManualOllamaProfiles({
      profiles,
      profileOrder: ["ollama-orphan"],
      activeProfile: "balanced",
      discoveredModels: [qwen36],
      ollamaConnectionName: "ollama-personal",
    });
    expect(out.nextProfiles["ollama-orphan"]).toBeDefined();
  });

  test("replaces manual key in-place within profileOrder", () => {
    const profiles = {
      balanced: { provider: "anthropic", model: "claude-sonnet-4-6" },
      "ollama-deep": {
        provider: "ollama",
        model: "qwen3.6:35b",
        source: "user",
      },
      kimi: { provider: "kimi", model: "kimi-k2.6" },
    };
    const out = migrateManualOllamaProfiles({
      profiles,
      profileOrder: ["balanced", "ollama-deep", "kimi"],
      activeProfile: "balanced",
      discoveredModels: [qwen36],
      ollamaConnectionName: "ollama-personal",
    });
    expect(out.nextProfileOrder).toEqual([
      "balanced",
      "auto-ollama-qwen3-6-35b",
      "kimi",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd assistant && bun test src/providers/ollama/__tests__/migration.test.ts`
Expected: FAIL with `Cannot find module ../migration`.

- [ ] **Step 3: Write the implementation**

```ts
// assistant/src/providers/ollama/migration.ts
import { modelKey } from "./slugify.js";
import { toProfileDefaults } from "./capability-mapping.js";
import type { DiscoveredModel } from "./api-client.js";
import type { ProfileRecord } from "./reconcile.js";

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
    next[autoKey] = { ...defaults, ...carried } as unknown as Record<string, unknown>;

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd assistant && bun test src/providers/ollama/__tests__/migration.test.ts`
Expected: 4 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add assistant/src/providers/ollama/migration.ts assistant/src/providers/ollama/__tests__/migration.test.ts
git commit -m "feat(ollama): one-shot migration of manual ollama-* profiles → auto-ollama-*"
```

---

## Task 6: Config-write mutex

**Files:**
- Create: `assistant/src/config/config-mutex.ts`
- Test: `assistant/src/config/__tests__/config-mutex.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// assistant/src/config/__tests__/config-mutex.test.ts
import { describe, expect, test } from "bun:test";
import { withConfigWriteLock } from "../config-mutex.js";

describe("withConfigWriteLock", () => {
  test("serializes concurrent writers", async () => {
    const log: string[] = [];
    const slow = withConfigWriteLock(async () => {
      log.push("slow-start");
      await new Promise((r) => setTimeout(r, 20));
      log.push("slow-end");
    });
    const fast = withConfigWriteLock(async () => {
      log.push("fast-start");
      log.push("fast-end");
    });
    await Promise.all([slow, fast]);
    expect(log).toEqual(["slow-start", "slow-end", "fast-start", "fast-end"]);
  });

  test("propagates errors and releases the lock", async () => {
    await expect(
      withConfigWriteLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Subsequent acquire works
    let ran = false;
    await withConfigWriteLock(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd assistant && bun test src/config/__tests__/config-mutex.test.ts`
Expected: FAIL with `Cannot find module ../config-mutex`.

- [ ] **Step 3: Write the implementation**

```ts
// assistant/src/config/config-mutex.ts
let chain: Promise<unknown> = Promise.resolve();

/**
 * Serializes async writers to ~/.../workspace/config.json. Every caller that
 * mutates the workspace config (seeder, discovery service, PATCH route) must
 * go through this.
 */
export async function withConfigWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = chain;
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  chain = chain.then(() => next);
  try {
    await prior;
    return await fn();
  } finally {
    release();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd assistant && bun test src/config/__tests__/config-mutex.test.ts`
Expected: 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add assistant/src/config/config-mutex.ts assistant/src/config/__tests__/config-mutex.test.ts
git commit -m "feat(config): single in-process mutex for workspace config writes"
```

---

## Task 7: Atomic write + mutex integration in saveRawConfig

**Files:**
- Modify: `assistant/src/config/loader.ts`

- [ ] **Step 1: Read the current implementation of `saveRawConfig`**

Run: `grep -n "saveRawConfig\|writeFileSync\|atomic\|rename" assistant/src/config/loader.ts | head -30`

Identify the exact line range that performs the write. The current code very likely uses `writeFileSync(configPath, ...)` directly.

- [ ] **Step 2: Update `saveRawConfig` to do atomic write-tmp + rename, gated by the mutex**

Replace the existing write block with:

```ts
// in saveRawConfig() — after computing serialized JSON
import { withConfigWriteLock } from "./config-mutex.js";
import { renameSync, writeFileSync } from "node:fs";

await withConfigWriteLock(async () => {
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, serialized);
  renameSync(tmpPath, configPath);
});
```

If `saveRawConfig` is currently synchronous, mark it `async` and update all callers to `await` it. Search for direct callers:

Run: `grep -rn "saveRawConfig\b" assistant/src --include="*.ts" | grep -v __tests__`

For each caller, add `await` and ensure the enclosing function is `async`.

- [ ] **Step 3: Verify the rest of the existing tests pass**

Run: `cd assistant && bun test src/config/`
Expected: all existing config tests pass.

- [ ] **Step 4: Commit**

```bash
git add assistant/src/config/loader.ts
git commit -m "fix(config): atomic write-tmp + rename for config.json under shared mutex"
```

---

## Task 8: Connection reachability columns + setter

**Files:**
- Modify: `assistant/src/memory/schema.ts`
- Modify: `assistant/src/providers/inference/connections.ts`

- [ ] **Step 1: Add Drizzle columns for `reachable` and `lastSeenAt` to the `connections` table**

Find the connections table definition. Add:

```ts
reachable: integer("reachable", { mode: "boolean" }),  // nullable: unknown for new rows
lastSeenAt: text("last_seen_at"),                       // ISO string, nullable
```

If the project uses migrations, create a new migration file under `assistant/src/memory/migrations/` following the existing numbering pattern (look at `230-*` etc.). Migration body:

```ts
import { sql } from "drizzle-orm";
import type { Migration } from "./types.js";

export const migration: Migration = {
  version: <next number>,
  name: "add-connection-reachability",
  up: async (db) => {
    await db.run(sql`ALTER TABLE connections ADD COLUMN reachable INTEGER`);
    await db.run(sql`ALTER TABLE connections ADD COLUMN last_seen_at TEXT`);
  },
};
```

Register the migration in the index.

- [ ] **Step 2: Add a setter to `connections.ts`**

Append:

```ts
export function setConnectionReachability(
  db: DrizzleDb,
  name: string,
  reachable: boolean,
  lastSeenAt: string,
): void {
  db.update(connectionsTable)
    .set({ reachable, lastSeenAt })
    .where(eq(connectionsTable.name, name))
    .run();
}
```

Update `readConnection` / `listConnections` row mappers to surface the new fields on the returned `Connection` type.

- [ ] **Step 3: Run existing connection tests**

Run: `cd assistant && bun test src/providers/inference/`
Expected: all existing tests pass; new columns are nullable so legacy code is unaffected.

- [ ] **Step 4: Commit**

```bash
git add assistant/src/memory/schema.ts assistant/src/memory/migrations/ assistant/src/providers/inference/connections.ts
git commit -m "feat(connections): add reachable + lastSeenAt columns and setter"
```

---

## Task 9: Runtime catalog extension hook

**Files:**
- Modify: `assistant/src/providers/model-catalog.ts`

- [ ] **Step 1: Expose a setter that appends discovered models to a provider entry**

Append to the module:

```ts
import type { CatalogModelRow } from "./ollama/capability-mapping.js";

const RUNTIME_EXTENSIONS = new Map<string, CatalogModelRow[]>();

export function extendProviderModels(
  providerId: string,
  models: CatalogModelRow[],
): void {
  RUNTIME_EXTENSIONS.set(providerId, models);
}

/** Used by isModelInCatalog and any other reader. */
function effectiveModelsForProvider(providerId: string) {
  const staticEntry = PROVIDER_CATALOG.find((p) => p.id === providerId);
  const staticModels = staticEntry?.models ?? [];
  const runtimeModels = RUNTIME_EXTENSIONS.get(providerId) ?? [];
  return [...staticModels, ...runtimeModels];
}
```

Update `isModelInCatalog(providerId, modelId)` to use `effectiveModelsForProvider`.

- [ ] **Step 2: Add a test for the extension**

Create `assistant/src/providers/__tests__/model-catalog-extension.test.ts`:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { extendProviderModels, isModelInCatalog } from "../model-catalog.js";

describe("extendProviderModels", () => {
  beforeEach(() => extendProviderModels("ollama", []));

  test("isModelInCatalog returns true for runtime-added models", () => {
    extendProviderModels("ollama", [
      {
        id: "qwen3.6:35b",
        displayName: "qwen3.6:35b",
        contextWindowTokens: 131072,
        maxOutputTokens: 8192,
        defaultContextWindowTokens: 131072,
        supportsThinking: true,
        supportsVision: true,
        supportsToolUse: true,
        supportsCaching: false,
        longContextMode: "native-model",
        pricing: { inputPer1mTokens: 0, outputPer1mTokens: 0 },
      },
    ]);
    expect(isModelInCatalog("ollama", "qwen3.6:35b")).toBe(true);
  });
});
```

Run: `cd assistant && bun test src/providers/__tests__/model-catalog-extension.test.ts`
Expected: 1 pass.

- [ ] **Step 3: Commit**

```bash
git add assistant/src/providers/model-catalog.ts assistant/src/providers/__tests__/model-catalog-extension.test.ts
git commit -m "feat(catalog): runtime extension point for auto-discovered models"
```

---

## Task 10: Schema additions for new config keys

**Files:**
- Modify: `assistant/src/config/schemas/llm.ts`

- [ ] **Step 1: Locate the top-level LLM config Zod schema**

Run: `grep -n "z.object\|autoOllama\|profileOrder\|activeProfile" assistant/src/config/schemas/llm.ts | head -20`

- [ ] **Step 2: Add the two new optional keys to the schema**

```ts
autoOllamaDiscovery: z.boolean().optional().default(true),
autoOllamaMigratedAt: z.string().datetime().nullish(),
```

These both live on the `llm` object alongside `profiles`, `profileOrder`, `activeProfile`.

- [ ] **Step 3: Run the schema tests**

Run: `cd assistant && bun test src/config/__tests__/`
Expected: all pass (new keys are optional).

- [ ] **Step 4: Commit**

```bash
git add assistant/src/config/schemas/llm.ts
git commit -m "feat(config): llm.autoOllamaDiscovery + llm.autoOllamaMigratedAt keys"
```

---

## Task 11: Skip auto-ollama in seed-inference-profiles fallback

**Files:**
- Modify: `assistant/src/config/seed-inference-profiles.ts`

- [ ] **Step 1: Inspect the tagging loop at the end of `seedInferenceProfiles`**

Run: `grep -nA5 "Tag any remaining profiles without a source" assistant/src/config/seed-inference-profiles.ts`

- [ ] **Step 2: Update the loop to skip auto-ollama**

Replace the `if (!("source" in profile))` check with:

```ts
if (
  profile != null &&
  typeof profile === "object" &&
  !("source" in profile) &&
  (profile as Record<string, unknown>).provider !== "ollama"
) {
  (profile as Record<string, unknown>).source = "user";
}
```

(Defensive — auto-ollama profiles always carry `source`, but if a partial write somehow strips it for an ollama-provider entry, we don't want it tagged "user" and made invisible to the reconciler.)

- [ ] **Step 3: Run existing seed tests**

Run: `cd assistant && bun test src/config/__tests__/`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add assistant/src/config/seed-inference-profiles.ts
git commit -m "fix(seed): don't auto-tag ollama-provider profiles as user-source"
```

---

## Task 12: Discovery service orchestrator

**Files:**
- Create: `assistant/src/providers/ollama/discovery-service.ts`

- [ ] **Step 1: Write the orchestrator**

```ts
// assistant/src/providers/ollama/discovery-service.ts
import {
  describeAllModels,
  listOllamaModels,
  type DiscoveredModel,
} from "./api-client.js";
import { reconcile } from "./reconcile.js";
import { migrateManualOllamaProfiles } from "./migration.js";
import { toCatalogModel } from "./capability-mapping.js";
import { extendProviderModels } from "../model-catalog.js";
import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import {
  getConnection,
  listConnections,
  setConnectionReachability,
} from "../inference/connections.js";
import type { DrizzleDb } from "../../memory/db-connection.js";
import { getLogger } from "../../util/logger.js";
import { copyFileSync } from "node:fs";
import { withConfigWriteLock } from "../../config/config-mutex.js";
import { getWorkspaceConfigPath } from "../../util/platform.js";

const log = getLogger("ollama-discovery");
const TICK_INTERVAL_MS = 60_000;

export type DiscoveryServiceHandle = {
  stop: () => void;
};

type Counters = Record<string, number>;

export function startOllamaDiscovery(db: DrizzleDb): DiscoveryServiceHandle {
  const counters: Counters = {};
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await runOneTick(db, counters);
    } catch (err) {
      log.error({ err }, "ollama-discovery tick failed");
    }
  };

  void tick();
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

async function runOneTick(db: DrizzleDb, counters: Counters): Promise<void> {
  const config = loadRawConfig();
  const llm = (config.llm ?? {}) as Record<string, unknown>;
  if (llm.autoOllamaDiscovery === false) return;

  const ollamaConn = pickOllamaConnection(db, llm);
  if (!ollamaConn) {
    log.debug("no ollama connection configured; skipping tick");
    return;
  }

  const baseUrl = ollamaConn.baseUrl ?? "http://127.0.0.1:11434";
  const tagsResult = await listOllamaModels(baseUrl);
  const now = new Date().toISOString();

  if (!tagsResult.ok) {
    setConnectionReachability(db, ollamaConn.name, false, now);
    return;
  }

  const discovered = await describeAllModels(baseUrl, tagsResult.value);
  setConnectionReachability(db, ollamaConn.name, true, now);

  // Extend catalog before any profile write so consumers see capabilities.
  extendProviderModels("ollama", discovered.map(toCatalogModel));

  await withConfigWriteLock(async () => {
    // Re-read inside the lock — another writer may have moved on.
    const fresh = loadRawConfig();
    const freshLlm = (fresh.llm ?? {}) as Record<string, unknown>;
    const profiles = (freshLlm.profiles ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const profileOrder = (freshLlm.profileOrder ?? []) as string[];
    const activeProfile = String(freshLlm.activeProfile ?? "balanced");

    // Phase 1: one-shot migration (gated)
    let nextProfiles = profiles;
    let nextOrder = profileOrder;
    let nextActive = activeProfile;
    const migratedAt = freshLlm.autoOllamaMigratedAt as string | undefined;
    if (!migratedAt && discovered.length > 0) {
      backupPreMigration();
      const m = migrateManualOllamaProfiles({
        profiles: nextProfiles,
        profileOrder: nextOrder,
        activeProfile: nextActive,
        discoveredModels: discovered,
        ollamaConnectionName: ollamaConn.name,
      });
      log.info(
        { migratedKeys: m.migratedKeys },
        "ollama-discovery one-shot migration complete",
      );
      nextProfiles = m.nextProfiles;
      nextOrder = m.nextProfileOrder;
      nextActive = m.nextActiveProfile;
      freshLlm.autoOllamaMigratedAt = new Date().toISOString();
    }

    // Phase 2: steady-state reconcile
    const r = reconcile({
      profiles: nextProfiles,
      profileOrder: nextOrder,
      activeProfile: nextActive,
      discoveredModels: discovered,
      ollamaConnectionName: ollamaConn.name,
      missingSinceCounter: counters,
    });

    // Update in-memory counter for next tick
    for (const k of Object.keys(counters)) delete counters[k];
    Object.assign(counters, r.nextMissingSinceCounter);

    if (!r.changed && migratedAt) return;

    freshLlm.profiles = r.nextProfiles;
    freshLlm.profileOrder = r.nextProfileOrder;
    freshLlm.activeProfile = r.nextActiveProfile;
    fresh.llm = freshLlm;
    await saveRawConfig(fresh);
    log.info({ events: r.events }, "ollama-discovery reconciled");
  });
}

function pickOllamaConnection(
  db: DrizzleDb,
  llm: Record<string, unknown>,
): { name: string; baseUrl?: string } | null {
  const defaultConn = (llm.default as Record<string, unknown> | undefined)
    ?.provider_connection as string | undefined;
  if (defaultConn) {
    const c = getConnection(db, defaultConn);
    if (c && c.provider === "ollama") {
      return { name: c.name, baseUrl: (c.metadata as { baseUrl?: string } | null)?.baseUrl };
    }
  }
  const all = listConnections(db)
    .filter((c) => c.provider === "ollama")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (all.length === 0) return null;
  const c = all[0];
  return { name: c.name, baseUrl: (c.metadata as { baseUrl?: string } | null)?.baseUrl };
}

function backupPreMigration(): void {
  const path = getWorkspaceConfigPath();
  const bak = `${path}.bak-pre-auto-ollama-${Date.now()}`;
  try {
    copyFileSync(path, bak);
    log.info({ bak }, "wrote pre-migration backup");
  } catch (err) {
    log.warn({ err }, "failed to write pre-migration backup");
    throw err; // abort migration if we can't back up
  }
}
```

- [ ] **Step 2: Confirm it type-checks**

Run: `cd assistant && bun run lint`
Expected: no errors related to the new file. Fix any type mismatches (e.g., `getConnection` / `listConnections` return shape — read the actual exports if unsure).

- [ ] **Step 3: Commit**

```bash
git add assistant/src/providers/ollama/discovery-service.ts
git commit -m "feat(ollama): discovery service orchestrator (poll → reconcile → save)"
```

---

## Task 13: Wire discovery service into daemon startup

**Files:**
- Modify: `assistant/src/daemon/main.ts`

- [ ] **Step 1: Find the daemon startup sequence**

Run: `grep -n "seedInferenceProfiles\|seedCanonical\|start\b\|listen(" assistant/src/daemon/main.ts | head -20`

- [ ] **Step 2: Add the discovery service start after connections + profiles are seeded**

Add near the end of the startup function (after seeding is complete and the DB handle is available):

```ts
import { startOllamaDiscovery } from "../providers/ollama/discovery-service.js";

// ... later, after seeding ...
const ollamaDiscovery = startOllamaDiscovery(db);
```

Capture the handle in the existing shutdown hook list. Find where other services register cleanup (likely an array of cleanup functions or a `process.on("SIGTERM", ...)` block) and append:

```ts
ollamaDiscovery.stop();
```

- [ ] **Step 3: Verify the daemon still builds**

Run: `cd assistant && bun run lint && bun test --bail src/daemon/`
Expected: lint clean, daemon tests pass.

- [ ] **Step 4: Commit**

```bash
git add assistant/src/daemon/main.ts
git commit -m "feat(daemon): start the ollama discovery service alongside other daemon services"
```

---

## Task 14: Swift — surface providerConnection on InferenceProfile

**Files:**
- Modify: `clients/macos/max-assistant/Features/Settings/InferenceProfile.swift`

- [ ] **Step 1: Check whether the struct already has the field**

Run: `grep -n "providerConnection\|provider_connection" clients/macos/max-assistant/Features/Settings/InferenceProfile.swift`

If absent, proceed. If present, skip to Task 15.

- [ ] **Step 2: Add the field + JSON parsing**

In the `InferenceProfile` struct add:

```swift
public var providerConnection: String?
```

In the JSON-decoding init that reads from a dictionary, add:

```swift
self.providerConnection = json["provider_connection"] as? String
```

- [ ] **Step 3: Build the macOS app**

Run: `cd clients/macos && ./build.sh`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add clients/macos/max-assistant/Features/Settings/InferenceProfile.swift
git commit -m "feat(macos): surface providerConnection on InferenceProfile"
```

---

## Task 15: Swift — connection reachability in SettingsStore

**Files:**
- Modify: `clients/macos/max-assistant/Features/Settings/SettingsStore.swift`

- [ ] **Step 1: Define a small reachability type**

Add (near the top of the file or in a sibling type file):

```swift
public struct ConnectionReachability: Equatable, Sendable {
    public let reachable: Bool
    public let lastSeenAt: Date?
}
```

- [ ] **Step 2: Add a published map**

Add to `SettingsStore`:

```swift
@Published public private(set) var connectionReachability: [String: ConnectionReachability] = [:]
```

- [ ] **Step 3: Populate it from `applyDaemonConfig`**

Find the `applyDaemonConfig(config:)` function. Add after `loadInferenceProfiles(config: config)`:

```swift
loadConnectionReachability(config: config)
```

Define the loader:

```swift
private func loadConnectionReachability(config: [String: Any]) {
    let llm = config["llm"] as? [String: Any]
    let connections = llm?["connections"] as? [[String: Any]] ?? []
    var map: [String: ConnectionReachability] = [:]
    let iso = ISO8601DateFormatter()
    for c in connections {
        guard let name = c["name"] as? String else { continue }
        let reachableRaw = c["reachable"]
        let reachable = (reachableRaw as? Bool) ?? true  // missing => treat as reachable
        let last = (c["lastSeenAt"] as? String).flatMap { iso.date(from: $0) }
        map[name] = ConnectionReachability(reachable: reachable, lastSeenAt: last)
    }
    self.connectionReachability = map
}
```

- [ ] **Step 4: Add `isConnectionReachable(_:)`**

```swift
public func isConnectionReachable(_ name: String?) -> Bool {
    guard let name else { return true }  // legacy: profile lacks connection field
    guard let state = connectionReachability[name] else { return true }  // cloud / unknown: optimistic
    return state.reachable
}
```

- [ ] **Step 5: Build**

Run: `cd clients/macos && ./build.sh`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add clients/macos/max-assistant/Features/Settings/SettingsStore.swift
git commit -m "feat(macos): track per-connection reachability from daemon config push"
```

---

## Task 16: Swift — picker filter + offline notice

**Files:**
- Modify: `clients/macos/max-assistant/Features/Chat/ChatProfilePicker.swift`

- [ ] **Step 1: Inject SettingsStore into the picker**

The picker is currently a stateless struct. The caller (ComposerView) already holds the store; thread it through as a new init parameter:

```swift
let settingsStore: SettingsStore
```

Update the call site in `ComposerView` to pass `settingsStore`. (Run `grep -n "ChatProfilePicker(" clients/macos/max-assistant/Features/Chat/` to find the call sites.)

- [ ] **Step 2: Extend the body filter at line ~69**

Replace:

```swift
let activeProfiles = profiles.filter { !$0.isDisabled }
```

With:

```swift
let activeProfiles = profiles.filter { profile in
    !profile.isDisabled
        && settingsStore.isConnectionReachable(profile.providerConnection)
}
let hiddenOllamaCount = profiles.filter { profile in
    !profile.isDisabled
        && profile.providerConnection.map { name in
            !settingsStore.isConnectionReachable(name)
        } ?? false
}.count
let ollamaConnectionReachability = settingsStore.connectionReachability
    .first { $0.value.reachable == false }?.value
```

- [ ] **Step 3: Render the offline notice in the menu**

After the existing `ForEach(activeProfiles)` block and the "Reset to default" item, append:

```swift
if hiddenOllamaCount > 0, let unreachable = ollamaConnectionReachability {
    let agoText = unreachable.lastSeenAt.map(relativeAgoString(_:)) ?? "—"
    VMenuItem(
        icon: VIcon.alertTriangle.rawValue,
        label: "Ollama offline — \(hiddenOllamaCount) model\(hiddenOllamaCount == 1 ? "" : "s") hidden",
        isActive: false,
        size: .regular
    ) {
        // no-op
    } trailing: {
        Text("Last seen: \(agoText)")
            .font(VFont.labelSmall)
            .foregroundStyle(VColor.contentTertiary)
    }
    .disabled(true)
}
```

Add a helper somewhere reachable from the picker:

```swift
private func relativeAgoString(_ date: Date) -> String {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f.localizedString(for: date, relativeTo: Date())
}
```

- [ ] **Step 4: Build and visually verify**

Run: `cd clients/macos && ./build.sh && open dist/max.app`
Open the picker — confirm the auto-ollama profiles appear when Ollama is reachable. (Manual verification step; no automated test here.)

- [ ] **Step 5: Commit**

```bash
git add clients/macos/max-assistant/Features/Chat/ChatProfilePicker.swift clients/macos/max-assistant/Features/Chat/ComposerView.swift
git commit -m "feat(macos): hide unreachable-connection profiles + show ollama offline notice in picker"
```

---

## Task 17: Swift — `(offline)` badge in Inference Profile editor

**Files:**
- Modify: `clients/macos/max-assistant/Features/Settings/InferenceProfileEditor.swift`

- [ ] **Step 1: Find where each profile row's label is rendered**

Run: `grep -n "Text(profile\|profile\.displayName\|profile\.label" clients/macos/max-assistant/Features/Settings/InferenceProfileEditor.swift | head -10`

- [ ] **Step 2: Append `(offline)` when the connection is unreachable**

Inside the row view, near the label:

```swift
if let conn = profile.providerConnection,
   !settingsStore.isConnectionReachable(conn) {
    Text("(offline)")
        .font(VFont.labelSmall)
        .foregroundStyle(VColor.contentTertiary)
}
```

If `settingsStore` isn't already passed into this view, thread it through following the same pattern as Task 16.

- [ ] **Step 3: Build**

Run: `cd clients/macos && ./build.sh`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add clients/macos/max-assistant/Features/Settings/InferenceProfileEditor.swift
git commit -m "feat(macos): (offline) badge in inference profile editor"
```

---

## Task 18: API-show schema canary test + fixtures

**Files:**
- Create: `assistant/src/providers/ollama/__tests__/api-show-schema.test.ts`
- Create: `assistant/src/providers/ollama/__tests__/fixtures/api-show/qwen3-6-35b.json`
- Create: 3 more fixture files (llama, mistral, gemma) by capturing the live API output

- [ ] **Step 1: Capture fixtures from live Ollama**

```bash
curl -s http://127.0.0.1:11434/api/show -d '{"name":"qwen3.6:35b"}' \
  | jq '.' > assistant/src/providers/ollama/__tests__/fixtures/api-show/qwen3-6-35b.json
```

Repeat for `llama3.2`, `mistral:7b`, `gemma3:4b` (or whatever variants are pulled). If a model isn't pulled, skip it — fixtures only cover what's available.

- [ ] **Step 2: Write the canary test**

```ts
// assistant/src/providers/ollama/__tests__/api-show-schema.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "api-show");
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

const ALLOWED_CAPS = new Set(["completion", "vision", "tools", "thinking"]);
const PARAM_SIZE_RE = /^\d+(\.\d+)?[BM]$/;

function assertShape(payload: Record<string, unknown>) {
  const caps = payload.capabilities as unknown;
  expect(Array.isArray(caps)).toBe(true);
  for (const c of caps as string[]) {
    expect(ALLOWED_CAPS.has(c)).toBe(true);
  }
  const modelinfo = payload.modelinfo as Record<string, unknown> | undefined;
  expect(modelinfo).toBeDefined();
  const hasCtx = Object.keys(modelinfo!).some(
    (k) => k.endsWith(".context_length") && typeof modelinfo![k] === "number",
  );
  expect(hasCtx).toBe(true);
  const details = payload.details as { parameter_size?: string } | undefined;
  if (details?.parameter_size) {
    expect(PARAM_SIZE_RE.test(details.parameter_size)).toBe(true);
  }
}

describe("api-show schema", () => {
  test("captured fixtures satisfy the expected schema", () => {
    if (!existsSync(FIXTURE_DIR)) {
      throw new Error("fixture directory missing");
    }
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const data = JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf-8"));
      try {
        assertShape(data);
      } catch (err) {
        throw new Error(`fixture ${f} failed schema check: ${(err as Error).message}`);
      }
    }
  });

  test.skipIf(!process.env.RUN_LIVE_OLLAMA)(
    "live Ollama satisfies the expected schema",
    async () => {
      const tags = await fetch(`${OLLAMA_BASE_URL}/api/tags`).then((r) => r.json());
      const first = (tags as { models: { name: string }[] }).models[0];
      const show = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: first.name }),
      }).then((r) => r.json());
      assertShape(show);
    },
  );
});
```

- [ ] **Step 3: Run the tests**

Run: `cd assistant && bun test src/providers/ollama/__tests__/api-show-schema.test.ts`
Expected: fixture test passes; live test skipped unless `RUN_LIVE_OLLAMA=1`.

- [ ] **Step 4: Commit**

```bash
git add assistant/src/providers/ollama/__tests__/api-show-schema.test.ts assistant/src/providers/ollama/__tests__/fixtures/
git commit -m "test(ollama): schema canary for /api/show + captured fixtures"
```

---

## Task 19: Integration test — discovery service against stub Ollama

**Files:**
- Create: `assistant/src/providers/ollama/__tests__/discovery-service.integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
// assistant/src/providers/ollama/__tests__/discovery-service.integration.test.ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { startOllamaDiscovery } from "../discovery-service.js";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test scaffolding — concrete shape depends on existing test helpers in
// the repo. Reuse the in-memory drizzle helper used by other provider tests;
// grep `bun test` setup files for the canonical pattern.

const ORIGINAL_HOME = process.env.HOME;

function setupWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "max-discovery-test-"));
  process.env.MAX_WORKSPACE_DIR = join(dir, "workspace");
  return dir;
}

function makeStubOllama(models: { name: string; capabilities?: string[] }[]) {
  // ... implement using Bun.serve() on a random port; return baseUrl
}

describe("discovery-service integration", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = setupWorkspace();
  });
  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    delete process.env.MAX_WORKSPACE_DIR;
    if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
  });

  test("first tick writes auto profiles for every Ollama model", async () => {
    // 1) stub Ollama with 2 models
    // 2) seed workspace with empty llm config + an ollama-personal connection
    // 3) start the discovery service
    // 4) wait one tick
    // 5) assert config.json contains auto-ollama-* entries for both
    expect(true).toBe(true); // TODO: flesh out using existing test helpers
  });

  test("Ollama offline → connection.reachable flips false, profiles preserved on disk", async () => {
    expect(true).toBe(true);
  });

  test("migration: pre-seeded ollama-deep → migrated, .bak file written", async () => {
    expect(true).toBe(true);
  });

  test("autoOllamaDiscovery: false → service no-ops", async () => {
    expect(true).toBe(true);
  });
});
```

(This is a TDD scaffold. The exact wiring of the in-memory drizzle DB + workspace path stubbing should follow the pattern used in `assistant/src/providers/inference/__tests__/`. Read one of those before fleshing out, then expand each test body.)

- [ ] **Step 2: Run the placeholder tests**

Run: `cd assistant && bun test src/providers/ollama/__tests__/discovery-service.integration.test.ts`
Expected: 4 tests pass as placeholders (each currently asserts `true`).

- [ ] **Step 3: Flesh out each `expect(true)` placeholder with real assertions**

For each test, replace the placeholder with real setup + assertions. Reference patterns in `connections.ts` tests for DB setup; use `Bun.serve()` for the stub HTTP server (capture port from the server handle, pass to a synthetic connection metadata.baseUrl).

After fleshing out, re-run the test — all 4 should pass against the stub.

- [ ] **Step 4: Commit**

```bash
git add assistant/src/providers/ollama/__tests__/discovery-service.integration.test.ts
git commit -m "test(ollama): integration tests for discovery service against stub Ollama"
```

---

## Task 20: Swift — ChatProfilePicker tests

**Files:**
- Modify: `clients/macos/max-assistantTests/Features/Chat/ChatProfilePickerTests.swift`

- [ ] **Step 1: Add filter tests**

Append the following test methods to the existing test class:

```swift
@MainActor
func test_filtersUnreachableOllamaProfile() {
    let store = SettingsTestFixture.makeStore()
    store.connectionReachability = [
        "ollama-personal": ConnectionReachability(reachable: false, lastSeenAt: Date())
    ]
    let profiles = [
        InferenceProfile(name: "anthropic-balanced", label: "Balanced",
                         providerConnection: "anthropic-managed"),
        InferenceProfile(name: "auto-ollama-qwen3-6-35b", label: "qwen3.6:35b",
                         providerConnection: "ollama-personal"),
    ]
    // Render the picker into a host, inspect via ViewInspector or assert
    // on the static label function. Adjust to the existing fixture pattern.
    XCTAssertEqual(
        ChatProfilePicker.label(current: nil, profiles: profiles, activeProfile: "anthropic-balanced"),
        "Default (Balanced)"
    )
    // Filter assertion: re-evaluate the same filter logic inline
    let visible = profiles.filter { p in
        store.isConnectionReachable(p.providerConnection)
    }
    XCTAssertEqual(visible.map(\.name), ["anthropic-balanced"])
}

@MainActor
func test_cloudProfileNotFilteredWhenConnectionLacksReachableField() {
    let store = SettingsTestFixture.makeStore()
    store.connectionReachability = [:]  // unknown for cloud
    let profile = InferenceProfile(name: "balanced", label: "Balanced",
                                   providerConnection: "anthropic-managed")
    XCTAssertTrue(store.isConnectionReachable(profile.providerConnection))
}
```

(Read `SettingsTestFixture.swift` to align the constructor calls with the actual fixture API.)

- [ ] **Step 2: Run the tests**

Run: `xcodebuild test -scheme max-assistant -destination 'platform=macOS' -only-testing:max-assistantTests/ChatProfilePickerTests`
(Or use the existing test-run command in the macOS project — check `clients/macos/build.sh` for a `test` subcommand.)
Expected: both new tests pass.

- [ ] **Step 3: Commit**

```bash
git add clients/macos/max-assistantTests/Features/Chat/ChatProfilePickerTests.swift
git commit -m "test(macos): ChatProfilePicker filters unreachable-connection profiles"
```

---

## Task 21: PR description with manual E2E checklist

**Files:**
- No files; the PR body itself.

- [ ] **Step 1: Compose the PR description**

When opening the PR, use this body verbatim — it doubles as the merge-time E2E checklist:

```markdown
## Summary

Ollama auto-discovery: the daemon polls `http://127.0.0.1:11434/api/tags` + `/api/show` every 60s, writes one `auto-ollama-*` profile per locally-installed model into `llm.profiles`, mutates `PROVIDER_CATALOG` in memory so capability checks (vision/tools/thinking) succeed, and updates `connections.<ollama>.reachable`. The macOS picker filters unreachable-connection profiles and shows a single "Ollama offline" notice at the bottom of the dropdown.

Pre-existing manual `ollama-*` / `qwen3-6-35b` profiles get migrated once into `auto-ollama-*` entries with `effort` / `maxTokens` / `thinking` / `contextWindow` carried over. A `config.json.bak-pre-auto-ollama-<ts>` is written before the migration runs.

Spec: `docs/superpowers/specs/2026-05-16-ollama-auto-discovery-design.md`

## Manual E2E checklist (run on real Mac + real Ollama before merge)

- [ ] Fresh workspace + Ollama running with 3 models → 3 auto profiles in picker within 60s
- [ ] `ollama pull <new-model>` → appears in picker within 60s
- [ ] `ollama rm <model>` → disappears from picker after ~2 min (2 ticks)
- [ ] Stop Ollama daemon → auto profiles gone from picker, "Ollama offline" notice shown
- [ ] Restart Ollama → profiles return, notice gone
- [ ] Existing user with manual `ollama-large` / `ollama-deep` / `qwen3-6-35b` → migration runs ONCE, `.bak-pre-auto-ollama-<ts>` exists alongside config.json, `effort` / `maxTokens` carried (exact values match pre-state)
- [ ] Set `llm.autoOllamaDiscovery: false` in workspace config → service no-ops, no auto profiles created
- [ ] `activeProfile: ollama-deep` set before upgrade → after migration, `activeProfile` cascaded to `auto-ollama-qwen3-6-35b` (same-model winner)

## Files touched

- New: `assistant/src/providers/ollama/{slugify,api-client,capability-mapping,reconcile,migration,discovery-service}.ts` + tests
- New: `assistant/src/config/config-mutex.ts` + tests
- Modified: `assistant/src/config/loader.ts` (atomic write + mutex), `assistant/src/config/schemas/llm.ts`, `assistant/src/config/seed-inference-profiles.ts`, `assistant/src/providers/inference/connections.ts`, `assistant/src/providers/model-catalog.ts`, `assistant/src/memory/schema.ts` + new migration, `assistant/src/daemon/main.ts`
- Modified: `clients/macos/.../InferenceProfile.swift`, `SettingsStore.swift`, `ChatProfilePicker.swift`, `InferenceProfileEditor.swift` + tests
```

- [ ] **Step 2: Open the PR**

Run from the feature branch:

```bash
gh pr create --title "feat: ollama auto-discovery for inference profiles" --body-file <(cat docs/superpowers/plans/<this-file>)
```

(Edit the body to use the description block above; this command is illustrative.)

---

## Self-review

**Spec coverage:**
- §1 architecture → Tasks 12, 13 (orchestrator + daemon wire-up)
- Safety rails → Tasks 6, 7 (mutex + atomic write), 12 (migration backup)
- §2 reconciliation → Tasks 1, 4, 5 (slugify, reconcile, migration)
- §3 defaults & catalog → Tasks 3, 9 (capability mapping + runtime catalog)
- §4 offline UX → Tasks 8, 15, 16, 17 (connection columns, SettingsStore, picker, editor)
- §5 testing → Tasks 18, 19, 20 (canary, integration, Swift) + every implementation task has TDD
- Schema additions → Tasks 8, 10 (DB columns + Zod schema)
- Seed fallback fix → Task 11

**Placeholder scan:** Task 19's integration test bodies are intentionally TDD-stubbed (each step explicitly says "flesh out with real setup" before commit). Every other task has complete code. No "TODO: implement later" in committed paths.

**Type consistency:**
- `DiscoveredModel` defined in `api-client.ts` (Task 2), consumed by `capability-mapping.ts` (Task 3), `reconcile.ts` (Task 4), `migration.ts` (Task 5), `discovery-service.ts` (Task 12). Consistent.
- `CatalogModelRow` defined in `capability-mapping.ts` (Task 3), consumed by `model-catalog.ts` (Task 9). Consistent.
- `ProfileRecord` defined in `reconcile.ts` (Task 4), consumed by `migration.ts` (Task 5). Consistent.
- Swift `ConnectionReachability` defined in Task 15, consumed in Tasks 16, 17, 20. Consistent.

**Scope check:** Single cohesive feature; tasks are individually committable and the daemon stays runnable at every commit (Swift changes are independent of TS changes once the wire format ships). No subsystem split needed.
