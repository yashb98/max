/**
 * Package boundary tests for @maxai/service-contracts.
 *
 * Ensures the package:
 * 1. Does NOT import from assistant, gateway, credential-executor, or other
 *    service runtime modules.
 * 2. Does NOT import from runtime shared packages that sit above it in the
 *    dependency hierarchy (@maxai/credential-storage, @maxai/egress-proxy,
 *    @maxai/skill-host-contracts).
 * 3. Does NOT import from x-client packages (@maxai/assistant-client,
 *    @maxai/ces-client, @maxai/gateway-client).
 * 4. Remains a pure schema/type package — no runtime dependencies beyond zod.
 *
 * @maxai/service-contracts is the lowest layer of the shared packages
 * hierarchy and must not depend on any higher-layer package.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../..");
const SRC_DIR = join(PACKAGE_ROOT, "src");

/**
 * Recursively collect all .ts source files, excluding test and declaration files.
 */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      files.push(...collectSourceFiles(full));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Patterns that must NOT appear in any import/require statement within
 * source files. These catch imports from higher-layer packages that would
 * create a forbidden upward dependency.
 */
const FORBIDDEN_IMPORT_PATTERNS = [
  // Assistant runtime
  /from\s+["'](?:\.\.\/)*assistant(?:\/|["'])/,
  /require\s*\(\s*["'](?:\.\.\/)*assistant(?:\/|["'])/,
  /from\s+["']@maxai\/assistant(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/assistant(?:\/|["'])/,

  // Gateway
  /from\s+["'](?:\.\.\/)*gateway(?:\/|["'])/,
  /require\s*\(\s*["'](?:\.\.\/)*gateway(?:\/|["'])/,
  /from\s+["']@maxai\/(?:max-)?gateway(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/(?:max-)?gateway(?:\/|["'])/,

  // Credential executor
  /from\s+["'](?:\.\.\/)*credential-executor(?:\/|["'])/,
  /require\s*\(\s*["'](?:\.\.\/)*credential-executor(?:\/|["'])/,
  /from\s+["']@maxai\/credential-executor(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/credential-executor(?:\/|["'])/,

  // Runtime shared packages (higher layer)
  /from\s+["']@maxai\/credential-storage(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/credential-storage(?:\/|["'])/,
  /from\s+["']@maxai\/egress-proxy(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/egress-proxy(?:\/|["'])/,
  /from\s+["']@maxai\/skill-host-contracts(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/skill-host-contracts(?:\/|["'])/,

  // x-client packages (higher layer)
  /from\s+["']@maxai\/assistant-client(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/assistant-client(?:\/|["'])/,
  /from\s+["']@maxai\/ces-client(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/ces-client(?:\/|["'])/,
  /from\s+["']@maxai\/gateway-client(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/gateway-client(?:\/|["'])/,
];

describe("package boundary", () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  test("has source files to validate", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  test("does not import from runtime or higher-layer packages", () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
          if (pattern.test(line)) {
            const relative = file.replace(PACKAGE_ROOT + "/", "");
            violations.push(`${relative}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} forbidden import(s) in service-contracts package:\n` +
          violations.map((v) => `  - ${v}`).join("\n") +
          "\n\n" +
          "@maxai/service-contracts is a pure schema/type package and must not\n" +
          "import from runtime services or higher-layer packages.",
      );
    }
  });

  test("package.json declares it as private", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.private).toBe(true);
  });

  test("package.json does not depend on runtime or higher-layer packages", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };

    const forbidden = Object.keys(allDeps).filter((dep) =>
      [
        "@maxai/assistant",
        "@maxai/credential-storage",
        "@maxai/egress-proxy",
        "@maxai/skill-host-contracts",
        "@maxai/assistant-client",
        "@maxai/ces-client",
        "@maxai/gateway-client",
      ].includes(dep),
    );

    expect(forbidden).toEqual([]);
  });
});
