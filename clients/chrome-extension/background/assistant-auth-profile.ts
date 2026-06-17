/**
 * Auth profile enum for the chrome extension's transport selection.
 *
 * - `self-hosted` — pair directly with the gateway's
 *   `/v1/pair` endpoint over HTTP, then open a
 *   WebSocket relay to the same gateway. Used for locally running
 *   assistants where the extension can reach the gateway over loopback
 *   (or a user-provided URL).
 * - `max-cloud` — Max-cloud-managed assistant. Auth relies on the
 *   WorkOS session token and the SSE `/events` transport.
 * - `unsupported` — the topology is not recognised by this version of
 *   the extension.
 */
export type AssistantAuthProfile = 'self-hosted' | 'max-cloud' | 'unsupported';

/**
 * The subset of topology fields needed to derive the auth profile.
 */
export interface LockfileTopology {
  cloud: string;
  runtimeUrl?: string;
}

/** Cloud values that map to self-hosted direct pairing. */
const LOCAL_CLOUD_VALUES = new Set(['local', 'apple-container']);

/** Cloud values that map to Max-cloud (WorkOS session auth). */
const MAX_CLOUD_VALUES = new Set(['max', 'platform']);

/**
 * Derive the auth profile for a given topology.
 */
export function resolveAuthProfile(topology: LockfileTopology): AssistantAuthProfile {
  if (LOCAL_CLOUD_VALUES.has(topology.cloud)) {
    return 'self-hosted';
  }
  if (MAX_CLOUD_VALUES.has(topology.cloud)) {
    return 'max-cloud';
  }
  return 'unsupported';
}
