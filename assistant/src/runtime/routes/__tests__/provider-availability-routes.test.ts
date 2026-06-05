/**
 * Unit tests for the provider-availability shared routes.
 * Asserts route definitions are correctly shaped, the list handler
 * returns a map containing ollama, the by-id handler returns the
 * single-provider status, and the `?fresh=true` query bust does not
 * throw.
 */
import { describe, expect, mock, test } from "bun:test";

// Force the feature flag ON so getAllProviderAvailability evaluates the
// claude-subscription branch deterministically across test runs.
mock.module("../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

const { ROUTES } = await import("../provider-availability-routes.js");

describe("provider-availability-routes", () => {
  test("exports exactly two routes: list and by-id", () => {
    expect(ROUTES).toHaveLength(2);
    const ids = ROUTES.map((r) => r.operationId).sort();
    expect(ids).toEqual([
      "provider_availability_get",
      "provider_availability_list",
    ]);
  });

  test("both routes are GET", () => {
    for (const r of ROUTES) expect(r.method).toBe("GET");
  });

  test("list endpoint is 'provider-availability' (no leading slash, no /v1/ prefix)", () => {
    const list = ROUTES.find((r) => r.operationId === "provider_availability_list");
    expect(list?.endpoint).toBe("provider-availability");
  });

  test("by-id endpoint includes the :id placeholder", () => {
    const byId = ROUTES.find((r) => r.operationId === "provider_availability_get");
    expect(byId?.endpoint).toBe("provider-availability/:id");
  });

  test("list handler returns a map keyed by provider id with ollama available", async () => {
    const list = ROUTES.find((r) => r.operationId === "provider_availability_list");
    expect(list).toBeDefined();
    const result = (await list!.handler({
      queryParams: {},
      pathParams: {},
    })) as Record<string, { available: boolean; reason?: string }>;
    expect(typeof result).toBe("object");
    expect(result["ollama"]).toEqual({ available: true });
  });

  test("by-id handler returns the single-provider status for ollama", async () => {
    const byId = ROUTES.find((r) => r.operationId === "provider_availability_get");
    expect(byId).toBeDefined();
    const result = await byId!.handler({
      queryParams: {},
      pathParams: { id: "ollama" },
    });
    expect(result).toEqual({ available: true });
  });

  test("by-id handler with missing :id returns a safe { available: false, reason: 'no-api-key' }", async () => {
    const byId = ROUTES.find((r) => r.operationId === "provider_availability_get");
    const result = await byId!.handler({
      queryParams: {},
      pathParams: {},
    });
    expect(result).toEqual({ available: false, reason: "no-api-key" });
  });

  test("?fresh=true does not throw on the list handler", async () => {
    const list = ROUTES.find((r) => r.operationId === "provider_availability_list");
    const result = (await list!.handler({
      queryParams: { fresh: "true" },
      pathParams: {},
    })) as Record<string, { available: boolean }>;
    expect(result["ollama"]).toEqual({ available: true });
  });
});
