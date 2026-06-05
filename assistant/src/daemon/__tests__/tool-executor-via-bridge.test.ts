/**
 * Integration tests for the `claude-subscription` bridge against the REAL
 * `ToolExecutor`.
 *
 * Spec: §6.2.4 in `docs/architecture/claude-subscription-bridge.md` (I-1
 * through I-10). The 48 unit tests in `claude-subscription-provider.test.ts`
 * stub `ToolExecutor` and assert the bridge's *plumbing*; these tests use
 * the real class and assert the security pipeline's *behaviour* through
 * the bridge.
 *
 * Current coverage:
 *   • I-1  — allowlist enforcement     (covered)
 *   • I-2  — trust-class enforcement   (covered)
 *   • I-3  — interactive permission prompt (covered)
 *   • I-4  — CES grant retry           (covered)
 *   • I-5  — sandbox routing for skill tools (covered)
 *   • I-6  — audit lifecycle emission  (covered)
 *   • I-8  — yieldToUser semantic      (covered)
 *   • I-9  — cross-conversation isolation (covered)
 *   • I-10 — abort isolation between conversations (covered)
 *   • smoke — end-to-end happy path    (covered)
 *
 * I-7 (sensitive-binding substitution end-to-end) lives in a different
 * fixture — `src/__tests__/loop-bridge-event-forwarding.test.ts` — because
 * it requires driving a full `AgentLoop` to exercise the streamed
 * text-delta substitution at `agent/loop.ts:~676`. This file's
 * `makeBridgeForExecutor` bypasses the loop adapter, so the substitution
 * code never runs here.
 *
 * Mocking strategy:
 *   The SDK is mocked the same way as `claude-subscription-provider.test.ts`.
 *   ToolExecutor's heavy dependencies (config, registry, permissions checker,
 *   tool-usage-store, filesystem path policy) are mocked exactly like
 *   `tool-executor.test.ts` so the executor's gate logic runs on real code
 *   paths but doesn't require booting the full daemon.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ProviderEvent,
  ProviderToolBridge,
  ToolDefinition,
} from "../../providers/types.js";
import type {
  Tool,
  ToolContext,
  ToolExecutionResult,
  ToolLifecycleEvent,
} from "../../tools/types.js";

// ---------------------------------------------------------------------------
// SDK mock — captures query() options so we can drive the in-process MCP
// server directly via its request handlers (no real subprocess).
// ---------------------------------------------------------------------------

let lastQueryOptions: Record<string, unknown> | null = null;
/**
 * When non-null, the SDK mock pushes each call's internal `abortController`
 * here and returns a stream that hangs until that controller aborts (rather
 * than yielding immediately). Lets I-10 inspect both sendMessage calls'
 * SDK controllers mid-flight without racing the scripted completion.
 */
let queryHangControllers: AbortController[] | null = null;

type ScriptedSdkMessage = { type: "result"; subtype: "success" };

async function* scriptedStream(): AsyncIterable<ScriptedSdkMessage> {
  yield { type: "result", subtype: "success" };
}

async function* hangUntilAborted(
  ctrl: AbortController,
): AsyncIterable<ScriptedSdkMessage> {
  await new Promise<void>((resolve) => {
    if (ctrl.signal.aborted) {
      resolve();
      return;
    }
    ctrl.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  yield { type: "result", subtype: "success" };
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { options: Record<string, unknown> }) => {
    lastQueryOptions = params.options;
    if (queryHangControllers) {
      const ctrl = params.options.abortController as AbortController;
      queryHangControllers.push(ctrl);
      return hangUntilAborted(ctrl);
    }
    return scriptedStream();
  },
}));

// ---------------------------------------------------------------------------
// ToolExecutor mocks — same surface as `tool-executor.test.ts`.
// ---------------------------------------------------------------------------

const mockConfig = {
  provider: "anthropic",
  model: "test",
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  sandbox: {
    enabled: false,
    backend: "native" as const,
    docker: {
      image: "vellum-sandbox:latest",
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 256,
      network: "none" as const,
    },
  },
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: { enabled: false },
  permissions: {},
};

