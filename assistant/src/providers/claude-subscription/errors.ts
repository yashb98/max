/**
 * Provider-specific error hierarchy for the claude-subscription bridge.
 *
 * The Agent SDK surfaces failures through generic `Error` objects whose
 * messages are the only place to recover discriminating signal. Vellum
 * wants those failures to reach the UI with actionable copy ("run
 * `claude login`") rather than a stack trace, so this module classifies
 * each known failure mode into a discriminator (`kind`) and pairs it
 * with a friendly user-facing message.
 *
 * Spec: Phase 3.2 in `docs/architecture/claude-subscription-bridge.md`.
 *
 * The classifier is pattern-based by necessity — the SDK gives us no
 * structured error type. Each kind has its own set of regexes informed
 * by:
 *   - Real auth-error messages observed during D-5 retry development
 *     ("Token expired", "401 unauthorized", "OAuth token invalid", …)
 *   - Node-level spawn failures (`ENOENT`, "no such file")
 *   - Subprocess lifecycle errors (`EPIPE`, "exit", "signal", crash)
 *   - Timeout shapes (`AbortError` with timeout reason, "deadline
 *     exceeded")
 *
 * When new failure modes are observed in production, add a regex here
 * rather than re-throwing the raw SDK error — that's the only way the
 * UI can give the user something to act on.
 */
import { ProviderError } from "../../util/errors.js";

/**
 * Stable discriminator for the bridge error subtype. The UI may switch
 * on this value to drive reason-specific behavior (e.g. linking
 * directly to the picker setup hint, offering "Switch to API key"
 * fallback).
 */
export type ClaudeSubscriptionBridgeErrorKind =
  | "cli-not-installed"
  | "not-logged-in"
  | "token-expired"
  | "sdk-timeout"
  | "subprocess-crashed"
  | "unknown";

/**
 * User-facing message for each error kind. Kept short and imperative
 * so the macOS error banner can render them verbatim without
 * truncation. Do NOT include URLs that may rot — the runbook
 * (`docs/runbook-claude-subscription.md`) is the durable diagnostic
 * surface.
 */
export const CLAUDE_SUBSCRIPTION_FRIENDLY_MESSAGES: Record<
  ClaudeSubscriptionBridgeErrorKind,
  string
> = {
  "cli-not-installed":
    "Claude Code is not installed. Install it from claude.com/code, then retry.",
  "not-logged-in":
    "Claude Code is not signed in. Run `claude login` in your terminal to authenticate your Max subscription, then retry.",
  "token-expired":
    "Your Claude subscription token has expired. Run `claude login` in your terminal to refresh, then retry.",
  "sdk-timeout":
    "The Claude subprocess took too long to respond. Check your network connection and retry.",
  "subprocess-crashed":
    "The Claude subprocess crashed unexpectedly. Retry the request; if it persists, run `claude --version` to verify your installation.",
  unknown:
    "Claude subscription provider failed unexpectedly. Retry, or switch to a different provider.",
};

const TOKEN_EXPIRED_PATTERNS: RegExp[] = [
  /token\s+(expired|revoked)/i,
  /oauth.*(expired|revoked)/i,
  /credential.*expired/i,
];

const NOT_LOGGED_IN_PATTERNS: RegExp[] = [
  /not\s+(logged|signed)\s+in/i,
  /no\s+credentials/i,
  /please\s+(re)?(run|do)\s*`?claude\s+login`?/i,
  /no\s+oauth\s+token/i,
];

const GENERIC_AUTH_PATTERNS: RegExp[] = [
  /\b401\b/,
  /\bhttp\s*401\b/i,
  /unauthorized/i,
  /authentication\s+failed/i,
  /invalid[_\s-]?credentials/i,
  /token\s+invalid/i,
];

const CLI_MISSING_PATTERNS: RegExp[] = [
  /\bENOENT\b/,
  /spawn\s+claude\b/i,
  /no\s+such\s+file\b/i,
  /command\s+not\s+found/i,
];

const TIMEOUT_PATTERNS: RegExp[] = [
  /timed\s*out/i,
  /\btimeout\b/i,
  /deadline\s+exceeded/i,
];

const SUBPROCESS_CRASH_PATTERNS: RegExp[] = [
  /\bEPIPE\b/,
  /\bECONNRESET\b/,
  /subprocess.*(crash|killed|exit)/i,
  /process\s+exited\s+with\s+(code|signal)/i,
  /spawn.*(failed|error)/i,
];

