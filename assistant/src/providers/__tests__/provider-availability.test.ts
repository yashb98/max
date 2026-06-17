/**
 * Unit tests for the typed `ProviderAvailabilityStatus` API in
 * `provider-availability.ts`. Covers the basic contract, the back-compat
 * wrapper, the feature-flag-aware claude-subscription branch, the
 * kimi-agent 4-state matrix, and the all-providers map.
 *
 * Mocks `isAssistantFeatureFlagEnabled` at the module boundary so flag-off
 * scenarios can be asserted without touching the on-disk feature-flag
 * registry.
 *
 * Kimi-agent tests use injectable `probes` (KimiAgentProbes.loginPresent)
 * to control the "vault key or config.toml" check without mocking
 * secure-keys — the production default checks both paths via the
 * `isKimiLoginPresent` helper; tests inject a synchronous probe instead.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let featureFlagReturn = true;
mock.module("../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => featureFlagReturn,
}));

const {
  clearClaudeSubscriptionAvailabilityCache,
  clearKimiAgentAvailabilityCache,
  getAllProviderAvailability,
  getProviderAvailabilityStatus,
  isProviderAvailable,
} = await import("../provider-availability.js");

type ProviderAvailabilityStatus = Awaited<
  ReturnType<typeof getProviderAvailabilityStatus>
>;

describe("getProviderAvailabilityStatus — contract", () => {
  beforeEach(() => {
    clearClaudeSubscriptionAvailabilityCache();
    clearKimiAgentAvailabilityCache();
    featureFlagReturn = true;
  });

  test("ollama is always available with no reason", async () => {
    const status: ProviderAvailabilityStatus =
      await getProviderAvailabilityStatus("ollama");
    expect(status.available).toBe(true);
    expect(status.reason).toBeUndefined();
  });

  test("isProviderAvailable matches getProviderAvailabilityStatus(...).available for ollama", async () => {
    const bool = await isProviderAvailable("ollama");
    const status = await getProviderAvailabilityStatus("ollama");
    expect(bool).toBe(status.available);
  });
});

describe("claude-subscription feature-flag matrix", () => {
  beforeEach(() => {
    clearClaudeSubscriptionAvailabilityCache();
    clearKimiAgentAvailabilityCache();
    featureFlagReturn = true;
  });

  test("flag off → { available: false, reason: 'not-enabled' }", async () => {
    featureFlagReturn = false;
    const status = await getProviderAvailabilityStatus("claude-subscription");
    expect(status.available).toBe(false);
    expect(status.reason).toBe("not-enabled");
  });

  test("flag on + cli/login both present → { available: true }", async () => {
    featureFlagReturn = true;
    const probes = {
      cliPresent: async () => true,
      loginPresent: async () => true,
    };
    const status = await getProviderAvailabilityStatus(
      "claude-subscription",
      probes,
    );
    expect(status.available).toBe(true);
    expect(status.reason).toBeUndefined();
  });

  test("flag on + cli absent → { available: false, reason: 'missing-cli' }", async () => {
    featureFlagReturn = true;
    const probes = {
      cliPresent: async () => false,
      loginPresent: async () => true, // login presence doesn't matter when CLI is absent
    };
    const status = await getProviderAvailabilityStatus(
      "claude-subscription",
      probes,
    );
    expect(status.available).toBe(false);
    expect(status.reason).toBe("missing-cli");
  });

  test("flag on + cli present + login absent → { available: false, reason: 'not-logged-in' }", async () => {
    featureFlagReturn = true;
    const probes = {
      cliPresent: async () => true,
      loginPresent: async () => false,
    };
    const status = await getProviderAvailabilityStatus(
      "claude-subscription",
      probes,
    );
    expect(status.available).toBe(false);
    expect(status.reason).toBe("not-logged-in");
  });

  test("flag on + cli absent + login absent → { available: false, reason: 'missing-cli' }", async () => {
    // Order matters: the check short-circuits on CLI absence before
    // probing for login state, so the reason is `missing-cli` rather
    // than `not-logged-in`.
    featureFlagReturn = true;
    const probes = {
      cliPresent: async () => false,
      loginPresent: async () => false,
    };
    const status = await getProviderAvailabilityStatus(
      "claude-subscription",
      probes,
    );
    expect(status.available).toBe(false);
    expect(status.reason).toBe("missing-cli");
  });

  test("isProviderAvailable wrapper matches getProviderAvailabilityStatus(...).available across the matrix", async () => {
    featureFlagReturn = true;
    const cases: Array<{
      cliPresent: boolean;
      loginPresent: boolean;
      expected: boolean;
    }> = [
      { cliPresent: true, loginPresent: true, expected: true },
      { cliPresent: true, loginPresent: false, expected: false },
      { cliPresent: false, loginPresent: true, expected: false },
      { cliPresent: false, loginPresent: false, expected: false },
    ];

    for (const c of cases) {
      clearClaudeSubscriptionAvailabilityCache();
      const probes = {
        cliPresent: async () => c.cliPresent,
        loginPresent: async () => c.loginPresent,
      };
      const bool = await isProviderAvailable("claude-subscription", probes);
      clearClaudeSubscriptionAvailabilityCache();
      const status = await getProviderAvailabilityStatus(
        "claude-subscription",
        probes,
      );
      expect(bool).toBe(c.expected);
      expect(status.available).toBe(c.expected);
      expect(bool).toBe(status.available);
    }
  });

  test("probe results are cached across calls until clearClaudeSubscriptionAvailabilityCache()", async () => {
    featureFlagReturn = true;
    let cliCalls = 0;
    let loginCalls = 0;
    const probes = {
      cliPresent: async () => {
        cliCalls += 1;
        return true;
      },
      loginPresent: async () => {
        loginCalls += 1;
        return true;
      },
    };

    await getProviderAvailabilityStatus("claude-subscription", probes);
    await getProviderAvailabilityStatus("claude-subscription", probes);
    await getProviderAvailabilityStatus("claude-subscription", probes);
    // Cache hit on 2nd + 3rd call: probes fire exactly once.
    expect(cliCalls).toBe(1);
    expect(loginCalls).toBe(1);

    clearClaudeSubscriptionAvailabilityCache();
    await getProviderAvailabilityStatus("claude-subscription", probes);
    // After clear, probes fire again.
    expect(cliCalls).toBe(2);
    expect(loginCalls).toBe(2);
  });
});

describe("kimi-agent feature-flag matrix", () => {
  beforeEach(() => {
    clearKimiAgentAvailabilityCache();
    featureFlagReturn = true;
  });

  test("flag off → { available: false, reason: 'not-enabled' }", async () => {
    featureFlagReturn = false;
    const status = await getProviderAvailabilityStatus("kimi-agent");
    expect(status.available).toBe(false);
    expect(status.reason).toBe("not-enabled");
  });

  test("flag on + cli absent → { available: false, reason: 'missing-cli' }", async () => {
    featureFlagReturn = true;
    const probes = {
      cliPresent: async () => false,
      loginPresent: async () => true,
    };
    const status = await getProviderAvailabilityStatus("kimi-agent", probes);
    expect(status.available).toBe(false);
    expect(status.reason).toBe("missing-cli");
  });

  test("flag on + cli present + no key + no config.toml → { available: false, reason: 'no-api-key' }", async () => {
    featureFlagReturn = true;
    const probes = {
      cliPresent: async () => true,
      loginPresent: async () => false,
    };
    const status = await getProviderAvailabilityStatus("kimi-agent", probes);
    expect(status.available).toBe(false);
    expect(status.reason).toBe("no-api-key");
  });

  test("flag on + cli present + config.toml present → { available: true }", async () => {
    featureFlagReturn = true;
    const probes = {
      cliPresent: async () => true,
      loginPresent: async () => true,
    };
    const status = await getProviderAvailabilityStatus("kimi-agent", probes);
    expect(status.available).toBe(true);
    expect(status.reason).toBeUndefined();
  });

  test("isProviderAvailable wrapper matches getProviderAvailabilityStatus(...).available", async () => {
    featureFlagReturn = true;
    const probes = {
      cliPresent: async () => true,
      loginPresent: async () => true,
    };
    clearKimiAgentAvailabilityCache();
    const bool = await isProviderAvailable("kimi-agent", probes);
    clearKimiAgentAvailabilityCache();
    const status = await getProviderAvailabilityStatus("kimi-agent", probes);
    expect(bool).toBe(status.available);
    expect(bool).toBe(true);
  });
});

describe("getAllProviderAvailability", () => {
  beforeEach(() => {
    clearClaudeSubscriptionAvailabilityCache();
    clearKimiAgentAvailabilityCache();
    featureFlagReturn = true;
  });

  test("returns a map containing ollama with { available: true }", async () => {
    const map = await getAllProviderAvailability();
    expect(map["ollama"]).toEqual({ available: true });
  });

  test("includes claude-subscription with reason 'not-enabled' when flag is off", async () => {
    featureFlagReturn = false;
    const map = await getAllProviderAvailability();
    expect(map["claude-subscription"]?.available).toBe(false);
    expect(map["claude-subscription"]?.reason).toBe("not-enabled");
  });
});
