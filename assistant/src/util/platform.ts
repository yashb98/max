import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getWorkspaceDirOverride } from "../config/env-registry.js";

/**
 * The daemon's root data directory (`~/.max`).
 *
 * Used as a fallback when `MAX_WORKSPACE_DIR` is not set, and as a
 * stable constant for paths (like `.env`) that intentionally live at the
 * host home directory regardless of workspace relocation.
 */
const MAX_ROOT = join(homedir(), ".max");

/**
 * Returns the Max root directory.
 *
 * Resolution order (mirrors workspace/migrations/utils.ts):
 * 1. Parent of MAX_WORKSPACE_DIR — e.g. /data/.max/workspace → /data/.max
 * 2. If that parent is "/" (workspace at top level), fall back to ~/.max
 */
export function maxRoot(): string {
  const override = getWorkspaceDirOverride();
  if (override) {
    const parent = dirname(override);
    if (parent !== "/") return parent;
  }
  return MAX_ROOT;
}

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Returns the raw platform string from Node.js (e.g. 'darwin', 'linux', 'win32').
 * Prefer this over accessing process.platform directly so all platform
 * detection is routed through this module.
 */
export function getPlatformName(): string {
  return process.platform;
}

/**
 * Normalize an assistant ID to its canonical form for DB operations.
 *
 * The system uses "self" as the canonical single-tenant identifier
 * (see migration 007-assistant-id-to-self). However, the desktop UI
 * sends the real assistant ID (e.g., "max-true-eel") while the
 * inbound call path resolves phone numbers to config keys (typically
 * "self"). This function maps the current assistant's ID to "self"
 * so both sides use a consistent DB key.
 */
export function normalizeAssistantId(assistantId: string): string {
  if (assistantId === "self") return "self";

  const ownName = process.env.MAX_ASSISTANT_NAME;
  if (ownName && assistantId === ownName) return "self";

  return assistantId;
}

/**
 * Returns the internal data directory (~/.max/workspace/data). Runtime
 * databases, logs, memory indices, and other internal state live here.
 */
export function getDataDir(): string {
  return join(getWorkspaceDir(), "data");
}

/**
 * Returns the embedding models directory (~/.max/workspace/embedding-models).
 * Downloaded embedding runtime (onnxruntime-node, transformers bundle, model weights)
 * is stored here, downloaded post-hatch rather than shipped with the app.
 */
export function getEmbeddingModelsDir(): string {
  return join(getWorkspaceDir(), "embedding-models");
}

/**
 * Returns the sandbox root directory (~/.max/data/sandbox).
 * Global sandbox state lives under this directory.
 */
export function getSandboxRootDir(): string {
  return join(getDataDir(), "sandbox");
}

/**
 * Returns the default sandbox working directory (~/.max/workspace).
 * This is the workspace root — tool working directories should use this
 * path unless explicitly overridden.
 */
export function getSandboxWorkingDir(): string {
  return getWorkspaceDir();
}

export function getInterfacesDir(): string {
  return join(getDataDir(), "interfaces");
}

/**
 * Returns the sounds directory (~/.max/workspace/data/sounds).
 * Custom sound files and sound configuration live here.
 */
export function getSoundsDir(): string {
  return join(getWorkspaceDir(), "data", "sounds");
}

/** Returns the avatar directory ($MAX_WORKSPACE_DIR/data/avatar). */
export function getAvatarDir(): string {
  return join(getWorkspaceDir(), "data", "avatar");
}

/** Canonical filename for the custom avatar PNG. */
export const AVATAR_IMAGE_FILENAME = "avatar-image.png";

/** Returns the canonical avatar image path (~/.max/workspace/data/avatar/avatar-image.png). */
export function getAvatarImagePath(): string {
  return join(getAvatarDir(), AVATAR_IMAGE_FILENAME);
}

// Kept in sync with `cli/src/lib/environments/seeds.ts`. Drift between
// these two sites is caught at test time by
// `cli/src/__tests__/env-drift.test.ts`. Fast follow: hoist the shared
// list into a `packages/environments` package so both sites import
// from one place.
const KNOWN_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "production",
  "staging",
  "test",
  "dev",
  "local",
]);

/**
 * Returns the env-scoped XDG config subdirectory name for Max
 * (`max` in production, `max-<env>` otherwise). Mirrors the Swift
 * side's `MaxPaths.configDir` and the CLI's
 * `environments/paths.ts:getConfigDir`.
 */
export function getXdgMaxConfigDirName(): string {
  const raw = process.env.MAX_ENVIRONMENT?.trim();
  if (!raw || raw === "production") return "max";
  if (!KNOWN_ENVIRONMENTS.has(raw)) return "max";
  return `max-${raw}`;
}

