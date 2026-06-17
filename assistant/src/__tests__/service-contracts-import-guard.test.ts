/**
 * Guard test: enforce import discipline for @maxai/service-contracts.
 *
 * Rules enforced:
 *
 * 1. No imports of `@maxai/ces-contracts` anywhere in the codebase.
 *    The compatibility shim package has been deleted; all code must import
 *    from `@maxai/service-contracts` directly using explicit subpaths.
 *
 * 2. `assistant/`, `gateway/`, and `credential-executor/` source files must
 *    not import the aggregate root `@maxai/service-contracts` (i.e.
 *    `from "@maxai/service-contracts"`). They must use explicit domain
 *    subpaths (e.g. `@maxai/service-contracts/credential-rpc`).
 *
 * See ARCHITECTURE.md (Credential Execution Service section) and
 * assistant/docs/credential-execution-service.md (Shared Private Packages)
 * for the rationale.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/** Resolve the repo root from the assistant test directory. */
function getRepoRoot(): string {
  return join(import.meta.dir, "..", "..", "..");
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("/__tests__/") ||
    filePath.endsWith(".test.ts") ||
    filePath.endsWith(".test.js") ||
    filePath.endsWith(".spec.ts") ||
    filePath.endsWith(".spec.js")
  );
}

/**
 * No files are permitted to reference `@maxai/ces-contracts`.
 * The compatibility shim package has been deleted; all code must import
 * from `@maxai/service-contracts` directly.
 */
const CES_CONTRACTS_ALLOWLIST = new Set<string>([]);

/**
 * No files are permitted to import the aggregate root
 * `@maxai/service-contracts` (without a subpath).
 * All runtime code must use explicit domain subpaths.
 */
const AGGREGATE_ROOT_ALLOWLIST = new Set<string>([]);

describe("service-contracts import discipline", () => {
  // ---------------------------------------------------------------------------
  // Rule 1: No @maxai/ces-contracts anywhere (shim package deleted)
  // ---------------------------------------------------------------------------

  test("no @maxai/ces-contracts imports anywhere in the codebase", () => {
    const repoRoot = getRepoRoot();

    let grepOutput = "";
    try {
      // Scan all tracked TypeScript files for any import/require statements
      // referencing ces-contracts. The compatibility shim has been deleted —
      // there should be zero references.
      grepOutput = execFileSync(
        "git",
        [
          "grep",
          "-lE",
          'from\\s+["\']@maxai/ces-contracts|require\\s*\\(\\s*["\']@maxai/ces-contracts',
          "--",
          ":(glob)**/*.ts",
        ],
        { encoding: "utf-8", cwd: repoRoot },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);
    const violations = files.filter((f) => {
      if (isTestFile(f)) return false;
      if (CES_CONTRACTS_ALLOWLIST.has(f)) return false;
      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Found files importing @maxai/ces-contracts.",
        "",
        "The @maxai/ces-contracts package has been deleted.",
        "All code must import from @maxai/service-contracts using explicit subpaths:",
        "  @maxai/service-contracts/credential-rpc",
        "  @maxai/service-contracts/trust-rules",
        "  @maxai/service-contracts/handles",
        "  @maxai/service-contracts/grants",
        "  @maxai/service-contracts/rpc",
        "  @maxai/service-contracts/rendering",
        "  @maxai/service-contracts/error",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: replace @maxai/ces-contracts with the appropriate",
        "@maxai/service-contracts/<subpath> import.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------------
  // Rule 2: No aggregate-root @maxai/service-contracts in runtime directories
  // ---------------------------------------------------------------------------

  test("assistant/gateway/credential-executor use explicit service-contracts subpaths (no aggregate root)", () => {
    const repoRoot = getRepoRoot();

    // Match the aggregate root import: from "@maxai/service-contracts" (with closing quote, no slash after)
    // This catches both single and double quote forms.
    const aggregateRootPattern =
      "from ['\"]@maxai/service-contracts['\"]";

    let grepOutput = "";
    try {
      grepOutput = execFileSync(
        "git",
        [
          "grep",
          "-lE",
          aggregateRootPattern,
          "--",
          "assistant/**/*.ts",
          "gateway/**/*.ts",
          "credential-executor/**/*.ts",
        ],
        { encoding: "utf-8", cwd: repoRoot },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split("\n").filter((f) => f.length > 0);
    const violations = files.filter((f) => {
      if (isTestFile(f)) return false;
      if (AGGREGATE_ROOT_ALLOWLIST.has(f)) return false;
      return true;
    });

    if (violations.length > 0) {
      const message = [
        "Found files importing the aggregate root @maxai/service-contracts.",
        "",
        "assistant/, gateway/, and credential-executor/ must import service-contracts",
        "using explicit domain subpaths, not the aggregate root barrel:",
        "  @maxai/service-contracts/credential-rpc",
        "  @maxai/service-contracts/trust-rules",
        "  @maxai/service-contracts/handles",
        "  @maxai/service-contracts/grants",
        "  @maxai/service-contracts/rpc",
        "  @maxai/service-contracts/rendering",
        "  @maxai/service-contracts/error",
        "",
        "Violations:",
        ...violations.map((f) => `  - ${f}`),
        "",
        "To fix: replace `from \"@maxai/service-contracts\"` with the",
        "appropriate `from \"@maxai/service-contracts/<subpath>\"` import.",
        "If this is an intentional exception, add it to AGGREGATE_ROOT_ALLOWLIST",
        "in service-contracts-import-guard.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
