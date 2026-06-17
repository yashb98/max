/**
 * Tests for getExternalAssistantId.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  getExternalAssistantId,
  resetExternalAssistantIdCache,
} from "../external-assistant-id.js";

afterEach(() => {
  resetExternalAssistantIdCache();
  delete process.env.MAX_ASSISTANT_NAME;
});

describe("getExternalAssistantId", () => {
  test("resolves from MAX_ASSISTANT_NAME env var", () => {
    process.env.MAX_ASSISTANT_NAME = "max-cool-eel";
    expect(getExternalAssistantId()).toBe("max-cool-eel");
  });

  test("caches the resolved value", () => {
    process.env.MAX_ASSISTANT_NAME = "max-cool-eel";
    expect(getExternalAssistantId()).toBe("max-cool-eel");
    // Change env var — cached value should still be returned
    process.env.MAX_ASSISTANT_NAME = "max-other-fox";
    expect(getExternalAssistantId()).toBe("max-cool-eel");
  });

  test("returns undefined when env var is not set", () => {
    expect(getExternalAssistantId()).toBe(undefined);
  });
});
