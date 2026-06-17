/**
 * Unit tests for the `claude-subscription` LLM provider.
 *
 * Scope: provider-level behavior — SDK options (security-critical),
 * streaming, usage aggregation, auth-retry, bridge resolution
 * precedence, yieldToUser plumbing.
 *
 * Mocking strategy:
 *   - `@anthropic-ai/claude-agent-sdk` is mocked at import time. The
 *     mock captures every `query()` call's options as a live reference
 *     (no JSON clone — the McpServer instance has cyclic refs).
 *   - The real `@modelcontextprotocol/sdk` McpServer is used so the
 *     request-handler wiring is exercised end-to-end.
 *
 * Concurrency tests live in a separate file (`claude-subscription-concurrency.test.ts`)
 * so they can use their own SDK mock instance.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  ProviderEvent,
  ProviderToolBridge,
  ToolBridgeInvocation,
  ToolDefinition,
} from "../providers/types.js";
import { isContextOverflowError } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock Agent SDK — must run BEFORE importing the provider under test.
// Captures options by reference; tests inspect them directly.
// ---------------------------------------------------------------------------

let lastQueryOptions: Record<string, unknown> | null = null;
let lastQueryPrompt: string | null = null;
let queryCallCount = 0;

type ScriptedSdkMessage =
  | {
      type: "system";
      subtype: "init";
      model: string;
      session_id: string;
      tools?: string[];
    }
  | {
      type: "assistant";
      message: {
        content: Array<{ type: string; text?: string; thinking?: string }>;
      };
    }
  | {
      type: "result";
      subtype: "success" | "error_max_turns" | "error_during_execution";
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };

/** Per-attempt streams (or thrown errors) keyed by call index. */
let scriptedAttempts: Array<ScriptedSdkMessage[] | { __throw: unknown }> = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({
    prompt,
    options,
  }: {
    prompt: string;
    options: Record<string, unknown>;
  }) => {
    queryCallCount += 1;
    lastQueryOptions = options; // live reference
    lastQueryPrompt = prompt;

    const idx = Math.min(queryCallCount - 1, scriptedAttempts.length - 1);
    const attempt = scriptedAttempts[idx];
    if (attempt && typeof attempt === "object" && "__throw" in attempt) {
      const err = attempt.__throw;
      return (async function* () {
        throw err;
      })();
    }
    const messages = (attempt as ScriptedSdkMessage[] | undefined) ?? [];
    return (async function* () {
      for (const m of messages) yield m;
    })();
  },
}));

// ---------------------------------------------------------------------------
// Import provider AFTER mock is in place.
// ---------------------------------------------------------------------------

import {
  _resetClaudeSubscriptionSemaphoreForTests,
  ClaudeSubscriptionProvider,
  clearMaxToolBridge,
  setMaxToolBridge,
} from "../providers/claude-subscription/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const assistantText = (text: string): ScriptedSdkMessage => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

const initMsg = (model = "claude-sonnet-4-5"): ScriptedSdkMessage => ({
  type: "system",
  subtype: "init",
  model,
  session_id: "test-session",
});

const resultMsg = (
  usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
  },
  subtype: "success" | "error_max_turns" | "error_during_execution" = "success",
): ScriptedSdkMessage => ({ type: "result", subtype, usage });

const happyStream = (text = "ok"): ScriptedSdkMessage[] => [
  initMsg(),
  assistantText(text),
  resultMsg(),
];

beforeEach(() => {
  lastQueryOptions = null;
  lastQueryPrompt = null;
  queryCallCount = 0;
  scriptedAttempts = [happyStream()];
  clearMaxToolBridge();
  _resetClaudeSubscriptionSemaphoreForTests();
});

// ---------------------------------------------------------------------------
// Construction & identity
// ---------------------------------------------------------------------------

