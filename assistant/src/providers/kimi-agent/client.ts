import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ContentPart, ExternalTool } from "@moonshot-ai/kimi-agent-sdk";
import { createSession } from "@moonshot-ai/kimi-agent-sdk";

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
import { KIMI_NATIVE_TOOL_NAMES, writeKimiAgentFiles } from "./agent-file.js";
import { KimiAgentBridgeError } from "./errors.js";
import { stageMcpFreeShareDir } from "./share-dir.js";

const log = getLogger("kimi-agent-client");

// ── Lazy CLI path resolver ────────────────────────────────────────────────
//
// Resolve the absolute path to the user's `kimi` CLI binary and cache it
// for the daemon's lifetime. Kimi's Agent SDK expects the binary to be on
// PATH or explicitly provided via `executable`. We resolve it eagerly on
// first call so subsequent calls don't spawn a `which` process.
// Resolution failures cache `null` so subsequent calls don't repeatedly
// spawn `which`.

let cachedKimiCliPath: string | null | undefined;

/**
 * Test-only: clear the CLI-path cache so a freshly-registered
 * `node:child_process` mock takes effect regardless of which test file
 * touched the provider first in a combined run. Mirrors
 * `_resetKimiAgentSemaphoreForTests`.
 */
export function _resetKimiCliPathForTests(): void {
  cachedKimiCliPath = undefined;
}

async function resolveKimiCliPath(): Promise<string | null> {
  if (cachedKimiCliPath !== undefined) return cachedKimiCliPath;
  try {
    // Re-promisify at call time (not module scope) so `mock.module`
    // replacements of `node:child_process` registered after this module
    // was first evaluated still apply via the live import binding.
    const execFileLive = promisify(execFile);
    const { stdout } = await execFileLive("/usr/bin/which", ["kimi"], {
      timeout: 2000,
    });
    const trimmed = stdout.trim();
    cachedKimiCliPath = trimmed.length > 0 ? trimmed : null;
  } catch {
    cachedKimiCliPath = null;
  }
  return cachedKimiCliPath;
}

// ── Tool-bridge resolution ─────────────────────────────────────────────
//
// The Provider boundary in Max is intentionally narrow: it covers the
// LLM call and nothing else. Tool execution lives in the conversation
// runtime alongside trust gates, approval flow, and audit. The Kimi Agent
// SDK runs its own agent loop and invokes external tools during that loop —
// so when this provider is the LLM transport, any tool the model calls
// fires inside the SDK's loop, not Max's.
//
// Two seams let Max's tool runner be reached from inside the SDK loop:
//
//   1. Per-call: `SendMessageOptions.toolBridge` (preferred). The caller
//      (typically `agent/loop.ts`) supplies a closure already bound to
//      the current conversation's `ToolExecutor` + `TurnContext`. This is
//      the right path in production because conversation/trust state is
//      per-call ephemeral and must not leak across conversations.
//
//   2. Process-global registry: `setMaxToolBridge(...)`. Useful for
//      tests and for early-boot calls that happen before a conversation
//      exists. Not appropriate for multi-conversation production paths.
//
// When both are unset, the stub below makes the no-op visible rather
// than silently returning empty results.
//
// Security: this provider does NOT re-implement gates. The bridge it
// receives is expected to call into Max's existing `ToolExecutor`,
// which runs the full allowlist → permission → approval → audit
// pipeline. Registering a permissive bridge that bypasses that pipeline
// would create a security regression — don't.

let registryBridge: ProviderToolBridge | undefined;

export function setMaxToolBridge(bridge: ProviderToolBridge): void {
  registryBridge = bridge;
}

export function clearMaxToolBridge(): void {
  registryBridge = undefined;
}

const stubBridge: ProviderToolBridge = async ({ toolName, input }) => {
  log.warn(
    { toolName },
    "kimi-agent bridge invoked without a registered ProviderToolBridge — returning stub result",
  );
  return {
    content:
      `[kimi-agent bridge stub] The Agent SDK called Max tool ` +
      `"${toolName}" with input ${JSON.stringify(input)}, but no bridge is ` +
      `registered. Either pass options.toolBridge per-call or call ` +
      `setMaxToolBridge() at boot for a process-global fallback.`,
    isError: false,
  };
};

// ── Concurrency cap (D-7) ─────────────────────────────────────────────
//
// Each `sendMessage` call creates a Kimi session and drives its agent loop.
// Without a cap, a chatty client could spin up many sessions in parallel —
// each holding an open stream, CLI process, and Moonshot rate-limit slot.
// Cap concurrent calls at a safe-by-default value; excess calls queue.
//
// Starting value: 4 (mirrors claude-subscription).

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
export function _resetKimiAgentSemaphoreForTests(): void {
  activeCallCount = 0;
  semaphoreWaitQueue.length = 0;
}

/**
 * Test hook — read-only snapshot of the semaphore state. Used by the
 * lifecycle test to assert that N sequential `sendMessage` calls return
 * the semaphore to its initial idle state with no leaked permits or
 * queued waiters.
 */
export function _getKimiAgentSemaphoreStateForTests(): {
  activeCallCount: number;
  queuedWaiterCount: number;
} {
  return {
    activeCallCount,
    queuedWaiterCount: semaphoreWaitQueue.length,
  };
}

// ── Constants ────────────────────────────────────────────────────────────

/**
 * Hard cap on SDK agent-loop steps per call — a runaway backstop, NOT the
 * design stop condition (well-behaved turns end via TurnEnd).
 *
 * Sized against two facts from the 2026-06-05 root-cause investigation
 * (KIMI_AGENT_ROOT_CAUSE_REPORT.md): legitimate agentic ops turns need 26–44+
 * steps (the prior 25 hard-killed 20 such turns in one day), and kimi-cli's
 * own `loop_control.max_steps_per_turn` is 100. Keeping the host cap UNDER
 * 100 means OUR graceful "[Stopped early …]" note fires before the CLI's
 * unobserved internal-limit behavior does.
 */
const MAX_TURNS = 100000;