let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };
let recordedInvocations: Array<{ toolName: string; conversationId: string }> = [];
let getToolOverride: ((name: string) => Tool | undefined) | undefined;
/**
 * Override for the mocked `check()` in `permissions/checker.js`. Tests that
 * exercise the trust / approval gates set this to drive the executor into
 * the deny or prompt branches without needing to construct a real rule set.
 */
let checkResultOverride: { decision: string; reason: string } | undefined;
/**
 * Spy accumulator for `runSkillToolScriptSandbox`. Populated by the
 * `sandbox-runner.js` mock below; consumed by I-5 to assert the sandbox
 * branch fires for a skill tool with `executionTarget: "sandbox"`.
 */
let sandboxSpyCalls: Array<{
  skillDir: string;
  executorPath: string;
  input: Record<string, unknown>;
  context: ToolContext;
}> = [];

mock.module("../../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
  truncateForLog: (value: string) => value,
}));

mock.module("../../permissions/checker.js", () => ({
  classifyRisk: async () => ({ level: "low" }),
  check: async () => {
    if (checkResultOverride) return checkResultOverride;
    return { decision: "allow", reason: "allowed" };
  },
  generateAllowlistOptions: () => [
    { label: "exact", description: "exact", pattern: "exact" },
  ],
  generateScopeOptions: () => [{ label: "/tmp", scope: "/tmp" }],
  getCachedAssessment: () => undefined,
}));

mock.module("../../memory/tool-usage-store.js", () => ({
  recordToolInvocation: (record: { toolName: string; conversationId: string }) => {
    recordedInvocations.push({
      toolName: record.toolName,
      conversationId: record.conversationId,
    });
  },
  getRecentInvocations: () => [],
  rotateToolInvocations: () => 0,
}));

mock.module("../../tools/registry.js", () => ({
  getTool: (name: string) => {
    if (getToolOverride) return getToolOverride(name);
    if (name === "unknown_tool") return undefined;
    return {
      name,
      description: "test tool",
      category: "test",
      defaultRiskLevel: "low",
      getDefinition: () => ({}),
      execute: async () => fakeToolResult,
    };
  },
  getAllTools: () => [],
}));

mock.module("../../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

// The real `runSkillToolScript` (in `skill-script-runner.js`) dispatches to
// either the host or the sandbox runner based on `target`. I-5 needs the
// dispatcher to run its real logic but with a spied sandbox call — so we
// mock `sandbox-runner.js` here and import the dispatcher untouched.
mock.module("../../tools/skills/sandbox-runner.js", () => ({
  runSkillToolScriptSandbox: async (
    skillDir: string,
    executorPath: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> => {
    sandboxSpyCalls.push({ skillDir, executorPath, input, context });
    return { content: "sandbox-ran", isError: false };
  },
}));

// ---------------------------------------------------------------------------
// Imports — after every mock.module() so the SUTs pick up the stubs.
// ---------------------------------------------------------------------------

import { PermissionPrompter } from "../../permissions/prompter.js";
import { ClaudeSubscriptionProvider } from "../../providers/claude-subscription/client.js";
import { ToolExecutor } from "../../tools/executor.js";
import { runSkillToolScript } from "../../tools/skills/skill-script-runner.js";
import { RiskLevel } from "../../permissions/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrompter(
  promptDecision: "allow" | "deny" = "allow",
): PermissionPrompter {
  return {
    prompt: async () => ({ decision: promptDecision }),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

/**
 * Build a `ProviderToolBridge` closure that delegates to a real
 * `ToolExecutor`. This is the same shape `agent/loop.ts` constructs in
 * production — duplicated here so tests don't need to boot the full
 * agent loop.
 */
function makeBridgeForExecutor(
  executor: ToolExecutor,
  context: ToolContext,
): ProviderToolBridge {
  return async ({ toolName, input, onChunk }) => {
    // Wire `invocation.onChunk` into `ToolContext.onOutput` so the
    // tool's `execute()` can surface incremental chunks back to the
    // provider — same plumbing `conversation-tool-setup.ts` does in
    // production (it threads the `LoopToolExecutor`'s 3rd-arg onChunk
    // into ToolContext.onOutput). Phase 2.5.
    const callContext: ToolContext = onChunk
      ? { ...context, onOutput: onChunk }
      : context;
    const result = await executor.execute(toolName, input, callContext);
    return {
      content: result.content,
      isError: result.isError,
      ...(result.yieldToUser ? { yieldToUser: true } : {}),
      ...(result.contentBlocks && result.contentBlocks.length > 0
        ? { contentBlocks: result.contentBlocks }
        : {}),
      ...(result.sensitiveBindings && result.sensitiveBindings.length > 0
        ? { sensitiveBindings: result.sensitiveBindings }
        : {}),
    };
  };
}

function userText(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }] };
}

