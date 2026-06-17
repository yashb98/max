import { afterEach, describe, expect, it, mock } from "bun:test";

const loginMock = mock(
  async (_opts: { onUrl?: (u: string) => void }) =>
    ({ success: true }) as { success: boolean; error?: string },
);
mock.module("@moonshot-ai/kimi-agent-sdk", () => ({ login: loginMock }));

const clearKimiCache = mock(() => {});
const clearClaudeCache = mock(() => {});
mock.module("../providers/provider-availability.js", () => ({
  clearKimiAgentAvailabilityCache: clearKimiCache,
  clearClaudeSubscriptionAvailabilityCache: clearClaudeCache,
}));

import { loginProvider } from "../providers/provider-login.js";

// Test seam for the claude path: a fake `getClaudeAuthStatus` so the suite
// never shells out to the real `claude` CLI.
const claudeStatus = mock(
  async () => ({ loggedIn: true }) as { loggedIn?: boolean } | null,
);

afterEach(() => {
  loginMock.mockReset();
  clearKimiCache.mockReset();
  clearClaudeCache.mockReset();
  claudeStatus.mockReset();
});

describe("loginProvider", () => {
  it("returns unsupported-provider for an unknown provider and does not call the SDK", async () => {
    const result = await loginProvider("openai", { onUrl: () => {} });
    expect(result).toEqual({ success: false, reason: "unsupported-provider" });
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("kimi-agent: forwards onUrl, returns success, busts availability cache", async () => {
    loginMock.mockImplementation(async ({ onUrl }) => {
      onUrl?.("https://kimi.com/oauth?x=1");
      return { success: true };
    });
    const urls: string[] = [];
    const result = await loginProvider("kimi-agent", {
      onUrl: (u) => urls.push(u),
    });
    expect(result).toEqual({ success: true });
    expect(urls).toEqual(["https://kimi.com/oauth?x=1"]);
    expect(clearKimiCache).toHaveBeenCalledTimes(1);
  });

  it("kimi-agent: maps SDK failure to cli-error with message, no cache bust", async () => {
    loginMock.mockImplementation(async () => ({
      success: false,
      error: "membership inactive",
    }));
    const result = await loginProvider("kimi-agent", { onUrl: () => {} });
    expect(result).toEqual({
      success: false,
      reason: "cli-error",
      error: "membership inactive",
    });
    expect(clearKimiCache).not.toHaveBeenCalled();
  });

  it("kimi-agent: maps an SDK throw to cli-error", async () => {
    loginMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    const result = await loginProvider("kimi-agent", { onUrl: () => {} });
    expect(result).toEqual({
      success: false,
      reason: "cli-error",
      error: "boom",
    });
    expect(clearKimiCache).not.toHaveBeenCalled();
  });

  it("claude-subscription: loggedIn → success and busts the availability cache", async () => {
    claudeStatus.mockImplementation(async () => ({
      loggedIn: true,
    }));
    const result = await loginProvider(
      "claude-subscription",
      { onUrl: () => {} },
      { getClaudeAuthStatus: claudeStatus },
    );
    expect(result).toEqual({ success: true });
    expect(clearClaudeCache).toHaveBeenCalledTimes(1);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("claude-subscription: not logged in → no-token-captured with terminal guidance, no cache bust", async () => {
    claudeStatus.mockImplementation(async () => ({ loggedIn: false }));
    const result = await loginProvider(
      "claude-subscription",
      { onUrl: () => {} },
      { getClaudeAuthStatus: claudeStatus },
    );
    expect(result.success).toBe(false);
    expect(result.reason).toBe("no-token-captured");
    expect(result.error).toMatch(/claude auth login/);
    expect(clearClaudeCache).not.toHaveBeenCalled();
  });

  it("claude-subscription: status unreadable (CLI missing) → cli-error, never throws", async () => {
    claudeStatus.mockImplementation(async () => null);
    const result = await loginProvider(
      "claude-subscription",
      { onUrl: () => {} },
      { getClaudeAuthStatus: claudeStatus },
    );
    expect(result.success).toBe(false);
    expect(result.reason).toBe("cli-error");
    expect(clearClaudeCache).not.toHaveBeenCalled();
  });
});
