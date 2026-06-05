/**
 * Tests for `KimiAgentBridgeError` + `classifyKimiAgentError`.
 *
 * Phase 3 Task 16 in `docs/superpowers/plans/2026-05-23-kimi-agent-sdk-provider.md`.
 * The classifier is pattern-based (the SDK surfaces failures as generic
 * `CliError`/`Error` whose message is the only discriminator), so coverage
 * here drives confidence that friendly, actionable copy reaches the UI for
 * every known failure mode — including the empirically observed HTTP 402
 * "membership inactive" case (see `kimi-agent-bridge.md`).
 */
import { describe, expect, test } from "bun:test";

import { ProviderError } from "../../../util/errors.js";
import {
  classifyKimiAgentError,
  KIMI_AGENT_FRIENDLY_MESSAGES,
  KimiAgentBridgeError,
} from "../errors.js";

describe("classifyKimiAgentError", () => {
  test("ENOENT spawn → cli-not-installed", () => {
    const err = Object.assign(new Error("spawn kimi ENOENT"), {
      code: "ENOENT",
    });
    expect(classifyKimiAgentError(err)).toBe("cli-not-installed");
  });

  test("'command not found' → cli-not-installed", () => {
    expect(
      classifyKimiAgentError(new Error("/bin/sh: kimi: command not found")),
    ).toBe("cli-not-installed");
  });

  test("HTTP 402 membership → membership-inactive", () => {
    expect(
      classifyKimiAgentError(
        new Error(
          "Error code: 402 - We're unable to verify your membership benefits at this time. Please ensure your membership is active.",
        ),
      ),
    ).toBe("membership-inactive");
  });

  test("CHAT_PROVIDER_ERROR code → membership-inactive", () => {
    const err = Object.assign(new Error("chat provider failed"), {
      code: "CHAT_PROVIDER_ERROR",
    });
    expect(classifyKimiAgentError(err)).toBe("membership-inactive");
  });

  test("numeric -32003 in message → membership-inactive", () => {
    expect(
      classifyKimiAgentError(new Error("RPC failed with code -32003")),
    ).toBe("membership-inactive");
  });

  test("'not logged in' → not-logged-in", () => {
    expect(classifyKimiAgentError(new Error("kimi is not logged in"))).toBe(
      "not-logged-in",
    );
  });

  test("'no api key' / MOONSHOT_API_KEY missing → not-logged-in", () => {
    expect(
      classifyKimiAgentError(new Error("MOONSHOT_API_KEY is not set")),
    ).toBe("not-logged-in");
  });

  test("'401 unauthorized' → auth-failed", () => {
    expect(classifyKimiAgentError(new Error("HTTP 401 unauthorized"))).toBe(
      "auth-failed",
    );
  });

  test("'authentication failed' → auth-failed", () => {
    expect(classifyKimiAgentError(new Error("authentication failed"))).toBe(
      "auth-failed",
    );
  });

  test("EPIPE during stream → subprocess-crashed", () => {
    expect(classifyKimiAgentError(new Error("write EPIPE"))).toBe(
      "subprocess-crashed",
    );
  });

  test("'process exited with signal SIGTERM' → subprocess-crashed", () => {
    expect(
      classifyKimiAgentError(
        new Error("subprocess process exited with signal SIGTERM"),
      ),
    ).toBe("subprocess-crashed");
  });

  test("'timed out' → sdk-timeout", () => {
    expect(
      classifyKimiAgentError(new Error("Request timed out after 30s")),
    ).toBe("sdk-timeout");
  });

  test("'deadline exceeded' → sdk-timeout", () => {
    expect(classifyKimiAgentError(new Error("deadline exceeded"))).toBe(
      "sdk-timeout",
    );
  });

  test("unknown shape → unknown", () => {
    expect(
      classifyKimiAgentError(new Error("something completely unrelated")),
    ).toBe("unknown");
  });

  test("walks cause chain so wrapped errors classify correctly", () => {
    const inner = new Error("Error code: 402 - membership benefits");
    const outer = new Error("Provider failed", { cause: inner });
    expect(classifyKimiAgentError(outer)).toBe("membership-inactive");
  });

  test("ENOENT wins over downstream auth-shaped messages", () => {
    const err = Object.assign(
      new Error("spawn kimi ENOENT — 401 unauthorized response"),
      { code: "ENOENT" },
    );
    expect(classifyKimiAgentError(err)).toBe("cli-not-installed");
  });

  test("membership 402 wins over generic auth so the user sees the right fix", () => {
    // A 402 can co-occur with auth-shaped text; the actionable remediation
    // ("renew membership") differs from "re-auth", so 402 must win.
    expect(
      classifyKimiAgentError(
        new Error("Error code: 402 unauthorized — membership benefits"),
      ),
    ).toBe("membership-inactive");
  });

  test("null/undefined → unknown", () => {
    expect(classifyKimiAgentError(null)).toBe("unknown");
    expect(classifyKimiAgentError(undefined)).toBe("unknown");
  });

  test("string error → classified from its content", () => {
    expect(classifyKimiAgentError("Error code: 402 membership")).toBe(
      "membership-inactive",
    );
  });
});

describe("KimiAgentBridgeError", () => {
  test("extends ProviderError so existing catch blocks still match", () => {
    const err = new KimiAgentBridgeError("membership-inactive");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("KimiAgentBridgeError");
    expect(err.provider).toBe("kimi-agent");
  });

  test("uses the friendly message for the kind by default", () => {
    const err = new KimiAgentBridgeError("not-logged-in");
    expect(err.message).toBe(KIMI_AGENT_FRIENDLY_MESSAGES["not-logged-in"]);
  });

  test("unknown kind preserves the underlying error's message for diagnostics", () => {
    const cause = new Error("Network unreachable");
    const err = new KimiAgentBridgeError("unknown", { cause });
    expect(err.message).toContain("Network unreachable");
    expect(err.kind).toBe("unknown");
  });

  test("unknown kind with no cause falls back to the canned copy", () => {
    const err = new KimiAgentBridgeError("unknown");
    expect(err.message).toBe(KIMI_AGENT_FRIENDLY_MESSAGES["unknown"]);
  });

  test("custom message overrides the canned copy", () => {
    const err = new KimiAgentBridgeError("unknown", {
      message: "Custom diagnostic from the SDK",
    });
    expect(err.message).toBe("Custom diagnostic from the SDK");
    expect(err.kind).toBe("unknown");
  });

  test("preserves the underlying cause + statusCode for diagnostics", () => {
    const cause = new Error("inner failure");
    const err = new KimiAgentBridgeError("membership-inactive", {
      cause,
      statusCode: 402,
    });
    expect(err.cause).toBe(cause);
    expect(err.statusCode).toBe(402);
  });

  test("fromUnknown() classifies and wraps in one step", () => {
    const cause = new Error("Error code: 402 - membership benefits inactive");
    const err = KimiAgentBridgeError.fromUnknown(cause, { statusCode: 402 });
    expect(err.kind).toBe("membership-inactive");
    expect(err.message).toBe(
      KIMI_AGENT_FRIENDLY_MESSAGES["membership-inactive"],
    );
    expect(err.cause).toBe(cause);
    expect(err.statusCode).toBe(402);
  });
});
