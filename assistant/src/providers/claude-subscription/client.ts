import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { truncateToolResultText } from "../../context/tool-result-truncation.js";
import { getLogger } from "../../util/logger.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderEvent,
  ProviderResponse,
  ProviderToolBridge,
  SendMessageOptions,
  ToolBridgeResult,
  ToolDefinition,
} from "../types.js";
import {
  ContextOverflowError,
  extractOverflowTokensFromMessage,
} from "../types.js";
import {
  classifyClaudeSubscriptionError,
  ClaudeSubscriptionBridgeError,
} from "./errors.js";

const log = getLogger("claude-subscription-client");

const execFileAsync = promisify(execFile);

// Lazily resolve the absolute path to the user's `claude` CLI binary and
// cache it for the daemon's lifetime. The Claude Agent SDK normally relies
// on a native CLI binary bundled by `@anthropic-ai/claude-agent-sdk`'s
// optional install, but Bun's `--compile` step strips optional packages —
// the bundled binary is missing in our daemon build. Passing the absolute
// path of the user's installed `claude` via `options.pathToClaudeCodeExecutable`
// is the SDK's documented fallback (per the error message it raises when
// the bundled binary is absent). Resolution failures cache `null` so
// subsequent calls don't repeatedly spawn `which`.
let cachedClaudeCliPath: string | null | undefined;
async function resolveClaudeCliPath(): Promise<string | null> {
  if (cachedClaudeCliPath !== undefined) return cachedClaudeCliPath;
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", ["claude"], {
      timeout: 2000,
    });
    const trimmed = stdout.trim();
    cachedClaudeCliPath = trimmed.length > 0 ? trimmed : null;
  } catch {
    cachedClaudeCliPath = null;
  }
  return cachedClaudeCliPath;
}

// ── Tool-bridge resolution ─────────────────────────────────────────────
//
// The Provider boundary in Vellum is intentionally narrow: it covers the
// LLM call and nothing else. Tool execution lives in the conversation
// runtime alongside trust gates, CES, approval flow, and audit. The
// Claude Agent SDK, by contrast, runs its own agent loop and invokes
// tools during that loop — so when this provider is the LLM transport,
// any tool the model calls fires inside the SDK's loop, not Vellum's.
//
// Two seams let Vellum's tool runner be reached from inside the SDK loop:
//
//   1. Per-call: `SendMessageOptions.toolBridge` (preferred). The caller
//      (typically `agent/loop.ts`) supplies a closure already bound to
//      the current conversation's `ToolExecutor` + `TurnContext`. This is
//      the right path in production because conversation/trust state is
//      per-call ephemeral and must not leak across conversations.
//
//   2. Process-global registry: `setVellumToolBridge(...)`. Useful for
//      tests and for early-boot calls that happen before a conversation
//      exists. Not appropriate for multi-conversation production paths.
//
// When both are unset, the stub below makes the no-op visible rather
// than silently returning empty results.
//
// Security: this provider does NOT re-implement gates. The bridge it
// receives is expected to call into Vellum's existing `ToolExecutor`,
// which runs the full allowlist → permission → approval → CES → audit
// pipeline. Registering a permissive bridge that bypasses that pipeline
// would create a security regression — don't.

let registryBridge: ProviderToolBridge | undefined;

export function setVellumToolBridge(bridge: ProviderToolBridge): void {
  registryBridge = bridge;
}

export function clearVellumToolBridge(): void {
  registryBridge = undefined;
}

// ── Auth-error heuristics for D-5 auto-refresh ───────────────────────
//
// The SDK is the `claude` CLI under the hood, which already auto-refreshes
// OAuth tokens silently during normal use. So in practice we should rarely
// see a 401 escape the SDK. When one does, it usually means the refresh
// token itself is gone or revoked — at which point the user needs to run
// `claude login` again.
//
// To be defensive, we retry the SDK call ONCE on a recognised auth error,
// in case the SDK happens to be in the middle of a token rotation when the
// first call lands. On second failure, we surface a clear error pointing
// the user at `claude login`. We never retry if the auth error surfaced
// AFTER partial output — that would risk replaying side effects.

