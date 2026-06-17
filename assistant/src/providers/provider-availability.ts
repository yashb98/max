/**
 * Provider availability checks.
 *
 * Determines which LLM providers are usable by checking secure storage,
 * environment variable fallbacks, and managed proxy availability.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { API_KEY_PROVIDERS } from "../config/loader.js";
import type { AssistantConfig } from "../config/schema.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import { PROVIDER_CATALOG } from "./model-catalog.js";
import { managedFallbackEnabledFor } from "./platform-proxy/context.js";

const log = getLogger("provider-availability");
const execFileAsync = promisify(execFile);

/**
 * Check whether the Claude Code CLI is installed AND the user has run
 * `claude login` (an OAuth token is present in the OS Keychain).
 *
 * Two checks:
 *   1. `which claude` resolves to a binary (PATH check).
 *   2. `security find-generic-password -s "Claude Code-credentials"` finds
 *      a Keychain entry (macOS only — on other OSes Claude Code stores the
 *      token in `~/.claude/.credentials.json`).
 *
 * Result is cached for the lifetime of the process. The cache is busted
 * on `clearClaudeSubscriptionAvailabilityCache()` so tests can re-evaluate.
 */
/**
 * Cached result of the CLI + login probes for claude-subscription. Stores
 * the *derived* `{ available, reason? }` based on filesystem/keychain
 * state — does NOT include the feature-flag dimension (the flag is read
 * fresh on every call so runtime toggles take effect immediately).
 *
 * Known limitation: the cache is module-level and NOT keyed by the
 * `ClaudeSubscriptionProbes` identity. Tests that exercise multiple
 * probe sets in one process MUST call
 * `clearClaudeSubscriptionAvailabilityCache()` between sets, or stale
 * results from an earlier probe set will be returned.
 */
let claudeSubscriptionCliLoginCache: ProviderAvailabilityStatus | undefined;

export function clearClaudeSubscriptionAvailabilityCache(): void {
  claudeSubscriptionCliLoginCache = undefined;
}

/**
 * Probe overrides for the claude-subscription availability check. Exists
 * so callers (tests in particular) can replace the real
 * `which`/`security`/`fs.access` subprocesses with deterministic mocks —
 * the production `promisify(execFile)` references are captured at module
 * load and `bun:test`'s `mock.module` does not propagate through them.
 *
 * Production callers do not pass `probes`; the defaults below are the
 * same real-subprocess implementations the module has always used.
 */
export interface ClaudeSubscriptionProbes {
  cliPresent?: () => Promise<boolean>;
  loginPresent?: () => Promise<boolean>;
}

async function getClaudeSubscriptionCliLoginStatus(
  probes: ClaudeSubscriptionProbes = {},
): Promise<ProviderAvailabilityStatus> {
  if (claudeSubscriptionCliLoginCache !== undefined) {
    return claudeSubscriptionCliLoginCache;
  }
  const cliPresent = await (probes.cliPresent ?? isClaudeCliInstalled)();
  if (!cliPresent) {
    log.info("claude CLI not on PATH; claude-subscription unavailable");
    claudeSubscriptionCliLoginCache = { available: false, reason: "missing-cli" };
    return claudeSubscriptionCliLoginCache;
  }
  const loggedIn = await (probes.loginPresent ?? isClaudeCliLoggedIn)();
  if (!loggedIn) {
    log.info(
      "claude CLI present but no OAuth credential found (run `claude login`); claude-subscription unavailable",
    );
    claudeSubscriptionCliLoginCache = { available: false, reason: "not-logged-in" };
    return claudeSubscriptionCliLoginCache;
  }
  claudeSubscriptionCliLoginCache = { available: true };
  return claudeSubscriptionCliLoginCache;
}

