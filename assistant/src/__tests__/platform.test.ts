import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  ensureDataDir,
  getDataDir,
  getDbPath,
  getHistoryPath,
  getInterfacesDir,
  getLogPath,
  getPidPath,
  getSandboxRootDir,
  getSandboxWorkingDir,
  getWorkspaceConfigPath,
  getWorkspaceDir,
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
  getWorkspacePromptPath,
  getWorkspaceSkillsDir,
  getXdgMaxConfigDirName,
  maxRoot,
} from "../util/platform.js";

const originalWorkspaceDir = process.env.MAX_WORKSPACE_DIR;
const originalMaxEnvironment = process.env.MAX_ENVIRONMENT;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (originalWorkspaceDir == null) {
    delete process.env.MAX_WORKSPACE_DIR;
  } else {
    process.env.MAX_WORKSPACE_DIR = originalWorkspaceDir;
  }
  if (originalMaxEnvironment == null) {
    delete process.env.MAX_ENVIRONMENT;
  } else {
    process.env.MAX_ENVIRONMENT = originalMaxEnvironment;
  }
  if (originalXdgConfigHome == null) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
});

// Path characterization: documents the current path layout.
// Root-level helpers always resolve under ~/.max (from homedir()).
// Workspace helpers resolve under MAX_WORKSPACE_DIR when set,
// otherwise under ~/.max/workspace.
describe("path characterization", () => {
  test("all path helpers resolve to expected locations", () => {
    // Without MAX_WORKSPACE_DIR override, workspace is under ~/.max
    delete process.env.MAX_WORKSPACE_DIR;
    const root = join(homedir(), ".max");
    const ws = getWorkspaceDir();
    const data = getDataDir();

    // Workspace is under root
    expect(ws).toBe(join(root, "workspace"));

    // Data dir is under workspace
    expect(data).toBe(join(ws, "data"));

    // Sub-paths under workspace/data
    expect(getDbPath()).toBe(join(data, "db", "assistant.db"));
    expect(getLogPath()).toBe(join(data, "logs", "max.log"));
    expect(getHistoryPath()).toBe(join(data, "history"));
    expect(getInterfacesDir()).toBe(join(data, "interfaces"));
    expect(getSandboxRootDir()).toBe(join(data, "sandbox"));
    expect(getSandboxWorkingDir()).toBe(ws);

    // Hooks live under workspace
    expect(getWorkspaceHooksDir()).toBe(join(ws, "hooks"));

    // PID file lives in the workspace directory
    expect(getPidPath()).toBe(join(ws, "max.pid"));
  });

  test("MAX_WORKSPACE_DIR overrides workspace location", () => {
    process.env.MAX_WORKSPACE_DIR = "/tmp/custom-workspace";
    expect(getWorkspaceDir()).toBe("/tmp/custom-workspace");
    expect(getDataDir()).toBe("/tmp/custom-workspace/data");
    // PID path follows workspace override
    expect(getPidPath()).toBe("/tmp/custom-workspace/max.pid");
  });

  test("hooks directory is inside the workspace boundary", () => {
    delete process.env.MAX_WORKSPACE_DIR;
    expect(getWorkspaceHooksDir().startsWith(getWorkspaceDir())).toBe(true);
  });

  test("ensureDataDir creates all expected directories", () => {
    // Use a temp MAX_WORKSPACE_DIR so ensureDataDir writes to a temp dir
    // rather than the real ~/.max. Root-level dirs still go to ~/.max
    // but we only verify workspace dirs here to avoid side effects.
    const wsDir = join(tmpdir(), `platform-test-ws-${Date.now()}`);
    process.env.MAX_WORKSPACE_DIR = wsDir;

    ensureDataDir();

    // Root-level dirs (ensureDataDir always creates these)
    const root = maxRoot();
    expect(existsSync(root)).toBe(true);

    // Workspace dirs (in our temp location)
    expect(existsSync(wsDir)).toBe(true);
    expect(existsSync(join(wsDir, "skills"))).toBe(true);

    // Data sub-dirs under workspace
    const data = join(wsDir, "data");
    expect(existsSync(data)).toBe(true);
    expect(existsSync(join(data, "db"))).toBe(true);
    expect(existsSync(join(data, "qdrant"))).toBe(true);
    expect(existsSync(join(data, "logs"))).toBe(true);
    expect(existsSync(join(data, "memory"))).toBe(true);
    expect(existsSync(join(data, "memory", "knowledge"))).toBe(true);
    expect(existsSync(join(data, "apps"))).toBe(true);
    expect(existsSync(join(data, "interfaces"))).toBe(true);

    rmSync(wsDir, { recursive: true, force: true });
  });
});

describe("XDG config dir name env-awareness", () => {
  test("production returns max", () => {
    delete process.env.MAX_ENVIRONMENT;
    delete process.env.XDG_CONFIG_HOME;
    expect(getXdgMaxConfigDirName()).toBe("max");
  });

  test("production (explicit) returns max", () => {
    process.env.MAX_ENVIRONMENT = "production";
    expect(getXdgMaxConfigDirName()).toBe("max");
  });

  test("dev environment returns max-dev", () => {
    process.env.MAX_ENVIRONMENT = "dev";
    expect(getXdgMaxConfigDirName()).toBe("max-dev");
  });

  test.each(["staging", "test", "local"])(
    "%s environment returns max-%s",
    (env) => {
      process.env.MAX_ENVIRONMENT = env;
      expect(getXdgMaxConfigDirName()).toBe(`max-${env}`);
    },
  );

  test("unknown environment falls back to production", () => {
    process.env.MAX_ENVIRONMENT = "no-such-env";
    expect(getXdgMaxConfigDirName()).toBe("max");
  });
});

describe("workspace path primitives", () => {
  test("workspace helpers resolve under workspace dir", () => {
    delete process.env.MAX_WORKSPACE_DIR;
    const ws = getWorkspaceDir();

    expect(getWorkspaceConfigPath()).toBe(join(ws, "config.json"));
    expect(getWorkspaceSkillsDir()).toBe(join(ws, "skills"));
    expect(getWorkspaceHooksDir()).toBe(join(ws, "hooks"));
    expect(getWorkspacePluginsDir()).toBe(join(ws, "plugins"));
    expect(getWorkspacePromptPath("IDENTITY.md")).toBe(join(ws, "IDENTITY.md"));
    expect(getWorkspacePromptPath("SOUL.md")).toBe(join(ws, "SOUL.md"));
  });
});