export function getPidPath(): string {
  return join(getWorkspaceDir(), "max.pid");
}

export function getDbPath(): string {
  return join(getDataDir(), "db", "assistant.db");
}

export function getLogPath(): string {
  return join(getDataDir(), "logs", "max.log");
}

export function getHistoryPath(): string {
  return join(getDataDir(), "history");
}

/**
 * Returns the protected directory. Security-sensitive files — trust rules,
 * encrypted credential store, signing keys, feature-flag overrides, device
 * approval lists — live here.
 *
 * This directory is:
 * - Outside the sandbox write boundary (tools cannot modify it)
 * - Skipped in containerized mode (credentials via CES, trust via gateway)
 */
export function getProtectedDir(): string {
  return join(maxRoot(), "protected");
}

/** Returns ~/.max/workspace/signals — the directory for IPC signal files. */
export function getSignalsDir(): string {
  return join(getWorkspaceDir(), "signals");
}

// --- Root-level runtime path helpers ---
// These expose specific root-level file paths so callers don't need to
// import getRootDir() directly. getRootDir() is intentionally unexported.

/** Returns the path to the daemon stderr log (~/.max/workspace/logs/daemon-stderr.log). */
export function getDaemonStderrLogPath(): string {
  return join(getWorkspaceDir(), "logs", "daemon-stderr.log");
}

/** Returns the path to the daemon startup lock file (~/.max/workspace/daemon-startup.lock). */
export function getDaemonStartupLockPath(): string {
  return join(getWorkspaceDir(), "daemon-startup.lock");
}

/** Returns the directory for externally-installed packages (~/.max/workspace/external). */
export function getExternalDir(): string {
  return join(getWorkspaceDir(), "external");
}

/** Returns the directory for installed binaries (~/.max/workspace/bin). */
export function getBinDir(): string {
  return join(getWorkspaceDir(), "bin");
}

/** Returns the path to the dot-env file (~/.max/.env). Stays at root because it contains secrets. */
export function getDotEnvPath(): string {
  return join(maxRoot(), ".env");
}

/** Returns the path to the embed-worker PID file (~/.max/workspace/embed-worker.pid). */
export function getEmbedWorkerPidPath(): string {
  return join(getWorkspaceDir(), "embed-worker.pid");
}

/**
 * Returns the workspace root for user-facing state.
 *
 * When the MAX_WORKSPACE_DIR env var is set, returns that value (used in
 * containerized deployments where the workspace is a separate volume).
 * Otherwise falls back to ~/.max/workspace.
 */
export function getWorkspaceDir(): string {
  const override = getWorkspaceDirOverride();
  if (override) return override;
  return join(MAX_ROOT, "workspace");
}

/**
 * Returns a display-friendly workspace path for embedding in agent-facing text
 * (skill bodies, tool descriptions). Replaces the home directory prefix with `~`
 * so paths stay concise and portable across machines.
 *
 * Examples:
 *   /Users/alice/.max/workspace → ~/.max/workspace
 *   /data/.max/workspace        → /data/.max/workspace
 */
export function getWorkspaceDirDisplay(): string {
  const abs = getWorkspaceDir();
  const home = homedir();
  if (abs.startsWith(home + "/") || abs === home) {
    return "~" + abs.slice(home.length);
  }
  return abs;
}

/** Returns ~/.max/workspace/config.json */
export function getWorkspaceConfigPath(): string {
  return join(getWorkspaceDir(), "config.json");
}

/** Returns ~/.max/workspace/skills */
export function getWorkspaceSkillsDir(): string {
  return join(getWorkspaceDir(), "skills");
}

/** Returns ~/.max/workspace/hooks */
export function getWorkspaceHooksDir(): string {
  return join(getWorkspaceDir(), "hooks");
}

/**
 * Returns `<workspaceDir>/plugins` — the directory scanned by the user plugin
 * loader at daemon startup. Writes here are security-sensitive: any
 * `register.{ts,js}` will be dynamic-imported on next restart, so the file
 * risk classifier escalates writes under this path to High.
 */
export function getWorkspacePluginsDir(): string {
  return join(getWorkspaceDir(), "plugins");
}

/** Returns $MAX_WORKSPACE_DIR/routes — user-defined HTTP route handlers. */
export function getWorkspaceRoutesDir(): string {
  return join(getWorkspaceDir(), "routes");
}

/** Returns ~/.max/workspace/deprecated — transitional files slated for removal. */
export function getDeprecatedDir(): string {
  return join(getWorkspaceDir(), "deprecated");
}

/** Returns ~/.max/workspace/conversations */
export function getConversationsDir(): string {
  return join(getWorkspaceDir(), "conversations");
}

/** Returns the workspace path for a prompt file (e.g. IDENTITY.md, SOUL.md). */
export function getWorkspacePromptPath(file: string): string {
  return join(getWorkspaceDir(), file);
}

