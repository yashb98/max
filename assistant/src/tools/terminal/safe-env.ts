/**
 * Environment variables that are safe to pass through to child processes.
 * Everything else (API keys, tokens, credentials) is stripped to prevent
 * accidental leakage via agent-spawned commands.
 *
 * Shared by the sandbox bash tool and skill sandbox runner.
 */
import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { getDataDir, getWorkspaceDir } from "../../util/platform.js";

export const SAFE_ENV_VARS = [
  "PATH",
  "HOME",
  "TERM",
  "LANG",
  "EDITOR",
  "SHELL",
  "USER",
  "TMPDIR",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "COLORTERM",
  "TERM_PROGRAM",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_TTY",
  "GNUPGHOME",
  "MAX_DEV",
  "MAX_DEBUG",
  "MAX_ENVIRONMENT",

  "MAX_WORKSPACE_DIR",
  "CES_BOOTSTRAP_SOCKET_DIR",
  "GATEWAY_INTERNAL_URL",
  "ASSISTANT_IPC_SOCKET_DIR",
  "ASSISTANT_SKILL_IPC_SOCKET_DIR",
  "GATEWAY_IPC_SOCKET_DIR",
  "GATEWAY_SECURITY_DIR",
  "MAX_PLATFORM_URL",
  "MAX_ASSISTANT_PLATFORM_URL",
  "MAX_DOCS_BASE_URL",
  "CES_CREDENTIAL_URL",
  "CES_MANAGED_MODE",
  "IS_CONTAINERIZED",
  "IS_PLATFORM",
  "MAX_CLOUD",
  "MAX_SANDBOX_RUNTIME",
  "CES_SERVICE_TOKEN",
  "MAX_PROFILER_RUN_ID",
  "MAX_PROFILER_MODE",
  "MAX_PROFILER_MAX_BYTES",
  "MAX_PROFILER_MAX_RUNS",
  "MAX_PROFILER_MIN_FREE_MB",
  "MAX_MEMORY_LIMIT",
  "MAX_CPU_LIMIT",
  "MAX_MINIKUBE_STORAGE_SIZE",
  "MAX_BACKUP_DIR",
  "MAX_BACKUP_KEY_PATH",
] as const;

export const KATA_SAFE_ENV_VARS = [
  "LD_LIBRARY_PATH",
  "MAX_APT_DATA_ROOT",
  "MAX_APT_DATA_SUITE",
  "MAX_APT_DATA_MIRROR",
] as const;

const KATA_APT_DATA_ROOT = "/data/system";

function kataAptPaths(dataRoot: string): string[] {
  return [
    `${dataRoot}/bin`,
    `${dataRoot}/usr/local/sbin`,
    `${dataRoot}/usr/local/bin`,
    `${dataRoot}/usr/sbin`,
    `${dataRoot}/usr/bin`,
    `${dataRoot}/sbin`,
    `${dataRoot}/usr/games`,
    `${dataRoot}/games`,
  ];
}

function kataAptLibraryPaths(dataRoot: string): string[] {
  return [
    `${dataRoot}/usr/local/lib`,
    `${dataRoot}/usr/lib`,
    `${dataRoot}/usr/lib/x86_64-linux-gnu`,
    `${dataRoot}/usr/lib/aarch64-linux-gnu`,
  ];
}

/**
 * Keys that buildSanitizedEnv always injects into the returned env,
 * independent of what is present in process.env.
 */
export const ALWAYS_INJECTED_ENV_VARS = [
  "INTERNAL_GATEWAY_BASE_URL",
  "SPECIES",
  "MAX_DATA_DIR",
  "MAX_WORKSPACE_DIR",
] as const;

function appendUniquePathEntries(
  value: string | undefined,
  entries: readonly string[],
): string {
  const parts = value ? value.split(":").filter(Boolean) : [];
  for (const entry of entries) {
    if (!parts.includes(entry)) {
      parts.push(entry);
    }
  }
  return parts.join(":");
}

export function buildSanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const isKataRuntime = process.env.MAX_SANDBOX_RUNTIME === "kata";
  const safeEnvVars = isKataRuntime
    ? [...SAFE_ENV_VARS, ...KATA_SAFE_ENV_VARS]
    : SAFE_ENV_VARS;

  for (const key of safeEnvVars) {
    if (process.env[key] != null) {
      env[key] = process.env[key]!;
    }
  }
  if (isKataRuntime) {
    const kataAptDataRoot = env.MAX_APT_DATA_ROOT ?? KATA_APT_DATA_ROOT;
    env.MAX_APT_DATA_ROOT = kataAptDataRoot;
    env.PATH = appendUniquePathEntries(env.PATH, kataAptPaths(kataAptDataRoot));
    env.LD_LIBRARY_PATH = appendUniquePathEntries(
      env.LD_LIBRARY_PATH,
      kataAptLibraryPaths(kataAptDataRoot),
    );
  }
  // Always inject an internal gateway base for local control-plane/API calls.
  const internalGatewayBase = getGatewayInternalBaseUrl();
  env.INTERNAL_GATEWAY_BASE_URL = internalGatewayBase;
  // @deprecated — MAX_DATA_DIR is equivalent to $MAX_WORKSPACE_DIR/data.
  // Removing this requires an LLM-based migration or declarative migration
  // file to update existing user-authored skills to use MAX_WORKSPACE_DIR.
  env.MAX_DATA_DIR = getDataDir();
  // Expose the workspace directory so skills and child processes can read/write
  // workspace-scoped files (e.g. avatar traits, user data).
  env.MAX_WORKSPACE_DIR = getWorkspaceDir();
  // Identify the assistant species so skill scripts can gate on species-specific
  // logic. Hardcoded to "max" — this is the Max assistant codebase.
  env.SPECIES = "max";
  // Ensure UTF-8 locale so multi-byte characters (em dashes, curly quotes,
  // arrows, etc.) survive piping through tools like pbcopy without corruption.
  // macOS (Darwin) does not provide C.UTF-8, so use en_US.UTF-8 there.
  const utf8Locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  if (!env.LANG) env.LANG = utf8Locale;
  if (!env.LC_ALL) env.LC_ALL = utf8Locale;
  return env;
}
