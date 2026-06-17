/**
 * Smoke test verifying that `buildProviderAdapter("kimi-agent", ...)` returns
 * a Provider whose `.name` matches the registry key. This exercises the
 * PROVIDER_CATALOG / ADAPTER_FACTORIES parity guard and confirms the import
 * chain works end-to-end.
 */
import { describe, expect, test } from "bun:test";

import { buildProviderAdapter } from "../adapter-factory.js";

describe("kimi-agent adapter factory", () => {
  test("buildProviderAdapter('kimi-agent') returns a provider with name 'kimi-agent'", () => {
    const provider = buildProviderAdapter("kimi-agent", {
      apiKey: "sk-x",
      model: "kimi-k2.6",
      streamTimeoutMs: 1000,
      useNativeWebSearch: false,
    });
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("kimi-agent");
  });
});
