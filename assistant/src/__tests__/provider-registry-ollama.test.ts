import { describe, expect, mock, test } from "bun:test";

// Mock secure-keys so tests don't depend on the developer's local secure storage.
const actualSecureKeys = await import("../security/secure-keys.js");
mock.module("../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async () => undefined,
}));

import { LLMSchema } from "../config/schemas/llm.js";
import {
  getProvider,
  initializeProviders,
  listProviders,
} from "../providers/registry.js";

const baseLlm = LLMSchema.parse({});

describe("provider registry (ollama)", () => {
  test("registers ollama when selected provider has no API key", async () => {
    await initializeProviders({
      services: {
        inference: {},
        "image-generation": {
          mode: "your-own",
          provider: "gemini",
          model: "gemini-3.1-flash-image-preview",
        },
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
      llm: {
        ...baseLlm,
        default: {
          ...baseLlm.default,
          provider: "ollama" as const,
          model: "claude-opus-4-6",
        },
      },
    });

    const provider = getProvider("ollama");
    expect(provider.name).toBe("ollama");
    // claude-subscription and kimi-agent are defaultEnabled cli-login providers
    // that always register regardless of API keys / selected provider; exclude
    // them to assert the key-based/selected-provider fallback set.
    expect(
      listProviders().filter(
        (p) => p !== "claude-subscription" && p !== "kimi-agent",
      ),
    ).toEqual(["ollama"]);
  });
});