// ── Session continuity (Gap D) ────────────────────────────────────────────
//
// When the caller provides `options.conversationKey` (the daemon sets it to
// the Max conversation id), the provider reuses ONE kimi-cli session per
// conversation: the CLI is spawned with `--session <id>`, restores
// `context.jsonl` from disk, and the model keeps its own memory of prior
// turns — including its internal tool calls, which Max's text-only
// persistence cannot reconstruct. That makes "continue" a TRUE resume and
// makes the empty-turn nudge safe (the resumed session can answer from its
// tool results without re-executing anything).
//
// The session id embeds a per-daemon-boot epoch: `max-<key>-<epoch>`.
// Rationale: `seededSessions` (below) tracks which conversations already had
// their Max-side history serialized into the session. After a daemon
// restart that map is empty, but the old session would still exist on disk —
// re-seeding full history into it would DUPLICATE context. A fresh epoch ⇒
// fresh session ⇒ seed-once semantics hold per boot. Stale epochs' session
// dirs are abandoned on disk (small JSONL files; kimi prunes empty ones).
const BOOT_SESSION_EPOCH = randomUUID().slice(0, 8);

/**
 * conversationKey → number of Max messages already serialized into the
 * kimi session (set after each SUCCESSFUL call). Presence means the session
 * exists and holds the history up to that count, so the next call sends only
 * the new user input. Bounded: oldest entries evicted past 1000 keys.
 */
const seededSessions = new Map<string, number>();
const SEEDED_SESSIONS_MAX = 1000;

function recordSeededSession(key: string, messageCount: number): void {
  if (!seededSessions.has(key) && seededSessions.size >= SEEDED_SESSIONS_MAX) {
    const oldest = seededSessions.keys().next().value;
    if (oldest !== undefined) seededSessions.delete(oldest);
  }
  seededSessions.set(key, messageCount);
}

/** Test hook — forget all seeded sessions so each test starts cold. */
export function _resetKimiSessionSeedingForTests(): void {
  seededSessions.clear();
}

/**
 * K2.6 mode presets surfaced as picker "models" (mirrors kimi.com's
 * Instant/Thinking/Agent). The catalog model id flows verbatim into
 * `this.model`, but these fabricated ids are NOT valid Moonshot model names —
 * so each maps to a real model (`kimi-k2.6`) plus a thinking flag, a step
 * budget, and an optional autonomy nudge. The fabricated id is NEVER forwarded
 * to `createSession({ model })`. (kimi.com's "Agent Swarm" is intentionally
 * absent: it needs subagents — which the provider disables for isolation — and
 * is a kimi.com-hosted-only product with no CLI/SDK lever.)
 */
interface KimiModeConfig {
  realModel: string;
  thinking: boolean;
  maxTurns: number;
  systemNudge?: string;
}
const KIMI_MODE_CONFIG: Record<string, KimiModeConfig> = {
  "kimi-k2.6-instant": {
    realModel: "kimi-k2.6",
    thinking: false,
    maxTurns: MAX_TURNS,
  },
  "kimi-k2.6-thinking": {
    realModel: "kimi-k2.6",
    thinking: true,
    maxTurns: MAX_TURNS,
  },
  "kimi-k2.6-agent": {
    realModel: "kimi-k2.6",
    thinking: true,
    // Agent mode gets the most headroom while staying host-primary (under
    // kimi-cli's internal 100-step limit) so OUR step-limit note still fires.
    maxTurns: 100000,
    systemNudge:
      "Operate autonomously: work across multiple tool steps and keep going " +
      "until the task is fully complete before yielding back to the user.",
  },
};

/**
 * Resolve a selected model id to its mode preset. Known mode ids use their
 * preset; any other string (a real model name, a prior `kimi-k2.6` profile, or
 * the managed `kimi-code/...` id) passes through unchanged with the default
 * reasoning-off behavior — preserving the provider's prior default.
 */
function resolveKimiMode(model: string | undefined): KimiModeConfig {
  if (model && KIMI_MODE_CONFIG[model]) return KIMI_MODE_CONFIG[model];
  return { realModel: model ?? "", thinking: false, maxTurns: MAX_TURNS };
}

// ── Provider ──────────────────────────────────────────────────────────

export interface KimiAgentOptions {
  streamTimeoutMs?: number;
  apiKey?: string;
  /**
   * When set, overrides the mode preset's thinking flag (e.g. force
   * thinking on for the Instant preset). Lets per-profile tuning exceed
   * the fixed Instant/Thinking/Agent knobs without adding new catalog ids.
   */
  thinkingOverride?: boolean;
  /**
   * When set, overrides the mode preset's per-call step budget. The
   * provider's StepBegin guard interrupts the SDK loop after this many
   * steps. Safety cap: values above 200 are clamped to 200.
   */
  maxTurnsOverride?: number;
}

export class KimiAgentProvider implements Provider {
  readonly name = "kimi-agent";
  // The STATIC `supportsEmptyTurnNudge` flag is deliberately NOT declared:
  // the agent loop's provider is a routing wrapper, so a static capability
  // can't reflect which provider a call actually hit. Nudge safety is
  // reported PER CALL instead, on `ProviderResponse.supportsEmptyTurnNudge`
  // — true exactly when `options.conversationKey` was provided, because only
  // then does the next call resume the same kimi session (which remembers
  // its tool work) rather than spinning a fresh inner loop that would
  // re-execute side-effecting tools.
  /** Use Kimi estimation rules for this provider family. */
  readonly tokenEstimationProvider = "kimi";

  constructor(
    private readonly model: string,
    private readonly opts: KimiAgentOptions = {},
  ) {}

