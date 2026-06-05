import { describe, expect, test } from "bun:test";

import type { DiscoveredModel } from "../api-client.js";
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

const qwen36: DiscoveredModel = {
  tag: "qwen3.6:35b",
  capabilities: ["completion", "thinking", "vision", "tools"],
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
    expect(out.nextProfiles["auto-ollama-qwen3-6-35b"].model).toBe(
      "qwen3.6:35b",
    );
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