describe("ClaudeSubscriptionProvider — construction & identity", () => {
  test("exposes name and tokenEstimationProvider", () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    expect(p.name).toBe("claude-subscription");
    expect(p.tokenEstimationProvider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// SDK isolation config — SECURITY LOAD-BEARING
// ---------------------------------------------------------------------------

describe("SDK isolation options (security)", () => {
  test("passes the four load-bearing isolation locks", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], "you are pyxis");

    expect(lastQueryOptions).not.toBeNull();
    expect(lastQueryOptions!.permissionMode).toBe("default");
    expect(lastQueryOptions!.settingSources).toEqual([]);
    expect(lastQueryOptions!.tools).toEqual(["Task"]);
    expect(typeof lastQueryOptions!.canUseTool).toBe("function");
  });

  test("uses `systemPrompt` (not the bogus `customSystemPrompt`)", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], "max persona");
    expect(lastQueryOptions!.systemPrompt).toBe("max persona");
    expect("customSystemPrompt" in lastQueryOptions!).toBe(false);
  });

  test("honors the per-call resolved model over the construction-time model", async () => {
    // Provider instances are cached per CONNECTION and shared by every
    // claude-subscription model profile. The model the user picked is
    // resolved per call into `options.config.model`; the provider must send
    // THAT, not the model it was constructed with — otherwise switching the
    // in-chat picker between two claude-subscription models does nothing
    // (the cached provider keeps sending its original model).
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-6");
    await p.sendMessage([userText("hi")], [], "sys", {
      config: { model: "claude-opus-4-8" },
    });
    // The model SENT to the CLI is the per-call resolved one. (The response's
    // `.model` echoes whatever the CLI reports back in its init/result
    // messages, which the mock controls separately.)
    expect(lastQueryOptions!.model).toBe("claude-opus-4-8");
  });

  test("falls back to the construction-time model when no per-call model is set", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-6");
    await p.sendMessage([userText("hi")], [], "sys");
    expect(lastQueryOptions!.model).toBe("claude-sonnet-4-6");
  });

  test("ignores an empty per-call model string (falls back to construction model)", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-6");
    await p.sendMessage([userText("hi")], [], "sys", {
      config: { model: "" },
    });
    expect(lastQueryOptions!.model).toBe("claude-sonnet-4-6");
  });

  test("omits systemPrompt when none provided", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], undefined);
    expect("systemPrompt" in lastQueryOptions!).toBe(false);
  });

  test("builds allowedTools = [mcp__max-skills__<name>...] + 'Task'", async () => {
    const tools: ToolDefinition[] = [
      { name: "alpha", description: "a", input_schema: { type: "object" } },
      { name: "beta", description: "b", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys");
    expect(lastQueryOptions!.allowedTools).toEqual([
      "mcp__max-skills__alpha",
      "mcp__max-skills__beta",
      "Task",
    ]);
  });

  test("canUseTool ALLOWS allowlisted Max tool names and 'Task'", async () => {
    const tools: ToolDefinition[] = [
      { name: "foo", description: "f", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys");
    const canUseTool = lastQueryOptions!.canUseTool as (
      name: string,
    ) => Promise<{ behavior: string }>;
    expect((await canUseTool("mcp__max-skills__foo")).behavior).toBe(
      "allow",
    );
    expect((await canUseTool("Task")).behavior).toBe("allow");
  });

  test("canUseTool DENIES built-in tools (Bash/Read/Write/Edit/WebFetch)", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], "sys");
    const canUseTool = lastQueryOptions!.canUseTool as (
      name: string,
    ) => Promise<{ behavior: string; message?: string }>;
    for (const name of [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "WebFetch",
      "Glob",
      "Grep",
    ]) {
      const r = await canUseTool(name);
      expect(r.behavior).toBe("deny");
      expect(r.message).toContain(name);
    }
  });

  test("canUseTool DENIES account-level MCP tools (Gmail/Drive/Notion leak path)", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], "sys");
    const canUseTool = lastQueryOptions!.canUseTool as (
      name: string,
    ) => Promise<{ behavior: string }>;
    for (const name of [
      "mcp__claude_ai_Gmail__send_email",
      "mcp__claude_ai_Google_Drive__create_file",
      "mcp__claude_ai_Notion__notion-create-pages",
      "mcp__claude_ai_Vercel__deploy_to_vercel",
    ]) {
      expect((await canUseTool(name)).behavior).toBe("deny");
    }
  });

  test("canUseTool DENIES arbitrary unregistered tool names (N-5 negative space)", async () => {
    const tools: ToolDefinition[] = [
      { name: "real", description: "r", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys");
    const canUseTool = lastQueryOptions!.canUseTool as (
      name: string,
    ) => Promise<{ behavior: string }>;
    expect((await canUseTool("mcp__attacker__exfiltrate")).behavior).toBe(
      "deny",
    );
    expect((await canUseTool("../escape")).behavior).toBe("deny");
    expect((await canUseTool("")).behavior).toBe("deny");
    expect(
      (await canUseTool("mcp__max-skills__not_registered")).behavior,
    ).toBe("deny");
  });

  test("registers exactly one MCP server named 'max-skills'", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], "sys");
    const servers = lastQueryOptions!.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["max-skills"]);
  });

  test("attaches an AbortController", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], "sys");
    expect(lastQueryOptions!.abortController).toBeInstanceOf(AbortController);
  });

  test("sets a hard maxTurns bound (runaway backstop for sub-agent recursion)", async () => {
    // I-19 found unbounded sub-agent recursion can run for 20+ minutes.
    // Per user direction (2026-06-06) the cap is now a RUNAWAY BACKSTOP,
    // not a work bound — tasks run as long as they need; the 3h provider
    // stream timeout is the operative wall-clock guard. The assertion
    // pins only that SOME finite bound is always passed to the SDK.
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], "sys");
    expect(typeof lastQueryOptions!.maxTurns).toBe("number");
    expect(lastQueryOptions!.maxTurns as number).toBeGreaterThan(0);
    expect(lastQueryOptions!.maxTurns as number).toBeLessThanOrEqual(100000);
  });
});

// ---------------------------------------------------------------------------
// Streaming + usage
// ---------------------------------------------------------------------------

