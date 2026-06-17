/**
 * Integration tests for the `kimi-agent` bridge against the REAL
 * `ToolExecutor`.
 *
 * Spec: Phase 3 Task 18 in
 * `docs/superpowers/plans/2026-05-23-kimi-agent-sdk-provider.md`. The unit
 * tests in `src/__tests__/kimi-agent-provider.test.ts` stub the bridge and
 * assert the provider's *plumbing* (session options, approval isolation,
 * usage aggregation). These tests use the real `ToolExecutor` and assert the
 * security pipeline's *behaviour* through the kimi-agent external-tool seam.
 *
 * Why a separate fixture from the claude-subscription one
 * (`tool-executor-via-bridge.test.ts`): kimi-agent has NO MCP server. Tools
 * the model calls are invoked through the `externalTools[].handler(params)`
 * the provider hands to `createSession`, which returns the Kimi SDK's
 * `{ output, message }` shape. So instead of reaching into an MCP server's
 * `_requestHandlers`, these tests capture the `externalTools` array from the
 * mocked `createSession` and invoke the handler directly.
 *
 * Result mapping (kimi handler → assertions):
 *   bridge `{ content, isError:false }` → handler `{ output: content, message: "ok" }`
 *   bridge `{ content, isError:true  }` → handler `{ output: content, message: "tool error" }`
 *
 * Current coverage:
 *   • smoke — end-to-end happy path        (covered)
 *   • I-1   — allowlist enforcement        (covered)
 *   • I-2   — trust-class enforcement      (covered)
 *   • I-3   — interactive permission prompt (covered)
 *   • I-4   — CES grant retry              (covered)
 *   • I-5   — sandbox routing for skill tools (covered)
 *   • I-6   — audit lifecycle emission     (covered)
 *   • I-9   — cross-conversation isolation (covered)
 *
 * Not covered here (out of scope for the current provider): I-7 (sensitive
 * binding substitution — needs a full AgentLoop), I-8 (yieldToUser loop
 * abort) and the onChunk streaming path are Phase 2 work (Tasks 13/15) not
 * yet wired into the kimi-agent external-tool handler.
 *
 * Mocking strategy mirrors `tool-executor-via-bridge.test.ts`: ToolExecutor's
 * heavy dependencies (config, registry, permissions checker, tool-usage-store,
 * filesystem path policy, sandbox runner) are mocked so the executor's gate
 * logic runs on real code paths without booting the full daemon. The Kimi SDK
 * is mocked at import time.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
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
// Kimi SDK mock — captures createSession() options (including externalTools)
// so tests can invoke the tool handler directly (no real subprocess/CLI).
// ---------------------------------------------------------------------------

type KimiExternalTool = {
  name: string;
  description: string;
  parameters: unknown;
  handler: (
    params: Record<string, unknown>,
  ) => Promise<{ output: string; message: string }>;
};

let scriptedEvents: Array<Record<string, unknown>> = [];
const TURN_END = { type: "TurnEnd", payload: {} };

function makeTurn(events: Array<Record<string, unknown>>) {
  return {
    approve: mock(async () => {}),
    interrupt: mock(async () => {}),
    respondQuestion: mock(async () => {}),
    result: Promise.resolve({ status: "finished" as const }),
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

const createSession = mock((_opts: Record<string, unknown>) => ({
  prompt: mock(() => makeTurn(scriptedEvents)),
  close: mock(async () => {}),
}));

mock.module("@moonshot-ai/kimi-agent-sdk", () => ({
  createSession,
  // Not used by the provider (requires zod) — exposed so an inadvertent call
  // fails loudly rather than silently.
  createExternalTool: (d: unknown) => d,
}));

// ---------------------------------------------------------------------------
// ToolExecutor mocks — same surface as `tool-executor-via-bridge.test.ts`.
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
      image: "max-sandbox:latest",
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
let checkResultOverride: { decision: string; reason: string } | undefined;
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
  recordToolInvocation: (record: {
    toolName: string;
    conversationId: string;
  }) => {
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
// Imports — after every mock.module() so the SUTs pick up the stubs. The
// provider is imported dynamically so its top-level `import { createSession }`
// resolves to the mock above (matches the kimi-agent unit-test ordering).
// ---------------------------------------------------------------------------

import { PermissionPrompter } from "../../permissions/prompter.js";
import { ToolExecutor } from "../../tools/executor.js";
import { runSkillToolScript } from "../../tools/skills/skill-script-runner.js";
import { RiskLevel } from "../../permissions/types.js";

const { KimiAgentProvider, clearMaxToolBridge, _resetKimiAgentSemaphoreForTests } =
  await import("../../providers/kimi-agent/client.js");

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
 * `ToolExecutor` — the same shape `agent/loop.ts` constructs in production.
 */
