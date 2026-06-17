import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Resolve the legacy Max root directory (~/.max).
 *
 * Resolution order:
 * 1. Parent of MAX_WORKSPACE_DIR — e.g. /data/.max/workspace → /data/.max
 * 2. If that parent is "/" (workspace at top level, e.g. /workspace), fall back
 *    to homedir()/.max
 *
 * This replaces the old inlined `getRootDir()` pattern used by individual migrations.
 */
export function getMaxRoot(): string {
  const workspaceDir = process.env.MAX_WORKSPACE_DIR?.trim();
  if (workspaceDir) {
    const parent = dirname(workspaceDir);
    if (parent !== "/") return parent;
  }
  return join(homedir(), ".max");
}
