import {
  existsSync,
  mkdirSync,
  readdirSync,
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
// the real one EXCEPT `mcp.json`, which is written empty. The session then
// sees zero ambient MCP servers — mirroring claude-subscription's
// `settingSources: []` pre-advertisement suppression — while auth, config,
// and session state remain shared:
//
//   - `credentials/`, `sessions/`, `logs/`, `bin/` are DIRECTORY symlinks:
//     writes inside them (e.g. an OAuth token refresh, which rewrites
//     `credentials/kimi-code.json`) land in the REAL dir, rename-proof.
//   - `config.toml` / `device_id` are read-mostly file symlinks.
//   - `kimi.json` (workdir→session bookkeeping) may diverge if kimi-cli
//     replaces it atomically; blast radius is session-index metadata for a
//     staged dir that is deleted after the call — accepted.
//
// The approval-deny gate stays as defense-in-depth behind this.

/**
 * Stage an MCP-free copy of the kimi share dir under `stagingParent`.
 *
 * Returns the staged dir to pass as `createSession({ shareDir })`, or
 * `undefined` when the real share dir does not exist or staging fails — the
 * caller must then OMIT `shareDir` (prior behavior: ambient MCP visible but
 * deny-gated). This function never throws: ambient-MCP suppression is an
 * optimization and must not take down the provider.
 */
export function stageMcpFreeShareDir(
  stagingParent: string,
  realShareDir?: string,
): string | undefined {
  try {
    const source =
      realShareDir ?? process.env.KIMI_SHARE_DIR ?? join(homedir(), ".kimi");
    if (!existsSync(source)) return undefined;
    const staged = join(stagingParent, "kimi-share");
    mkdirSync(staged, { recursive: true });
    for (const entry of readdirSync(source)) {
      if (entry === "mcp.json") continue;
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
    return staged;
  } catch (err) {
    log.warn(
      { err },
      "kimi-agent share-dir staging failed; falling back to real share dir",
    );
    return undefined;
  }
}
