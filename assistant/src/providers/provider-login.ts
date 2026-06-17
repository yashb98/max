/**
 * Provider login orchestration.
 *
 * Drives an agentic provider's OAuth/login flow from inside the daemon so
 * the macOS client can offer a "Sign in" button instead of asking the user
 * to run a terminal command. The OAuth URL is surfaced to the caller via the
 * `onUrl` callback (the route wires this to `openInHostBrowser`, which the
 * macOS app turns into a browser open).
 *
 * Asymmetry between providers (verified against each SDK):
 *   - kimi-agent: `@moonshot-ai/kimi-agent-sdk` exposes a programmatic
 *     `login({ onUrl })` that runs OAuth and writes the token to
 *     `~/.kimi/config.toml`.
 *   - claude-subscription: `@anthropic-ai/claude-agent-sdk` has no login API;
 *     login goes through the interactive `claude` CLI. Implemented separately.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { login as kimiLogin } from "@moonshot-ai/kimi-agent-sdk";

import { getLogger } from "../util/logger.js";
import {
  clearClaudeSubscriptionAvailabilityCache,
  clearKimiAgentAvailabilityCache,
} from "./provider-availability.js";

const log = getLogger("provider-login");
const execFileAsync = promisify(execFile);

export type ProviderLoginReason =
  | "unsupported-provider"
  | "cli-error"
  | "cancelled"
  | "no-token-captured"
  | "subscription-required";

export interface ProviderLoginResult {
  success: boolean;
  reason?: ProviderLoginReason;
  error?: string;
}

export interface ProviderLoginOptions {
  /** Called with the OAuth URL the user must visit to authorize. */
  onUrl: (url: string) => void;
}

export interface ProviderLoginDeps {
  /** Test seam: read claude login state. Defaults to the real CLI probe. */
  getClaudeAuthStatus?: () => Promise<{ loggedIn?: boolean } | null>;
}

export async function loginProvider(
  provider: string,
  options: ProviderLoginOptions,
  deps: ProviderLoginDeps = {},
): Promise<ProviderLoginResult> {
  switch (provider) {
    case "kimi-agent":
      return loginKimiAgent(options);
    case "claude-subscription":
      return loginClaudeSubscription(deps);
    default:
      log.warn({ provider }, "login requested for unsupported provider");
      return { success: false, reason: "unsupported-provider" };
  }
}

async function loginKimiAgent(
  options: ProviderLoginOptions,
): Promise<ProviderLoginResult> {
  try {
    const result = await kimiLogin({ onUrl: (url) => options.onUrl(url) });
    if (!result.success) {
      return { success: false, reason: "cli-error", error: result.error };
    }
    // Token is now in ~/.kimi/config.toml; re-evaluate availability.
    clearKimiAgentAvailabilityCache();
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, "kimi-agent login threw");
    return { success: false, reason: "cli-error", error: message };
  }
}

// claude-subscription has no programmatic OAuth: its `setup-token` flow is a
// TTY-only UI (it emits nothing on a pipe and blocks), so the daemon cannot
// drive a fresh interactive sign-in without a PTY. The credential itself is
// managed by the `claude` CLI (macOS Keychain). What we CAN do without a TTY
// is read `claude auth status`, which prints login state as JSON on stdout.
// So Max's "Sign in" detects a CLI-side login and refreshes availability;
// when not logged in, it returns actionable guidance pointing at the terminal.
async function loginClaudeSubscription(
  deps: ProviderLoginDeps,
): Promise<ProviderLoginResult> {
  const status = await (deps.getClaudeAuthStatus ?? getClaudeAuthStatus)();
  if (status === null) {
    return {
      success: false,
      reason: "cli-error",
      error:
        "Couldn't read Claude sign-in state. Make sure Claude Code is installed, then run `claude auth login` in a terminal.",
    };
  }
  if (status.loggedIn === true) {
    clearClaudeSubscriptionAvailabilityCache();
    return { success: true };
  }
  return {
    success: false,
    reason: "no-token-captured",
    error:
      "Run `claude auth login` in a terminal to sign in to your Claude subscription, then tap Sign in again.",
  };
}

/** Resolve the `claude` binary off PATH (the daemon's PATH may omit it). */
async function resolveClaudeCliPath(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", ["claude"], {
      timeout: 2000,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Read `claude auth status` as JSON. Returns the parsed object, or `null` when
 * the CLI is missing or its output can't be parsed. `auth status` may exit
 * non-zero while still printing `{ "loggedIn": false }` to stdout, so we
 * recover stdout from the rejection before giving up.
 */
async function getClaudeAuthStatus(): Promise<{ loggedIn?: boolean } | null> {
  const claudePath = await resolveClaudeCliPath();
  if (!claudePath) return null;
  try {
    const { stdout } = await execFileAsync(claudePath, ["auth", "status"], {
      timeout: 5000,
    });
    return JSON.parse(stdout) as { loggedIn?: boolean };
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim().length > 0) {
      try {
        return JSON.parse(stdout) as { loggedIn?: boolean };
      } catch {
        // fall through
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, "claude auth status failed");
    return null;
  }
}
