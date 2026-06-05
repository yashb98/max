import { describe, expect, test } from "bun:test";

import { ensureUniqueSlug,modelKey } from "../slugify.js";

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
