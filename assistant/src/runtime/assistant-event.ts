/**
 * Assistant Events -- thin re-export layer.
 *
 * The shared types and SSE framing helpers live in the neutral
 * `@maxai/skill-host-contracts` package so isolated skill processes
 * can consume them without pulling in the daemon. This file pins the
 * generic payload to the daemon-side `ServerMessage` union so existing
 * callers continue to get full discriminated-union narrowing.
 */

import type { AssistantEvent as BaseAssistantEvent } from "@maxai/skill-host-contracts";
import { buildAssistantEvent as baseBuildAssistantEvent } from "@maxai/skill-host-contracts";

import type { ServerMessage } from "../daemon/message-protocol.js";

export {
  formatSseFrame,
  formatSseHeartbeat,
} from "@maxai/skill-host-contracts";

/** Daemon-side specialization of the generic event envelope. */
export type AssistantEvent = BaseAssistantEvent<ServerMessage>;

/** Daemon-side wrapper preserving the original `ServerMessage`-typed signature. */
export function buildAssistantEvent(
  message: ServerMessage,
  conversationId?: string,
): AssistantEvent {
  return baseBuildAssistantEvent<ServerMessage>(message, conversationId);
}