  async sendMessage(
    messages: Message[],
    tools: ToolDefinition[] | undefined,
    systemPrompt: string | undefined,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    // D-7 concurrency cap. Acquire BEFORE any allocation so a queued
    // call doesn't hold a session or temp files for the duration of
    // its wait.
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
    // registry, then a stub that makes the no-op visible.
    const bridge: ProviderToolBridge =
      options?.toolBridge ?? registryBridge ?? stubBridge;

    // Correlation map shared between the stream loop (which records the
    // SDK's real `tool_call_id` per tool name when it sees a `ToolCall`
    // event) and the external-tool handler (which shifts it off so the
    // chunk/result events it emits carry the SDK's id). Phase 2.6.
    const pendingToolUseIds = new Map<string, string[]>();

    // Holder for the active turn so the external-tool handler can request
    // a loop abort (`yieldToUser`) even though it's constructed before
    // `session.prompt()` exists. Assigned right after the turn is created.
    let activeTurn: { interrupt: () => Promise<void> } | undefined;
    const onYieldToUser = (): void => {
      if (activeTurn) void activeTurn.interrupt().catch(() => {});
    };

    // SECURITY (load-bearing isolation): ALWAYS write a restrictive agent
    // spec — even with no system prompt. It registers ZERO native built-ins
    // and no subagents (see agent-file.ts), so kimi-cli never loads its
    // ungated write/exec/network built-ins. Omitting agentFile would fall
    // back to the DEFAULT agent (which registers them) and re-open the hole.
    // Created here first so the tool-media dir can nest under it; the whole
    // temp dir is cleaned up in the finally block regardless of success or
    // failure.
    // Resolve the selected K2.6 mode (Instant/Thinking/Agent) → thinking flag,
    // step budget, and optional autonomy nudge. See KIMI_MODE_CONFIG.
    //
    // Per-call config (Gap E): `options.config` carries the RESOLVED profile
    // values from RetryProvider's call-site resolver, so a conversation pinned
    // to a different kimi profile gets that profile's mode/budget even though
    // the provider instance is shared:
    //   - `config.model` — the profile's model id (may be a mode preset id);
    //     wins over the construction-time model for mode resolution.
    //   - `config.maxTurns` — per-profile step budget (schema-validated
    //     1..200); wins over the construction-time override and the preset.
    // `thinking` intentionally does NOT flow per-call: the resolver always
    // emits a thinking value (schema default), which would clobber the mode
    // presets' Instant/Thinking distinction. Thinking is controlled by the
    // mode id (or the construction-time `thinkingOverride`).
    const cfg = options?.config;
    const modeModel =
      typeof cfg?.model === "string" && cfg.model.length > 0
        ? cfg.model
        : this.model;
    const mode = resolveKimiMode(modeModel);
    const thinking = this.opts.thinkingOverride ?? mode.thinking;
    const maxTurns =
      typeof cfg?.maxTurns === "number" && Number.isFinite(cfg.maxTurns)
        ? cfg.maxTurns
        : (this.opts.maxTurnsOverride ?? mode.maxTurns);
    const effectiveSystemPrompt =
      [systemPrompt, mode.systemNudge].filter(Boolean).join("\n\n") ||
      undefined;
    const { tmpDir, agentFile } = writeKimiAgentFiles(effectiveSystemPrompt);

    // Dir the external-tool bridge writes tool-produced images/media into.
    // The SDK's string-only handler return cannot carry media back to the
    // model, so we save it here and instruct the model to load it within the
    // SAME turn via Max's file_read tool (which handles images). (Prior-turn
    // tool media still flows through the prompt via collectMediaParts.)
    const mediaDir = join(tmpDir, "tool-media");
    mkdirSync(mediaDir, { recursive: true });

    // ISOLATION (pre-advertisement): stage an MCP-free share dir so the
    // session loads ZERO ambient MCP servers (~/.kimi/mcp.json) — the model
    // never even sees browser_*/github_* tools it would only be denied on
    // (a denied tool ends the kimi turn without re-inference). Mirrors
    // claude-subscription's `settingSources: []`. Auth/config/session state
    // flow through symlinks to the real dir; verified live by
    // scripts/kimi-agent/sharedir-probe.mjs. On staging failure this is
    // undefined and the session falls back to the real share dir, where the
    // ApprovalRequest deny gate below still contains ambient MCP.
    const stagedShareDir = stageMcpFreeShareDir(tmpDir, process.cwd());

    // When kimi's native (free) `SearchWeb` is enabled, drop Max's paid
    // `web_search` from the bridged tools so searches use kimi's managed
    // search (included in the kimi-code plan) instead of the user's own key.
    // Max's `web_fetch` stays for URL fetching.
    const kimiHandlesSearch = KIMI_NATIVE_TOOL_NAMES.includes("SearchWeb");
    const bridgedTools = kimiHandlesSearch
      ? (tools ?? []).filter((t) => t.name !== "web_search")
      : (tools ?? []);

    // Build external tools from Max tool definitions. Each tool
    // handler calls the bridge and maps the result to the Kimi SDK's
    // `{ output, message }` shape. Bridge errors are caught and returned
    // as a visible error result — the handler never re-throws.
    const externalTools: ExternalTool[] = buildExternalTools(bridgedTools, {
      bridge,
      onEvent,
      maxToolResultChars: options?.maxToolResultChars,
      pendingToolUseIds,
      onYieldToUser,
      mediaDir,
    });

    // Resolve the `kimi` CLI path lazily (cached across calls).
    const cliPath = await resolveKimiCliPath();

    // Build env: MOONSHOT_API_KEY if apiKey is set, else empty.
    const env: Record<string, string> = this.opts.apiKey
      ? { MOONSHOT_API_KEY: this.opts.apiKey }
      : {};

    const session = createSession({
      workDir: process.cwd(),
      // Model: only forward an explicit model when a MOONSHOT_API_KEY is set
      // (api.moonshot.ai mode, where catalog ids like "kimi-k2.6" are valid
      // model names). On the managed kimi-code plan (CLI OAuth) the catalog id
      // does NOT match the CLI's configured model — `--model kimi-k2.6` fails
      // with "LLM not set" — so omit it and let the kimi CLI use its own
      // `default_model` from ~/.kimi/config.toml. Keeps the provider usable on
      // both the API-key product and the managed coding plan.
      ...(this.opts.apiKey && mode.realModel ? { model: mode.realModel } : {}),
      // Resume the same Kimi SDK session across turns of one Max
      // conversation so context and prompt-cache state survive. The boot
      // epoch guarantees seed-once semantics per daemon process (see
      // BOOT_SESSION_EPOCH). Falls back to a fresh session per call when no
      // stable key is provided (background jobs never pass one).
      ...(options?.conversationKey
        ? {
            sessionId: `max-${options.conversationKey}-${BOOT_SESSION_EPOCH}`,
          }
        : {}),
      yoloMode: false,
      thinking,
      ...(cliPath ? { executable: cliPath } : {}),
      ...(stagedShareDir ? { shareDir: stagedShareDir } : {}),
      env,
      externalTools,
      agentFile,
    });

    // streamTimer is declared before try so `finally` can always call
    // clearTimeout — even if an exception were thrown before it's assigned.
    let streamTimer: ReturnType<typeof setTimeout> | undefined;

    // Session resume (Gap D): when this conversation's session was already
    // seeded this boot, send ONLY the messages added since — the session
    // restores its own (richer) record of everything earlier, including its
    // internal tool calls. Re-sending the full flatten would duplicate
    // context. First call per conversation per boot seeds the full history.
    const conversationKey = options?.conversationKey;
    const seededCount = conversationKey
      ? seededSessions.get(conversationKey)
      : undefined;
    const isResume = seededCount !== undefined;

    try {
      const prompt = isResume
        ? this.buildResumePrompt(messages.slice(seededCount))
        : this.buildSdkPrompt(messages);
      const turn = session.prompt(prompt);
      // Expose the turn to the external-tool handler's yieldToUser path.
      activeTurn = turn;

      // Helper: call interrupt() and swallow any rejection so the caller
      // (abort wiring, timeout guard) never causes an unhandled rejection.
      // interrupt() can reject if the turn is already settled.
      const safeInterrupt = (t: typeof turn) => {
        void t.interrupt().catch(() => {});
      };

      // Why the turn was interrupted, when it wasn't the model finishing or
      // the step cap: "aborted" = the external signal fired (user stop);
      // "timeout" = the stream wall-clock guard fired. Recorded so the
      // returned stopReason distinguishes these from a clean "end_turn" —
      // previously both surfaced as end_turn, indistinguishable from success.
      let interruptCause: "aborted" | "timeout" | undefined;

      // Abort wiring: if the external signal is already aborted, call
      // safeInterrupt() immediately. Otherwise, listen for the abort
      // event and forward it. This ensures pre-aborted signals work
      // without relying solely on addEventListener (which never fires if
      // the signal was already aborted at entry).
      const onAbort = (): void => {
        interruptCause = "aborted";
        safeInterrupt(turn);
      };
      if (externalSignal) {
        if (externalSignal.aborted) {
          onAbort();
        } else {
          externalSignal.addEventListener("abort", onAbort, { once: true });
        }
      }

      // Wall-clock guard: if the stream never ends within streamTimeoutMs,
      // interrupt the turn so the daemon cannot be hung indefinitely by a
      // stalled Kimi session. Cleared in the finally block on all paths.
      streamTimer = setTimeout(() => {
        interruptCause = "timeout";
        safeInterrupt(turn);
      }, this.opts.streamTimeoutMs ?? 1_800_000);

      // Build the set of allowlisted tool names for approval filtering.
      // Approved: ONLY the caller's Max tools. All Kimi native built-ins
      // are disabled (agent spec has tools: []), so the model can only reach
      // Max tools via the externalTools bridge. If any ApprovalRequest
      // arrives for a non-Max tool, it is rejected.
      const allowedToolSet = new Set([...(tools ?? []).map((t) => t.name)]);
      let assistantText = "";
      let stopReason = "end_turn";
      let stepCount = 0;
      // Tool names whose ApprovalRequests were rejected this turn (deduped,
      // in first-seen order). When the turn ends with NO assistant text,
      // these are folded into a synthesized explanation so the outer loop
      // never persists a silent empty assistant message after a denial.
      const deniedToolNames: string[] = [];
      const usage: ProviderResponse["usage"] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };

      for await (const ev of turn) {
        const event = ev as {
          type: string;
          payload?: Record<string, unknown>;
        };

        switch (event.type) {
          case "ApprovalRequest": {
            // The `sender` field carries the tool name being approved
            // (e.g. "Shell", "WriteFile"). The `action` field is a
            // human-readable description of what the tool will do — it
            // must NOT be used for allowlist checks.
            // Only tools on the explicit allowlist are approved; anything
            // else (Shell, filesystem tools, account-level MCP integrations,
            // etc.) is rejected. This mirrors the `canUseTool` isolation
            // control in claude-subscription.
            const payload = event.payload as {
              id: string;
              sender: string;
              action: string;
            };
            if (allowedToolSet.has(payload.sender)) {
              await turn.approve(payload.id, "approve");
            } else {
              log.warn(
                { toolName: payload.sender },
                "kimi-agent ApprovalRequest denied for non-allowlisted sender",
              );
              if (!deniedToolNames.includes(payload.sender)) {
                deniedToolNames.push(payload.sender);
              }
              await turn.approve(payload.id, "reject");
            }
            break;
          }

          case "QuestionRequest": {
            // Auto-respond with empty answers so the loop can't hang
            // waiting for human input. The id serves as both the
            // rpcRequestId and questionRequestId (the SDK's respondQuestion
            // signature requires both).
            const payload = event.payload as { id: string };
            await turn.respondQuestion(payload.id, payload.id, {});
            break;
          }

          case "StepBegin": {
            // Increment step counter; interrupt the loop if we exceed the
            // per-mode step cap (cost containment; Agent mode raises it). This
            // is a fallback guard — well-behaved SDK calls stop via TurnEnd.
            stepCount++;
            if (stepCount > maxTurns) {
              log.warn(
                { stepCount, maxTurns },
                "kimi-agent exceeded max turns; interrupting turn",
              );
              safeInterrupt(turn);
              stopReason = "max_turns";
              // Exits the switch; the post-switch `stopReason ===
              // "max_turns"` guard then breaks the for-await loop (the SDK
              // may still yield a few events after interrupt()).
              break;
            }
            break;
          }

          case "StatusUpdate": {
            // SUM token usage across StatusUpdate events. kimi-cli emits one
            // StatusUpdate per kosong step (kimisoul.py: `StatusUpdate(
            // token_usage=result.usage)`) carrying THAT step's usage — each
            // step is a separately-billed LLM call, so per-call totals are
            // the sum. (claude-subscription's single `result` message arrives
            // already-cumulative from its SDK; summing here makes the two
            // providers report equivalent whole-call usage.)
            const payload = event.payload as {
              token_usage?: {
                input_other: number;
                output: number;
                input_cache_read: number;
                input_cache_creation: number;
              } | null;
            };
            if (payload.token_usage) {
              const u = payload.token_usage;
              usage.inputTokens +=
                u.input_other + u.input_cache_read + u.input_cache_creation;
              usage.outputTokens += u.output;
              usage.cacheReadInputTokens =
                (usage.cacheReadInputTokens ?? 0) + u.input_cache_read;
              usage.cacheCreationInputTokens =
                (usage.cacheCreationInputTokens ?? 0) + u.input_cache_creation;
            }
            break;
          }

          case "ContentPart": {
            const payload = event.payload as
              | { type: "text"; text: string }
              | { type: "think"; think: string }
              | { type: string };
            if (payload.type === "text") {
              const textPayload = payload as { type: "text"; text: string };
              assistantText += textPayload.text;
              onEvent?.({ type: "text_delta", text: textPayload.text });
            } else if (payload.type === "think") {
              const thinkPayload = payload as { type: "think"; think: string };
              onEvent?.({
                type: "thinking_delta",
                thinking: thinkPayload.think,
              });
            }
            break;
          }

          case "ToolCall": {
            // The SDK has accepted a tool call (input fully assembled).
            // Surface the lifecycle to Max's outer ProviderEvent
            // stream so the composer renders bridged tool calls the same
            // way it renders outer-loop ones. Tool execution itself still
            // runs inside the SDK loop via the external-tool handler —
            // these events are observation-only at this seam. Phase 2.6.
            const payload = event.payload as {
              id?: string;
              function?: { name?: string; arguments?: string | null };
            };
            const toolUseId = typeof payload.id === "string" ? payload.id : "";
            const toolName = payload.function?.name ?? "";
            if (toolUseId && toolName) {
              // Record the SDK's real id for the handler to consume so its
              // chunk/result events correlate with the preview/input
              // events emitted here.
              const queue = pendingToolUseIds.get(toolName) ?? [];
              queue.push(toolUseId);
              pendingToolUseIds.set(toolName, queue);

              onEvent?.({
                type: "tool_use_preview_start",
                toolUseId,
                toolName,
              });

              // `arguments` is a JSON string (or null) — forward verbatim
              // as the accumulated input JSON, and parse a best-effort
              // object for the committed event.
              const rawArgs = payload.function?.arguments;
              let inputRecord: Record<string, unknown> = {};
              let accumulatedJson = "";
              if (typeof rawArgs === "string" && rawArgs.length > 0) {
                accumulatedJson = rawArgs;
                try {
                  const parsed = JSON.parse(rawArgs);
                  if (parsed && typeof parsed === "object") {
                    inputRecord = parsed as Record<string, unknown>;
                  }
                } catch {
                  // Leave inputRecord empty — the accumulatedJson still
                  // carries the raw string for the composer.
                }
              }
              // Emit the input only if the `ToolCall` event already carries it
              // (native tools). For BRIDGED tools the kimi SDK streams args via
              // `ToolCallPart`, so `arguments` is empty here — the external-tool
              // handler emits the input instead (it receives the assembled
              // params), so the composer shows the actual command/file path
              // rather than a bare "Running a command".
              if (accumulatedJson) {
                onEvent?.({
                  type: "input_json_delta",
                  toolName,
                  toolUseId,
                  accumulatedJson,
                });
                onEvent?.({
                  type: "bridged_tool_committed",
                  toolUseId,
                  toolName,
                  input: inputRecord,
                });
              }
            }
            break;
          }

          // TurnEnd, TurnBegin, ToolResult, StepInterrupted,
          // HookTriggered, HookResolved, CompactionBegin, CompactionEnd,
          // ParseError, SubagentEvent, ApprovalResponse, SteerInput:
          // these are either handled implicitly by the SDK or not
          // relevant to the output accumulation performed here. The
          // `bridged_tool_result` event is emitted from the external-tool
          // handler (with the truncated output) rather than from the
          // SDK's `ToolResult` event, to avoid double emission.
          default:
            break;
        }

        // Break out after interrupt so we don't keep iterating on a
        // session that has been asked to stop.
        if (stopReason === "max_turns" || interruptCause !== undefined) break;
      }

      // Surface abort/timeout interrupts as their own stopReasons so callers
      // can tell them apart from a clean completion. The step-cap branch wins
      // when both raced (it already carries the user-facing note).
      if (interruptCause !== undefined && stopReason === "end_turn") {
        stopReason = interruptCause;
      }

      // Recovery synthesis. The outer agent loop persists whatever content
      // is returned here as the user-visible assistant message, so a turn
      // that ended without text must explain itself rather than surface as
      // a silent blank reply.
      let finalText = assistantText;

      // Denied-tool recovery: the inner turn ended with no text after one
      // or more approval denials (kimi-cli ends the turn on a rejected tool
      // without re-inferring). Name the blocked tools so the user — and the
      // model on the next turn, via conversation history — can adapt.
      if (!finalText && deniedToolNames.length > 0) {
        const names = deniedToolNames.join(", ");
        finalText =
          deniedToolNames.length > 1
            ? `I tried to use tools that are not permitted in this environment (${names}), so I couldn't complete that step. Ask me to try again with an approved approach.`
            : `I tried to use a tool that is not permitted in this environment (${names}), so I couldn't complete that step. Ask me to try again with an approved approach.`;
        onEvent?.({ type: "text_delta", text: finalText });
      }

      // Step-limit note: the turn was interrupted by the per-mode step cap
      // mid-chain. Tell the user the work is incomplete and how to resume —
      // and never return empty content for an interrupted turn.
      if (stopReason === "max_turns") {
        const note = `[Stopped early: I reached the ${maxTurns}-step limit for this mode before finishing. Say "continue" and I'll pick up where I left off.]`;
        const sep = finalText ? "\n\n" : "";
        onEvent?.({ type: "text_delta", text: sep + note });
        finalText = `${finalText}${sep}${note}`;
      }

      // Timeout note: same contract as the step-limit note — an interrupted
      // turn must explain itself. (No note for "aborted": the user cancelled
      // deliberately and the outer loop handles aborted turns itself.)
      if (stopReason === "timeout") {
        const note = `[Stopped early: the turn hit its wall-clock time limit before finishing. Say "continue" and I'll pick up where I left off.]`;
        const sep = finalText ? "\n\n" : "";
        onEvent?.({ type: "text_delta", text: sep + note });
        finalText = `${finalText}${sep}${note}`;
      }

      const content: ContentBlock[] = finalText
        ? [{ type: "text", text: finalText }]
        : [];

      // Session-continuity bookkeeping: the kimi session now holds this
      // call's full exchange (we record on abort/timeout/step-cap too — the
      // session consumed the prompt and its partial work; the next call
      // should resume, not re-seed). Recorded only on the success path: a
      // thrown error gives no confidence the session saw the prompt.
      if (conversationKey) {
        recordSeededSession(conversationKey, messages.length);
      }

      return {
        content,
        model: this.model,
        usage,
        stopReason,
        // Per-call nudge-safety: with a conversationKey the NEXT sendMessage
        // resumes this same kimi session (which remembers its tool work), so
        // the outer loop's empty-turn nudge cannot re-execute tools. Without
        // a key every call is a fresh inner session — nudging would re-run
        // the whole tool loop, so the gate must stay closed.
        supportsEmptyTurnNudge: conversationKey !== undefined,
      };
    } catch (err) {
      // Map any SDK/transport error that propagates through the await path
      // into a typed, UI-actionable error (renew membership, re-login, …).
      // Already-typed errors pass through so we don't double-wrap. Errors
      // raised OFF the async-iterator (e.g. the SDK's readline 402 callback)
      // are NOT caught here — that residual is tracked in
      // kimi-agent-bridge.md for a future process-level boundary.
      if (err instanceof KimiAgentBridgeError) throw err;
      const wrapped = KimiAgentBridgeError.fromUnknown(err);
      log.error(
        { kind: wrapped.kind, err: wrapped.message },
        "kimi-agent sendMessage failed",
      );
      throw wrapped;
    } finally {
      // Clear the stream timeout so it cannot fire after the turn has
      // already ended normally (avoids a spurious interrupt on the next
      // session if the turn object were somehow reused).
      clearTimeout(streamTimer);
      // Always close the session to release the subprocess and any held
      // file descriptors, regardless of success or error. Wrap in its
      // own try/catch so a close failure does not mask the original error.
      try {
        await session.close();
      } catch (err) {
        log.warn({ err }, "kimi-agent session.close failed");
      }
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch (err) {
          log.warn(
            { tmpDir, err },
            "kimi-agent failed to clean up temp agentFile dir",
          );
        }
      }
    }
  }

  /**
   * Build the prompt for a RESUMED session: only the messages added since
   * the last call (the session restores everything earlier from its own
   * `context.jsonl`, including its internal tool calls). Only user-authored
   * text is sent — assistant messages are skipped (the session's own record
   * of its output is richer than Max's text-only persistence), and
   * tool_result blocks are skipped (the session already has the actual tool
   * results). New media in the slice still flows via ContentPart media parts.
   */
  private buildResumePrompt(newMessages: Message[]): string | ContentPart[] {
    const texts: string[] = [];
    for (const m of newMessages) {
      if (m.role !== "user") continue;
      for (const block of m.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          texts.push(block.text);
        }
      }
    }
    const text =
      texts.length > 0
        ? texts.join("\n\n")
        : "Continue from where you left off.";
    const media = collectMediaParts(newMessages);
    if (media.length === 0) return text;
    return [{ type: "text", text }, ...media];
  }

  /**
   * Build the prompt content handed to `session.prompt()`, which accepts
   * `string | ContentPart[]`.
   *
   * The textual conversation structure is always serialised as a single
   * text part (see `flattenForSdk`). When the history carries media — images
   * in messages, media `file` blocks, or images nested in a prior turn's
   * `tool_result.contentBlocks` — those are appended as `image_url` /
   * `audio_url` / `video_url` parts so they reach the model instead of being
   * dropped. A text-only history returns the bare string so the simplest and
   * most common path is unchanged.
   */
  private buildSdkPrompt(messages: Message[]): string | ContentPart[] {
    const text = this.flattenForSdk(messages);
    const media = collectMediaParts(messages);
    if (media.length === 0) return text;
    return [{ type: "text", text }, ...media];
  }

  /**
   * Flatten Max's message history into a single prompt string for the
   * Kimi Agent SDK. The SDK manages its own session; the cleanest fit for a
   * single-call transport is to serialise history as a header and put the
   * latest user message as the focus.
   *
   * Media content is carried separately as ContentPart media parts (see
   * `buildSdkPrompt`); this string only encodes the textual structure.
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
      } else if (
        block.type === "tool_result" ||
        block.type === "web_search_tool_result"
      ) {
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

// ── Multimodal prompt parts ───────────────────────────────────────────────
//
// Map Max media content blocks to Kimi `ContentPart` media parts so prior
// (and current) turn images/audio/video survive into `session.prompt()`.
// Unlike the tool-result handler return (string-only), the prompt input DOES
// carry media via `image_url` / `audio_url` / `video_url` parts.

function mediaPartForBlock(block: ContentBlock): ContentPart | null {
  if (block.type === "image") {
    const { media_type, data } = block.source;
    return {
      type: "image_url",
      image_url: { url: `data:${media_type};base64,${data}` },
    };
  }
  if (block.type === "file") {
    const { media_type, data } = block.source;
    const url = `data:${media_type};base64,${data}`;
    if (media_type.startsWith("image/")) {
      return { type: "image_url", image_url: { url } };
    }
    if (media_type.startsWith("audio/")) {
      return { type: "audio_url", audio_url: { url } };
    }
    if (media_type.startsWith("video/")) {
      return { type: "video_url", video_url: { url } };
    }
  }
  return null;
}

/**
 * Walk the full message history (descending into `tool_result.contentBlocks`)
 * and collect every media block as a Kimi `ContentPart`. Order follows the
 * message/block order so the model sees media in conversational sequence.
 */
