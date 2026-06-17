/**
 * Device ID resolver.
 *
 * Reads or creates a stable per-device UUID stored in device.json under the
 * Max config directory. The file is a JSON object (`{ "deviceId": "<uuid>" }`)
 * extensible for future per-device metadata.
 *
 * Path resolution:
 *   - Containerized (IS_CONTAINERIZED=true): `/home/assistant/.max/device.json`
 *     — the assistant user's persistent home dir, kept off the shared data
 *     volume. Not affected by MAX_ENVIRONMENT because the container fs
 *     has no cross-process contract with the Swift client.
 *   - Non-containerized production: `~/.max/device.json` (legacy, shared
 *     across all local instances on the same machine).
 *   - Non-containerized non-production: `$XDG_CONFIG_HOME/max-<env>/device.json`,
 *     matching Swift's `MaxPaths.deviceIdFile`.
 *
 * The value is cached in memory after the first successful read/write.
 * Falls back to a generated UUID if the file cannot be read or written.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getLogger } from "./logger.js";
import { getXdgMaxConfigDirName } from "./platform.js";

const log = getLogger("device-id");

let cached: string | undefined;

/**
 * Resolve the directory and file path for `device.json` based on the
 * runtime environment. See the module docblock for the resolution table.
 *
 * Production and containerized modes preserve the legacy `~/.max` /
 * `/home/assistant/.max` paths. Non-production, non-containerized
 * deployments route through `$XDG_CONFIG_HOME/max-<env>` to match
 * the Swift client's `MaxPaths.deviceIdFile`.
 */
function resolveDeviceIdPaths(): { dir: string; file: string } {
  if (getIsContainerized()) {
    const dir = join("/home/assistant", ".max");
    return { dir, file: join(dir, "device.json") };
  }

  const configDirName = getXdgMaxConfigDirName();
  if (configDirName === "max") {
    // Production: device.json lives at ~/.max/device.json, shared
    // across all local instances on the same machine.
    const dir = join(homedir(), ".max");
    return { dir, file: join(dir, "device.json") };
  }

  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  const dir = join(configHome, configDirName);
  return { dir, file: join(dir, "device.json") };
}

/**
 * Get the stable device ID for this machine.
 *
 * Resolution order:
 *   1. Cached in-memory value (populated on first call)
 *   2. `deviceId` field from device.json
 *   3. Generate a new UUID, persist it to device.json, and return it
 *
 * On any read/write error the generated UUID is still cached so the
 * process uses a consistent ID for the remainder of its lifetime.
 */
export function getDeviceId(): string {
  if (cached !== undefined) {
    return cached;
  }

  const { dir: maxDir, file: filePath } = resolveDeviceIdPaths();
  const generated = randomUUID();

  try {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      if (
        raw &&
        typeof raw === "object" &&
        typeof raw.deviceId === "string" &&
        raw.deviceId.length > 0
      ) {
        cached = raw.deviceId as string;
        log.info({ deviceId: cached }, "Resolved device ID from device.json");
        return cached;
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to read device.json — generating new device ID");
  }

  // Either the file doesn't exist or deviceId was missing/empty.
  // Generate a new UUID and persist it.
  try {
    mkdirSync(maxDir, { recursive: true });

    // Read existing content to preserve other fields
    let existing: Record<string, unknown> = {};
    try {
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, "utf-8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          existing = raw as Record<string, unknown>;
        }
      }
    } catch {
      // Malformed JSON — start fresh
    }

    existing.deviceId = generated;
    writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", {
      mode: 0o644,
    });
    log.info({ deviceId: generated }, "Created new device ID in device.json");
  } catch (err) {
    log.warn(
      { err },
      "Failed to write device.json — using generated device ID in-memory only",
    );
  }

  cached = generated;
  return cached;
}

/**
 * Reset the cached device ID. Used by tests to force
 * re-resolution on the next call.
 */
export function resetDeviceIdCache(): void {
  cached = undefined;
}
