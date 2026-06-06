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

const WORK_DIR = "/fake/work/dir";

/** Build a fake ~/.kimi with the entries the real one carries. */
function makeFakeShareDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-kimi-share-"));
  writeFileSync(
    join(dir, "config.toml"),
    'default_model = "kimi-code/kimi-for-coding"\n',
  );
  writeFileSync(join(dir, "device_id"), "dev-123");
  writeFileSync(
    join(dir, "kimi.json"),
    JSON.stringify({
      work_dirs: [
        { path: "/some/other/dir", kaos: "local", last_session_id: "old-id" },
      ],
    }),
  );
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

describe("stageMcpFreeShareDir (ambient-MCP suppression + resume seeding)", () => {
  test("stages a share dir: everything symlinked EXCEPT mcp.json (empty) and kimi.json (seeded real file)", () => {
    const source = makeFakeShareDir();
    const parent = mkdtempSync(join(tmpdir(), "kimi-staging-"));
    try {
      const staged = stageMcpFreeShareDir(parent, WORK_DIR, source);
      expect(staged).toBeDefined();

      // mcp.json is a REAL file with zero servers — the ambient playwright
      // entry must not survive into the staged dir.
      const mcpStat = lstatSync(join(staged!, "mcp.json"));
      expect(mcpStat.isSymbolicLink()).toBe(false);
      const mcp = JSON.parse(readFileSync(join(staged!, "mcp.json"), "utf-8"));
      expect(mcp).toEqual({ mcpServers: {} });

      // kimi.json is a REAL file too (a symlink would be clobbered by
      // kimi-cli ≥1.14's atomic write+rename) seeded with the workDir entry
      // Session.find needs for resume — while preserving real entries.
      const kimiStat = lstatSync(join(staged!, "kimi.json"));
      expect(kimiStat.isSymbolicLink()).toBe(false);
      const kimi = JSON.parse(
        readFileSync(join(staged!, "kimi.json"), "utf-8"),
      ) as {
        work_dirs: Array<{
          path: string;
          kaos: string;
          last_session_id: string | null;
        }>;
      };
      expect(kimi.work_dirs).toContainEqual({
        path: WORK_DIR,
        kaos: "local",
        last_session_id: null,
      });
      expect(kimi.work_dirs).toContainEqual({
        path: "/some/other/dir",
        kaos: "local",
        last_session_id: "old-id",
      });

      // Everything else is a symlink pointing back at the real entry, so
      // auth/config/session state stays shared with the real dir.
      for (const entry of [
        "config.toml",
        "device_id",
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

  test("workDir already registered in real kimi.json → no duplicate entry", () => {
    const source = makeFakeShareDir();
    writeFileSync(
      join(source, "kimi.json"),
      JSON.stringify({
        work_dirs: [{ path: WORK_DIR, kaos: "local", last_session_id: "s1" }],
      }),
    );
    const parent = mkdtempSync(join(tmpdir(), "kimi-staging-"));
    try {
      const staged = stageMcpFreeShareDir(parent, WORK_DIR, source);
      const kimi = JSON.parse(
        readFileSync(join(staged!, "kimi.json"), "utf-8"),
      ) as {
        work_dirs: Array<{ path: string; last_session_id: string | null }>;
      };
      const entries = kimi.work_dirs.filter((w) => w.path === WORK_DIR);
      expect(entries).toHaveLength(1);
      // The real entry (with its last_session_id) is preserved verbatim.
      expect(entries[0].last_session_id).toBe("s1");
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("source dir without mcp.json/kimi.json still stages (both written fresh)", () => {
    const source = makeFakeShareDir();
    rmSync(join(source, "mcp.json"));
    rmSync(join(source, "kimi.json"));
    const parent = mkdtempSync(join(tmpdir(), "kimi-staging-"));
    try {
      const staged = stageMcpFreeShareDir(parent, WORK_DIR, source);
      expect(staged).toBeDefined();
      const mcp = JSON.parse(readFileSync(join(staged!, "mcp.json"), "utf-8"));
      expect(mcp).toEqual({ mcpServers: {} });
      const kimi = JSON.parse(
        readFileSync(join(staged!, "kimi.json"), "utf-8"),
      ) as { work_dirs: Array<{ path: string }> };
      expect(kimi.work_dirs.some((w) => w.path === WORK_DIR)).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("corrupt real kimi.json → seeded fresh, staging still succeeds", () => {
    const source = makeFakeShareDir();
    writeFileSync(join(source, "kimi.json"), "{not json!!");
    const parent = mkdtempSync(join(tmpdir(), "kimi-staging-"));
    try {
      const staged = stageMcpFreeShareDir(parent, WORK_DIR, source);
      expect(staged).toBeDefined();
      const kimi = JSON.parse(
        readFileSync(join(staged!, "kimi.json"), "utf-8"),
      ) as { work_dirs: Array<{ path: string }> };
      expect(kimi.work_dirs.some((w) => w.path === WORK_DIR)).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("missing source dir returns undefined (fall back to SDK defaults, never throw)", () => {
    const parent = mkdtempSync(join(tmpdir(), "kimi-staging-"));
    try {
      expect(
        stageMcpFreeShareDir(parent, WORK_DIR, join(parent, "does-not-exist")),
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
      stageMcpFreeShareDir(parent, WORK_DIR, source);
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
      const a = stageMcpFreeShareDir(parent, WORK_DIR, source);
      const b = stageMcpFreeShareDir(parent, WORK_DIR, source);
      expect(a).toBe(b!);
      const mcp = JSON.parse(readFileSync(join(b!, "mcp.json"), "utf-8"));
      expect(mcp).toEqual({ mcpServers: {} });
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