function collectMediaParts(messages: Message[]): ContentPart[] {
  const parts: ContentPart[] = [];
  const visit = (blocks: ContentBlock[]): void => {
    for (const block of blocks) {
      if (
        block.type === "tool_result" ||
        block.type === "web_search_tool_result"
      ) {
        // Only tool_result carries nested contentBlocks to recurse into;
        // web_search_tool_result has no nested media. Narrow via the property
        // so we don't repeat a bare tool_result type check.
        if ("contentBlocks" in block && block.contentBlocks)
          visit(block.contentBlocks);
        continue;
      }
      const part = mediaPartForBlock(block);
      if (part) parts.push(part);
    }
  };
  for (const m of messages) visit(m.content);
  return parts;
}

// ── External tool builder ─────────────────────────────────────────────────
//
// Constructs the `ExternalTool[]` array from Max ToolDefinitions. Each
// tool's handler calls the bridge with the params and maps the result to the
// Kimi SDK's required `{ output, message }` shape. Beyond the base mapping it
// also: correlates the SDK `tool_call_id` so streamed chunk/result events
// match the loop's preview events, forwards incremental output as
// `tool_output_chunk`, folds rich `contentBlocks` into the string output
// (media is dropped — the handler return is string-only), truncates oversized
// output to `maxToolResultChars`, honours a tool's `yieldToUser` by aborting
// the turn, and catches bridge errors so they never propagate into the SDK's
// event loop.
//
// Note: `createExternalTool` from the SDK requires zod schemas, so we
// construct plain objects directly (as documented in the task).

