/**
 * Canonical environment contract for the Max Chrome extension.
 *
 * This module is the single source of truth for:
 *   - the set of valid extension environments
 *   - parsing / normalizing raw environment strings (including aliases)
 *   - resolving the build-time default from `process.env.MAX_ENVIRONMENT`
 *   - mapping each environment to its cloud API and web base URLs
 *
 * All other extension code that needs environment awareness should import
 * from this module rather than hard-coding URLs or re-implementing parsing.
 */

// ── Environment type ────────────────────────────────────────────────

/**
 * The four deployment environments the extension can target.
 *
 * - `local`      — developer's machine (`vel up`), local gateway + relay
 * - `dev`        — artifacts built from `main`, dev platform
 * - `staging`    — QA against staging platform before production rollout
 * - `production` — full production behavior
 */
export type ExtensionEnvironment = 'local' | 'dev' | 'staging' | 'production';

const VALID_ENVIRONMENTS: ReadonlySet<string> = new Set<ExtensionEnvironment>([
  'local',
  'dev',
  'staging',
  'production',
]);

/** Aliases that map to a canonical {@link ExtensionEnvironment}. */
const ENVIRONMENT_ALIASES: Readonly<Record<string, ExtensionEnvironment>> = {
  prod: 'production',
};

// ── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a raw string into a validated {@link ExtensionEnvironment}.
 *
 * - Trims whitespace and lowercases before matching.
 * - Accepts `"prod"` as an alias for `"production"`.
 * - Returns `null` for `undefined`, empty, or unrecognized values.
 */
export function parseExtensionEnvironment(raw: string | undefined): ExtensionEnvironment | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return null;

  if (VALID_ENVIRONMENTS.has(normalized)) {
    return normalized as ExtensionEnvironment;
  }

  const aliased = ENVIRONMENT_ALIASES[normalized];
  if (aliased !== undefined) {
    return aliased;
  }

  return null;
}

// ── Build-time default ──────────────────────────────────────────────

/**
 * Resolve the build-time default environment from the bundler-defined
 * `process.env.MAX_ENVIRONMENT` constant.
 *
 * Falls back to `"production"` when the variable is missing, empty, or
 * set to an unrecognized value, ensuring released extensions always
 * target production even if the build pipeline omits the variable.
 */
export function resolveBuildDefaultEnvironment(): ExtensionEnvironment {
  // `process.env.MAX_ENVIRONMENT` is replaced at bundle time by the
  // build tool (e.g. `bun build --define`). At runtime in a bundled
  // extension it becomes a string literal. In tests or unbundled
  // contexts it may be the actual env var or undefined.
  let raw: string | undefined;
  try {
    raw = process.env.MAX_ENVIRONMENT;
  } catch {
    // In some browser runtimes `process` is not defined at all.
    raw = undefined;
  }
  // Default to `production`: when the env var is absent it means the extension
  // was loaded without a bundler `--define` injection. Defaulting to production
  // ensures released extensions always target the correct environment even if
  // the build pipeline omits the variable. Local dev builds inject 'local' via
  // build.sh, and dev/staging releases inject their respective environments.
  return parseExtensionEnvironment(raw) ?? 'production';
}

// ── Cloud URL mapping ───────────────────────────────────────────────

export interface CloudUrls {
  /** Gateway / API base URL (e.g. `https://api.max.ai`). */
  apiBaseUrl: string;
  /** Web app base URL for browser-facing pages (e.g. `https://www.max.ai`). */
  webBaseUrl: string;
}

/**
 * Return the cloud API and web base URLs for the given environment.
 *
 * Production uses the canonical Max production hosts. Non-production
 * environments use environment-prefixed subdomains following the
 * convention `<env>-api.max.ai` / `<env>-assistant.max.ai`, with
 * `local` using `localhost` origins for both.
 */
export function cloudUrlsForEnvironment(env: ExtensionEnvironment): CloudUrls {
  switch (env) {
    case 'production':
      return {
        apiBaseUrl: 'https://platform.max.ai',
        webBaseUrl: 'https://www.max.ai',
      };
    case 'staging':
      return {
        apiBaseUrl: 'https://staging-platform.max.ai',
        webBaseUrl: 'https://staging-assistant.max.ai',
      };
    case 'dev':
      return {
        apiBaseUrl: 'https://dev-platform.max.ai',
        webBaseUrl: 'https://dev-assistant.max.ai',
      };
    case 'local':
      return {
        apiBaseUrl: 'http://localhost:8000',
        webBaseUrl: 'http://localhost:3000',
      };
  }
}
