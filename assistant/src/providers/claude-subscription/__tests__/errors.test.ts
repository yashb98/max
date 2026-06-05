/**
 * Tests for `ClaudeSubscriptionBridgeError` + `classifyClaudeSubscriptionError`.
 *
 * Phase 3.2 in `docs/architecture/claude-subscription-bridge.md`. The
 * classifier is pattern-based, so coverage here drives confidence that
 * the friendly messages reach the UI for every known failure mode.
 */
import { describe, expect, test } from "bun:test";

import { ProviderError } from "../../../util/errors.js";
import {
  CLAUDE_SUBSCRIPTION_FRIENDLY_MESSAGES,
  ClaudeSubscriptionBridgeError,
  classifyClaudeSubscriptionError,
} from "../errors.js";

describe("classifyClaudeSubscriptionError", () => {
  test("ENOENT spawn → cli-not-installed", () => {
    const err = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
    });
    expect(classifyClaudeSubscriptionError(err)).toBe("cli-not-installed");
  });

  test("'command not found' → cli-not-installed", () => {
    expect(
      classifyClaudeSubscriptionError(new Error("/bin/sh: claude: command not found")),
    ).toBe("cli-not-installed");
  });

  test("'Token expired' → token-expired", () => {
    expect(classifyClaudeSubscriptionError(new Error("Token expired"))).toBe(
      "token-expired",
    );
  });

  test("'OAuth token invalid' → token-expired (generic auth fallback)", () => {
    expect(
      classifyClaudeSubscriptionError(new Error("OAuth token invalid")),
    ).toBe("token-expired");
  });

  test("'Not signed in' → not-logged-in", () => {
    expect(
      classifyClaudeSubscriptionError(new Error("Claude Code is not signed in")),
    ).toBe("not-logged-in");
  });

  test("'Please run `claude login`' → not-logged-in", () => {
    expect(
      classifyClaudeSubscriptionError(
        new Error("Please run `claude login` to authenticate"),
      ),
    ).toBe("not-logged-in");
  });

  test("'401 unauthorized' → token-expired", () => {
    expect(
      classifyClaudeSubscriptionError(new Error("HTTP 401 unauthorized")),
    ).toBe("token-expired");
  });

  test("EPIPE during stream → subprocess-crashed", () => {
    expect(
      classifyClaudeSubscriptionError(new Error("write EPIPE")),
    ).toBe("subprocess-crashed");
  });

  test("'process exited with signal SIGTERM' → subprocess-crashed", () => {
    expect(
      classifyClaudeSubscriptionError(
        new Error("subprocess process exited with signal SIGTERM"),
      ),
    ).toBe("subprocess-crashed");
  });

  test("'timed out' → sdk-timeout", () => {
    expect(
      classifyClaudeSubscriptionError(new Error("Request timed out after 30s")),
    ).toBe("sdk-timeout");
  });

  test("'deadline exceeded' → sdk-timeout", () => {
    expect(
      classifyClaudeSubscriptionError(new Error("deadline exceeded")),
    ).toBe("sdk-timeout");
  });

  test("unknown shape → unknown", () => {
    expect(
      classifyClaudeSubscriptionError(new Error("something completely unrelated")),
    ).toBe("unknown");
  });

  test("walks cause chain so wrapped errors classify correctly", () => {
    const inner = new Error("Token expired");
    const outer = new Error("Provider failed", { cause: inner });
    expect(classifyClaudeSubscriptionError(outer)).toBe("token-expired");
  });

  test("ENOENT wins over downstream auth-shaped messages", () => {
    // A missing CLI can produce confusing auth-shaped error text downstream;
    // the classifier must catch ENOENT first so the user sees "install
    // Claude Code", not "run claude login".
    const err = Object.assign(
      new Error("spawn claude ENOENT — 401 unauthorized response"),
      { code: "ENOENT" },
    );
    expect(classifyClaudeSubscriptionError(err)).toBe("cli-not-installed");
  });

  test("null/undefined → unknown", () => {
    expect(classifyClaudeSubscriptionError(null)).toBe("unknown");
    expect(classifyClaudeSubscriptionError(undefined)).toBe("unknown");
  });

  test("string error → classified from its content", () => {
    expect(classifyClaudeSubscriptionError("Token expired")).toBe(
      "token-expired",
    );
  });
});

describe("ClaudeSubscriptionBridgeError", () => {
  test("extends ProviderError so existing catch blocks still match", () => {
    const err = new ClaudeSubscriptionBridgeError("token-expired");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ClaudeSubscriptionBridgeError");
    expect(err.provider).toBe("claude-subscription");
  });

  test("uses the friendly message for the kind by default", () => {
    const err = new ClaudeSubscriptionBridgeError("not-logged-in");
    expect(err.message).toBe(
      CLAUDE_SUBSCRIPTION_FRIENDLY_MESSAGES["not-logged-in"],
    );
  });

  test("unknown kind preserves the underlying error's message for diagnostics", () => {
    const cause = new Error("Network unreachable");
    const err = new ClaudeSubscriptionBridgeError("unknown", { cause });
    expect(err.message).toContain("Network unreachable");
    expect(err.kind).toBe("unknown");
  });

  test("unknown kind with no cause falls back to the canned copy", () => {
    const err = new ClaudeSubscriptionBridgeError("unknown");
    expect(err.message).toBe(CLAUDE_SUBSCRIPTION_FRIENDLY_MESSAGES["unknown"]);
  });

  test("custom message overrides the canned copy", () => {
    const err = new ClaudeSubscriptionBridgeError("unknown", {
      message: "Custom diagnostic from the SDK",
    });
    expect(err.message).toBe("Custom diagnostic from the SDK");
    expect(err.kind).toBe("unknown");
  });

  test("preserves the underlying cause for diagnostics", () => {
    const cause = new Error("inner failure");
    const err = new ClaudeSubscriptionBridgeError("token-expired", {
      cause,
      statusCode: 401,
    });
    expect(err.cause).toBe(cause);
    expect(err.statusCode).toBe(401);
  });

  test("fromUnknown() classifies and wraps in one step", () => {
    const cause = new Error("Please run `claude login`");
    const err = ClaudeSubscriptionBridgeError.fromUnknown(cause, {
      statusCode: 401,
    });
    expect(err.kind).toBe("not-logged-in");
    expect(err.message).toBe(
      CLAUDE_SUBSCRIPTION_FRIENDLY_MESSAGES["not-logged-in"],
    );
    expect(err.cause).toBe(cause);
    expect(err.statusCode).toBe(401);
  });
});
