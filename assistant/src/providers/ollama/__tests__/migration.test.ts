import { describe, expect, test } from "bun:test";

import type { DiscoveredModel } from "../api-client.js";
import { migrateManualOllamaProfiles } from "../migration.js";

const qwen36: DiscoveredModel = {
  tag: "qwen3.6:35b",
  capabilities: ["completion", "thinking", "vision", "tools"],
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
    expect(out.nextProfiles[key].contextWindow).toEqual({
      maxInputTokens: 20000,
    });
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