/**
 * Best-effort classification of an Agent-SDK error into one of the known
 * bridge failure modes. Walks the `cause` chain so wrapped errors are
 * inspected too. Order matters: more specific patterns win over generic
 * auth so "token expired" doesn't get swallowed by the generic 401 case.
 */
export function classifyClaudeSubscriptionError(
  err: unknown,
): ClaudeSubscriptionBridgeErrorKind {
  if (err == null) return "unknown";

  // Walk the cause chain so wrapped errors contribute their messages.
  const messages: string[] = [];
  let cursor: unknown = err;
  // Bound the walk to avoid runaway on cyclic causes.
  for (let i = 0; i < 5 && cursor != null; i++) {
    if (cursor instanceof Error) {
      messages.push(cursor.message);
      // Node spawn errors carry a `code` property (`ENOENT`, `EPIPE`).
      const nodeCode = (cursor as NodeJS.ErrnoException).code;
      if (typeof nodeCode === "string") messages.push(nodeCode);
      cursor = (cursor as Error & { cause?: unknown }).cause;
    } else {
      messages.push(String(cursor));
      break;
    }
  }
  const haystack = messages.join(" | ");

  // CLI missing wins — it's the only kind that means "the binary itself
  // is gone", which fixes via install (not login). Check this before
  // any auth pattern (a missing CLI can produce confusing downstream
  // auth-shaped errors).
  if (CLI_MISSING_PATTERNS.some((re) => re.test(haystack))) {
    return "cli-not-installed";
  }
  // Specific auth subtypes before the generic 401 catch-all.
  if (TOKEN_EXPIRED_PATTERNS.some((re) => re.test(haystack))) {
    return "token-expired";
  }
  if (NOT_LOGGED_IN_PATTERNS.some((re) => re.test(haystack))) {
    return "not-logged-in";
  }
  if (GENERIC_AUTH_PATTERNS.some((re) => re.test(haystack))) {
    // Default generic 401-style auth failures to "token-expired" — the
    // user-facing remediation (`claude login`) is the same and that
    // copy is the most common outcome.
    return "token-expired";
  }
  if (SUBPROCESS_CRASH_PATTERNS.some((re) => re.test(haystack))) {
    return "subprocess-crashed";
  }
  if (TIMEOUT_PATTERNS.some((re) => re.test(haystack))) {
    return "sdk-timeout";
  }
  return "unknown";
}

/**
 * Provider error specialized for the claude-subscription bridge. Carries
 * a `kind` discriminator so consumers can render reason-specific UX or
 * route to specific recovery flows without re-classifying the message.
 *
 * Extends `ProviderError` so existing handlers that catch `ProviderError`
 * continue to function — they'll see the friendly message in
 * `.message` and the provider name in `.provider`.
 */
export class ClaudeSubscriptionBridgeError extends ProviderError {
  public readonly kind: ClaudeSubscriptionBridgeErrorKind;

  constructor(
    kind: ClaudeSubscriptionBridgeErrorKind,
    options?: {
      cause?: unknown;
      statusCode?: number;
      message?: string;
    },
  ) {
    // For unclassified errors, preserve the underlying message so the
    // user sees the actual diagnostic (e.g. "Network unreachable")
    // instead of a generic "failed unexpectedly". Known kinds always
    // get the canned friendly copy unless an explicit `message`
    // override is supplied.
    const causeMessage =
      options?.cause instanceof Error ? options.cause.message : undefined;
    const message =
      options?.message ??
      (kind === "unknown" && causeMessage
        ? `Claude subscription provider error: ${causeMessage}`
        : CLAUDE_SUBSCRIPTION_FRIENDLY_MESSAGES[kind]);
    super(message, "claude-subscription", options?.statusCode, {
      cause: options?.cause,
    });
    this.name = "ClaudeSubscriptionBridgeError";
    this.kind = kind;
  }

  /**
   * Construct a `ClaudeSubscriptionBridgeError` by classifying an
   * underlying SDK error. Convenience helper so call sites don't have
   * to know which `kind` to pick.
   */
  static fromUnknown(
    err: unknown,
    overrides?: { statusCode?: number },
  ): ClaudeSubscriptionBridgeError {
    const kind = classifyClaudeSubscriptionError(err);
    return new ClaudeSubscriptionBridgeError(kind, {
      cause: err,
      statusCode: overrides?.statusCode,
    });
  }
}