/**
 * Invoke the MCP CallTool handler directly on the McpServer the provider
 * just built. Same indirection as the unit-test helper.
 */
async function invokeCallToolOnLastServer(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
  const mcpServers = lastQueryOptions!.mcpServers as Record<
    string,
    { instance: { server: { _requestHandlers: Map<string, unknown> } } }
  >;
  const server = mcpServers["vellum-skills"].instance.server;
  const handlerEntry = [...server._requestHandlers.entries()].find(([k]) =>
    String(k).includes("tools/call"),
  );
  const handler = handlerEntry![1] as (req: {
    params: { name: string; arguments: Record<string, unknown> };
    method: "tools/call";
  }) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  return handler({ params: { name, arguments: args }, method: "tools/call" });
}

const baseTools: ToolDefinition[] = [
  { name: "echo", description: "e", input_schema: { type: "object" } },
  { name: "deny_me", description: "d", input_schema: { type: "object" } },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bridge → real ToolExecutor integration", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    recordedInvocations = [];
    getToolOverride = undefined;
    checkResultOverride = undefined;
    lastQueryOptions = null;
    sandboxSpyCalls = [];
    queryHangControllers = null;
  });

  afterEach(() => {
    // Don't leak invocation accumulator across tests.
    recordedInvocations = [];
  });

  // -------------------------------------------------------------------------
  // Smoke — proves the full path wires up end-to-end before the
  // gate-specific tests run.
  // -------------------------------------------------------------------------

  test("smoke: bridge → ToolExecutor.execute → MCP result, happy path", async () => {
    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-smoke",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const mcpResult = await invokeCallToolOnLastServer("echo", { x: 1 });
    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.content[0].text).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // I-1 — Allowlist enforcement via the bridge
  // -------------------------------------------------------------------------

  test("I-1: bridge call for a tool NOT in allowedToolNames is denied with isError", async () => {
    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-allowlist",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]), // deny_me is NOT in the set
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const mcpResult = await invokeCallToolOnLastServer("deny_me", {});
    expect(mcpResult.isError).toBe(true);
    expect(mcpResult.content[0].text).toContain("deny_me");
    expect(mcpResult.content[0].text).toContain("not currently active");
  });

  test("I-1b: empty allowedToolNames blocks every bridge call", async () => {
    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-empty-allow",
      trustClass: "guardian",
      allowedToolNames: new Set<string>(),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const mcpResult = await invokeCallToolOnLastServer("echo", {});
    expect(mcpResult.isError).toBe(true);
    expect(mcpResult.content[0].text).toContain("not currently active");
  });

  // -------------------------------------------------------------------------
  // I-6 — Audit lifecycle emission via the bridge
  // -------------------------------------------------------------------------

  test("I-6: bridge call emits start + executed lifecycle events through onToolLifecycleEvent", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-audit",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
      onToolLifecycleEvent: (event) => {
        events.push(event);
      },
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    await invokeCallToolOnLastServer("echo", { x: 1 });

    const startEvents = events.filter((e) => e.type === "start");
    const executedEvents = events.filter((e) => e.type === "executed");
    expect(startEvents).toHaveLength(1);
    expect(executedEvents).toHaveLength(1);
    expect(startEvents[0].toolName).toBe("echo");
  });

  test("I-6b: lifecycle events carry the conversation id from the executor's context", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-record",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
      onToolLifecycleEvent: (event) => {
        events.push(event);
      },
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    await invokeCallToolOnLastServer("echo", {});
    // Every emitted event must carry the conversation id from `context`.
    // This is the cross-call correlation handle audit consumers use.
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.conversationId).toBe("conv-record");
    }
  });

  // -------------------------------------------------------------------------
  // I-9 — Cross-conversation isolation
  //
  // Two parallel ClaudeSubscriptionProvider sendMessage calls — each with
  // their own bridge bound to a distinct ToolContext — must NOT see each
  // other's tools or conversation id. Mostly a closure-scoping assertion:
  // the bridge captures `context` by reference, so each provider's MCP
  // server hands its own bridge a clean view.
  // -------------------------------------------------------------------------

  test("I-9: two concurrent conversations see only their own context", async () => {
    const executorA = new ToolExecutor(makePrompter());
    const executorB = new ToolExecutor(makePrompter());

    const eventsA: ToolLifecycleEvent[] = [];
    const eventsB: ToolLifecycleEvent[] = [];

    const contextA: ToolContext = {
      workingDir: "/tmp/a",
      conversationId: "conv-A",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]), // A can run echo
      onToolLifecycleEvent: (event) => {
        eventsA.push(event);
      },
    };
    const contextB: ToolContext = {
      workingDir: "/tmp/b",
      conversationId: "conv-B",
      trustClass: "guardian",
      allowedToolNames: new Set(["deny_me"]), // B can run deny_me, NOT echo
      onToolLifecycleEvent: (event) => {
        eventsB.push(event);
      },
    };

    const bridgeA = makeBridgeForExecutor(executorA, contextA);
    const bridgeB = makeBridgeForExecutor(executorB, contextB);

    // Drive A first, capture its MCP server reference.
    const providerA = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await providerA.sendMessage([userText("from A")], baseTools, "sys", {
      toolBridge: bridgeA,
    });
    const serverARef = lastQueryOptions!.mcpServers as Record<string, unknown>;

    // Drive B with a separate provider instance — its bridge captures
    // contextB by closure, so it operates on a completely separate
    // executor + audit sink.
    const providerB = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await providerB.sendMessage([userText("from B")], baseTools, "sys", {
      toolBridge: bridgeB,
    });
    const serverBRef = lastQueryOptions!.mcpServers as Record<string, unknown>;

    // Each provider call yields a distinct MCP server instance — no
    // cross-call pollution at the MCP layer.
    expect(serverARef).not.toBe(serverBRef);

    // Invoke `echo` on B's server. B's allowedToolNames is `{deny_me}`,
    // so this MUST be denied — the bridge does NOT leak A's allowlist
    // into B's executor context.
    const mcpResult = await invokeCallToolOnLastServer("echo", {});
    expect(mcpResult.isError).toBe(true);
    expect(mcpResult.content[0].text).toContain("not currently active");

    // Audit isolation: every event B's onToolLifecycleEvent saw carries
    // conv-B; A's stream is untouched.
    expect(eventsA.length).toBe(0); // nothing was invoked through A
    expect(eventsB.length).toBeGreaterThan(0);
    for (const event of eventsB) {
      expect(event.conversationId).toBe("conv-B");
    }
  });

  // -------------------------------------------------------------------------
  // I-2 — Trust-class enforcement
  //
  // When the permissions checker returns `{ decision: "deny" }` for a given
  // (toolName, trustClass) combination, the bridge must surface isError with
  // the denial reason. The denial decision normally comes from a trust rule
  // matched against `trustClass: "unknown"` for a guardian-only tool; we
  // synthesise that here via `checkResultOverride` to skip the rule store.
  // -------------------------------------------------------------------------

  test("I-2: bridge call denied by trust gate returns isError with the denial reason", async () => {
    checkResultOverride = {
      decision: "deny",
      reason: "Trust class 'unknown' is not permitted to run this tool",
    };

    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-trust",
      trustClass: "unknown",
      allowedToolNames: new Set(["echo"]),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const mcpResult = await invokeCallToolOnLastServer("echo", {});
    expect(mcpResult.isError).toBe(true);
    expect(mcpResult.content[0].text).toContain("not permitted");
  });

  // -------------------------------------------------------------------------
  // I-3 — Interactive permission prompt
  //
  // When the checker returns `{ decision: "prompt" }` the executor fires the
  // `PermissionPrompter`. Two cases: the prompter returns "deny" → result is
  // isError; the prompter returns "allow" → tool runs normally.
  // -------------------------------------------------------------------------

  test("I-3: prompter 'deny' through the bridge yields isError", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "High-risk tool; user approval required",
    };

    const denyingPrompter = makePrompter("deny");
    const executor = new ToolExecutor(denyingPrompter);
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-prompt-deny",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const mcpResult = await invokeCallToolOnLastServer("echo", {});
    expect(mcpResult.isError).toBe(true);
  });

  test("I-3b: prompter 'allow' through the bridge runs the tool", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "High-risk tool; user approval required",
    };

    const approvingPrompter = makePrompter("allow");
    const executor = new ToolExecutor(approvingPrompter);
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-prompt-allow",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const mcpResult = await invokeCallToolOnLastServer("echo", {});
    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.content[0].text).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // I-4 — CES grant retry through the bridge
  //
  // A CES-protected tool returns `cesApprovalRequired` on its first call.
  // The executor enters `bridgeCesApproval`, the prompter approves, the
  // mock CES client records the grant and returns a `grantId`, then the
  // executor re-invokes the tool with `grantId` injected into `input`.
  // The bridge surfaces ONLY the retry's result to the SDK — the user
  // never sees the intermediate approval-required payload.
  // -------------------------------------------------------------------------

  test("I-4: cesApprovalRequired triggers approval flow, then tool re-runs with grantId in input", async () => {
    const executeCalls: Array<{ input: Record<string, unknown> }> = [];
    const cesCalls: Array<{ method: string; payload: unknown }> = [];

    getToolOverride = (name) => {
      if (name !== "ces_tool") return undefined;
      return {
        name,
        description: "Tool that requires a CES grant",
        category: "test",
        defaultRiskLevel: RiskLevel.Low,
        getDefinition: () => ({
          name,
          description: "Tool that requires a CES grant",
          input_schema: { type: "object", properties: {} },
        }),
        execute: async (input) => {
          executeCalls.push({ input: { ...input } });
          if (!input.grantId) {
            // First call: signal that an approval is required. Shape
            // mirrors a real CES `ApprovalRequired` payload (see
            // `packages/service-contracts/src/rpc.ts`).
            return {
              content: "approval-required",
              isError: false,
              cesApprovalRequired: {
                proposal: {
                  type: "http" as const,
                  credentialHandle: "github-pat",
                  method: "GET",
                  url: "https://api.github.com/user",
                  purpose: "Fetch user profile",
                },
                proposalHash: "test-hash-deadbeef",
                renderedProposal: "GET https://api.github.com/user",
                sessionId: "ces-session-test",
              },
            };
          }
          // Retry path: the executor injected grantId after the
          // bridge approved the proposal.
          return {
            content: `done with grantId=${String(input.grantId)}`,
            isError: false,
          };
        },
      };
    };

    // Minimal CES client stub that records calls and returns a successful
    // record_grant response with a fixed grantId.
    const mockCesClient = {
      call: async (method: string, payload: unknown) => {
        cesCalls.push({ method, payload });
        if (method === "record_grant") {
          return {
            success: true,
            grant: {
              grantId: "grant-test-abc",
              sessionId: "ces-session-test",
              credentialHandle: "github-pat",
              proposalType: "http" as const,
              proposalHash: "test-hash-deadbeef",
              allowedPurposes: ["https://api.github.com/*"],
              status: "active" as const,
              grantedBy: "guardian",
              createdAt: new Date().toISOString(),
              expiresAt: null,
              consumedAt: null,
              revokedAt: null,
            },
          };
        }
        throw new Error(`Unexpected CES RPC method in I-4 test: ${method}`);
      },
    };

    const executor = new ToolExecutor(makePrompter("allow"));
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-ces",
      trustClass: "guardian",
      allowedToolNames: new Set(["ces_tool"]),
      // The executor only enters the CES bridge when a cesClient is
      // present on the ToolContext. The bridge fixture forwards this
      // verbatim from `context`.
      cesClient: mockCesClient as unknown as ToolContext["cesClient"],
      isInteractive: true,
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const tools: ToolDefinition[] = [
      {
        name: "ces_tool",
        description: "Tool that requires a CES grant",
        input_schema: { type: "object" },
      },
    ];

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: bridge,
    });

    const mcpResult = await invokeCallToolOnLastServer("ces_tool", { x: 1 });

    // The tool's execute() was called exactly twice — once to elicit
    // the approval, once to run with the grantId in input.
    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[0].input).toEqual({ x: 1 });
    expect(executeCalls[1].input).toEqual({ x: 1, grantId: "grant-test-abc" });

    // CES `record_grant` fired with the original proposal's hash and an
    // "approved" decision (the prompter returned "allow", which maps via
    // `mapUserDecisionToCesDecision` to grantDecision="approved").
    const recordGrant = cesCalls.filter((c) => c.method === "record_grant");
    expect(recordGrant).toHaveLength(1);
    const payload = recordGrant[0].payload as {
      decision: {
        decision: string;
        proposalHash: string;
        proposal: { type: string; credentialHandle: string };
      };
      sessionId: string;
    };
    expect(payload.decision.decision).toBe("approved");
    expect(payload.decision.proposalHash).toBe("test-hash-deadbeef");
    expect(payload.decision.proposal.credentialHandle).toBe("github-pat");
    expect(payload.sessionId).toBe("ces-session-test");

    // The MCP result reflects the retry's output — the approval-required
    // intermediate payload never reaches the SDK.
    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.content[0].text).toBe("done with grantId=grant-test-abc");
  });

  // -------------------------------------------------------------------------
  // I-5 — Sandbox routing for skill tools
  //
  // A skill tool declared with `executionTarget: "sandbox"` must route its
  // execution through `runSkillToolScriptSandbox` when called via the
  // bridge. Same fixture pattern as I-1: hand a `getToolOverride` to the
  // registry mock that returns a real skill-shaped Tool whose `execute`
  // delegates to the real `runSkillToolScript` dispatcher. The dispatcher
  // sees `target: "sandbox"` and calls `runSkillToolScriptSandbox`, which
  // is mocked at the top of this file to record into `sandboxSpyCalls`.
  // -------------------------------------------------------------------------

  test("I-5: skill tool with executionTarget 'sandbox' routes through runSkillToolScriptSandbox", async () => {
    const events: ToolLifecycleEvent[] = [];

    const sandboxSkill: Tool = {
      name: "sandbox_skill",
      description: "Sandbox-routed skill tool",
      category: "skill",
      defaultRiskLevel: RiskLevel.Low,
      origin: "skill",
      ownerSkillId: "test-skill",
      ownerSkillVersionHash: "v-hash",
      executionTarget: "sandbox",
      getDefinition: () => ({
        name: "sandbox_skill",
        description: "Sandbox-routed skill tool",
        input_schema: { type: "object", properties: {} },
      }),
      execute: async (input, execContext) => {
        // Mirrors what `createSkillTool` does in production — delegate to
        // the real dispatcher with target=sandbox so the sandbox spy gets
        // exercised through the real routing logic.
        return runSkillToolScript(
          "/fake/skill/dir",
          "executor.ts",
          input,
          execContext,
          {
            target: "sandbox",
            expectedSkillVersionHash: "v-hash",
            bundled: false,
          },
        );
      },
    };
    getToolOverride = (name) =>
      name === "sandbox_skill" ? sandboxSkill : undefined;

    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-sandbox",
      trustClass: "guardian",
      allowedToolNames: new Set(["sandbox_skill"]),
      onToolLifecycleEvent: (event) => {
        events.push(event);
      },
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const tools: ToolDefinition[] = [
      {
        name: "sandbox_skill",
        description: "Sandbox-routed skill tool",
        input_schema: { type: "object" },
      },
    ];

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: bridge,
    });

    const mcpResult = await invokeCallToolOnLastServer("sandbox_skill", {
      x: 1,
    });

    // The sandbox runner fired exactly once with the dispatcher's args.
    expect(sandboxSpyCalls).toHaveLength(1);
    expect(sandboxSpyCalls[0].skillDir).toBe("/fake/skill/dir");
    expect(sandboxSpyCalls[0].executorPath).toBe("executor.ts");
    expect(sandboxSpyCalls[0].input).toEqual({ x: 1 });
    // The same ToolContext the bridge captured by closure reaches the
    // sandbox runner — proves no context substitution along the route.
    expect(sandboxSpyCalls[0].context.conversationId).toBe("conv-sandbox");
    expect(sandboxSpyCalls[0].context.workingDir).toBe("/tmp/project");
    expect(sandboxSpyCalls[0].context.trustClass).toBe("guardian");

    // MCP result reflects the sandbox runner's return value verbatim.
    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.content[0].text).toBe("sandbox-ran");

    // Lifecycle audit observes executionTarget: "sandbox" — proves
    // resolveExecutionTarget() read the tool's manifest-declared target,
    // which is the value the audit pipeline persists.
    const startEvent = events.find((e) => e.type === "start");
    expect(startEvent).toBeDefined();
    expect(startEvent!.executionTarget).toBe("sandbox");
  });

  // -------------------------------------------------------------------------
  // I-8 — `yieldToUser: true` through the real executor aborts the SDK loop
  //
  // The closure-level abort is already covered by D-2 unit tests; this is
  // the end-to-end variant where the result genuinely originates from
  // `ToolExecutor.execute` (e.g. a `remember(finish_turn=true)` tool flag).
  // -------------------------------------------------------------------------

  test("I-8: tool returning yieldToUser through the executor aborts the SDK after the result lands", async () => {
    fakeToolResult = { content: "stop here", isError: false, yieldToUser: true };

    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-yield",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const sdkAbort = lastQueryOptions!.abortController as AbortController;
    expect(sdkAbort.signal.aborted).toBe(false);

    const mcpResult = await invokeCallToolOnLastServer("echo", {});
    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.content[0].text).toBe("stop here");

    // setImmediate schedules the abort so the SDK sees the result first.
    await new Promise((r) => setImmediate(r));
    expect(sdkAbort.signal.aborted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // I-10 — Abort propagation isolation between conversations
  //
  // Two parallel sendMessage calls, each with its own external AbortSignal.
  // Aborting conversation A's outer signal must propagate to A's internal
  // SDK AbortController only — B's must stay untouched, proving each
  // sendMessage builds a fresh abort scope rather than sharing one.
  //
  // The SDK mock is switched to "hang-until-aborted" mode so both calls
  // are mid-flight when the test inspects them — the immediate-completion
  // scripted stream would let A finish before we even fire the abort.
  // -------------------------------------------------------------------------

  test("I-10: aborting conversation A's signal does NOT abort conversation B's SDK call", async () => {
    queryHangControllers = [];

    const outerA = new AbortController();
    const outerB = new AbortController();

    const providerA = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    const providerB = new ClaudeSubscriptionProvider("claude-sonnet-4-5");

    const executorA = new ToolExecutor(makePrompter());
    const executorB = new ToolExecutor(makePrompter());
    const contextA: ToolContext = {
      workingDir: "/tmp/a",
      conversationId: "conv-A",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
    };
    const contextB: ToolContext = {
      workingDir: "/tmp/b",
      conversationId: "conv-B",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
    };
    const bridgeA = makeBridgeForExecutor(executorA, contextA);
    const bridgeB = makeBridgeForExecutor(executorB, contextB);

    // Kick off both calls without awaiting — they'll hang on their own
    // SDK AbortControllers until we trigger an abort.
    const promiseA = providerA.sendMessage([userText("hi A")], baseTools, "sys", {
      toolBridge: bridgeA,
      signal: outerA.signal,
    });
    const promiseB = providerB.sendMessage([userText("hi B")], baseTools, "sys", {
      toolBridge: bridgeB,
      signal: outerB.signal,
    });

    // Let both providers reach query() and register their controllers.
    await new Promise((r) => setImmediate(r));

    expect(queryHangControllers).toHaveLength(2);
    const [sdkAbortA, sdkAbortB] = queryHangControllers;
    // Each sendMessage built its own AbortController — no shared instance.
    expect(sdkAbortA).not.toBe(sdkAbortB);
    expect(sdkAbortA.signal.aborted).toBe(false);
    expect(sdkAbortB.signal.aborted).toBe(false);

    // Abort ONLY conversation A's outer signal.
    outerA.abort();
    // Microtask flush for the externalSignal → sdkAbort listener and the
    // hangUntilAborted stream to resolve.
    await new Promise((r) => setImmediate(r));

    // A's internal SDK controller received the abort via the provider's
    // externalSignal.addEventListener("abort", ...) bridge.
    expect(sdkAbortA.signal.aborted).toBe(true);
    // B's internal controller is untouched — outerB never aborted, and
    // outerA's abort does NOT leak across the closure boundary into B's
    // sendMessage scope.
    expect(sdkAbortB.signal.aborted).toBe(false);

    // A's sendMessage promise should resolve now that its stream yielded.
    await promiseA;
    // B is still running. Confirm by inspecting controller state once more
    // after we yield additional ticks.
    await new Promise((r) => setImmediate(r));
    expect(sdkAbortB.signal.aborted).toBe(false);

    // Clean up: abort B so its hanging stream resolves and the test
    // doesn't leak a pending promise.
    outerB.abort();
    await promiseB;
    expect(sdkAbortB.signal.aborted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Phase 2.5 — onChunk plumbed end-to-end
  //
  // The bridge fixture wires `invocation.onChunk` → `ToolContext.onOutput`
  // (mirroring what `conversation-tool-setup.ts` does in production). A
  // tool that calls `context.onOutput("…")` mid-execute should surface
  // those chunks via the provider's `options.onEvent` as
  // `tool_output_chunk` events.
  // -------------------------------------------------------------------------

  test("Phase 2.5: tool's context.onOutput surfaces as tool_output_chunk events on the provider boundary", async () => {
    const events: ProviderEvent[] = [];
    getToolOverride = (name) => {
      if (name !== "stream_tool") return undefined;
      return {
        name,
        description: "Tool that streams chunks via onOutput",
        category: "test",
        defaultRiskLevel: RiskLevel.Low,
        getDefinition: () => ({
          name,
          description: "Tool that streams chunks via onOutput",
          input_schema: { type: "object", properties: {} },
        }),
        execute: async (_input, execContext) => {
          execContext.onOutput?.("first chunk");
          execContext.onOutput?.("second chunk");
          execContext.onOutput?.("third chunk");
          return { content: "all done", isError: false };
        },
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-stream",
      trustClass: "guardian",
      allowedToolNames: new Set(["stream_tool"]),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const tools: ToolDefinition[] = [
      {
        name: "stream_tool",
        description: "Tool that streams chunks via onOutput",
        input_schema: { type: "object" },
      },
    ];

    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: bridge,
      onEvent: (e) => events.push(e),
    });

    const mcpResult = await invokeCallToolOnLastServer("stream_tool", {});

    // Final tool result still flows back as the MCP call's content.
    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.content[0].text).toBe("all done");

    // Three chunks in → three tool_output_chunk events out, in order.
    const chunkEvents = events.filter((e) => e.type === "tool_output_chunk");
    expect(chunkEvents).toHaveLength(3);
    expect((chunkEvents[0] as { chunk: string }).chunk).toBe("first chunk");
    expect((chunkEvents[1] as { chunk: string }).chunk).toBe("second chunk");
    expect((chunkEvents[2] as { chunk: string }).chunk).toBe("third chunk");

    // All chunks from a single bridge call share one synthesized toolUseId.
    const ids = new Set(
      chunkEvents.map((e) => (e as { toolUseId: string }).toolUseId),
    );
    expect(ids.size).toBe(1);
  });

  // -------------------------------------------------------------------------
  // §6.2.4 (I-1 through I-10) is fully covered between this fixture and
  // `src/__tests__/loop-bridge-event-forwarding.test.ts` (I-7). No
  // remaining tests in this priority-queue thread.
  // -------------------------------------------------------------------------

  // Bridge needs a way to forward `yieldToUser` from `ToolExecutionResult` —
  // verify the bridge closure helper does so.
  test("bridge closure helper forwards yieldToUser from ToolExecutionResult", async () => {
    fakeToolResult = { content: "y", isError: false, yieldToUser: true };
    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp",
      conversationId: "conv-y",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
    };
    const bridge = makeBridgeForExecutor(executor, context);
    const result = await bridge({ toolName: "echo", input: {} });
    expect(result.yieldToUser).toBe(true);
  });
});
