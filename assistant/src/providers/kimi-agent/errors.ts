/**
 * Provider-specific error hierarchy for the kimi-agent bridge.
 *
 * `@moonshot-ai/kimi-agent-sdk` surfaces failures through generic `Error` /
 * `CliError` objects whose message (and occasionally a `code` property) is the
 * only place to recover discriminating signal. Vellum wants those failures to
 * reach the UI with actionable copy ("renew your Kimi membership", "run
 * `kimi /login`") rather than a stack trace, so this module classifies each
 * known failure mode into a discriminator (`kind`) paired with a friendly
 * user-facing message.
 *
 * Spec: Phase 3 Task 16 in
 * `docs/superpowers/plans/2026-05-23-kimi-agent-sdk-provider.md`. The
 * `membership-inactive` kind and its 402 / `CHAT_PROVIDER_ERROR` / `-32003`
 * patterns are grounded in the empirically observed Phase 0 failure recorded
 * in `docs/architecture/kimi-agent-bridge.md` — that error is raised OFF the
 * async-iterator path, so the provider must wrap SDK calls in a boundary that
 * classifies through this module.
 */
import { ProviderError } from "../../util/errors.js";

/**
 * Stable discriminator for the bridge error subtype. The UI may switch on
 * this value to drive reason-specific behavior (link to the picker setup
 * hint, offer "renew membership", etc.).
 */
export type KimiAgentBridgeErrorKind =
  | "cli-not-installed"
  | "not-logged-in"
  | "membership-inactive"
  | "auth-failed"
  | "sdk-timeout"
  | "subprocess-crashed"
  | "unknown";

/**
 * User-facing message for each error kind. Kept short and imperative so the
 * macOS error banner can render them verbatim. Do NOT include URLs that may
 * rot — the runbook (`docs/runbook-kimi-agent.md`) is the durable diagnostic
 * surface.
 */
export const KIMI_AGENT_FRIENDLY_MESSAGES: Record<
  KimiAgentBridgeErrorKind,
  string
> = {
  "cli-not-installed": "The Kimi CLI is not installed. Install it, then retry.",
  "not-logged-in":
    "Kimi is not signed in. Run `kimi /login` in your terminal (or set MOONSHOT_API_KEY), then retry.",
  "membership-inactive":
    "Your Kimi membership is inactive. Renew it to use the Kimi agent provider, then retry.",
  "auth-failed":
    "Kimi authentication failed. Run `kimi /login` to re-authenticate, then retry.",
  "sdk-timeout":
    "The Kimi subprocess took too long to respond. Check your network connection and retry.",
  "subprocess-crashed":
    "The Kimi subprocess crashed unexpectedly. Retry the request; if it persists, run `kimi --version` to verify your installation.",
  unknown:
    "Kimi agent provider failed unexpectedly. Retry, or switch to a different provider.",
};

// HTTP 402 + the SDK's CHAT_PROVIDER_ERROR (numeric -32003) are the verified
// shapes of the "membership benefits not verified" failure (kimi-agent-bridge.md).
const MEMBERSHIP_PATTERNS: RegExp[] = [
  /\b402\b/,
  /membership/i,
  /CHAT_PROVIDER_ERROR/i,
  /-32003\b/,
];

const CLI_MISSING_PATTERNS: RegExp[] = [
  /\bENOENT\b/,
  /spawn\s+kimi\b/i,
  /no\s+such\s+file\b/i,
  /command\s+not\s+found/i,
];

const NOT_LOGGED_IN_PATTERNS: RegExp[] = [
  /not\s+(logged|signed)\s+in/i,
  /no\s+credentials/i,
  /please\s+(re)?(run|do)\s*`?kimi\s*\/?login`?/i,
  /MOONSHOT_API_KEY/i,
  /no\s+api\s*key/i,
];

const AUTH_FAILED_PATTERNS: RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /authentication\s+failed/i,
  /invalid[_\s-]?credentials/i,
  /token\s+(invalid|expired|revoked)/i,
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
 * Best-effort classification of an SDK error into one of the known bridge
 * failure modes. Walks the `cause` chain so wrapped errors are inspected too.
 * Order matters:
 *   - CLI-missing wins (it means the binary itself is gone → fix via install,
 *     not login; a missing CLI can produce confusing auth-shaped downstream
 *     errors).
 *   - membership-inactive (402) beats generic auth: the remediation ("renew
 *     membership") differs from "re-authenticate", and the two can co-occur.
 */
export function classifyKimiAgentError(err: unknown): KimiAgentBridgeErrorKind {
  if (err == null) return "unknown";

  const messages: string[] = [];
  let cursor: unknown = err;
  // Bound the walk to avoid runaway on cyclic causes.
  for (let i = 0; i < 5 && cursor != null; i++) {
    if (cursor instanceof Error) {
      messages.push(cursor.message);
      // Node spawn errors carry a `code` (`ENOENT`, `EPIPE`); the Kimi SDK
      // tags its membership failure with `code: "CHAT_PROVIDER_ERROR"`.
      const nodeCode = (cursor as NodeJS.ErrnoException).code;
      if (typeof nodeCode === "string") messages.push(nodeCode);
      cursor = (cursor as Error & { cause?: unknown }).cause;
    } else {
      messages.push(String(cursor));
      break;
    }
  }
  const haystack = messages.join(" | ");

  if (CLI_MISSING_PATTERNS.some((re) => re.test(haystack))) {
    return "cli-not-installed";
  }
  if (MEMBERSHIP_PATTERNS.some((re) => re.test(haystack))) {
    return "membership-inactive";
  }
  if (NOT_LOGGED_IN_PATTERNS.some((re) => re.test(haystack))) {
    return "not-logged-in";
  }
  if (AUTH_FAILED_PATTERNS.some((re) => re.test(haystack))) {
    return "auth-failed";
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
 * Provider error specialized for the kimi-agent bridge. Carries a `kind`
 * discriminator so consumers can render reason-specific UX without
 * re-classifying the message. Extends `ProviderError` so existing handlers
 * that catch `ProviderError` continue to function.
 */
export class KimiAgentBridgeError extends ProviderError {
  public readonly kind: KimiAgentBridgeErrorKind;

  constructor(
    kind: KimiAgentBridgeErrorKind,
    options?: {
      cause?: unknown;
      statusCode?: number;
      message?: string;
    },
  ) {
    // For unclassified errors, preserve the underlying message so the user
    // sees the actual diagnostic instead of a generic "failed unexpectedly".
    // Known kinds always get the canned friendly copy unless an explicit
    // `message` override is supplied.
    const causeMessage =
      options?.cause instanceof Error ? options.cause.message : undefined;
    const message =
      options?.message ??
      (kind === "unknown" && causeMessage
        ? `Kimi agent provider error: ${causeMessage}`
        : KIMI_AGENT_FRIENDLY_MESSAGES[kind]);
    super(message, "kimi-agent", options?.statusCode, {
      cause: options?.cause,
    });
    this.name = "KimiAgentBridgeError";
    this.kind = kind;
  }

  /**
   * Construct a `KimiAgentBridgeError` by classifying an underlying SDK
   * error. Convenience helper so call sites don't have to pick the `kind`.
   */
  static fromUnknown(
    err: unknown,
    overrides?: { statusCode?: number },
  ): KimiAgentBridgeError {
    const kind = classifyKimiAgentError(err);
    return new KimiAgentBridgeError(kind, {
      cause: err,
      statusCode: overrides?.statusCode,
    });
  }
}