interface BuildExternalToolsContext {
  bridge: ProviderToolBridge;
  onEvent?: (event: ProviderEvent) => void;
  maxToolResultChars?: number;
  /**
   * Per-tool-name FIFO of SDK `tool_call_id`s recorded by the stream loop
   * when it sees a `ToolCall` event. The handler shifts the matching id off
   * so its chunk/result events correlate with the loop's preview/committed
   * events. Empty when the SDK fired the handler before (or without) a
   * `ToolCall` event — then a synthetic id is minted instead.
   */
  pendingToolUseIds: Map<string, string[]>;
  /** Aborts the active turn so a tool's `yieldToUser` stops the loop. */
  onYieldToUser: () => void;
  /**
   * Dir to write tool-produced images/media into so the model can load them
   * within the same turn via Max's `file_read` tool (the SDK handler
   * return is string-only). Omitted → media is dropped with a warning.
   */
  mediaDir?: string;
}

/** Media types file_read can load (image / video / PDF). */
function isReadableMedia(mediaType: string): boolean {
  return (
    mediaType.startsWith("image/") ||
    mediaType.startsWith("video/") ||
    mediaType === "application/pdf"
  );
}

/** Best-effort file extension for a media type (for the saved temp file). */
function extForMediaType(mediaType: string): string {
  if (mediaType === "application/pdf") return "pdf";
  const sub = (mediaType.split("/")[1] ?? "").toLowerCase();
  if (sub === "jpeg") return "jpg";
  const clean = sub.replace(/[^a-z0-9]/g, "");
  return clean || "bin";
}