describe("Streaming + usage", () => {
  test("emits text_delta events for each assistant text block", async () => {
    scriptedAttempts = [
      [initMsg(), assistantText("hello "), assistantText("world"), resultMsg()],
    ];
    const seen: Array<{ type: string; text?: string }> = [];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    const resp = await p.sendMessage([userText("hi")], [], "sys", {
      onEvent: (e) => seen.push(e as { type: string; text?: string }),
    });
    expect(
      seen.filter((e) => e.type === "text_delta").map((e) => e.text),
    ).toEqual(["hello ", "world"]);
    expect(resp.content).toEqual([{ type: "text", text: "hello world" }]);
  });

  test("emits thinking_delta for thinking blocks", async () => {
    scriptedAttempts = [
      [
        initMsg(),
        {
          type: "assistant",
          message: {
            content: [{ type: "thinking", thinking: "let me think..." }],
          },
        },
        assistantText("answer"),
        resultMsg(),
      ],
    ];
    const seen: Array<{ type: string; thinking?: string }> = [];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], "sys", {
      onEvent: (e) => seen.push(e as { type: string; thinking?: string }),
    });
    expect(seen.find((e) => e.type === "thinking_delta")?.thinking).toBe(
      "let me think...",
    );
  });

  test("aggregates SDK usage including cache fields", async () => {
    scriptedAttempts = [
      [
        initMsg(),
        assistantText("ok"),
        resultMsg({
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
        }),
      ],
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    const resp = await p.sendMessage([userText("hi")], [], "sys");
    expect(resp.usage).toEqual({
      inputTokens: 100 + 20 + 30,
      outputTokens: 50,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
    });
  });

  test("uses init.model when present, else falls back to constructor model", async () => {
    scriptedAttempts = [
      [initMsg("claude-sonnet-4-5"), assistantText("ok"), resultMsg()],
    ];
    const p1 = new ClaudeSubscriptionProvider("claude-opus-4-7");
    expect((await p1.sendMessage([userText("hi")], [], "sys")).model).toBe(
      "claude-sonnet-4-5",
    );
  });

  test("maps result subtype to stopReason", async () => {
    scriptedAttempts = [
      [initMsg(), assistantText("a"), resultMsg(undefined, "success")],
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    expect((await p.sendMessage([userText("hi")], [], "sys")).stopReason).toBe(
      "end_turn",
    );

    queryCallCount = 0;
    scriptedAttempts = [
      [initMsg(), assistantText("p"), resultMsg(undefined, "error_max_turns")],
    ];
    expect((await p.sendMessage([userText("hi")], [], "sys")).stopReason).toBe(
      "max_turns",
    );

    queryCallCount = 0;
    scriptedAttempts = [
      [
        initMsg(),
        assistantText("e"),
        resultMsg(undefined, "error_during_execution"),
      ],
    ];
    expect((await p.sendMessage([userText("hi")], [], "sys")).stopReason).toBe(
      "error",
    );
  });
});

// ---------------------------------------------------------------------------
// Bridge resolution precedence
// ---------------------------------------------------------------------------