function makeBridgeForExecutor(
  executor: ToolExecutor,
  context: ToolContext,
): ProviderToolBridge {
  return async ({ toolName, input, onChunk }) => {
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

/** The `externalTools` array passed to the createSession() call at `index`. */
function externalToolsForCall(index: number): KimiExternalTool[] {
  const call = createSession.mock.calls[index];
  return (call as unknown as Array<{ externalTools: KimiExternalTool[] }>)[0]
    .externalTools;
}

/** The `externalTools` array from the most-recent createSession() call. */
function lastExternalTools(): KimiExternalTool[] {
  return externalToolsForCall(createSession.mock.calls.length - 1);
}

/** Invoke a captured external tool's handler — the kimi-agent tool seam. */
async function invokeExternalTool(
  tools: KimiExternalTool[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ output: string; message: string }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`external tool not captured: ${name}`);
  return tool.handler(args);
}

const baseTools: ToolDefinition[] = [
  { name: "echo", description: "e", input_schema: { type: "object" } },
  { name: "deny_me", description: "d", input_schema: { type: "object" } },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kimi-agent bridge → real ToolExecutor integration", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    recordedInvocations = [];
    getToolOverride = undefined;
    checkResultOverride = undefined;
    sandboxSpyCalls = [];
    scriptedEvents = [TURN_END];
    createSession.mockClear();
    clearMaxToolBridge();
    _resetKimiAgentSemaphoreForTests();
  });

  afterEach(() => {
    recordedInvocations = [];
  });

  // -------------------------------------------------------------------------
  // Smoke — proves the full path wires up end-to-end.
  // -------------------------------------------------------------------------

  test("smoke: external-tool handler → ToolExecutor.execute → result, happy path", async () => {
    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-smoke",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new KimiAgentProvider("kimi-k2");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const result = await invokeExternalTool(lastExternalTools(), "echo", {
      x: 1,
    });
    expect(result.message).toBe("ok");
    expect(result.output).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // I-1 — Allowlist enforcement via the bridge
  // -------------------------------------------------------------------------

  test("I-1: handler for a tool NOT in allowedToolNames is denied with a tool error", async () => {
    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-allowlist",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]), // deny_me is NOT in the set
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new KimiAgentProvider("kimi-k2");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const result = await invokeExternalTool(lastExternalTools(), "deny_me", {});
    expect(result.message).toBe("tool error");
    expect(result.output).toContain("deny_me");
    expect(result.output).toContain("not currently active");
  });

  test("I-1b: empty allowedToolNames blocks every handler call", async () => {
    const executor = new ToolExecutor(makePrompter());
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-empty-allow",
      trustClass: "guardian",
      allowedToolNames: new Set<string>(),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new KimiAgentProvider("kimi-k2");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const result = await invokeExternalTool(lastExternalTools(), "echo", {});
    expect(result.message).toBe("tool error");
    expect(result.output).toContain("not currently active");
  });

  // -------------------------------------------------------------------------
  // I-2 — Trust-class enforcement
  // -------------------------------------------------------------------------

  test("I-2: handler call denied by trust gate returns a tool error with the denial reason", async () => {
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

    const provider = new KimiAgentProvider("kimi-k2");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const result = await invokeExternalTool(lastExternalTools(), "echo", {});
    expect(result.message).toBe("tool error");
    expect(result.output).toContain("not permitted");
  });

  // -------------------------------------------------------------------------
  // I-3 — Interactive permission prompt
  // -------------------------------------------------------------------------

  test("I-3: prompter 'deny' through the bridge yields a tool error", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "High-risk tool; user approval required",
    };

    const executor = new ToolExecutor(makePrompter("deny"));
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-prompt-deny",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new KimiAgentProvider("kimi-k2");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const result = await invokeExternalTool(lastExternalTools(), "echo", {});
    expect(result.message).toBe("tool error");
  });

  test("I-3b: prompter 'allow' through the bridge runs the tool", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "High-risk tool; user approval required",
    };

    const executor = new ToolExecutor(makePrompter("allow"));
    const context: ToolContext = {
      workingDir: "/tmp/project",
      conversationId: "conv-prompt-allow",
      trustClass: "guardian",
      allowedToolNames: new Set(["echo"]),
    };
    const bridge = makeBridgeForExecutor(executor, context);

    const provider = new KimiAgentProvider("kimi-k2");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    const result = await invokeExternalTool(lastExternalTools(), "echo", {});
    expect(result.message).toBe("ok");
    expect(result.output).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // I-4 — CES grant retry through the bridge
  //
  // A CES-protected tool returns `cesApprovalRequired` on its first call. The
  // executor enters the approval flow, the prompter approves, the mock CES
  // client records the grant, then the executor re-invokes the tool with the
  // grantId injected. The handler surfaces ONLY the retry's result.
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
          return {
            content: `done with grantId=${String(input.grantId)}`,
            isError: false,
          };
        },
      };
    };

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

    const provider = new KimiAgentProvider("kimi-k2");
    await provider.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: bridge,
    });

    const result = await invokeExternalTool(lastExternalTools(), "ces_tool", {
      x: 1,
    });

    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[0].input).toEqual({ x: 1 });
    expect(executeCalls[1].input).toEqual({ x: 1, grantId: "grant-test-abc" });

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

    // The handler reflects the retry's output — the approval-required
    // intermediate payload never reaches the SDK.
    expect(result.message).toBe("ok");
    expect(result.output).toBe("done with grantId=grant-test-abc");
  });

  // -------------------------------------------------------------------------
  // I-5 — Sandbox routing for skill tools
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

    const provider = new KimiAgentProvider("kimi-k2");
    await provider.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: bridge,
    });

    const result = await invokeExternalTool(
      lastExternalTools(),
      "sandbox_skill",
      { x: 1 },
    );

    expect(sandboxSpyCalls).toHaveLength(1);
    expect(sandboxSpyCalls[0].skillDir).toBe("/fake/skill/dir");
    expect(sandboxSpyCalls[0].executorPath).toBe("executor.ts");
    expect(sandboxSpyCalls[0].input).toEqual({ x: 1 });
    expect(sandboxSpyCalls[0].context.conversationId).toBe("conv-sandbox");
    expect(sandboxSpyCalls[0].context.workingDir).toBe("/tmp/project");
    expect(sandboxSpyCalls[0].context.trustClass).toBe("guardian");

    expect(result.message).toBe("ok");
    expect(result.output).toBe("sandbox-ran");

    const startEvent = events.find((e) => e.type === "start");
    expect(startEvent).toBeDefined();
    expect(startEvent!.executionTarget).toBe("sandbox");
  });

  // -------------------------------------------------------------------------
  // I-6 — Audit lifecycle emission via the bridge
  // -------------------------------------------------------------------------

  test("I-6: handler call emits start + executed lifecycle events through onToolLifecycleEvent", async () => {
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

    const provider = new KimiAgentProvider("kimi-k2");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    await invokeExternalTool(lastExternalTools(), "echo", { x: 1 });

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

    const provider = new KimiAgentProvider("kimi-k2");
    await provider.sendMessage([userText("hi")], baseTools, "sys", {
      toolBridge: bridge,
    });

    await invokeExternalTool(lastExternalTools(), "echo", {});
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.conversationId).toBe("conv-record");
    }
  });

  // -------------------------------------------------------------------------
  // I-9 — Cross-conversation isolation
  //
  // Two parallel KimiAgentProvider sendMessage calls — each with its own
  // bridge bound to a distinct ToolContext — must NOT see each other's tools
  // or conversation id. Each createSession call captures its own
  // externalTools array, so invoking conversation B's handler runs through
  // B's executor/allowlist only.
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

    const providerA = new KimiAgentProvider("kimi-k2");
    await providerA.sendMessage([userText("from A")], baseTools, "sys", {
      toolBridge: bridgeA,
    });
    const toolsA = lastExternalTools();

    const providerB = new KimiAgentProvider("kimi-k2");
    await providerB.sendMessage([userText("from B")], baseTools, "sys", {
      toolBridge: bridgeB,
    });
    const toolsB = lastExternalTools();

    // Each provider call yields a distinct externalTools array — no
    // cross-call pollution at the SDK boundary.
    expect(toolsA).not.toBe(toolsB);

    // Invoke `echo` on B's handler. B's allowedToolNames is `{deny_me}`, so
    // this MUST be denied — the bridge does NOT leak A's allowlist into B's
    // executor context.
    const result = await invokeExternalTool(toolsB, "echo", {});
    expect(result.message).toBe("tool error");
    expect(result.output).toContain("not currently active");

    // Audit isolation: every event B saw carries conv-B; A's stream is
    // untouched (nothing was invoked through A).
    expect(eventsA.length).toBe(0);
    expect(eventsB.length).toBeGreaterThan(0);
    for (const event of eventsB) {
      expect(event.conversationId).toBe("conv-B");
    }
  });
});