const AUTH_ERROR_PATTERNS = [
  /\b401\b/,
  /\bunauthorized\b/i,
  /authentication\s+(failed|required|error)/i,
  /token\s+(expired|invalid|revoked)/i,
  /invalid[_\s-]?credentials/i,
  /please\s+(re)?(run|do)\s*`?claude\s+login`?/i,
  /oauth.*(expired|invalid)/i,
];

function isAuthError(err: unknown): boolean {
  if (!err) return false;
  const msg =
    err instanceof Error
      ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`
      : String(err);
  return AUTH_ERROR_PATTERNS.some((re) => re.test(msg));
}

const MAX_AUTH_RETRIES = 1;

/**
 * Context-overflow wording the `claude` CLI emits in its error result.
 * "Prompt is too long" is the observed production string; the broader
 * alternates cover Anthropic's API phrasings should the CLI pass them
 * through verbatim.
 */
const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|context.?length.?exceeded|maximum.?context.?length/i;

// ── Concurrency cap (D-7) ─────────────────────────────────────────────
//
// Each `sendMessage` call spawns a `claude` subprocess via the Agent SDK.
// Without a cap, a chatty client (or a proactivity sweep) could spin up
// many subprocesses in parallel — each holding an open stream, OAuth
// session, and Anthropic rate-limit slot. Cap concurrent calls at a
// safe-by-default value; excess calls queue.
//
// Starting value: 4. Tune based on observed contention.

const MAX_CONCURRENT_CALLS = 4;
let activeCallCount = 0;
const semaphoreWaitQueue: Array<() => void> = [];

async function acquireSemaphore(): Promise<void> {
  if (activeCallCount < MAX_CONCURRENT_CALLS) {
    activeCallCount++;
    return;
  }
  await new Promise<void>((resolve) => {
    semaphoreWaitQueue.push(() => {
      activeCallCount++;
      resolve();
    });
  });
}

function releaseSemaphore(): void {
  activeCallCount = Math.max(0, activeCallCount - 1);
  const next = semaphoreWaitQueue.shift();
  if (next) next();
}

/** Test hook — clears any queued waiters and resets the active count. */
export function _resetClaudeSubscriptionSemaphoreForTests(): void {
  activeCallCount = 0;
  semaphoreWaitQueue.length = 0;
}

/**
 * Test hook — read-only snapshot of the semaphore state. Used by the
 * lifecycle test (Phase 3.3) to assert that N sequential `sendMessage`
 * calls return the semaphore to its initial idle state with no leaked
 * permits or queued waiters.
 */
export function _getClaudeSubscriptionSemaphoreStateForTests(): {
  activeCallCount: number;
  queuedWaiterCount: number;
} {
  return {
    activeCallCount,
    queuedWaiterCount: semaphoreWaitQueue.length,
  };
}

const stubBridge: ProviderToolBridge = async ({ toolName, input }) => {
  log.warn(
    { toolName },
    "claude-subscription bridge invoked without a registered ProviderToolBridge — returning stub result",
  );
  return {
    content:
      `[claude-subscription bridge stub] The Agent SDK called Vellum tool ` +
      `"${toolName}" with input ${JSON.stringify(input)}, but no bridge is ` +
      `registered. Either pass options.toolBridge per-call or call ` +
      `setVellumToolBridge() at boot for a process-global fallback.`,
    isError: false,
  };
};

// ── Provider ──────────────────────────────────────────────────────────

export interface ClaudeSubscriptionOptions {
  streamTimeoutMs?: number;
}

const MCP_SERVER_NAME = "vellum-skills";

/**
 * Items the MCP `CallToolResult.content` array accepts. Loose-typed so we can
 * emit `text`, `image`, and `resource` items without importing the SDK's
 * internal union — the SDK forwards whatever we put here to the model.
 */
type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Translate Vellum's `ContentBlock[]` (carried on `ToolBridgeResult`) into
 * MCP `CallToolResult.content` items. Only kinds that make semantic sense as
 * tool output emit a corresponding MCP item:
 *   • `text`  → `{ type: "text", text }`
 *   • `image` → `{ type: "image", data, mimeType }` (base64 + media type)
 *   • `file`  → text item carrying `extracted_text` when present; without
 *               `extracted_text` the block is dropped with a warning (the
 *               MCP embedded-resource shape needs a URI we don't have here,
 *               and shipping raw binary would blow most context windows).
 * Model-internal kinds (`thinking`, `redacted_thinking`, `tool_use`,
 * `tool_result`, `server_tool_use`, `web_search_tool_result`) cannot
 * meaningfully appear in a tool result returned to the model and are
 * silently skipped.
 */
function mapContentBlocksToMcp(
  blocks: ContentBlock[] | undefined,
): McpContentItem[] {
  if (!blocks || blocks.length === 0) return [];
  const out: McpContentItem[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        out.push({ type: "text", text: block.text });
        break;
      case "image":
        out.push({
          type: "image",
          data: block.source.data,
          mimeType: block.source.media_type,
        });
        break;
      case "file":
        if (block.extracted_text) {
          out.push({ type: "text", text: block.extracted_text });
        } else {
          log.warn(
            {
              filename: block.source.filename,
              mediaType: block.source.media_type,
            },
            "claude-subscription bridge dropped a file content block without extracted_text",
          );
        }
        break;
      // thinking / redacted_thinking / tool_use / tool_result /
      // server_tool_use / web_search_tool_result: skipped — none of these
      // are valid tool-result content for the model.
      default:
        break;
    }
  }
  return out;
}

export class ClaudeSubscriptionProvider implements Provider {
  readonly name = "claude-subscription";
  /** Use Anthropic estimation rules — we target Claude models. */
  readonly tokenEstimationProvider = "anthropic";

  constructor(
    private readonly model: string,
    private readonly opts: ClaudeSubscriptionOptions = {},
  ) {}

  async sendMessage(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    systemPrompt: string | undefined,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    // D-7 concurrency cap. Acquire BEFORE any allocation so a queued
    // call doesn't hold an MCP server or AbortController for the
    // duration of its wait.
    await acquireSemaphore();
    try {
      return await this.sendMessageInner(
        messages,
        tools,
        systemPrompt,
        options,
      );
    } finally {
      releaseSemaphore();
    }
  }

  private async sendMessageInner(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    systemPrompt: string | undefined,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const onEvent = options?.onEvent;
    const externalSignal = options?.signal;
    // Resolve the tool bridge: per-call wins, then process-global
    // registry, then a stub that makes the no-op visible. Documented in
    // the section header above.
    const bridge: ProviderToolBridge =
      options?.toolBridge ?? registryBridge ?? stubBridge;

    // Per-call model: honor the model the routing layer resolved for THIS
    // call (`options.config.model`) over the construction-time `this.model`.
    //
    // Why this matters: provider instances are cached per CONNECTION
    // (`resolveProviderFromConnection`), and every claude-subscription model
    // profile — "Claude (Max Plan)" (sonnet), "Claude Opus 4.8", "Claude
    // Opus 4.7", … — shares the one `claude-subscription-personal`
    // connection. With `this.model` frozen at construction, switching the
    // in-chat (per-conversation) model picker set the override but the
    // cached provider kept sending the original model — conversations pinned
    // to "Opus 4.7" actually billed sonnet-4-6 (verified in the usage
    // ledger). `RetryProvider.normalizeSendMessageOptions` already resolves
    // the active/override profile to `config.model` per call; honoring it
    // here makes the picker actually change the model. Falls back to
    // `this.model` for direct construction (tests, early-boot) where no
    // routing layer supplies a per-call model.
    const callModel =
      typeof options?.config?.model === "string" &&
      options.config.model.length > 0
        ? options.config.model
        : this.model;

    // Build the AbortController FIRST so we can hand its `.abort()` into
    // the MCP server (needed for yieldToUser → loop-abort, D-2).
    const sdkAbort = new AbortController();
    if (externalSignal) {
      if (externalSignal.aborted) sdkAbort.abort();
      else
        externalSignal.addEventListener("abort", () => sdkAbort.abort(), {
          once: true,
        });
    }

    // FIFO queue of tool_use_ids the SDK has announced in its assistant
    // message stream, keyed by tool name. The for-await loop below pushes
    // ids onto a per-tool-name queue as `tool_use` blocks arrive; the MCP
    // CallTool handler shifts off the head when a matching tool fires.
    // Empty-queue case (handler racing ahead of the assistant message, or
    // an SDK that omits the id) falls back to a synthetic id so chunks
    // still group within a single call.
    const pendingToolUseIds = new Map<string, string[]>();
    const mcpServer = this.buildMcpServer(
      tools ?? [],
      bridge,
      () => sdkAbort.abort(),
      options?.maxToolResultChars,
      onEvent,
      pendingToolUseIds,
    );
    const allowedTools = (tools ?? []).map(
      (t) => `mcp__${MCP_SERVER_NAME}__${t.name}`,
    );
    const prompt = this.flattenForSdk(messages);

    // Retry-on-auth-error loop (D-5). Each attempt is a fresh SDK call;
    // accumulators are reset per-attempt so a retry doesn't double-count.
    // We only retry if the first attempt produced ZERO output before
    // failing — otherwise side effects may have fired in tools and a
    // retry would double-apply them.
    let assistantText = "";
    let stopReason = "end_turn";
    let modelUsed = callModel;
    const usage: ProviderResponse["usage"] = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    const resetAccumulators = () => {
      assistantText = "";
      stopReason = "end_turn";
      modelUsed = callModel;
      usage.inputTokens = 0;
      usage.outputTokens = 0;
      usage.cacheCreationInputTokens = 0;
      usage.cacheReadInputTokens = 0;
    };

    let attempts = 0;

    while (true) {
      try {
        // SDK isolation strategy (each option matters; verified empirically in
        // `docs/architecture/claude-subscription-bridge.md` § I-11):
        //
        //   `tools: ["Task"]`      → enable the `Task` built-in (sub-agent
        //                            spawn) but disable every other built-in
        //                            (Bash/Read/Write/Edit/WebFetch/…).
        //                            Sub-agents are a product decision (D-3);
        //                            re-verify isolation if you change this.
        //   `settingSources: []`   → skip loading user/project/local settings
        //                            so the user's `~/.claude/settings.json`
        //                            MCP server list is not auto-attached.
        //   `permissionMode:        → require explicit per-call permission;
        //      "default"`            never auto-bypass.
        //   `canUseTool`           → hard runtime deny for anything not on
        //                            the bridge's allowlist. Catches MCP
        //                            tools the SDK may still surface from
        //                            the user's Anthropic-account
        //                            integrations (Gmail, Drive, etc.) which
        //                            `settingSources: []` does NOT exclude.
        //                            `"Task"` is allowed so sub-agents can
        //                            spawn — they inherit this same callback,
        //                            so the same isolation applies to them.
        //   `mcpServers: {…}`      → register ONLY our in-process bridge.
        //
        // DO NOT change these without re-running the I-11 isolation test.
        const allowedToolSet = new Set<string>([...allowedTools, "Task"]);
        const claudeCliPath = await resolveClaudeCliPath();
        const stream = query({
          prompt,
          options: {
            model: callModel,
            // Bun's `--compile` strips the SDK's bundled native CLI binary,
            // so fall back to the user's locally-installed `claude` CLI when
            // we can resolve it. Without this the SDK throws "Native CLI
            // binary for darwin-arm64 not found" on the first send.
            ...(claudeCliPath
              ? { pathToClaudeCodeExecutable: claudeCliPath }
              : {}),
            permissionMode: "default",
            settingSources: [],
            tools: ["Task"],
            // Hard bound on the SDK's agent-loop recursion. Without this,
            // sub-agents can spawn deeper sub-agents and a single
            // `sendMessage` call can run for tens of minutes (observed
            // empirically during I-19). The cap covers parent turns +
            // every nested sub-agent turn. 50 = the safety ceiling the
            // provider tests pin (a turn batches many tool calls, so this is
            // generous: a 138-tool-call turn completed well within 25; the
            // cap exists only to stop runaway recursion, not to bound work).
            maxTurns: 100000,
            allowedTools: [...allowedTools, "Task"],
            canUseTool: async (toolName) => {
              if (allowedToolSet.has(toolName)) {
                return { behavior: "allow" };
              }
              log.warn(
                { toolName },
                "claude-subscription canUseTool denied a non-allowlisted tool",
              );
              return {
                behavior: "deny",
                message: `Tool '${toolName}' is not available in this session.`,
              };
            },
            mcpServers: {
              [MCP_SERVER_NAME]: {
                type: "sdk",
                name: MCP_SERVER_NAME,
                instance: mcpServer,
              },
            },
            abortController: sdkAbort,
            // `systemPrompt: <string>` REPLACES Claude Code's default
            // coding-agent prompt with Vellum's prompt (SOUL.md +
            // identity). `customSystemPrompt` is not a real SDK option;
            // an earlier draft passed that and it was silently ignored,
            // leaving Claude Code's coding-agent persona in place. I-22
            // verified the replace behavior with this option. DO NOT
            // change to the `{type:"preset",preset:"claude_code",append}`
            // shape unless you want Claude Code's biases to leak.
            ...(systemPrompt ? { systemPrompt } : {}),
          },
        });

        for await (const msg of stream as AsyncIterable<SDKMessage>) {
          if (msg.type === "assistant") {
            for (const block of msg.message.content) {
              if (block.type === "text") {
                assistantText += block.text;
                onEvent?.({ type: "text_delta", text: block.text });
              } else if (block.type === "thinking") {
                onEvent?.({
                  type: "thinking_delta",
                  thinking: block.thinking,
                });
              } else if (block.type === "tool_use") {
                // Surface the SDK's tool-call lifecycle to Vellum's outer
                // ProviderEvent stream so the composer renders bridged tool
                // calls the same way it renders outer-loop ones (Kimi /
                // Ollama). The SDK's `id` is the real tool_use_id assigned
                // by Anthropic; the outer-loop adapter in `agent/loop.ts`
                // forwards both events as AgentEvents. Tool execution itself
                // still runs inside the SDK loop via the MCP bridge — these
                // events are observation-only at this seam, mirroring how
                // anthropic.ts emits them for non-bridged tools.
                //
                // The SDK delivers a complete tool_use block per assistant
                // message (input JSON is already fully assembled by the time
                // it reaches us), so we emit a single `input_json_delta`
                // carrying the complete accumulated input rather than
                // streaming partial deltas. Matches the contract of
                // `input_json_delta.accumulatedJson` in `providers/types.ts`.
                const toolName: string =
                  typeof (block as { name?: unknown }).name === "string"
                    ? (block as { name: string }).name
                    : "";
                const toolUseId: string =
                  typeof (block as { id?: unknown }).id === "string"
                    ? (block as { id: string }).id
                    : "";
                if (toolName && toolUseId) {
                  // Record the real tool_use_id for the MCP CallTool handler
                  // to consume — every chunk it emits for this call carries
                  // the SDK's id instead of the synthetic fallback so the UI
                  // can correlate the preview_start, input, and chunk events.
                  const queue = pendingToolUseIds.get(toolName) ?? [];
                  queue.push(toolUseId);
                  pendingToolUseIds.set(toolName, queue);
                  onEvent?.({
                    type: "tool_use_preview_start",
                    toolUseId,
                    toolName,
                  });
                  const rawInput = (block as { input?: unknown }).input;
                  const inputRecord =
                    rawInput && typeof rawInput === "object"
                      ? (rawInput as Record<string, unknown>)
                      : {};
                  let accumulatedJson: string;
                  try {
                    accumulatedJson = JSON.stringify(inputRecord);
                  } catch {
                    accumulatedJson = "";
                  }
                  if (accumulatedJson) {
                    onEvent?.({
                      type: "input_json_delta",
                      toolName,
                      toolUseId,
                      accumulatedJson,
                    });
                  }
                  // Committed tool_use — the loop adapter forwards this as
                  // `AgentEvent.tool_use` so the composer renders the
                  // tool-call card the same way it does for non-bridged
                  // providers. Without this, the outer loop never sees a
                  // committed tool_use (the SDK is the one dispatching the
                  // tool) and the UI shows nothing inline.
                  onEvent?.({
                    type: "bridged_tool_committed",
                    toolUseId,
                    toolName,
                    input: inputRecord,
                  });
                }
              }
            }
          } else if (msg.type === "system" && msg.subtype === "init") {
            if (typeof msg.model === "string") modelUsed = msg.model;
          } else if (msg.type === "result") {
            const u = (msg.usage ?? {}) as unknown as Record<
              string,
              number | undefined
            >;
            const cacheCreation = u.cache_creation_input_tokens ?? 0;
            const cacheRead = u.cache_read_input_tokens ?? 0;
            usage.inputTokens =
              (u.input_tokens ?? 0) + cacheCreation + cacheRead;
            usage.outputTokens = u.output_tokens ?? 0;
            usage.cacheCreationInputTokens = cacheCreation;
            usage.cacheReadInputTokens = cacheRead;
            if (msg.subtype === "error_max_turns") stopReason = "max_turns";
            else if (msg.subtype === "success") stopReason = "end_turn";
            else stopReason = "error";
          }
        }
        // Successful stream consumption — break out of the retry loop.
        break;
      } catch (err) {
        const authError = isAuthError(err);
        const hadPartialOutput = assistantText.length > 0;

        // Retry policy: ONLY auth errors, ONLY if no output streamed,
        // ONLY MAX_AUTH_RETRIES times. The SDK's `claude` subprocess
        // usually refreshes OAuth tokens silently across spawns; this
        // retry exists for the case where a token rotation happened to
        // race the first call.
        if (authError && !hadPartialOutput && attempts < MAX_AUTH_RETRIES) {
          attempts++;
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            `Auth error from Agent SDK; retrying once (attempt ${attempts}/${MAX_AUTH_RETRIES})`,
          );
          resetAccumulators();
          continue;
        }

        // Context overflow must surface as the TYPED ContextOverflowError,
        // not a generic 500 bridge error. The CLI reports it as a result
        // error ("Claude Code returned an error result: Prompt is too
        // long"); wrapping that at statusCode 500 makes RetryProvider treat
        // it as a transient server error — three futile retries (each
        // spawning a fresh `claude` that fails identically) before the
        // daemon's overflow-recovery compaction can engage. The typed error
        // skips retries (retry.ts treats overflow as non-retryable) and
        // routes the agent loop straight to the deterministic reducer.
        const overflowMessage =
          err instanceof Error ? err.message : String(err);
        if (CONTEXT_OVERFLOW_PATTERN.test(overflowMessage)) {
          throw new ContextOverflowError(overflowMessage, this.name, {
            cause: err,
            ...extractOverflowTokensFromMessage(overflowMessage),
          });
        }

        // Classify into a discriminated `ClaudeSubscriptionBridgeError`
        // subtype so the UI gets reason-specific copy (e.g. "Install
        // Claude Code" vs "Run `claude login`") instead of a generic
        // "provider failed" banner. Phase 3.2 in
        // docs/architecture/claude-subscription-bridge.md.
        const kind = classifyClaudeSubscriptionError(err);
        const statusCode =
          kind === "token-expired" ||
          kind === "not-logged-in" ||
          kind === "cli-not-installed"
            ? 401
            : 500;
        throw new ClaudeSubscriptionBridgeError(kind, {
          cause: err,
          statusCode,
        });
      }
    } // end while (retry loop)

    const content: ContentBlock[] = assistantText
      ? [{ type: "text", text: assistantText }]
      : [];

    return {
      content,
      model: modelUsed,
      usage,
      stopReason,
    };
  }

  /**
   * Build an in-process MCP server that exposes each Vellum tool to the
   * Agent SDK. We use the lower-level `Server` request handlers (via
   * `McpServer.server`) instead of `registerTool()` so we can forward the
   * Vellum-supplied JSON Schema as-is — the higher-level API expects a
   * Zod shape, which would require lossy schema conversion.
   */
  private buildMcpServer(
    tools: ToolDefinition[],
    bridge: ProviderToolBridge,
    onYieldToUser: () => void,
    maxToolResultChars: number | undefined,
    onEvent: ((event: ProviderEvent) => void) | undefined,
    pendingToolUseIds: Map<string, string[]>,
  ): McpServer {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema as Record<string, unknown>,
      })),
    }));

    server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      // Phase 2.6: prefer the SDK's real tool_use_id (recorded by the
      // assistant-message stream consumer in sendMessage's for-await loop
      // and shifted off the FIFO queue here) so this call's chunks
      // correlate with the `tool_use_preview_start` / `input_json_delta`
      // events the loop already emitted. Falls back to a synthetic id if
      // the queue is empty (race where the MCP CallTool fires before the
      // assistant message is dispatched, or an SDK build that omits ids
      // entirely) — chunks still group within this single call.
      const queued = pendingToolUseIds.get(req.params.name);
      const chunkToolUseId =
        queued && queued.length > 0
          ? (queued.shift() as string)
          : `mcp-bridge-chunk-${randomUUID()}`;
      const onChunk: ((chunk: string) => void) | undefined = onEvent
        ? (chunk) =>
            onEvent({
              type: "tool_output_chunk",
              toolUseId: chunkToolUseId,
              chunk,
            })
        : undefined;
      let result: ToolBridgeResult;
      try {
        result = await bridge({
          toolName: req.params.name,
          input: args,
          onChunk,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          { toolName: req.params.name, err: msg },
          "Vellum tool bridge threw inside MCP server",
        );
        result = { content: `Bridge error: ${msg}`, isError: true };
      }

      // Honor yieldToUser. We schedule the abort with setImmediate so the
      // MCP response we return below is still well-formed and reaches the
      // SDK — the SDK's tool-result accounting expects to see the result
      // before the loop unwinds. The abort fires on the next tick, after
      // the SDK has accepted this tool_result, and unwinds the loop on the
      // following turn boundary.
      if (result.yieldToUser) {
        log.info(
          { toolName: req.params.name },
          "Vellum tool requested yieldToUser; aborting SDK loop",
        );
        setImmediate(() => onYieldToUser());
      }

      // Truncate `result.content` before it crosses into the SDK. Matches
      // what the outer-loop `toolResultTruncate` pipeline would do for a
      // non-bridged tool result — without this the SDK happily forwards a
      // 10 MB tool dump into its own loop and blows the context window.
      // `contentBlocks` are NOT truncated here: image base64 has no
      // meaningful "newline-aware" truncation, and the outer loop doesn't
      // truncate rich blocks either — parity preserved.
      let truncatedContent = result.content;
      if (
        maxToolResultChars !== undefined &&
        result.content.length > maxToolResultChars
      ) {
        truncatedContent = truncateToolResultText(
          result.content,
          maxToolResultChars,
        );
        log.warn(
          {
            toolName: req.params.name,
            originalChars: result.content.length,
            truncatedChars: truncatedContent.length,
            maxChars: maxToolResultChars,
          },
          "claude-subscription bridge truncated oversized tool result",
        );
      }

      // Committed tool_result — the loop adapter forwards this as
      // `AgentEvent.tool_result`, swapping the in-flight tool-call card
      // for its final-state rendering. The SDK keeps consuming the
      // result returned below; this event is observation-only and runs
      // in parallel with the SDK reading the response.
      onEvent?.({
        type: "bridged_tool_result",
        toolUseId: chunkToolUseId,
        content: truncatedContent,
        isError: result.isError ?? false,
      });

      const extraItems = mapContentBlocksToMcp(result.contentBlocks);
      return {
        content: [
          { type: "text" as const, text: truncatedContent },
          ...extraItems,
        ],
        isError: result.isError ?? false,
      };
    });

    return server;
  }

  /**
   * Flatten Vellum's message history into a single prompt string for the
   * Agent SDK. The SDK manages its own session; the cleanest fit for a
   * single-call transport is to serialise history as a header and put the
   * latest user message as the focus.
   *
   * Multimodal content (images, file blocks) in prior turns is lossy here.
   * A follow-up can switch to the SDK's async-iterable `prompt` form to
   * preserve full fidelity, including `tool_result` blocks from earlier
   * turns when re-invoking the bridge across multiple sendMessage calls.
   */
  private flattenForSdk(messages: Message[]): string {
    if (messages.length === 0) return "";
    if (messages.length === 1 && messages[0].role === "user") {
      return this.textOf(messages[0]);
    }

    const parts: string[] = ["# Prior conversation"];
    for (let i = 0; i < messages.length - 1; i++) {
      const m = messages[i];
      parts.push(`\n## ${m.role === "user" ? "User" : "Assistant"}`);
      parts.push(this.textOf(m));
    }

    const last = messages[messages.length - 1];
    if (last.role === "user") {
      parts.push("\n# Current user message");
      parts.push(this.textOf(last));
    } else {
      parts.push("\n# Continue\nContinue from where you left off.");
    }
    return parts.join("\n");
  }

  private textOf(msg: Message): string {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        parts.push(block.text);
      } else if (block.type === "tool_use") {
        parts.push(`[tool_use ${block.name}(${JSON.stringify(block.input)})]`);
      } else if (block.type === "tool_result") {
        const text =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        parts.push(`[tool_result ${text}]`);
      } else {
        parts.push(`[${block.type} block omitted]`);
      }
    }
    return parts.join("\n");
  }
}