describe("Bridge resolution precedence", () => {
  /**
   * Pull the CallTool handler off the McpServer instance and invoke it
   * directly to simulate the SDK calling a tool. The MCP SDK stores
   * handlers on `server.server._requestHandlers` keyed by request-schema
   * method string ("tools/call"). Access is by intent, not by API — if
   * a future MCP SDK upgrade reshapes this, these tests will need to
   * update.
   */
  /**
   * MCP content items the SDK forwards to the model. The bridge maps Max
   * `ContentBlock`s onto these. We loosen the type so tests can assert on
   * image / resource items in addition to text.
   */
  type McpContentItem = {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: {
      uri?: string;
      mimeType?: string;
      blob?: string;
      text?: string;
    };
  };

  async function invokeCallTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ content: McpContentItem[]; isError?: boolean }> {
    const mcpServers = lastQueryOptions!.mcpServers as Record<
      string,
      { instance: { server: { _requestHandlers: Map<string, unknown> } } }
    >;
    const server = mcpServers["max-skills"].instance.server;
    const handlerEntry = [...server._requestHandlers.entries()].find(([k]) =>
      String(k).includes("tools/call"),
    );
    expect(handlerEntry).toBeDefined();
    const handler = handlerEntry![1] as (req: {
      params: { name: string; arguments: Record<string, unknown> };
      method: "tools/call";
    }) => Promise<{ content: McpContentItem[]; isError?: boolean }>;
    return handler({
      params: { name, arguments: args },
      method: "tools/call",
    });
  }

  test("options.toolBridge wins over the registry bridge", async () => {
    const calls: string[] = [];
    setMaxToolBridge(async () => {
      calls.push("registry");
      return { content: "from registry" };
    });
    const perCall: ProviderToolBridge = async () => {
      calls.push("per-call");
      return { content: "from per-call" };
    };
    const tools: ToolDefinition[] = [
      { name: "echo", description: "e", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: perCall,
    });
    await invokeCallTool("echo", { x: 1 });
    expect(calls).toEqual(["per-call"]);
  });

  test("falls back to registry bridge when options.toolBridge unset", async () => {
    const calls: string[] = [];
    setMaxToolBridge(async () => {
      calls.push("registry");
      return { content: "ok" };
    });
    const tools: ToolDefinition[] = [
      { name: "echo", description: "e", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys");
    await invokeCallTool("echo", {});
    expect(calls).toEqual(["registry"]);
  });

  test("falls back to stub bridge when neither set, with isError: false", async () => {
    const tools: ToolDefinition[] = [
      { name: "echo", description: "e", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys");
    const result = await invokeCallTool("echo", {});
    expect(result.content[0].text).toContain("bridge stub");
    expect(result.isError).toBe(false);
  });

  test("Max tool schemas pass through to MCP ListTools verbatim (JSON Schema)", async () => {
    const tools: ToolDefinition[] = [
      {
        name: "search",
        description: "Search the web",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "search terms" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["query"],
        },
      },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys");
    const mcpServers = lastQueryOptions!.mcpServers as Record<
      string,
      { instance: { server: { _requestHandlers: Map<string, unknown> } } }
    >;
    const server = mcpServers["max-skills"].instance.server;
    const listEntry = [...server._requestHandlers.entries()].find(([k]) =>
      String(k).includes("tools/list"),
    );
    const handler = listEntry![1] as (
      req: { method: "tools/list"; params: Record<string, unknown> },
      extra: unknown,
    ) => Promise<{ tools: Array<{ name: string; inputSchema: unknown }> }>;
    const list = await handler(
      { method: "tools/list", params: {} },
      { signal: new AbortController().signal },
    );
    expect(list.tools).toHaveLength(1);
    expect(list.tools[0].name).toBe("search");
    expect(list.tools[0].inputSchema).toEqual(tools[0].input_schema);
  });

  test("bridge throw is caught; CallTool returns isError result, never propagates", async () => {
    const tools: ToolDefinition[] = [
      { name: "bad", description: "b", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => {
        throw new Error("executor blew up");
      },
    });
    const result = await invokeCallTool("bad", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Bridge error");
    expect(result.content[0].text).toContain("executor blew up");
  });

  // -------------------------------------------------------------------------
  // Phase 2.1 — contentBlocks mapping (audit row I-12)
  // -------------------------------------------------------------------------

  test("ImageContent in contentBlocks becomes an MCP image item alongside the text", async () => {
    // 16-char base64 (encodes "hello world\0\0\0\0\0"); valid per the MCP
    // CallToolResultSchema's strict base64 validator — the test asserts the
    // mapping, not the image format itself.
    const validBase64 = "aGVsbG8gd29ybGQ=";
    const tools: ToolDefinition[] = [
      {
        name: "screenshot",
        description: "s",
        input_schema: { type: "object" },
      },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({
        content: "Screenshot captured",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: validBase64,
            },
          },
        ],
      }),
    });
    const result = await invokeCallTool("screenshot", {});
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Screenshot captured",
    });
    expect(result.content[1]).toEqual({
      type: "image",
      data: validBase64,
      mimeType: "image/png",
    });
    expect(result.isError).toBe(false);
  });

  test("multiple TextContent blocks map to multiple MCP text items", async () => {
    const tools: ToolDefinition[] = [
      { name: "multi", description: "m", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({
        content: "summary",
        contentBlocks: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      }),
    });
    const result = await invokeCallTool("multi", {});
    expect(result.content).toHaveLength(3); // summary + first + second
    expect(result.content[0].text).toBe("summary");
    expect(result.content[1].text).toBe("first");
    expect(result.content[2].text).toBe("second");
  });

  test("FileContent falls back to extracted_text when present", async () => {
    const tools: ToolDefinition[] = [
      { name: "pdf", description: "p", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({
        content: "PDF parsed",
        contentBlocks: [
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "JVBERi0=",
              filename: "report.pdf",
            },
            extracted_text: "page 1 body text",
          },
        ],
      }),
    });
    const result = await invokeCallTool("pdf", {});
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({
      type: "text",
      text: "page 1 body text",
    });
  });

  test("FileContent without extracted_text is dropped (with warning) rather than blowing up", async () => {
    const tools: ToolDefinition[] = [
      { name: "blob", description: "b", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({
        content: "binary uploaded",
        contentBlocks: [
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/octet-stream",
              data: "AAAA",
              filename: "raw.bin",
            },
          },
        ],
      }),
    });
    const result = await invokeCallTool("blob", {});
    expect(result.content).toHaveLength(1); // just the leading text
    expect(result.content[0].text).toBe("binary uploaded");
  });

  test("ThinkingContent and other model-internal blocks are skipped (only tool-result-relevant kinds emit)", async () => {
    const tools: ToolDefinition[] = [
      { name: "noisy", description: "n", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({
        content: "done",
        contentBlocks: [
          { type: "thinking", thinking: "internal", signature: "sig" },
          { type: "redacted_thinking", data: "opaque" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: "/9j/4AAQ",
            },
          },
        ],
      }),
    });
    const result = await invokeCallTool("noisy", {});
    expect(result.content).toHaveLength(2); // text + image; thinking blocks skipped
    expect(result.content[0].type).toBe("text");
    expect(result.content[1].type).toBe("image");
  });

  test("absent contentBlocks preserves the existing single-text-item shape", async () => {
    const tools: ToolDefinition[] = [
      { name: "plain", description: "p", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({ content: "just text" }),
    });
    const result = await invokeCallTool("plain", {});
    expect(result.content).toEqual([{ type: "text", text: "just text" }]);
  });

  // -------------------------------------------------------------------------
  // Phase 2.4 — toolResultTruncate (audit row I-14)
  // -------------------------------------------------------------------------

  test("content > maxToolResultChars is truncated before reaching the SDK", async () => {
    const tools: ToolDefinition[] = [
      { name: "dump", description: "d", input_schema: { type: "object" } },
    ];
    const huge = "x".repeat(10_000) + "\n" + "y".repeat(10_000);
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({ content: huge }),
      maxToolResultChars: 5_000,
    });
    const result = await invokeCallTool("dump", {});
    expect(result.content).toHaveLength(1);
    const text = result.content[0].text!;
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain("[Content truncated");
  });

  test("content within maxToolResultChars passes through unchanged", async () => {
    const tools: ToolDefinition[] = [
      { name: "small", description: "s", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({ content: "short result" }),
      maxToolResultChars: 5_000,
    });
    const result = await invokeCallTool("small", {});
    expect(result.content[0].text).toBe("short result");
    expect(result.content[0].text).not.toContain("[Content truncated");
  });

  test("maxToolResultChars unset → no truncation even for very large content", async () => {
    const tools: ToolDefinition[] = [
      { name: "raw", description: "r", input_schema: { type: "object" } },
    ];
    const huge = "z".repeat(100_000);
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({ content: huge }),
    });
    const result = await invokeCallTool("raw", {});
    expect(result.content[0].text!.length).toBe(huge.length);
    expect(result.content[0].text).not.toContain("[Content truncated");
  });

  // -------------------------------------------------------------------------
  // Phase 2.2 — sensitiveBindings sanity (audit row I-11)
  //
  // The substitution behaviour itself (placeholder → real value in streamed
  // text deltas) is tested end-to-end in the integration suite at
  // `daemon/__tests__/tool-executor-via-bridge.test.ts` (priority queue
  // item #4 — pending). These tests cover the MCP-layer shape only.
  // -------------------------------------------------------------------------

  test("ToolBridgeResult.sensitiveBindings does NOT leak placeholder→value pairs into the MCP result", async () => {
    const tools: ToolDefinition[] = [
      { name: "secret", description: "s", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({
        content: "Generated invite code MAX_ASSISTANT_INVITE_CODE_ABCD1234",
        sensitiveBindings: [
          {
            kind: "invite_code",
            placeholder: "MAX_ASSISTANT_INVITE_CODE_ABCD1234",
            value: "REAL-SECRET-VALUE-12345",
          },
        ],
      }),
    });
    const result = await invokeCallTool("secret", {});
    // Placeholder reaches the model (it has to — that's what gets substituted
    // back on the outer-loop side). The real value MUST NOT appear in any
    // MCP content item the SDK forwards to the model.
    const flattened = JSON.stringify(result);
    expect(flattened).toContain("MAX_ASSISTANT_INVITE_CODE_ABCD1234");
    expect(flattened).not.toContain("REAL-SECRET-VALUE-12345");
  });

  test("ToolBridgeResult.sensitiveBindings is accepted without altering content/blocks", async () => {
    const tools: ToolDefinition[] = [
      {
        name: "rich-secret",
        description: "r",
        input_schema: { type: "object" },
      },
    ];
    const validBase64 = "aGVsbG8gd29ybGQ=";
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({
        content: "summary",
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: validBase64,
            },
          },
        ],
        sensitiveBindings: [
          { kind: "invite_code", placeholder: "X", value: "Y" },
        ],
      }),
    });
    const result = await invokeCallTool("rich-secret", {});
    expect(result.content[0]).toEqual({ type: "text", text: "summary" });
    expect(result.content[1]).toEqual({
      type: "image",
      data: validBase64,
      mimeType: "image/png",
    });
  });

  test("truncation only affects content; contentBlocks pass through unchanged", async () => {
    const tools: ToolDefinition[] = [
      { name: "rich", description: "r", input_schema: { type: "object" } },
    ];
    const huge = "a".repeat(10_000);
    const validBase64 = "aGVsbG8gd29ybGQ=";
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({
        content: huge,
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: validBase64,
            },
          },
        ],
      }),
      maxToolResultChars: 5_000,
    });
    const result = await invokeCallTool("rich", {});
    expect(result.content[0].text).toContain("[Content truncated");
    expect(result.content[1]).toEqual({
      type: "image",
      data: validBase64,
      mimeType: "image/png",
    });
  });
});