async function isClaudeCliInstalled(): Promise<boolean> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(cmd, ["claude"], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

async function isClaudeCliLoggedIn(): Promise<boolean> {
  if (process.platform === "darwin") {
    try {
      await execFileAsync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials"],
        { timeout: 2000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  // Linux / Windows: Claude Code stores credentials at ~/.claude/.credentials.json
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return false;
  try {
    const fs = await import("node:fs/promises");
    const credPath = `${home}/.claude/.credentials.json`;
    await fs.access(credPath);
    return true;
  } catch {
    return false;
  }
}

async function isClaudeSubscriptionAvailable(
  probes: ClaudeSubscriptionProbes = {},
): Promise<boolean> {
  const status = await getClaudeSubscriptionCliLoginStatus(probes);
  return status.available;
}

// ---------------------------------------------------------------------------
// kimi-agent availability
// ---------------------------------------------------------------------------

/**
 * Cached result of the CLI + login probes for kimi-agent. Stores the
 * *derived* `{ available, reason? }` based on filesystem/PATH state — does
 * NOT include the feature-flag dimension (the flag is read fresh on every
 * call so runtime toggles take effect immediately).
 *
 * Tests MUST call `clearKimiAgentAvailabilityCache()` between probe sets.
 */
let kimiAgentCliLoginCache: ProviderAvailabilityStatus | undefined;

export function clearKimiAgentAvailabilityCache(): void {
  kimiAgentCliLoginCache = undefined;
}

/**
 * Probe overrides for the kimi-agent availability check. Allows tests to
 * replace real `which`/`fs.access` calls with deterministic mocks.
 *
 * Production callers do not pass `probes`; the defaults are the same
 * real-subprocess implementations the module uses for claude-subscription.
 */
export interface KimiAgentProbes {
  cliPresent?: () => Promise<boolean>;
  loginPresent?: () => Promise<boolean>;
}

async function isKimiCliInstalled(): Promise<boolean> {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(cmd, ["kimi"], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

async function isKimiConfigPresent(): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    await fs.access(join(homedir(), ".kimi", "config.toml"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Default `loginPresent` probe: checks vault key first, then
 * `~/.kimi/config.toml`. Both paths represent a valid Kimi/Moonshot
 * credential. The probe contract is: return `true` if any auth credential
 * for kimi-agent is present, `false` otherwise.
 */
async function isKimiLoginPresent(): Promise<boolean> {
  if (await getProviderKeyAsync("kimi-agent")) return true;
  return isKimiConfigPresent();
}

async function getKimiAgentCliLoginStatus(
  probes: KimiAgentProbes = {},
): Promise<ProviderAvailabilityStatus> {
  if (kimiAgentCliLoginCache !== undefined) {
    return kimiAgentCliLoginCache;
  }
  const cliPresent = await (probes.cliPresent ?? isKimiCliInstalled)();
  if (!cliPresent) {
    log.info("kimi CLI not on PATH; kimi-agent unavailable");
    kimiAgentCliLoginCache = { available: false, reason: "missing-cli" };
    return kimiAgentCliLoginCache;
  }
  // Check for a vault key or ~/.kimi/config.toml login session.
  const hasAuth = await (probes.loginPresent ?? isKimiLoginPresent)();
  if (!hasAuth) {
    log.info(
      "kimi CLI present but no API key or config.toml found; kimi-agent unavailable",
    );
    kimiAgentCliLoginCache = { available: false, reason: "no-api-key" };
    return kimiAgentCliLoginCache;
  }
  kimiAgentCliLoginCache = { available: true };
  return kimiAgentCliLoginCache;
}

/**
 * Reason a provider is unavailable. Used by the picker's setup-hint UX to
 * render specific copy (e.g. "Install Claude Code" vs "Run `claude login`")
 * rather than a generic "not available" badge. See
 * `assistant/docs/architecture/claude-subscription-picker-setup-hint.md`.
 */
export type ProviderAvailabilityReason =
  | "missing-cli"
  | "not-logged-in"
  | "not-enabled"
  | "no-api-key";

/**
 * Typed result of an availability check. `reason` is set only when
 * `available === false`; when available, callers should treat any `reason`
 * field as informational at best.
 */
export interface ProviderAvailabilityStatus {
  available: boolean;
  reason?: ProviderAvailabilityReason;
}

/**
 * Detailed availability check for a single provider. Mirrors
 * `isProviderAvailable` but returns a typed reason on failure so the
 * macOS picker can render reason-specific setup hints.
 *
 * Phase 1: ollama always available; claude-subscription wraps the existing
 * boolean check; api-key providers report `"no-api-key"` on failure.
 * Phase 2 enriches the claude-subscription branch with feature-flag
 * awareness and CLI/login reason discrimination.
 */
export async function getProviderAvailabilityStatus(
  provider: string,
  probes: ClaudeSubscriptionProbes & KimiAgentProbes = {},
): Promise<ProviderAvailabilityStatus> {
  if (provider === "ollama") return { available: true };
  if (provider === "claude-subscription") {
    if (
      !isAssistantFeatureFlagEnabled(
        "claude-subscription-provider",
        {} as AssistantConfig,
      )
    ) {
      return { available: false, reason: "not-enabled" };
    }
    return getClaudeSubscriptionCliLoginStatus(probes);
  }
  if (provider === "kimi-agent") {
    if (
      !isAssistantFeatureFlagEnabled(
        "kimi-agent-provider",
        {} as AssistantConfig,
      )
    ) {
      return { available: false, reason: "not-enabled" };
    }
    return getKimiAgentCliLoginStatus(probes);
  }
  const ok =
    !!(await getProviderKeyAsync(provider)) ||
    !!(await managedFallbackEnabledFor(provider));
  return ok ? { available: true } : { available: false, reason: "no-api-key" };
}

/**
 * Build an availability map keyed by provider id for every entry in
 * `PROVIDER_CATALOG`. Used by the macOS picker to render reason-specific
 * setup hints; see
 * `assistant/docs/architecture/claude-subscription-picker-setup-hint.md`.
 */
export async function getAllProviderAvailability(
  probes: ClaudeSubscriptionProbes & KimiAgentProbes = {},
): Promise<Record<string, ProviderAvailabilityStatus>> {
  const result: Record<string, ProviderAvailabilityStatus> = {};
  for (const entry of PROVIDER_CATALOG) {
    result[entry.id] = await getProviderAvailabilityStatus(entry.id, probes);
  }
  // Ollama is always considered available even if the catalog representation
  // changes; defensive guard so consumers can rely on its presence.
  if (!result["ollama"]) result["ollama"] = { available: true };
  return result;
}

/**
 * Check whether a single provider is usable — via a user-provided key
 * (secure storage or env var) or via the managed proxy fallback.
 * Ollama is always considered available because it does not require an API key.
 * claude-subscription requires the `claude` CLI installed and a Keychain entry.
 */
export async function isProviderAvailable(
  provider: string,
  probes: ClaudeSubscriptionProbes & KimiAgentProbes = {},
): Promise<boolean> {
  if (provider === "ollama") return true;
  if (provider === "claude-subscription") {
    return isClaudeSubscriptionAvailable(probes);
  }
  if (provider === "kimi-agent") {
    const status = await getProviderAvailabilityStatus("kimi-agent", probes);
    return status.available;
  }
  return !!(
    (await getProviderKeyAsync(provider)) ||
    (await managedFallbackEnabledFor(provider))
  );
}

/**
 * Build the list of providers that are usable — via a user-provided key
 * (secure storage or env var) or via the managed proxy fallback.
 * Ollama is always included because it does not require an API key.
 */
export async function getConfiguredProviders(): Promise<string[]> {
  const configured: string[] = [];
  for (const p of API_KEY_PROVIDERS) {
    if (await isProviderAvailable(p)) {
      configured.push(p);
    }
  }
  if (!configured.includes("ollama")) configured.push("ollama");
  if (
    !configured.includes("claude-subscription") &&
    (await isProviderAvailable("claude-subscription"))
  ) {
    configured.push("claude-subscription");
  }
  return configured;
}