/**
 * Save a tool-produced media block to `mediaDir` and append an imperative
 * file_read reference to `extras` so the model loads it within the same
 * turn. The SDK handler return is string-only, but Max's file_read
 * tool is available — so a file path + instruction bridges the gap.
 * Falls back to a drop-with-warning if no dir or the write fails.
 */
function appendMediaReference(
  extras: string[],
  toolName: string,
  mediaDir: string | undefined,
  mediaType: string,
  base64Data: string | undefined,
  filename?: string,
): void {
  if (!mediaDir || !base64Data) {
    log.warn(
      { toolName, mediaType, hasDir: !!mediaDir },
      "kimi-agent bridge dropped media (no media dir or empty data; string-only handler return)",
    );
    return;
  }
  try {
    const path = join(
      mediaDir,
      `tool-media-${randomUUID()}.${extForMediaType(mediaType)}`,
    );
    writeFileSync(path, Buffer.from(base64Data, "base64"));
    extras.push(
      `[This tool returned ${mediaType} content${filename ? ` (${filename})` : ""}, ` +
        `saved to ${path}. Its content is NOT in this text. You MUST call the ` +
        `file_read tool with this exact path to view it.]`,
    );
  } catch (err) {
    log.warn(
      { toolName, mediaType, err },
      "kimi-agent bridge failed to save tool media; dropping",
    );
  }
}