// ---------------------------------------------------------------------------
// D-5 auth retry
// ---------------------------------------------------------------------------

describe("D-5 auth retry", () => {
  test("retries ONCE on auth error with no prior output", async () => {
    scriptedAttempts = [
      { __throw: new Error("HTTP 401 unauthorized: token expired") },
      [initMsg(), assistantText("ok after retry"), resultMsg()],
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    const resp = await p.sendMessage([userText("hi")], [], "sys");
    expect(queryCallCount).toBe(2);
    expect(resp.content).toEqual([{ type: "text", text: "ok after retry" }]);
  });

  test("does NOT retry non-auth errors", async () => {
    scriptedAttempts = [{ __throw: new Error("Network unreachable") }];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await expect(p.sendMessage([userText("hi")], [], "sys")).rejects.toThrow(
      /Network unreachable/,
    );
    expect(queryCallCount).toBe(1);
  });

  test("surfaces friendly 401 error after retries exhausted", async () => {
    scriptedAttempts = [
      { __throw: new Error("401 unauthorized") },
      { __throw: new Error("401 unauthorized still") },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await expect(
      p.sendMessage([userText("hi")], [], "sys"),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/claude login/i),
    });
    expect(queryCallCount).toBe(2);
  });

  test("recognises various auth-error signatures", async () => {
    const cases = [
      "Token expired",
      "Authentication failed",
      "401 unauthorized",
      "invalid credentials",
      "OAuth token invalid",
      "Please run `claude login`",
    ];
    for (const msg of cases) {
      queryCallCount = 0;
      scriptedAttempts = [
        { __throw: new Error(msg) },
        [initMsg(), assistantText("recovered"), resultMsg()],
      ];
      const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
      const resp = await p.sendMessage([userText("hi")], [], "sys");
      expect(queryCallCount).toBe(2);
      expect(resp.content[0]).toMatchObject({ text: "recovered" });
    }
  });
});

