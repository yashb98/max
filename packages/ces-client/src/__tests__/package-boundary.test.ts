/**
 * Package boundary tests for @maxai/ces-client.
 *
 * Ensures the package:
 * 1. Does NOT import from assistant, gateway, or credential-executor service
 *    runtime modules.
 * 2. Does NOT import from runtime shared packages (@maxai/credential-storage,
 *    @maxai/egress-proxy).
 * 3. Remains a lightweight client package with no runtime service dependencies.
 *
 * @maxai/ces-client is a typed HTTP and RPC client for
 * assistant/gateway-to-CES calls. It may depend on @maxai/service-contracts
 * for shared type definitions, but must not pull in runtime service internals.
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
 * source files.
 */
const FORBIDDEN_IMPORT_PATTERNS = [
  // Assistant runtime internals
  /from\s+["'](?:\.\.\/)+assistant\/src/,
  /require\s*\(\s*["'](?:\.\.\/)+assistant\/src/,
  /from\s+["']@maxai\/assistant(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/assistant(?:\/|["'])/,

  // Gateway runtime internals
  /from\s+["'](?:\.\.\/)+gateway\/src/,
  /require\s*\(\s*["'](?:\.\.\/)+gateway\/src/,
  /from\s+["']@maxai\/(?:max-)?gateway(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/(?:max-)?gateway(?:\/|["'])/,

  // Credential executor runtime internals
  /from\s+["'](?:\.\.\/)+credential-executor\/src/,
  /require\s*\(\s*["'](?:\.\.\/)+credential-executor\/src/,
  /from\s+["']@maxai\/credential-executor(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/credential-executor(?:\/|["'])/,

  // Runtime shared packages
  /from\s+["']@maxai\/credential-storage(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/credential-storage(?:\/|["'])/,
  /from\s+["']@maxai\/egress-proxy(?:\/|["'])/,
  /require\s*\(\s*["']@maxai\/egress-proxy(?:\/|["'])/,
];

describe("package boundary", () => {
  const sourceFiles = collectSourceFiles(SRC_DIR);

  test("has source files to validate", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  test("does not import from service runtime modules or runtime shared packages", () => {
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
        `Found ${violations.length} forbidden import(s) in ces-client package:\n` +
          violations.map((v) => `  - ${v}`).join("\n") +
          "\n\n" +
          "@maxai/ces-client must not import from service runtime modules\n" +
          "or runtime shared packages (credential-storage, egress-proxy).",
      );
    }
  });

  test("package.json declares it as private", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.private).toBe(true);
  });

  test("package.json does not depend on service runtime or runtime shared packages", () => {
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
      ].includes(dep),
    );

    expect(forbidden).toEqual([]);
  });
});
