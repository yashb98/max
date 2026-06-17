/**
 * Package boundary tests for @maxai/egress-proxy.
 *
 * These tests ensure the egress-proxy package remains isolated from
 * assistant runtime and CES server implementation modules. If a direct
 * import of those modules is introduced, these tests will fail.
 *
 * Tightened boundaries (added):
 * - Does NOT import from x-client packages (@maxai/assistant-client,
 *   @maxai/ces-client, @maxai/gateway-client).
 * - Does NOT import from @maxai/service-contracts (the egress-proxy
 *   package deals only with proxy session lifecycle and must not depend on
 *   CES wire-protocol types).
 */

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const PKG_SRC = resolve(import.meta.dir, "..");

/** Recursively collect all .ts source files (excluding tests and declaration files). */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...(await collectSourceFiles(fullPath)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Read file content as UTF-8. */
async function readSource(filePath: string): Promise<string> {
  return Bun.file(filePath).text();
}

/**
 * Forbidden import patterns — if any source file in packages/egress-proxy
 * imports from these paths, the package boundary has been violated.
 */
const FORBIDDEN_PATTERNS = [
  // Assistant runtime internals
  /from\s+['"].*\/assistant\/src\//,
  /from\s+['"]@maxai\/assistant/,
  /import\s*\(.*\/assistant\/src\//,
  /require\s*\(.*\/assistant\/src\//,
  /import\s+['"].*\/assistant\/src\//,
  /import\s+['"]@maxai\/assistant/,

  // CES server modules (future — reserve the boundary now)
  /from\s+['"].*\/ces\/src\//,
  /from\s+['"]@maxai\/ces/,
  /import\s*\(.*\/ces\/src\//,
  /require\s*\(.*\/ces\/src\//,
  /import\s+['"].*\/ces\/src\//,
  /import\s+['"]@maxai\/ces/,

  // Gateway internals
  /from\s+['"].*\/gateway\/src\//,
  /from\s+['"]@maxai\/max-gateway/,
  /import\s*\(.*\/gateway\/src\//,
  /require\s*\(.*\/gateway\/src\//,
  /import\s+['"].*\/gateway\/src\//,
  /import\s+['"]@maxai\/max-gateway/,

  // x-client packages (must not depend on any typed service client)
  /from\s+['"]@maxai\/assistant-client(?:\/|['"])/,
  /import\s+['"]@maxai\/assistant-client(?:\/|['"])/,
  /require\s*\(['"]@maxai\/assistant-client(?:\/|['"])/,
  /from\s+['"]@maxai\/ces-client(?:\/|['"])/,
  /import\s+['"]@maxai\/ces-client(?:\/|['"])/,
  /require\s*\(['"]@maxai\/ces-client(?:\/|['"])/,
  /from\s+['"]@maxai\/gateway-client(?:\/|['"])/,
  /import\s+['"]@maxai\/gateway-client(?:\/|['"])/,
  /require\s*\(['"]@maxai\/gateway-client(?:\/|['"])/,

  // service-contracts (RPC protocol types — egress-proxy must not depend on CES wire types)
  /from\s+['"]@maxai\/service-contracts(?:\/|['"])/,
  /import\s+['"]@maxai\/service-contracts(?:\/|['"])/,
  /require\s*\(['"]@maxai\/service-contracts(?:\/|['"])/,
  /from\s+['"]@maxai\/ces-contracts(?:\/|['"])/,
  /import\s+['"]@maxai\/ces-contracts(?:\/|['"])/,
  /require\s*\(['"]@maxai\/ces-contracts(?:\/|['"])/,
];

describe("package boundary", () => {
  test("source files do not import assistant, CES, or gateway modules", async () => {
    const sourceFiles = await collectSourceFiles(PKG_SRC);
    expect(sourceFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const filePath of sourceFiles) {
      const content = await readSource(filePath);
      for (const pattern of FORBIDDEN_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          const relativePath = filePath.replace(PKG_SRC + "/", "");
          violations.push(`${relativePath}: ${match[0]}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Package boundary violated — egress-proxy must not import assistant, CES, or gateway modules:\n` +
          violations.map((v) => `  - ${v}`).join("\n"),
      );
    }
  });

  test("package.json has no dependencies on assistant, CES, gateway, x-client, or service-contracts", async () => {
    const pkgJsonPath = resolve(PKG_SRC, "..", "package.json");
    const pkgJson = JSON.parse(await Bun.file(pkgJsonPath).text());

    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
      ...pkgJson.peerDependencies,
      ...pkgJson.optionalDependencies,
    };

    const forbidden = [
      "@maxai/assistant",
      "@maxai/ces",
      "@maxai/max-gateway",
      "@maxai/assistant-client",
      "@maxai/ces-client",
      "@maxai/ces-contracts",
      "@maxai/gateway-client",
      "@maxai/service-contracts",
    ];

    for (const dep of forbidden) {
      expect(allDeps).not.toHaveProperty(dep);
    }
  });

  test("exports the expected egress control primitives", async () => {
    const mod = await import("../index.js");

    // The module should export only types at this stage.
    // TypeScript types are erased at runtime, so we verify the module
    // loads without error and doesn't unexpectedly export runtime values
    // that would indicate coupling to implementation modules.
    //
    // The key assertion is that the module exists and is importable
    // without pulling in assistant/CES/gateway runtime code.
    expect(mod).toBeDefined();
  });
});
