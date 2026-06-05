import type { ToolDefinition } from "@vellumai/skill-host-contracts";
export type { ToolDefinition };

import type { LLMCallSite } from "../config/schemas/llm.js";
import type { SensitiveOutputBinding } from "../tools/sensitive-output-placeholders.js";
import { ProviderError } from "../util/errors.js";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface FileContent {
  type: "file";
  source: {
    type: "base64";
    media_type: string;
    data: string;
    filename: string;
  };
  extracted_text?: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  providerMetadata?: {
    gemini?: {
      thoughtSignature?: string;
    };
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingContent {
  type: "redacted_thinking";
  data: string;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /** Rich content blocks (e.g. images) to include alongside text in the tool result. */
  contentBlocks?: ContentBlock[];
}

export interface ServerToolUseContent {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface WebSearchToolResultContent {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: unknown; // Opaque — encrypted_content in search results is provider-specific
}

export type ContentBlock =
  | TextContent
  | ThinkingContent
  | RedactedThinkingContent
  | ImageContent
  | FileContent
  | ToolUseContent
  | ToolResultContent
  | ServerToolUseContent
  | WebSearchToolResultContent;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export type ModelIntent =
  | "balanced"
  | "latency-optimized"
  | "quality-optimized"
  | "vision-optimized";

export interface ProviderResponse {
  content: ContentBlock[];
  model: string;
  /** Provider that actually produced this response, which may differ from a wrapper provider name. */
  actualProvider?: string;
  usage: {
    /** Total input tokens (input_tokens + cache_creation + cache_read). */
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    reasoningTokens?: number;
  };
  stopReason: string;
  /** Raw JSON request body sent to the provider (for diagnostics logging). */
  rawRequest?: unknown;
  /** Raw JSON response body received from the provider (for diagnostics logging). */
  rawResponse?: unknown;
}

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_use_preview_start"; toolUseId: string; toolName: string }
  | {
      type: "input_json_delta";
      toolName: string;
      toolUseId: string;
      accumulatedJson: string;
    }
  | {
      type: "server_tool_start";
      name: string;
      toolUseId: string;
      input: Record<string, unknown>;
    }
  | {
      type: "server_tool_complete";
      toolUseId: string;
      isError: boolean;
      content?: unknown[];
    }
  /**
   * Incremental tool-output chunk emitted from a *bridged* tool — i.e. a
   * tool that ran inside an agentic provider's own loop (currently only
   * `claude-subscription`) rather than via Vellum's outer
   * `agent/loop.ts` dispatch. Vellum's normal tool dispatch surfaces
   * chunks at the outer loop and never round-trips through the provider
   * boundary — but bridged tools have no outer-loop tool_use block, so
   * the provider emits chunks here and the outer-loop adapter
   * (`loop.ts`) forwards them as `tool_output_chunk` AgentEvents.
   * `toolUseId` matches the SDK's real `tool_use_id` once Phase 2.6
   * correlation is wired (claude-subscription bridge).
   */
  | { type: "tool_output_chunk"; toolUseId: string; chunk: string }
  /**
   * Committed tool-use event from a bridged agentic provider. The bridge
   * emits this when its underlying SDK has accepted a tool call (input is
   * fully assembled) — analogous to the outer loop's
   * `AgentEvent.tool_use`, which fires only after the loop itself
   * dispatches a tool. Bridged tools never reach the outer-loop dispatch
   * path, so the provider has to synthesise the committed event here. The
   * loop adapter forwards it as `AgentEvent.tool_use` so composer UIs
   * render the tool-call card the same way they do for non-bridged
   * providers.
   */
  | {
      type: "bridged_tool_committed";
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  /**
   * Result of a bridged tool execution. Emitted by the bridge's MCP
   * `CallTool` handler once `ProviderToolBridge` returns. Mirrors the
   * outer loop's `AgentEvent.tool_result` shape sufficient for the
   * composer to swap the in-flight tool-call card for its final state.
   */
  | {
      type: "bridged_tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
    };

export interface SendMessageConfig {
  model?: string;
  /**
   * LLM call-site identifier. `RetryProvider` resolves
   * provider/model/maxTokens/effort/speed/verbosity/temperature/thinking/
   * contextWindow via `resolveCallSiteConfig(callSite, config.llm)`, falling
   * back to `llm.default` when no callSite-specific entry is present.
   */
  callSite?: LLMCallSite;
  /**
   * Optional ad-hoc profile override applied per request. When set, the
   * resolver layers `llm.profiles[overrideProfile]` between the workspace's
   * `activeProfile` and the call-site's named profile (see
   * `resolveCallSiteConfig`). Used by per-conversation pinned profiles to
   * override the workspace default for a single send. Missing profile names
   * silently fall through.
   */
  overrideProfile?: string;
  /**
   * Internal per-request HTTP headers for managed-proxy usage attribution.
   * Provider clients may pass these through SDK request options only when the
   * transport is Vellum-managed, and must never include this object in provider
   * JSON request bodies.
   */
  usageAttributionHeaders?: Record<string, string>;
  /**
   * Controls local usage-ledger writes for attributed provider calls.
   * Defaults to `auto`; conversation paths that aggregate usage separately
   * set `manual` to avoid double-counting.
   */
  usageTracking?: "auto" | "manual";
  effort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  speed?: "standard" | "fast";
  verbosity?: "low" | "medium" | "high";
  [key: string]: unknown;
}

/**
 * Invocation handed to a `ProviderToolBridge` when a provider that runs
 * its own agent loop (currently only `claude-subscription` via the Claude
 * Agent SDK) needs to execute one of Vellum's tools mid-loop.
 */
export interface ToolBridgeInvocation {
  toolName: string;
  input: Record<string, unknown>;
  /**
   * Incremental tool output callback. The provider supplies this when it
   * wants to surface chunks emitted by the tool (`context.onOutput(...)`
   * in production tools — e.g. the shell tool's stdout/stderr) back to its
   * `SendMessageOptions.onEvent` consumer as `tool_output_chunk` events.
   * Bridges that delegate to Vellum's `ToolExecutor` should forward this
   * into the executor's per-call `onOutput` argument (or, when calling
   * `ToolExecutor.execute` directly, into `ToolContext.onOutput`). Phase
   * 2.5 in `docs/architecture/claude-subscription-bridge.md`.
   */
  onChunk?: (chunk: string) => void;
}

/**
 * Result returned to the in-provider agent loop after a Vellum tool runs.
 * `content` and `isError` are the always-present fields the SDK needs to
 * continue. `yieldToUser` is propagated so an agentic provider can abort
 * its loop immediately when a Vellum tool requests a hard yield (e.g.
 * interactive tables or `remember(finish_turn=true)`); see D-2 in
 * `docs/architecture/claude-subscription-bridge.md`.
 *
 * `contentBlocks` carries rich tool-result content (images, additional
 * text segments, file extractions). Providers that bridge through MCP map
 * these onto the spec's `CallToolResult.content` array so the model can
 * see screenshots, parsed PDFs, and other multimodal output. Phase 2.1
 * in `docs/architecture/claude-subscription-bridge.md`.
 */
export interface ToolBridgeResult {
  content: string;
  isError?: boolean;
  /**
   * When true, the provider's agentic loop must stop after this tool
   * returns. The subscription provider implements this by aborting the
   * SDK's internal agent loop; Vellum's outer loop then sees the
   * accumulated assistant text with no further tool_use blocks and
   * breaks normally.
   */
  yieldToUser?: boolean;
  /**
   * Rich content blocks accompanying `content`. Forwarded from
   * `ToolExecutionResult.contentBlocks` by the outer-loop bridge closure
   * and translated to MCP content items in `client.ts`. Only the kinds
   * that make semantic sense as tool output emit a corresponding MCP
   * item: `text` → text, `image` → image, `file` with `extracted_text`
   * → text. Model-internal kinds (`thinking`, `redacted_thinking`,
   * `tool_use`, `tool_result`, `server_tool_use`,
   * `web_search_tool_result`) are skipped — they cannot meaningfully
   * appear in a tool result returned to the model.
   */
  contentBlocks?: ContentBlock[];
  /**
   * Placeholder→value bindings the tool emitted via
   * `<vellum-sensitive-output>` directives. Forwarded so the outer-loop
   * bridge closure can merge them into the per-run `substitutionMap`,
   * matching what the non-bridge path does in
   * `loop.ts:992-998`. Without this, the model echoes literal
   * `VELLUM_ASSISTANT_INVITE_CODE_<token>` placeholders to the user
   * instead of the masked value (security invariant — the secret —
   * still holds; UX regression only). Phase 2.2 in
   * `docs/architecture/claude-subscription-bridge.md`.
   */
  sensitiveBindings?: SensitiveOutputBinding[];
}

/**
 * Per-call callback the caller of `sendMessage` may supply to let an
 * agentic provider invoke Vellum tools without rebuilding the trust,
 * approval, CES, and audit pipeline. The implementation is expected to
 * delegate to Vellum's existing `ToolExecutor` (`assistant/src/tools/
 * executor.ts`) so all security gates fire as on the normal path.
 *
 * Providers that do not run their own loop (anthropic, openai, gemini,
 * etc.) ignore this field — Vellum's outer loop handles tool execution
 * after `sendMessage` returns.
 */
export type ProviderToolBridge = (
  invocation: ToolBridgeInvocation,
) => Promise<ToolBridgeResult>;

export interface SendMessageOptions {
  config?: SendMessageConfig;
  onEvent?: (event: ProviderEvent) => void;
  signal?: AbortSignal;
  /**
   * Bridge that an agentic provider calls when its own loop wants to
   * execute a Vellum tool. Only consumed by providers like
   * `claude-subscription` whose underlying SDK runs the tool loop
   * internally. When unset, the provider falls back to its own
   * registry (e.g. `setVellumToolExecutor`) or to a stub.
   */
  toolBridge?: ProviderToolBridge;
  /**
   * Maximum characters for a single bridged tool result before it is
   * truncated with a clear suffix. Only consulted by agentic providers
   * that route Vellum tool calls internally (currently
   * `claude-subscription`). Computed by the outer loop from the
   * conversation's context-window size, matching what the outer-loop
   * `toolResultTruncate` pipeline would apply to a non-bridged tool
   * result. When unset, no truncation is applied at the bridge seam —
   * useful for tests that want raw passthrough. Phase 2.4 in
   * `docs/architecture/claude-subscription-bridge.md`.
   */
  maxToolResultChars?: number;
}

export interface Provider {
  name: string;
  /**
   * Provider key used by the local token estimator to select model-family
   * specific rules (e.g. Anthropic's `width * height / 750` image sizing).
   * Wrapper providers that route to another provider's API — e.g. OpenRouter
   * calling Anthropic's Messages endpoint for `anthropic/*` models — override
   * this so the estimator matches what the upstream API will actually charge.
   * Falls back to `name` when unset.
   */
  tokenEstimationProvider?: string;
  sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse>;
}

// ── Context-overflow error ────────────────────────────────────────────

export interface ContextOverflowErrorOptions {
  /** Actual tokens the request was estimated/measured to consume, when the provider reports it. */
  actualTokens?: number;
  /** Context-window cap the provider enforced, when reported in the error body. */
  maxTokens?: number;
  /** HTTP status reported by the provider. Defaults to 400. */
  statusCode?: number;
  /** Underlying error to preserve the cause chain (standard Error.cause). */
  cause?: unknown;
}

/**
 * Thrown by provider clients when the request exceeded the model's context
 * window (HTTP 400 `context_length_exceeded`, Anthropic's `prompt_too_long`,
 * Gemini's resource-exhausted category, etc.).
 *
 * Extends `ProviderError` so existing `instanceof ProviderError` classifiers
 * (`util/retry.ts`, `daemon/conversation-error.ts`) continue to see it as a
 * typed 4xx provider error and apply the right policy. The
 * `actualTokens`/`maxTokens` fields carry structured counts when the
 * provider reports them, avoiding brittle regex parsing at the caller.
 *
 * A regex-on-message fallback still exists in
 * `daemon/parse-actual-tokens-from-error.ts` as a safety net for adapters
 * that rewrap the error (e.g. managed-proxy) before it reaches the agent
 * loop.
 */
export class ContextOverflowError extends ProviderError {
  public readonly actualTokens?: number;
  public readonly maxTokens?: number;

  constructor(
    message: string,
    provider: string,
    options: ContextOverflowErrorOptions = {},
  ) {
    super(
      message,
      provider,
      options.statusCode ?? 400,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "ContextOverflowError";
    this.actualTokens = options.actualTokens;
    this.maxTokens = options.maxTokens;
  }
}

export function isContextOverflowError(
  err: unknown,
): err is ContextOverflowError {
  return err instanceof ContextOverflowError;
}

/**
 * Extract `actualTokens` / `maxTokens` from provider overflow messages of the
 * form "N tokens > M maximum" or bare "N > M". Returns an empty object when
 * neither count is parseable — callers should treat this as "matched the
 * overflow signal but counts unknown".
 */
export function extractOverflowTokensFromMessage(message: string): {
  actualTokens?: number;
  maxTokens?: number;
} {
  const match = message.match(/(\d[\d,]*)\s*(?:tokens?\s*)?[>≥]\s*(\d[\d,]*)/i);
  if (!match) return {};
  const actual = parseInt(match[1].replace(/,/g, ""), 10);
  const max = parseInt(match[2].replace(/,/g, ""), 10);
  const out: { actualTokens?: number; maxTokens?: number } = {};
  if (!isNaN(actual) && actual > 0) out.actualTokens = actual;
  if (!isNaN(max) && max > 0) out.maxTokens = max;
  return out;
}
