import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";

const log = getLogger("kimi-agent-share-dir");

// ── Ambient-MCP suppression via a staged share dir ─────────────────────────
//
// kimi-cli auto-loads MCP servers from `<share dir>/mcp.json` into EVERY
// session, independent of the agent-spec `tools:` allowlist (verified:
// `kimi_cli/cli/mcp.py` resolves the file via `get_share_dir()`, and
// `cli/__init__.py` appends it whenever no `--mcp-config-file` is passed —
// which the SDK never passes). Those tools (browser_*, github_*, …) are
// therefore VISIBLE to the model but always denied by the provider's
// ApprovalRequest gate — and a denied tool ends the kimi turn without
// re-inference (see KIMI_AGENT_ROOT_CAUSE_REPORT.md).
//
// The SDK's only lever is `SessionOptions.shareDir`, which it forwards as
// `KIMI_SHARE_DIR` to the spawned CLI (`kimi_cli/share.py` honors it). So:
// stage a copy of the real share dir where every entry is a symlink back to
// the real one EXCEPT two files written fresh:
//
//   - `mcp.json` — written `{"mcpServers":{}}` so the session loads ZERO
//     ambient MCP servers, mirroring claude-subscription's
//     `settingSources: []` pre-advertisement suppression.
//   - `kimi.json` — written as a REAL file (copied from the real one, plus a
//     seeded `work_dirs` entry for this session's workDir). Two reasons it
//     must not be a symlink: (a) kimi-cli ≥1.14 writes it via atomic
//     write+rename, which would REPLACE a symlink with a real file in the
//     staged dir (clobbering the link, losing updates); (b) `Session.find`
//     resumes a session only when the workDir is registered in
//     `kimi.json.work_dirs` — seeding the entry up front makes resume work
//     even though each call stages a fresh ephemeral dir.
//
// Auth, config, and session state remain shared with the real dir:
//   - `credentials/`, `sessions/`, `logs/`, `bin/` are DIRECTORY symlinks:
//     writes inside them (an OAuth token refresh rewriting
//     `credentials/kimi-code.json`; a new session's `context.jsonl`) land in
//     the REAL dir, rename-proof (the CLI opens files inside the dir, which
//     follows the dir symlink).
//   - `config.toml` / `device_id` are read-mostly file symlinks.
//
// The approval-deny gate stays as defense-in-depth behind this.

/** Shape of the slice of `kimi.json` the seeding logic touches. */
interface KimiMetadataFile {
  work_dirs?: Array<{
    path?: string;
    kaos?: string;
    last_session_id?: string | null;
  }>;
  [key: string]: unknown;
}

/**
 * Build the staged `kimi.json` content: the real file's content (when
 * readable) with a `work_dirs` entry for `workDir` ensured. The entry shape
 * mirrors kimi-cli's `WorkDirMeta` (`metadata.py`): `{path, kaos: "local",
 * last_session_id}` — `kaos` must be `"local"` to match
 * `get_current_kaos().name` in `Metadata.get_work_dir_meta`.
 */
function buildSeededKimiJson(
  realKimiJsonPath: string,
  workDir: string,
): string {
  let meta: KimiMetadataFile = {};
  try {
    if (existsSync(realKimiJsonPath)) {
      meta = JSON.parse(
        readFileSync(realKimiJsonPath, "utf-8"),
      ) as KimiMetadataFile;
    }
  } catch (err) {
    log.warn(
      { err },
      "kimi-agent share-dir staging: unreadable real kimi.json; seeding fresh",
    );
    meta = {};
  }
  if (!Array.isArray(meta.work_dirs)) meta.work_dirs = [];
  const registered = meta.work_dirs.some(
    (wd) => wd && wd.path === workDir && wd.kaos === "local",
  );
  if (!registered) {
    meta.work_dirs.push({
      path: workDir,
      kaos: "local",
      last_session_id: null,
    });
  }
  return JSON.stringify(meta);
}

/**
 * Stage an MCP-free copy of the kimi share dir under `stagingParent`,
 * seeded so sessions for `workDir` can be resumed by id.
 *
 * Returns the staged dir to pass as `createSession({ shareDir })`, or
 * `undefined` when the real share dir does not exist or staging fails — the
 * caller must then OMIT `shareDir` (prior behavior: ambient MCP visible but
 * deny-gated). This function never throws: ambient-MCP suppression is an
 * optimization and must not take down the provider.
 */
export function stageMcpFreeShareDir(
  stagingParent: string,
  workDir: string,
  realShareDir?: string,
): string | undefined {
  try {
    const source =
      realShareDir ?? process.env.KIMI_SHARE_DIR ?? join(homedir(), ".kimi");
    if (!existsSync(source)) return undefined;
    const staged = join(stagingParent, "kimi-share");
    mkdirSync(staged, { recursive: true });
    for (const entry of readdirSync(source)) {
      if (entry === "mcp.json" || entry === "kimi.json") continue;
      try {
        symlinkSync(join(source, entry), join(staged, entry));
      } catch (err) {
        // EEXIST on re-staging into the same parent is fine; anything else
        // for a single entry is logged but does not abort the staging.
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          log.warn(
            { entry, err },
            "kimi-agent share-dir staging: symlink failed",
          );
        }
      }
    }
    writeFileSync(
      join(staged, "mcp.json"),
      JSON.stringify({ mcpServers: {} }),
      "utf-8",
    );
    writeFileSync(
      join(staged, "kimi.json"),
      buildSeededKimiJson(join(source, "kimi.json"), workDir),
      "utf-8",
    );
    return staged;
  } catch (err) {
    log.warn(
      { err },
      "kimi-agent share-dir staging failed; falling back to real share dir",
    );
    return undefined;
  }
}