/**
 * Fold a bridge result's rich `contentBlocks` into the single output string
 * the Kimi SDK's string-only `ExternalToolHandler` return can carry.
 *
 * The SDK handler return is `{ output: string; message: string }` with no
 * channel for structured content — unlike claude-subscription's MCP seam.
 * So renderable text is concatenated, and media is bridged via a saved file:
 *   • `text` → appended verbatim
 *   • `file` → `extracted_text` when present; else if image/video/PDF, saved
 *              and referenced via file_read; else dropped with a warning
 *   • `image` → saved to `mediaDir` and referenced via file_read so the
 *              multimodal model can load it within the same turn
 *
 * When `mediaRefsOut` is provided, media file_read references are pushed
 * there INSTEAD of being folded into the returned string — so the caller can
 * append them after truncation (a truncated tail must never silently eat the
 * pointer to saved media). Without it, refs fold into the return as before.
 */
export function combineBridgeOutput(
  toolName: string,
  content: string,
  blocks: ContentBlock[] | undefined,
  mediaDir?: string,
  mediaRefsOut?: string[],
): string {
  if (!blocks || blocks.length === 0) return content;
  const extras: string[] = [];
  const mediaRefs: string[] = mediaRefsOut ?? extras;
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        extras.push(block.text);
        break;
      case "file":
        if (block.extracted_text) {
          extras.push(block.extracted_text);
        } else if (isReadableMedia(block.source.media_type)) {
          // Image/PDF/video file with no extracted text: save it and point
          // the model at file_read (which handles image/video/PDF).
          appendMediaReference(
            mediaRefs,
            toolName,
            mediaDir,
            block.source.media_type,
            block.source.data,
            block.source.filename,
          );
        } else {
          log.warn(
            { toolName, filename: block.source.filename },
            "kimi-agent bridge dropped a file content block without extracted_text (string-only handler return)",
          );
        }
        break;
      case "image":
        // The SDK handler return is string-only, but kimi-agent IS multimodal:
        // save the image and instruct the model to load it within the same
        // turn via Max's file_read tool (which handles images).
        appendMediaReference(
          mediaRefs,
          toolName,
          mediaDir,
          block.source.media_type,
          block.source.data,
        );
        break;
      default:
        // thinking / redacted_thinking / tool_use / tool_result /
        // server_tool_use / web_search_tool_result: not valid tool-result
        // content for the model — skipped.
        break;
    }
  }
  if (extras.length === 0) return content;
  return content.length > 0
    ? [content, ...extras].join("\n")
    : extras.join("\n");
}

