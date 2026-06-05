import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { stageMcpFreeShareDir } from "../share-dir.js";

/** Build a fake ~/.kimi with the entries the real one carries. */
function makeFakeShareDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-kimi-share-"));
  writeFileSync(
    join(dir, "config.toml"),
    'default_model = "kimi-code/kimi-for-coding"\n',
  );
  writeFileSync(join(dir, "device_id"), "dev-123");
  writeFileSync(join(dir, "kimi.json"), JSON.stringify({ work_dirs: [] }));
  writeFileSync(
    join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      },
    }),
  );
  mkdirSync(join(dir, "credentials"));
  writeFileSync(
    join(dir, "credentials", "kimi-code.json"),
    JSON.stringify({ access_token: "tok" }),
  );
  mkdirSync(join(dir, "sessions"));
  return dir;
}

describe("stageMcpFreeShareDir (ambient-MCP suppression)", () => {
  test("stages a share dir: everything symlinked EXCEPT mcp.json, which is written empty", () => {
    const source = makeFakeShareDir();
    const parent = mkdtempSync(join(tmpdir(), "kimi-staging-"));
    try {
      const staged = stageMcpFreeShareDir(parent, source);
      expect(staged).toBeDefined();

      // mcp.json is a REAL file with zero servers — the ambient playwright
      // entry must not survive into the staged dir.
      const mcpStat = lstatSync(join(staged!, "mcp.json"));
      expect(mcpStat.isSymbolicLink()).toBe(false);
      const mcp = JSON.parse(readFileSync(join(staged!, "mcp.json"), "utf-8"));
      expect(mcp).toEqual({ mcpServers: {} });

      // Everything else is a symlink pointing back at the real entry, so
      // auth/config/session state stays shared with the real dir.
      for (const entry of [
        "config.toml",
        "device_id",
        "kimi.json",
        "credentials",
        "sessions",
      ]) {
        const p = join(staged!, entry);
        expect(lstatSync(p).isSymbolicLink()).toBe(true);
        expect(readlinkSync(p)).toBe(join(source, entry));
      }

      // A token refresh writing INSIDE the symlinked credentials dir lands
      // in the REAL credentials dir (dir-level symlinks are rename-proof).
      writeFileSync(join(staged!, "credentials", "refreshed.json"), "{}");
      expect(existsSync(join(source, "credentials", "refreshed.json"))).toBe(
        true,
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("source dir without an mcp.json still stages (empty mcp.json written)", () => {
    const source = makeFakeShareDir();
    rmSync(join(source, "mcp.json"));
    const parent = mkdtempSync(join(tmpdir(), "kimi-staging-"));
    try {
      const staged = stageMcpFreeShareDir(parent, source);
      expect(staged).toBeDefined();
      const mcp = JSON.parse(readFileSync(join(staged!, "mcp.json"), "utf-8"));
      expect(mcp).toEqual({ mcpServers: {} });
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("missing source dir returns undefined (fall back to SDK defaults, never throw)", () => {
    const parent = mkdtempSync(join(tmpdir(), "kimi-staging-"));
    try {
      expect(
        stageMcpFreeShareDir(parent, join(parent, "does-not-exist")),
      ).toBeUndefined();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("LOAD-BEARING: rmSync of the staging parent must NOT delete through symlinks into the real dir", () => {
    // The provider stages under its session tmpDir and cleans up with
    // `rmSync(tmpDir, { recursive: true, force: true })`. That cleanup
    // unlinks the SYMLINKS — it must never recurse through them into the
    // real ~/.kimi (credentials, sessions). If this test ever fails, the
    // cleanup path would be deleting users' real OAuth credentials.
    const source = makeFakeShareDir();
    const parent = mkdtempSync(join(tmpdir(), "kimi-staging-"));
    try {
      stageMcpFreeShareDir(parent, source);
      writeFileSync(join(source, "credentials", "sentinel.json"), "{}");

      // Mirror the provider's real cleanup: remove the whole PARENT.
      rmSync(parent, { recursive: true, force: true });

      expect(existsSync(join(source, "credentials", "sentinel.json"))).toBe(
        true,
      );
      expect(existsSync(join(source, "credentials", "kimi-code.json"))).toBe(
        true,
      );
      expect(existsSync(join(source, "config.toml"))).toBe(true);
      expect(existsSync(join(source, "sessions"))).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("staging twice into the same parent does not throw (idempotent symlinks)", () => {
    const source = makeFakeShareDir();
    const parent = mkdtempSync(join(tmpdir(), "kimi-staging-"));
    try {
      const a = stageMcpFreeShareDir(parent, source);
      const b = stageMcpFreeShareDir(parent, source);
      expect(a).toBe(b!);
      const mcp = JSON.parse(readFileSync(join(b!, "mcp.json"), "utf-8"));
      expect(mcp).toEqual({ mcpServers: {} });
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
