/**
 * Skill IPC routes: `host.platform.workspaceDir`, `host.platform.maxRoot`,
 * and `host.platform.runtimeMode`.
 *
 * Surface the platform-path helpers and deployment mode so out-of-process
 * skills can compute workspace-relative paths and branch on docker vs
 * bare-metal behavior without reaching into assistant internals.
 */

import { getDaemonRuntimeMode } from "../../runtime/runtime-mode.js";
import { getWorkspaceDir, maxRoot } from "../../util/platform.js";
import type { SkillIpcRoute } from "../skill-ipc-types.js";

export const hostPlatformWorkspaceDirRoute: SkillIpcRoute = {
  method: "host.platform.workspaceDir",
  handler: () => {
    return getWorkspaceDir();
  },
};

export const hostPlatformMaxRootRoute: SkillIpcRoute = {
  method: "host.platform.maxRoot",
  handler: () => {
    return maxRoot();
  },
};

export const hostPlatformRuntimeModeRoute: SkillIpcRoute = {
  method: "host.platform.runtimeMode",
  handler: () => {
    return getDaemonRuntimeMode();
  },
};

export const platformRoutes: SkillIpcRoute[] = [
  hostPlatformWorkspaceDirRoute,
  hostPlatformMaxRootRoute,
  hostPlatformRuntimeModeRoute,
];
