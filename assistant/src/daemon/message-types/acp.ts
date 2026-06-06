// ACP (Agent Client Protocol) session lifecycle and communication types.

// === Server → Client (streamed via SSE) ===

export interface AcpSessionSpawned {
  type: "acp_session_spawned";
  acpSessionId: string;
  agent: string;
  parentConversationId: string;
}

export interface AcpSessionUpdate {
  type: "acp_session_update";
  acpSessionId: string;
  updateType:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "user_message_chunk"
    | "tool_call"
    | "tool_call_update"
    | "plan";
  content?: string;
  toolCallId?: string;
  toolTitle?: string;
  toolKind?: string;
  toolStatus?: string;
}

export interface AcpSessionCompleted {
  type: "acp_session_completed";
  acpSessionId: string;
  stopReason:
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled"
    // Agentic bridge providers (kimi-agent) additionally report:
    // step-cap interrupt, user abort, and stream wall-clock timeout.
    // Swift decodes unknown values to `.unknown`, so additions here are
    // forward-compatible with older clients.
    | "max_turns"
    | "aborted"
    | "timeout"
    | "error";
}

export interface AcpSessionError {
  type: "acp_session_error";
  acpSessionId: string;
  error: string;
}

// --- Domain-level union alias (consumed by message-protocol.ts) ---

export type _AcpServerMessages =
  | AcpSessionSpawned
  | AcpSessionUpdate
  | AcpSessionCompleted
  | AcpSessionError;