// ---------------------------------------------------------------------------
// Context overflow → typed ContextOverflowError (NOT a retryable 500 bridge
// error). The CLI reports overflow as an error result ("Claude Code returned
// an error result: Prompt is too long"); wrapping that at statusCode 500 made
// RetryProvider burn 3 futile retries before the daemon's overflow-recovery
// compaction could engage.
// ---------------------------------------------------------------------------

describe("context overflow classification", () => {
  test("'Prompt is too long' CLI result → typed ContextOverflowError, no auth retry", async () => {
    scriptedAttempts = [
      {
        __throw: new Error(
          "Claude Code returned an error result: Prompt is too long",
        ),
      },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    let caught: unknown;
    try {
      await p.sendMessage([userText("hi")], [], "sys");
    } catch (err) {
      caught = err;
    }
    expect(isContextOverflowError(caught)).toBe(true);
    expect((caught as Error).message).toContain("Prompt is too long");
    expect(queryCallCount).toBe(1);
  });

  test("overflow message with token counts populates actualTokens/maxTokens", async () => {
    scriptedAttempts = [
      {
        __throw: new Error(
          "Claude Code returned an error result: prompt is too long: 242201 tokens > 200000 maximum",
        ),
      },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    let caught: unknown;
    try {
      await p.sendMessage([userText("hi")], [], "sys");
    } catch (err) {
      caught = err;
    }
    expect(isContextOverflowError(caught)).toBe(true);
    const overflow = caught as { actualTokens?: number; maxTokens?: number };
    expect(overflow.actualTokens).toBe(242201);
    expect(overflow.maxTokens).toBe(200000);
  });

  test("non-overflow errors still surface as bridge errors", async () => {
    scriptedAttempts = [{ __throw: new Error("Network unreachable") }];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    let caught: unknown;
    try {
      await p.sendMessage([userText("hi")], [], "sys");
    } catch (err) {
      caught = err;
    }
    expect(isContextOverflowError(caught)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I-4 / I-5 inheritance — the bridge awaits slow tool execution properly
//
// I-4 (approval UI mid-await) and I-5 (CES grant flow) both rely on the
// bridge faithfully awaiting `tool.execute()`, which in turn awaits the
// prompter / CES bridge. The bridge itself is a transparent forwarder; if
// it correctly propagates a slow async return, then approval and CES
// flows that take seconds to resolve will also flow back through.
// ---------------------------------------------------------------------------

describe("I-4 / I-5 inheritance: bridge propagates slow async tool execution", () => {
  async function invokeCallToolDirectly(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const mcpServers = lastQueryOptions!.mcpServers as Record<
      string,
      { instance: { server: { _requestHandlers: Map<string, unknown> } } }
    >;
    const server = mcpServers["max-skills"].instance.server;
    const handler = [...server._requestHandlers.entries()].find(([k]) =>
      String(k).includes("tools/call"),
    )![1] as (req: {
      params: { name: string; arguments: Record<string, unknown> };
      method: "tools/call";
    }) => Promise<unknown>;
    return handler({ params: { name, arguments: args }, method: "tools/call" });
  }

  test("a 200ms tool execution resolves through the bridge to the SDK without timing out", async () => {
    const tools: ToolDefinition[] = [
      { name: "slow", description: "s", input_schema: { type: "object" } },
    ];
    let bridgeResolveAt = 0;
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => {
        await new Promise((r) => setTimeout(r, 200));
        bridgeResolveAt = Date.now();
        return { content: "delayed result" };
      },
    });
    const start = Date.now();
    const result = (await invokeCallToolDirectly("slow")) as {
      content: Array<{ text: string }>;
    };
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(bridgeResolveAt).toBeGreaterThan(0);
    expect(result.content[0].text).toBe("delayed result");
  });

  test("simulated approval-prompt pattern: bridge waits on an external promise then returns", async () => {
    const tools: ToolDefinition[] = [
      {
        name: "needs_approval",
        description: "a",
        input_schema: { type: "object" },
      },
    ];
    let resolveApproval: ((v: { content: string }) => void) | undefined;
    const approvalPromise = new Promise<{ content: string }>((r) => {
      resolveApproval = r;
    });
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: () => approvalPromise,
    });

    // Fire the tool call; it should hang waiting on resolveApproval.
    const callPromise = invokeCallToolDirectly("needs_approval");
    let resolved = false;
    callPromise.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false); // not yet — approval still pending

    // Simulate the user clicking "approve" — bridge resolves.
    resolveApproval!({ content: "approved" });
    const result = (await callPromise) as { content: Array<{ text: string }> };
    expect(resolved).toBe(true);
    expect(result.content[0].text).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// I-9 abort propagation — when the outer signal aborts, the SDK is aborted
// ---------------------------------------------------------------------------

describe("I-9 abort propagation", () => {
  test("external signal already aborted: the SDK's AbortController fires immediately", async () => {
    scriptedAttempts = [[initMsg(), assistantText("ok"), resultMsg()]];
    const external = new AbortController();
    external.abort();
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], "sys", {
      signal: external.signal,
    });
    const sdkAbort = lastQueryOptions!.abortController as AbortController;
    expect(sdkAbort.signal.aborted).toBe(true);
  });

  test("external signal aborts mid-call: SDK's AbortController follows", async () => {
    scriptedAttempts = [[initMsg(), assistantText("ok"), resultMsg()]];
    const external = new AbortController();
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], [], "sys", {
      signal: external.signal,
    });
    const sdkAbort = lastQueryOptions!.abortController as AbortController;
    expect(sdkAbort.signal.aborted).toBe(false);
    external.abort();
    // Abort is wired via addEventListener; the SDK controller should now be aborted.
    expect(sdkAbort.signal.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-2 yieldToUser → SDK abort
// ---------------------------------------------------------------------------

describe("D-2 yieldToUser triggers SDK abort", () => {
  async function invokeCallToolDirectly(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const mcpServers = lastQueryOptions!.mcpServers as Record<
      string,
      { instance: { server: { _requestHandlers: Map<string, unknown> } } }
    >;
    const server = mcpServers["max-skills"].instance.server;
    const handlerEntry = [...server._requestHandlers.entries()].find(([k]) =>
      String(k).includes("tools/call"),
    );
    const handler = handlerEntry![1] as (req: {
      params: { name: string; arguments: Record<string, unknown> };
      method: "tools/call";
    }) => Promise<unknown>;
    return handler({ params: { name, arguments: args }, method: "tools/call" });
  }

  test("bridge returning yieldToUser=true aborts the SDK's AbortController", async () => {
    const tools: ToolDefinition[] = [
      { name: "yielder", description: "y", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({ content: "stop here", yieldToUser: true }),
    });
    const sdkAbort = lastQueryOptions!.abortController as AbortController;
    expect(sdkAbort.signal.aborted).toBe(false); // before tool fires
    await invokeCallToolDirectly("yielder");
    // Abort is scheduled via setImmediate to let the MCP result reach the
    // SDK first. Wait one tick.
    await new Promise((r) => setImmediate(r));
    expect(sdkAbort.signal.aborted).toBe(true);
  });

  test("bridge returning yieldToUser=false does NOT abort the SDK", async () => {
    const tools: ToolDefinition[] = [
      { name: "normal", description: "n", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: async () => ({ content: "keep going" }),
    });
    const sdkAbort = lastQueryOptions!.abortController as AbortController;
    await invokeCallToolDirectly("normal");
    await new Promise((r) => setImmediate(r));
    expect(sdkAbort.signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I-19 code-level: canUseTool under concurrent invocation
//
// Sub-agent fan-out exercises canUseTool from many call sites in parallel.
// The check is `allowedToolSet.has(name)` against a per-call Set — no
// mutation, no shared state — so it should be race-free by construction.
// This test pins that property: 1000 concurrent invocations, each MUST
// return the correct verdict.
// ---------------------------------------------------------------------------

describe("I-19 code-level: canUseTool is race-free under concurrent load", () => {
  test("1000 concurrent invocations all return the correct allow/deny verdicts", async () => {
    const tools: ToolDefinition[] = [
      { name: "alpha", description: "a", input_schema: { type: "object" } },
      { name: "beta", description: "b", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys");
    const canUseTool = lastQueryOptions!.canUseTool as (
      name: string,
    ) => Promise<{ behavior: string }>;

    const allowed = [
      "mcp__max-skills__alpha",
      "mcp__max-skills__beta",
      "Task",
    ];
    const denied = [
      "Bash",
      "Read",
      "Write",
      "mcp__claude_ai_Gmail__send",
      "Task2",
    ];
    const names: string[] = [];
    for (let i = 0; i < 1000; i++) {
      names.push(
        (i % 2 === 0 ? allowed : denied)[i % allowed.length] ?? "Bash",
      );
    }

    const results = await Promise.all(names.map((n) => canUseTool(n)));
    // Every result must match the static allowlist verdict for that name.
    for (let i = 0; i < names.length; i++) {
      const expected = allowed.includes(names[i]) ? "allow" : "deny";
      expect(results[i].behavior).toBe(expected);
    }
  });

  test("canUseTool does not mutate the allowedToolSet (subsequent calls give same verdict)", async () => {
    const tools: ToolDefinition[] = [
      { name: "stable", description: "s", input_schema: { type: "object" } },
    ];
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hi")], tools, "sys");
    const canUseTool = lastQueryOptions!.canUseTool as (
      name: string,
    ) => Promise<{ behavior: string }>;
    // Many calls — same name — same verdict every time.
    const verdicts = await Promise.all(
      Array.from({ length: 100 }, () =>
        canUseTool("mcp__max-skills__stable"),
      ),
    );
    expect(verdicts.every((v) => v.behavior === "allow")).toBe(true);
    const denyVerdicts = await Promise.all(
      Array.from({ length: 100 }, () => canUseTool("Bash")),
    );
    expect(denyVerdicts.every((v) => v.behavior === "deny")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Multi-turn flattening
// ---------------------------------------------------------------------------

describe("Multi-turn flattening", () => {
  test("single user message: prompt is just that text", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage([userText("hello")], [], "sys");
    expect(lastQueryPrompt).toBe("hello");
  });

  test("multi-turn history: includes 'Prior conversation' header and last user as 'Current user message'", async () => {
    const p = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await p.sendMessage(
      [
        userText("first"),
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        userText("second"),
      ],
      [],
      "sys",
    );
    expect(lastQueryPrompt).toContain("# Prior conversation");
    expect(lastQueryPrompt).toContain("first");
    expect(lastQueryPrompt).toContain("reply");
    expect(lastQueryPrompt).toContain("# Current user message");
    expect(lastQueryPrompt).toContain("second");
  });
});

// ---------------------------------------------------------------------------
// Phase 2.5 — Bridge plumbs onChunk so the consumer sees `tool_output_chunk`
// events for chunks emitted from inside a bridged tool. The MCP CallTool
// handler synthesizes a per-call `chunkToolUseId` and wraps it into an
// `onChunk` callback handed to the bridge invocation; the bridge forwards
// chunks back through `options.onEvent`.
// ---------------------------------------------------------------------------

describe("Phase 2.5 — onChunk plumbed as tool_output_chunk events", () => {
  // The MCP `tools/call` handler lives off-instance; pull it via the same
  // reflection helper the "Bridge resolution precedence" suite uses.
  async function invokeCallTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }> {
    const mcpServers = lastQueryOptions!.mcpServers as Record<
      string,
      { instance: { server: { _requestHandlers: Map<string, unknown> } } }
    >;
    const server = mcpServers["max-skills"].instance.server;
    const handlerEntry = [...server._requestHandlers.entries()].find(([k]) =>
      String(k).includes("tools/call"),
    );
    const handler = handlerEntry![1] as (req: {
      params: { name: string; arguments: Record<string, unknown> };
      method: "tools/call";
    }) => Promise<{
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }>;
    return handler({
      params: { name, arguments: args },
      method: "tools/call",
    });
  }

  test("bridge invocation receives an onChunk that fans out via onEvent", async () => {
    const events: ProviderEvent[] = [];
    let capturedInvocation: ToolBridgeInvocation | null = null;
    const bridge: ProviderToolBridge = async (invocation) => {
      capturedInvocation = invocation;
      // Emit two chunks before returning.
      invocation.onChunk?.("chunk-1");
      invocation.onChunk?.("chunk-2");
      return { content: "final" };
    };

    const tools: ToolDefinition[] = [
      {
        name: "stream_tool",
        description: "s",
        input_schema: { type: "object" },
      },
    ];
    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: bridge,
      onEvent: (e) => events.push(e),
    });
    await invokeCallTool("stream_tool", {});

    // Bridge was given an onChunk.
    expect(capturedInvocation).not.toBeNull();
    expect(typeof capturedInvocation!.onChunk).toBe("function");

    // Two chunks in → two tool_output_chunk events out, in order.
    const chunkEvents = events.filter((e) => e.type === "tool_output_chunk");
    expect(chunkEvents).toHaveLength(2);
    expect((chunkEvents[0] as { chunk: string }).chunk).toBe("chunk-1");
    expect((chunkEvents[1] as { chunk: string }).chunk).toBe("chunk-2");

    // Every chunk event from a single bridge call carries the same
    // synthesized toolUseId — the value is opaque to the test (mints a
    // fresh UUID) but consistent across the call so the consumer can
    // group chunks by tool invocation. Format-only assertion: the id
    // begins with `mcp-bridge-chunk-`.
    const id0 = (chunkEvents[0] as { toolUseId: string }).toolUseId;
    const id1 = (chunkEvents[1] as { toolUseId: string }).toolUseId;
    expect(id0).toBe(id1);
    expect(id0).toMatch(/^mcp-bridge-chunk-/);
  });

  test("each bridge call gets a fresh chunkToolUseId — no leak across calls", async () => {
    const events: ProviderEvent[] = [];
    const bridge: ProviderToolBridge = async (invocation) => {
      invocation.onChunk?.("c");
      return { content: "ok" };
    };

    const tools: ToolDefinition[] = [
      {
        name: "stream_tool",
        description: "s",
        input_schema: { type: "object" },
      },
    ];
    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    await provider.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: bridge,
      onEvent: (e) => events.push(e),
    });
    await invokeCallTool("stream_tool", {});
    await invokeCallTool("stream_tool", {});

    const chunkEvents = events.filter((e) => e.type === "tool_output_chunk");
    expect(chunkEvents).toHaveLength(2);
    const id1 = (chunkEvents[0] as { toolUseId: string }).toolUseId;
    const id2 = (chunkEvents[1] as { toolUseId: string }).toolUseId;
    expect(id1).not.toBe(id2);
  });

  test("onChunk is undefined on the invocation when onEvent is not supplied", async () => {
    let capturedInvocation: ToolBridgeInvocation | null = null;
    const bridge: ProviderToolBridge = async (invocation) => {
      capturedInvocation = invocation;
      return { content: "ok" };
    };

    const tools: ToolDefinition[] = [
      {
        name: "stream_tool",
        description: "s",
        input_schema: { type: "object" },
      },
    ];
    const provider = new ClaudeSubscriptionProvider("claude-sonnet-4-5");
    // Note: no onEvent supplied.
    await provider.sendMessage([userText("hi")], tools, "sys", {
      toolBridge: bridge,
    });
    await invokeCallTool("stream_tool", {});

    expect(capturedInvocation).not.toBeNull();
    // No consumer means there's nothing to fan chunks out to — onChunk
    // is left undefined so well-behaved tools can short-circuit and skip
    // chunk allocation entirely.
    expect(capturedInvocation!.onChunk).toBeUndefined();
  });
});
