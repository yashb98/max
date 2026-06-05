import { beforeEach, describe, expect, test } from "bun:test";

import type { CatalogModel } from "../model-catalog.js";
import {
  effectiveModelsForProvider,
  extendProviderModels,
  getCatalogProviderForModel,
  isModelInCatalog,
} from "../model-catalog.js";

function discoveredModel(id: string): CatalogModel {
  return {
    id,
    displayName: id,
    contextWindowTokens: 131072,
    maxOutputTokens: 8192,
    defaultContextWindowTokens: 131072,
    supportsThinking: true,
    supportsVision: true,
    supportsToolUse: true,
    supportsCaching: false,
    longContextMode: "native-model",
    pricing: { inputPer1mTokens: 0, outputPer1mTokens: 0 },
  };
}

describe("extendProviderModels", () => {
  // Reset the runtime extension between tests so one test's registration
  // can't leak into another. Module-level state survives test boundaries.
  beforeEach(() => {
    extendProviderModels("ollama", []);
  });

  test("isModelInCatalog returns true for runtime-added models", () => {
    extendProviderModels("ollama", [discoveredModel("qwen3.6:35b")]);
    expect(isModelInCatalog("ollama", "qwen3.6:35b")).toBe(true);
  });

  test("isModelInCatalog returns false for a model never registered", () => {
    extendProviderModels("ollama", [discoveredModel("qwen3.6:35b")]);
    expect(isModelInCatalog("ollama", "never-installed:13b")).toBe(false);
  });

  test("extendProviderModels replaces (not merges) the prior registration", () => {
    extendProviderModels("ollama", [discoveredModel("a:1")]);
    extendProviderModels("ollama", [discoveredModel("b:1")]);
    expect(isModelInCatalog("ollama", "a:1")).toBe(false);
    expect(isModelInCatalog("ollama", "b:1")).toBe(true);
  });

  test("effectiveModelsForProvider merges static + runtime", () => {
    extendProviderModels("ollama", [discoveredModel("qwen3.6:35b")]);
    const models = effectiveModelsForProvider("ollama");
    // The static catalog ships llama3.2 + mistral; the runtime extension
    // appends qwen3.6:35b. We assert presence of both sides rather than
    // exact length so the test survives static-catalog churn.
    expect(models.some((m) => m.id === "llama3.2")).toBe(true);
    expect(models.some((m) => m.id === "qwen3.6:35b")).toBe(true);
  });

  test("static catalog models still resolve when no runtime extension is set", () => {
    expect(isModelInCatalog("ollama", "llama3.2")).toBe(true);
  });

  test("getCatalogProviderForModel resolves a runtime-added model to its provider", () => {
    extendProviderModels("ollama", [discoveredModel("qwen3.6:35b")]);
    expect(getCatalogProviderForModel("qwen3.6:35b")).toBe("ollama");
  });

  test("extending an unknown provider id leaves the catalog untouched for known ids", () => {
    extendProviderModels("does-not-exist", [discoveredModel("x:1")]);
    expect(isModelInCatalog("does-not-exist", "x:1")).toBe(true);
    expect(isModelInCatalog("ollama", "llama3.2")).toBe(true);
  });
});
