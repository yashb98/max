import { describe, expect, test } from "bun:test";

import type { DiscoveredModel } from "../api-client.js";
import {
  CONTEXT_CLAMP_MAX,
  CONTEXT_FALLBACK,
  toCatalogModel,
  toProfileDefaults,
} from "../capability-mapping.js";

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