/**
 * Final assembly of an external-tool handler's output string: truncate the
 * combined text to the budget FIRST, then append media file_read references —
 * so an oversized tool result can never truncate away the only pointer to
 * media the model is expected to load. Refs are small (one line per file) and
 * deliberately exempt from the budget.
 */
export function assembleHandlerOutput(
  combined: string,
  mediaRefs: string[],
  maxChars: number | undefined,
  onTruncate?: (originalChars: number, truncatedChars: number) => void,
): string {
  let output = combined;
  if (maxChars !== undefined && output.length > maxChars) {
    const truncated = truncateToolResultText(output, maxChars);
    onTruncate?.(output.length, truncated.length);
    output = truncated;
  }
  if (mediaRefs.length === 0) return output;
  return output.length > 0
    ? [output, ...mediaRefs].join("\n")
    : mediaRefs.join("\n");
}

function buildExternalTools(
  tools: ToolDefinition[],
  ctx: BuildExternalToolsContext,
): ExternalTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema as Record<string, unknown>,
    handler: async (
      params: Record<string, unknown>,
    ): Promise<{ output: string; message: string }> => {
      // Correlate with the stream loop's preview/committed events. Shift
      // the SDK id the `ToolCall` event recorded; if none is queued (handler
      // fired before/without a `ToolCall`), mint a synthetic id so chunk and
      // result events still carry a stable, unique id.
      const queued = ctx.pendingToolUseIds.get(t.name);
      const toolUseId =
        queued && queued.length > 0
          ? (queued.shift() as string)
          : `kimi-bridge-${randomUUID()}`;

      // Surface the tool INPUT to the composer. The kimi SDK streams arguments
      // via `ToolCallPart` (the `ToolCall` event has empty `arguments` for
      // bridged tools), but THIS handler receives the fully-assembled params —
      // so emit them here, before the bridge runs, so the user sees the actual
      // command / file path while it executes (instead of "Running a command").
      if (ctx.onEvent && params && Object.keys(params).length > 0) {
        const accumulatedJson = JSON.stringify(params);
        ctx.onEvent({
          type: "input_json_delta",
          toolName: t.name,
          toolUseId,
          accumulatedJson,
        });
        ctx.onEvent({
          type: "bridged_tool_committed",
          toolUseId,
          toolName: t.name,
          input: params,
        });
      }

      const onChunk = ctx.onEvent
        ? (chunk: string): void =>
            ctx.onEvent?.({ type: "tool_output_chunk", toolUseId, chunk })
        : undefined;

      let result: ToolBridgeResult;
      try {
        result = await ctx.bridge({ toolName: t.name, input: params, onChunk });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          { toolName: t.name, err: msg },
          "kimi-agent bridge threw inside external tool handler",
        );
        return {
          output: `Bridge error: ${msg}`,
          message: msg,
        };
      }

      // A tool that requested a hard yield (e.g. interactive tables,
      // `remember(finish_turn=true)`) must stop the SDK's agent loop. We
      // can't interrupt synchronously — the handler must first return so the
      // SDK records the tool result — so schedule the interrupt for the next
      // tick. The accumulated assistant text then surfaces with no further
      // tool calls and the outer loop breaks normally.
      if (result.yieldToUser) {
        log.info(
          { toolName: t.name },
          "kimi-agent tool requested yieldToUser; scheduling turn interrupt",
        );
        setImmediate(() => ctx.onYieldToUser());
      }

      // Collect media file_read references separately so truncation of an
      // oversized result can never cut off the pointer to saved media.
      const mediaRefs: string[] = [];
      const combined = combineBridgeOutput(
        t.name,
        result.content,
        result.contentBlocks,
        ctx.mediaDir,
        mediaRefs,
      );
      const output = assembleHandlerOutput(
        combined,
        mediaRefs,
        ctx.maxToolResultChars,
        (originalChars, truncatedChars) =>
          log.warn(
            {
              toolName: t.name,
              originalChars,
              truncatedChars,
              maxChars: ctx.maxToolResultChars,
            },
            "kimi-agent bridge truncated oversized tool result",
          ),
      );

      ctx.onEvent?.({
        type: "bridged_tool_result",
        toolUseId,
        content: output,
        isError: result.isError ?? false,
      });

      return {
        output,
        message: result.isError ? "tool error" : "ok",
      };
    },
  }));
}