// ── Profiler filesystem layout ──────────────────────────────────────────
// Managed profiler runs live under <workspace>/data/profiler/. These
// helpers enforce a single canonical layout so every runtime caller
// resolves the same paths.

/**
 * Returns the profiler root directory (<workspace>/data/profiler).
 * All profiler state (runs directory, global metadata) lives here.
 */
export function getProfilerRootDir(): string {
  return join(getDataDir(), "profiler");
}

/**
 * Returns the profiler runs directory (<workspace>/data/profiler/runs).
 * Each completed or active profiler run gets its own sub-directory here.
 */
export function getProfilerRunsDir(): string {
  return join(getProfilerRootDir(), "runs");
}

/**
 * Returns the directory for a specific profiler run by ID
 * (<workspace>/data/profiler/runs/<runId>).
 */
export function getProfilerRunDir(runId: string): string {
  return join(getProfilerRunsDir(), runId);
}

/**
 * Resolve the shipped source directory for a first-party skill (e.g.
 * `meet-join`) whose runtime is launched outside the compiled daemon
 * binary — notably the meet-host child process spawned via
 * `bun run <skill>/register.ts`.
 *
 * Layers on top of `getRepoSkillsDir()` from `skills/catalog-install.ts`:
 * that helper locates the first-party skills root (validated by
 * `catalog.json`); this helper appends the skill id and validates the
 * per-skill entry point (`register.ts`). Returns `undefined` when the
 * root is unavailable (e.g. dev-mode build without `MAX_DEV=1`) or
 * the skill directory has no `register.ts`.
 *
 * Implemented here instead of `skills/catalog-install.ts` to avoid
 * pulling that module's platform-API dependencies (fetch, memory graph)
 * into callers that only need a path resolution. Takes the first-party
 * skills root as a dependency to keep this module free of a reverse
 * import.
 */
export function getSkillRuntimePath(
  skillId: string,
  firstPartySkillsRoot: string | undefined,
): string | undefined {
  if (!firstPartySkillsRoot) return undefined;
  const candidate = join(firstPartySkillsRoot, skillId);
  if (existsSync(join(candidate, "register.ts"))) {
    return candidate;
  }
  return undefined;
}

/**
 * Resolve the on-disk path to a standalone `bun` binary that the meet-host
 * supervisor (PR 27) uses to spawn external skills. Prefers the
 * packaging-site-bundled copy before falling back to the shared
 * download/PATH resolver in `bun-runtime.ts`.
 *
 * Resolution order:
 *
 *   1. macOS `.app` bundle: `Contents/Resources/bun` — shipped by
 *      `clients/macos/build.sh` at a version that matches `.tool-versions`.
 *   2. Next-to-binary: `<execDir>/bun` for Docker/generic compiled layouts
 *      that stage a bun binary alongside the daemon (PR 29 wires this up).
 *
 * Returns `undefined` when no bundled copy is present; callers should
 * fall back to `ensureBun()` from `./bun-runtime.ts`, which handles PATH
 * lookup and JIT download for bare-metal dev.
 */
export function getBundledBunPath(): string | undefined {
  const importDir = import.meta.dir;
  if (!importDir.startsWith("/$bunfs/")) return undefined;

  const execDir = dirname(process.execPath);
  const resourcesPath = join(execDir, "..", "Resources", "bun");
  if (existsSync(resourcesPath)) return resourcesPath;
  const execDirPath = join(execDir, "bun");
  if (existsSync(execDirPath)) return execDirPath;
  return undefined;
}

export function ensureDataDir(): void {
  const root = maxRoot();
  const workspace = getWorkspaceDir();
  const wsData = join(workspace, "data");
  const dirs = [
    // Root-level dirs (runtime)
    root,
    // Workspace dirs
    workspace,
    join(workspace, "signals"),
    join(workspace, "skills"),
    join(workspace, "routes"),
    join(workspace, "embedding-models"),
    join(workspace, "conversations"),
    join(workspace, "logs"),
    join(workspace, "external"),
    join(workspace, "bin"),
    // Data sub-dirs under workspace
    wsData,
    join(wsData, "db"),
    join(wsData, "qdrant"),
    join(wsData, "logs"),
    join(wsData, "memory"),
    join(wsData, "memory", "knowledge"),
    join(wsData, "apps"),
    join(wsData, "attachments"),
    join(wsData, "interfaces"),
    join(wsData, "sounds"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  // Lock down the root directory so only the owner can traverse it.
  // Runtime files (socket, session token, PID) live directly under root.
  try {
    chmodSync(root, 0o700);
  } catch {
    // Non-fatal: some filesystems don't support Unix permissions
  }
}
