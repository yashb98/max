import { afterEach, describe, expect, it, mock } from "bun:test";

const loginProviderMock = mock(
  async (_provider: string, _opts: { onUrl: (u: string) => void }) =>
    ({ success: true }) as { success: boolean; reason?: string; error?: string },
);
mock.module("../providers/provider-login.js", () => ({
  loginProvider: loginProviderMock,
}));

const openInHostBrowser = mock(async (_u: string) => {});
mock.module("../util/browser.js", () => ({ openInHostBrowser }));

import { handleProviderLogin } from "../runtime/routes/provider-login-routes.js";

afterEach(() => {
  loginProviderMock.mockReset();
  openInHostBrowser.mockReset();
});

describe("handleProviderLogin", () => {
  it("invokes loginProvider with an onUrl that opens the host browser", async () => {
    loginProviderMock.mockImplementation(async (_provider, opts) => {
      opts.onUrl("https://x/oauth");
      return { success: true };
    });
    const result = await handleProviderLogin({ body: { provider: "kimi-agent" } });
    expect(result).toEqual({ success: true });
    expect(loginProviderMock).toHaveBeenCalledTimes(1);
    expect(loginProviderMock.mock.calls[0]?.[0]).toBe("kimi-agent");
    expect(openInHostBrowser).toHaveBeenCalledWith("https://x/oauth");
  });

  it("passes the login result through unchanged", async () => {
    loginProviderMock.mockImplementation(async () => ({
      success: false,
      reason: "cli-error",
      error: "nope",
    }));
    const result = await handleProviderLogin({ body: { provider: "kimi-agent" } });
    expect(result).toEqual({ success: false, reason: "cli-error", error: "nope" });
  });

  it("throws when provider is missing", async () => {
    await expect(handleProviderLogin({ body: {} })).rejects.toThrow(
      "provider is required",
    );
    expect(loginProviderMock).not.toHaveBeenCalled();
  });

  it("throws when no body is provided", async () => {
    await expect(handleProviderLogin()).rejects.toThrow("provider is required");
  });
});
