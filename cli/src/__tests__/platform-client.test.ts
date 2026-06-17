import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearPlatformToken,
  getPlatformUrl,
  readPlatformToken,
  savePlatformToken,
} from "../lib/platform-client.js";

describe("platform-client token path is env-scoped", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.MAX_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-platform-client-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.MAX_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    if (savedEnv === undefined) {
      delete process.env.MAX_ENVIRONMENT;
    } else {
      process.env.MAX_ENVIRONMENT = savedEnv;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("prod (MAX_ENVIRONMENT unset) writes to $XDG_CONFIG_HOME/max/platform-token", () => {
    const token = "vak_prod_token_123";
    savePlatformToken(token);

    const prodPath = join(tempHome, "max", "platform-token");
    expect(existsSync(prodPath)).toBe(true);
    expect(readFileSync(prodPath, "utf-8").trim()).toBe(token);
    expect(readPlatformToken()).toBe(token);
  });

  test("dev (MAX_ENVIRONMENT=dev) writes to $XDG_CONFIG_HOME/max-dev/platform-token", () => {
    process.env.MAX_ENVIRONMENT = "dev";
    const token = "vak_dev_token_456";
    savePlatformToken(token);

    const devPath = join(tempHome, "max-dev", "platform-token");
    expect(existsSync(devPath)).toBe(true);
    expect(readFileSync(devPath, "utf-8").trim()).toBe(token);

    const prodPath = join(tempHome, "max", "platform-token");
    expect(existsSync(prodPath)).toBe(false);

    expect(readPlatformToken()).toBe(token);
  });

  test("prod and dev tokens are isolated on disk", () => {
    // Save prod token
    delete process.env.MAX_ENVIRONMENT;
    savePlatformToken("prod-token");

    // Switch to dev and save a different token
    process.env.MAX_ENVIRONMENT = "dev";
    savePlatformToken("dev-token");

    // Dev read returns dev
    expect(readPlatformToken()).toBe("dev-token");

    // Switch back to prod — prod value is unchanged
    delete process.env.MAX_ENVIRONMENT;
    expect(readPlatformToken()).toBe("prod-token");

    // Files live at distinct paths
    expect(
      readFileSync(join(tempHome, "max", "platform-token"), "utf-8").trim(),
    ).toBe("prod-token");
    expect(
      readFileSync(
        join(tempHome, "max-dev", "platform-token"),
        "utf-8",
      ).trim(),
    ).toBe("dev-token");
  });

  test("clearPlatformToken removes only the env-scoped token", () => {
    // Prod token
    delete process.env.MAX_ENVIRONMENT;
    savePlatformToken("prod-token");

    // Dev token
    process.env.MAX_ENVIRONMENT = "dev";
    savePlatformToken("dev-token");

    // Clear dev
    clearPlatformToken();
    expect(existsSync(join(tempHome, "max-dev", "platform-token"))).toBe(
      false,
    );

    // Prod still there
    expect(existsSync(join(tempHome, "max", "platform-token"))).toBe(true);
  });
});

describe("getPlatformUrl resolution order", () => {
  let tempLockDir: string;
  let savedLockDir: string | undefined;
  let savedEnv: string | undefined;
  let savedPlatformUrl: string | undefined;

  beforeEach(() => {
    savedLockDir = process.env.MAX_LOCKFILE_DIR;
    savedEnv = process.env.MAX_ENVIRONMENT;
    savedPlatformUrl = process.env.MAX_PLATFORM_URL;
    tempLockDir = mkdtempSync(join(tmpdir(), "cli-platform-url-test-"));
    process.env.MAX_LOCKFILE_DIR = tempLockDir;
    delete process.env.MAX_ENVIRONMENT;
    delete process.env.MAX_PLATFORM_URL;
  });

  afterEach(() => {
    if (savedLockDir === undefined) {
      delete process.env.MAX_LOCKFILE_DIR;
    } else {
      process.env.MAX_LOCKFILE_DIR = savedLockDir;
    }
    if (savedEnv === undefined) {
      delete process.env.MAX_ENVIRONMENT;
    } else {
      process.env.MAX_ENVIRONMENT = savedEnv;
    }
    if (savedPlatformUrl === undefined) {
      delete process.env.MAX_PLATFORM_URL;
    } else {
      process.env.MAX_PLATFORM_URL = savedPlatformUrl;
    }
    rmSync(tempLockDir, { recursive: true, force: true });
  });

  function writeLockfile(data: Record<string, unknown>): void {
    // MAX_ENVIRONMENT is unset → production env → `.max.lock.json`.
    writeFileSync(
      join(tempLockDir, ".max.lock.json"),
      JSON.stringify(data, null, 2),
    );
  }

  test("returns lockfile platformBaseUrl when set", () => {
    writeLockfile({ platformBaseUrl: "https://staging.max.ai" });
    expect(getPlatformUrl()).toBe("https://staging.max.ai");
  });

  test("lockfile platformBaseUrl takes priority over MAX_PLATFORM_URL", () => {
    writeLockfile({ platformBaseUrl: "https://lockfile.max.ai" });
    process.env.MAX_PLATFORM_URL = "https://env.max.ai";
    expect(getPlatformUrl()).toBe("https://lockfile.max.ai");
  });

  test("falls back to MAX_PLATFORM_URL when lockfile is missing", () => {
    process.env.MAX_PLATFORM_URL = "https://env-only.max.ai";
    expect(getPlatformUrl()).toBe("https://env-only.max.ai");
  });

  test("falls back to MAX_PLATFORM_URL when lockfile has no platformBaseUrl", () => {
    writeLockfile({ assistants: [] });
    process.env.MAX_PLATFORM_URL = "https://env-fallback.max.ai";
    expect(getPlatformUrl()).toBe("https://env-fallback.max.ai");
  });

  test("falls back to MAX_PLATFORM_URL when lockfile platformBaseUrl is blank", () => {
    writeLockfile({ platformBaseUrl: "   " });
    process.env.MAX_PLATFORM_URL = "https://env-after-blank.max.ai";
    expect(getPlatformUrl()).toBe("https://env-after-blank.max.ai");
  });

  test("falls back to prod env seed URL when lockfile and MAX_PLATFORM_URL are unset (prod env)", () => {
    // MAX_ENVIRONMENT is unset → production → prod seed URL.
    expect(getPlatformUrl()).toBe("https://platform.max.ai");
  });

  test("falls back to dev env seed URL when MAX_ENVIRONMENT=dev", () => {
    process.env.MAX_ENVIRONMENT = "dev";
    expect(getPlatformUrl()).toBe("https://dev-platform.max.ai");
  });

  test("trims whitespace from MAX_PLATFORM_URL", () => {
    process.env.MAX_PLATFORM_URL = "  https://trimmed.max.ai  ";
    expect(getPlatformUrl()).toBe("https://trimmed.max.ai");
  });
});
