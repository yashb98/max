/**
 * Unit tests for the `kimi-agent` LLM provider.
 *
 * Scope: provider-level behavior — session creation, streaming, usage
 * aggregation, approval isolation, bridge resolution, systemPrompt/agentFile
 * plumbing, abort propagation, and the StepBegin MAX_TURNS guard.
 *
 * Mocking strategy:
 *   - `@moonshot-ai/kimi-agent-sdk` is mocked at import time via
 *     `mock.module()`. All imports of the provider happen AFTER the mock is
 *     registered so the provider's top-level `import { createSession }` picks
 *     up the mock. Dynamic `await import(...)` is required for this order.
 *   - `node:child_process` is mocked so `which` returns a fake kimi path,
 *     enabling the `executable` branch tests without spawning real processes.
 *   - No live network or CLI calls are made.
 */
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderEvent,
  ProviderToolBridge,
  ToolDefinition,
} from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mock node:child_process — execFile("which", ["kimi"]) returns a fake path.
// Must run BEFORE importing the provider so the cached CLI path is set
// to the fake value on first call.
// ---------------------------------------------------------------------------

const FAKE_KIMI_PATH = "/usr/local/bin/kimi-fake";

mock.module("node:child_process", () => {
  return {
    execFile: (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, result: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout: FAKE_KIMI_PATH + "\n", stderr: "" });
    },
  };
});

// ---------------------------------------------------------------------------
// Mock Kimi Agent SDK — must run BEFORE importing the provider under test.
// ---------------------------------------------------------------------------

/** Helper: build a fake Turn from a list of scripted stream events. */
function makeTurn(events: Array<Record<string, unknown>>) {
  return {
    approve: mock(async () => {}),
    interrupt: mock(async () => {}),
    respondQuestion: mock(async () => {}),
    result: Promise.resolve({ status: "finished" as const }),
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        yield e;
      }
    },
  };
}

/** Per-test scripted events passed to the mock session's prompt(). */
let scriptedEvents: Array<Record<string, unknown>> = [];

/** The mock `createSession` function — tests call mock.calls to assert on it. */
const createSession = mock(() => ({
  prompt: mock((_content: unknown) => makeTurn(scriptedEvents)),
  close: mock(async () => {}),
}));

mock.module("@moonshot-ai/kimi-agent-sdk", () => ({
  createSession,
  // `createExternalTool` is NOT used by our provider (requires zod) — exposed
  // here only so any inadvertent call fails loudly rather than silently.
  createExternalTool: (d: unknown) => d,
  // Include `login` so later tests that import this module (e.g. provider-login)
  // don't see a missing-export error when this mock is active in the same process.
  login: mock(async () => ({ success: true })),
}));

// ---------------------------------------------------------------------------
// Import provider AFTER mock is in place. Dynamic import required.
// ---------------------------------------------------------------------------

const {
  KimiAgentProvider,
  clearVellumToolBridge,
  setVellumToolBridge,
  assembleHandlerOutput,
  combineBridgeOutput,
  _resetKimiAgentSemaphoreForTests,
  _getKimiAgentSemaphoreStateForTests,
  _resetKimiCliPathForTests,
} = await import("../providers/kimi-agent/client.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

/** Returns the Turn mock from the most-recent createSession().prompt() call. */
function lastTurn() {
  const session = createSession.mock.results[
    createSession.mock.results.length - 1
  ]?.value as {
    prompt: ReturnType<typeof mock>;
  };
  const turn = session.prompt.mock.results[
    session.prompt.mock.results.length - 1
  ]?.value as ReturnType<typeof makeTurn>;
  return turn;
}

/** Returns the options passed to the most-recent createSession() call. */
function lastSessionOptions() {
  const call = createSession.mock.calls[createSession.mock.calls.length - 1];

  return (call as any)?.[0] as Record<string, unknown>;
}

const TURN_END = { type: "TurnEnd", payload: {} };

beforeEach(() => {
  scriptedEvents = [TURN_END];
  createSession.mockClear();
  clearVellumToolBridge();
  _resetKimiAgentSemaphoreForTests();
  // Clear the CLI-path cache so this file's `node:child_process` mock is
  // authoritative even when a sibling test file resolved the real path
  // first in a combined run.
  _resetKimiCliPathForTests();
});

// ---------------------------------------------------------------------------
// Construction & identity
// ---------------------------------------------------------------------------

describe("KimiAgentProvider — construction & identity", () => {
  test("exposes correct name and tokenEstimationProvider", () => {
    const p = new KimiAgentProvider("kimi-k2");
    expect(p.name).toBe("kimi-agent");
    expect(p.tokenEstimationProvider).toBe("kimi");
  });
});

// ---------------------------------------------------------------------------
// Session creation — model, yoloMode, env
// ---------------------------------------------------------------------------

describe("Session creation options", () => {
  test("omits model when no apiKey (managed plan → CLI default_model); sets yoloMode:false, thinking:false", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], undefined);
    const opts = lastSessionOptions();
    // On the managed kimi-code plan the catalog id won't match the CLI's
    // configured model, so the provider omits it and lets the CLI pick its
    // own default_model. (See client.ts createSession model comment.)
    expect("model" in opts).toBe(false);
    expect(opts.yoloMode).toBe(false);
    expect(opts.thinking).toBe(false);
  });

  test("forwards model to createSession when a MOONSHOT_API_KEY is set (api.moonshot.ai mode)", async () => {
    const p = new KimiAgentProvider("kimi-k2", { apiKey: "mk-test-key" });
    await p.sendMessage([userText("hi")], [], undefined);
    const opts = lastSessionOptions();
    expect(opts.model).toBe("kimi-k2");
  });

  test("passes MOONSHOT_API_KEY env when apiKey option is provided", async () => {
    const p = new KimiAgentProvider("kimi-k2", { apiKey: "mk-test-key" });
    await p.sendMessage([userText("hi")], [], undefined);
    const opts = lastSessionOptions();
    expect((opts.env as Record<string, string>).MOONSHOT_API_KEY).toBe(
      "mk-test-key",
    );
  });

  test("passes empty env when apiKey is not provided", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], undefined);
    const opts = lastSessionOptions();
    expect(opts.env).toEqual({});
  });

  test("passes workDir as process.cwd()", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], undefined);
    const opts = lastSessionOptions();
    expect(opts.workDir).toBe(process.cwd());
  });
});

// ---------------------------------------------------------------------------
// K2.6 mode presets (Instant / Thinking / Agent) — picker "models"
// ---------------------------------------------------------------------------

describe("K2.6 mode presets", () => {
  test("Instant mode → thinking:false", async () => {
    const p = new KimiAgentProvider("kimi-k2.6-instant");
    await p.sendMessage([userText("hi")], [], undefined);
    expect(lastSessionOptions().thinking).toBe(false);
  });

  test("Thinking mode → thinking:true", async () => {
    const p = new KimiAgentProvider("kimi-k2.6-thinking");
    await p.sendMessage([userText("hi")], [], undefined);
    expect(lastSessionOptions().thinking).toBe(true);
  });

  test("fabricated mode id maps to the real model on the API-key path (never the picker id)", async () => {
    const p = new KimiAgentProvider("kimi-k2.6-thinking", {
      apiKey: "mk-test",
    });
    await p.sendMessage([userText("hi")], [], undefined);
    // The invalid Moonshot id "kimi-k2.6-thinking" must NOT reach createSession.
    expect(lastSessionOptions().model).toBe("kimi-k2.6");
  });

  test("Agent mode → thinking:true and an autonomy nudge is appended to the system prompt", async () => {
    let prompt: string | undefined;

    (createSession as any).mockImplementationOnce(() => ({
      prompt: mock(() => {
        const call =
          createSession.mock.calls[createSession.mock.calls.length - 1];

        const opts = (call as any)?.[0] as Record<string, unknown>;
        if (typeof opts?.agentFile === "string") {
          prompt = readFileSync(
            join(dirname(opts.agentFile), "system.md"),
            "utf-8",
          );
        }
        return makeTurn(scriptedEvents);
      }),
      close: mock(async () => {}),
    }));
    const p = new KimiAgentProvider("kimi-k2.6-agent");
    await p.sendMessage([userText("hi")], [], "Base prompt.");
    expect(lastSessionOptions().thinking).toBe(true);
    expect(prompt).toContain("Base prompt.");
    expect(prompt).toContain("Operate autonomously");
  });
});

// ---------------------------------------------------------------------------
// Ambient-MCP suppression via staged shareDir
// ---------------------------------------------------------------------------

describe("staged shareDir (ambient-MCP suppression)", () => {
  test("createSession receives a staged shareDir whose mcp.json is empty and whose entries symlink the real dir", async () => {
    // Fake the real share dir via the env override stageMcpFreeShareDir
    // honors, so the test is hermetic on machines without ~/.kimi.
    const fake = mkdtempSync(join(tmpdir(), "fake-kimi-"));
    writeFileSync(
      join(fake, "config.toml"),
      'default_model = "kimi-code/kimi-for-coding"\n',
    );
    writeFileSync(
      join(fake, "mcp.json"),
      JSON.stringify({ mcpServers: { playwright: { command: "npx" } } }),
    );
    const prevEnv = process.env.KIMI_SHARE_DIR;
    process.env.KIMI_SHARE_DIR = fake;

    // The staged dir lives under the provider's temp dir, which is removed
    // when sendMessage returns — so capture its contents at prompt() time,
    // while the session is alive (same pattern as the system-prompt capture).
    let stagedMcp: string | undefined;
    let configIsSymlink: boolean | undefined;

    (createSession as any).mockImplementationOnce(() => ({
      prompt: mock(() => {
        const call =
          createSession.mock.calls[createSession.mock.calls.length - 1];

        const opts = (call as any)?.[0] as Record<string, unknown>;
        if (typeof opts?.shareDir === "string") {
          stagedMcp = readFileSync(join(opts.shareDir, "mcp.json"), "utf-8");
          configIsSymlink = lstatSync(
            join(opts.shareDir, "config.toml"),
          ).isSymbolicLink();
        }
        return makeTurn(scriptedEvents);
      }),
      close: mock(async () => {}),
    }));

    try {
      const p = new KimiAgentProvider("kimi-k2");
      await p.sendMessage([userText("hi")], [], undefined);
      expect(stagedMcp).toBeDefined();
      expect(JSON.parse(stagedMcp!)).toEqual({ mcpServers: {} });
      expect(configIsSymlink).toBe(true);
    } finally {
      if (prevEnv === undefined) delete process.env.KIMI_SHARE_DIR;
      else process.env.KIMI_SHARE_DIR = prevEnv;
      rmSync(fake, { recursive: true, force: true });
    }
  });

  test("missing real share dir → shareDir omitted from createSession (prior behavior preserved)", async () => {
    const prevEnv = process.env.KIMI_SHARE_DIR;
    process.env.KIMI_SHARE_DIR = join(
      tmpdir(),
      `kimi-nonexistent-${Date.now()}`,
    );
    try {
      const p = new KimiAgentProvider("kimi-k2");
      await p.sendMessage([userText("hi")], [], undefined);
      expect(lastSessionOptions().shareDir).toBeUndefined();
    } finally {
      if (prevEnv === undefined) delete process.env.KIMI_SHARE_DIR;
      else process.env.KIMI_SHARE_DIR = prevEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// External tools / bridge plumbing
// ---------------------------------------------------------------------------

describe("External tools (externalTools) from ToolDefinition", () => {
  test("externalTools built from tools array: name, description, parameters === input_schema", async () => {
    const tools: ToolDefinition[] = [
      {
        name: "my_tool",
        description: "Does stuff",
        input_schema: { type: "object", properties: { x: { type: "string" } } },
      },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined);
    const opts = lastSessionOptions();
    const extTools = opts.externalTools as Array<{
      name: string;
      description: string;
      parameters: unknown;
      handler: (...args: unknown[]) => unknown;
    }>;
    expect(extTools).toHaveLength(1);
    expect(extTools[0].name).toBe("my_tool");
    expect(extTools[0].description).toBe("Does stuff");
    expect(extTools[0].parameters).toBe(tools[0].input_schema); // same reference
    expect(typeof extTools[0].handler).toBe("function");
  });

  test("externalTool handler routes params to bridge and returns { output, message }", async () => {
    const calls: Array<{ toolName: string; input: Record<string, unknown> }> =
      [];
    const bridge: ProviderToolBridge = async ({ toolName, input }) => {
      calls.push({ toolName, input });
      return { content: "bridge result", isError: false };
    };
    const tools: ToolDefinition[] = [
      { name: "echo", description: "e", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
    });
    const opts = lastSessionOptions();
    const extTools = opts.externalTools as Array<{
      name: string;
      handler: (
        params: Record<string, unknown>,
      ) => Promise<{ output: string; message: string }>;
    }>;
    const result = await extTools[0].handler({ key: "val" });
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("echo");
    expect(calls[0].input).toEqual({ key: "val" });
    expect(result.output).toBe("bridge result");
    expect(result.message).toBe("ok");
  });

  test("externalTool handler returns message:'tool error' when bridge reports isError", async () => {
    const bridge: ProviderToolBridge = async () => ({
      content: "something went wrong",
      isError: true,
    });
    const tools: ToolDefinition[] = [
      { name: "bad_tool", description: "b", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
    });
    const opts = lastSessionOptions();
    const extTools = opts.externalTools as Array<{
      handler: (
        params: Record<string, unknown>,
      ) => Promise<{ output: string; message: string }>;
    }>;
    const result = await extTools[0].handler({});
    expect(result.output).toBe("something went wrong");
    expect(result.message).toBe("tool error");
  });

  test("externalTool handler catches bridge throw; returns Bridge error without re-throwing", async () => {
    const bridge: ProviderToolBridge = async () => {
      throw new Error("executor blew up");
    };
    const tools: ToolDefinition[] = [
      { name: "crasher", description: "c", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
    });
    const opts = lastSessionOptions();
    const extTools = opts.externalTools as Array<{
      handler: (
        params: Record<string, unknown>,
      ) => Promise<{ output: string; message: string }>;
    }>;
    // Must not throw.
    const result = await extTools[0].handler({});
    expect(result.output).toContain("Bridge error:");
    expect(result.output).toContain("executor blew up");
    expect(result.message).toBe("executor blew up");
  });

  test("options.toolBridge wins over the registry bridge", async () => {
    const registryCalls: string[] = [];
    const perCallCalls: string[] = [];
    setVellumToolBridge(async () => {
      registryCalls.push("registry");
      return { content: "from registry" };
    });
    const perCall: ProviderToolBridge = async () => {
      perCallCalls.push("per-call");
      return { content: "from per-call" };
    };
    const tools: ToolDefinition[] = [
      { name: "echo", description: "e", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: perCall,
    });
    const opts = lastSessionOptions();
    const extTools = opts.externalTools as Array<{
      handler: (
        params: Record<string, unknown>,
      ) => Promise<{ output: string; message: string }>;
    }>;
    await extTools[0].handler({});
    expect(perCallCalls).toHaveLength(1);
    expect(registryCalls).toHaveLength(0);
  });

  test("falls back to registry bridge when options.toolBridge is unset", async () => {
    const registryCalls: string[] = [];
    setVellumToolBridge(async () => {
      registryCalls.push("registry");
      return { content: "ok" };
    });
    const tools: ToolDefinition[] = [
      { name: "echo", description: "e", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined);
    const opts = lastSessionOptions();
    const extTools = opts.externalTools as Array<{
      handler: (
        params: Record<string, unknown>,
      ) => Promise<{ output: string; message: string }>;
    }>;
    await extTools[0].handler({});
    expect(registryCalls).toHaveLength(1);
  });

  test("falls back to stub bridge when neither per-call nor registry bridge is set", async () => {
    const tools: ToolDefinition[] = [
      { name: "orphan", description: "o", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined);
    const opts = lastSessionOptions();
    const extTools = opts.externalTools as Array<{
      handler: (
        params: Record<string, unknown>,
      ) => Promise<{ output: string; message: string }>;
    }>;
    // The stub should not throw and should return a visible result.
    const result = await extTools[0].handler({});
    expect(typeof result.output).toBe("string");
    expect(result.output.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — tool-call functionality parity
// ---------------------------------------------------------------------------

/** Grab the captured external-tool handler for the first tool. */
function firstHandler() {
  const opts = lastSessionOptions();
  const extTools = opts.externalTools as Array<{
    handler: (
      params: Record<string, unknown>,
    ) => Promise<{ output: string; message: string }>;
  }>;
  return extTools[0].handler;
}

describe("Task 11 — contentBlocks folded into string output", () => {
  test("text content blocks are appended to the output string", async () => {
    const bridge: ProviderToolBridge = async () => ({
      content: "primary",
      contentBlocks: [
        { type: "text", text: "extra one" },
        { type: "text", text: "extra two" },
      ],
    });
    const tools: ToolDefinition[] = [
      { name: "blocky", description: "b", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
    });
    const result = await firstHandler()({});
    expect(result.output).toBe("primary\nextra one\nextra two");
    expect(result.message).toBe("ok");
  });

  // Media bridging (combineBridgeOutput) is unit-tested directly with a live
  // mediaDir: the firstHandler() path can't exercise it because sendMessage
  // cleans up the temp dir before the captured handler is invoked.
  test("file block: extracted_text appended; image/PDF without it saved + referenced via ReadMediaFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-media-"));
    try {
      const out = combineBridgeOutput(
        "filer",
        "doc summary",
        [
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "QUFB",
              filename: "a.pdf",
            },
            extracted_text: "parsed pdf text",
          },
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "QkJC",
              filename: "b.pdf",
            },
          },
        ] as any,
        dir,
      );
      expect(out).toContain("doc summary");
      expect(out).toContain("parsed pdf text"); // a.pdf via extracted_text
      expect(out).toContain("file_read"); // b.pdf referenced, not dropped
      expect(out).toContain("b.pdf");
      expect(out).toMatch(/tool-media-[\w-]+\.pdf/);
      expect(out).not.toContain("QkJC"); // raw base64 never inlined
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("image block saved to mediaDir + referenced via ReadMediaFile (multimodal bridge)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-media-"));
    try {
      const out = combineBridgeOutput(
        "shot",
        "screenshot taken",

        [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ] as any,
        dir,
      );
      expect(out).toContain("screenshot taken");
      expect(out).toContain("file_read");
      expect(out).toContain("image/png");
      const m = out.match(/tool-media-[\w-]+\.png/);
      expect(m).not.toBeNull();
      expect(existsSync(join(dir, m![0]))).toBe(true); // file actually written
      expect(out).not.toContain("iVBORw0KGgo="); // raw base64 not inlined
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mediaRefsOut: media references are collected separately, not folded into the return", () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-media-"));
    try {
      const refs: string[] = [];
      const out = combineBridgeOutput(
        "shot",
        "screenshot taken",

        [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ] as any,
        dir,
        refs,
      );
      expect(out).toBe("screenshot taken"); // ref NOT folded in
      expect(refs).toHaveLength(1);
      expect(refs[0]).toContain("file_read");
      expect(refs[0]).toMatch(/tool-media-[\w-]+\.png/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("assembleHandlerOutput: truncation cannot cut off the media pointer (refs appended AFTER truncation)", () => {
    const big = "x".repeat(5000);
    const ref =
      "[This tool returned image/png content, saved to /tmp/t.png. You MUST call the file_read tool with this exact path to view it.]";
    const out = assembleHandlerOutput(big, [ref], 100);
    expect(out.length).toBeLessThan(big.length + ref.length + 10);
    expect(out).toContain(ref); // pointer survives even when content is truncated
  });

  test("assembleHandlerOutput: no refs and within budget passes through unchanged", () => {
    expect(assembleHandlerOutput("short", [], 100)).toBe("short");
    expect(assembleHandlerOutput("short", [], undefined)).toBe("short");
  });

  test("image block with no mediaDir falls back to a drop (string-only handler)", () => {
    const out = combineBridgeOutput(
      "shot",
      "screenshot taken",

      [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgo=",
          },
        },
      ] as any,
      undefined,
    );
    expect(out).toBe("screenshot taken");
  });

  test("empty primary content with text blocks yields just the joined blocks", async () => {
    const bridge: ProviderToolBridge = async () => ({
      content: "",
      contentBlocks: [{ type: "text", text: "only block" }],
    });
    const tools: ToolDefinition[] = [
      { name: "noprim", description: "n", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
    });
    const result = await firstHandler()({});
    expect(result.output).toBe("only block");
  });
});

describe("Task 13 — yieldToUser aborts the turn", () => {
  test("a tool result with yieldToUser:true schedules turn.interrupt()", async () => {
    const bridge: ProviderToolBridge = async () => ({
      content: "done, yielding",
      yieldToUser: true,
    });
    const tools: ToolDefinition[] = [
      { name: "yielder", description: "y", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
    });
    const turn = lastTurn();
    const before = turn.interrupt.mock.calls.length;
    await firstHandler()({});
    // interrupt is scheduled via setImmediate — drain the macrotask queue.
    await new Promise((r) => setImmediate(r));
    expect(turn.interrupt.mock.calls.length).toBeGreaterThan(before);
  });

  test("a tool result WITHOUT yieldToUser does not interrupt the turn", async () => {
    const bridge: ProviderToolBridge = async () => ({ content: "ok" });
    const tools: ToolDefinition[] = [
      { name: "noyield", description: "n", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
    });
    const turn = lastTurn();
    const before = turn.interrupt.mock.calls.length;
    await firstHandler()({});
    await new Promise((r) => setImmediate(r));
    expect(turn.interrupt.mock.calls.length).toBe(before);
  });
});

describe("Task 14 — maxToolResultChars truncation", () => {
  test("oversized output is truncated to the budget", async () => {
    const big = "x".repeat(5000);
    const bridge: ProviderToolBridge = async () => ({ content: big });
    const tools: ToolDefinition[] = [
      { name: "huge", description: "h", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
      maxToolResultChars: 100,
    });
    const result = await firstHandler()({});
    expect(result.output.length).toBeLessThan(big.length);
  });

  test("within-budget output passes through unchanged", async () => {
    const bridge: ProviderToolBridge = async () => ({ content: "short" });
    const tools: ToolDefinition[] = [
      { name: "tiny", description: "t", input_schema: { type: "object" } },
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
      maxToolResultChars: 100,
    });
    const result = await firstHandler()({});
    expect(result.output).toBe("short");
  });
});

describe("Task 15 — onChunk forwarding + tool_use_id correlation", () => {
  test("bridge onChunk is forwarded as tool_output_chunk with the correlated id", async () => {
    const bridge: ProviderToolBridge = async ({ onChunk }) => {
      onChunk?.("partial-1");
      onChunk?.("partial-2");
      return { content: "final" };
    };
    const tools: ToolDefinition[] = [
      { name: "echo", description: "e", input_schema: { type: "object" } },
    ];
    // Script a ToolCall event so the loop records the SDK id "sdk-call-7"
    // for tool "echo" before the handler runs.
    scriptedEvents = [
      {
        type: "ToolCall",
        payload: {
          id: "sdk-call-7",
          function: { name: "echo", arguments: JSON.stringify({ k: "v" }) },
        },
      },
      TURN_END,
    ];
    const seen: ProviderEvent[] = [];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
      onEvent: (e) => seen.push(e),
    });

    // The loop emitted preview/committed events carrying the SDK id.
    const preview = seen.find((e) => e.type === "tool_use_preview_start") as
      | { type: "tool_use_preview_start"; toolUseId: string; toolName: string }
      | undefined;
    expect(preview?.toolUseId).toBe("sdk-call-7");
    expect(preview?.toolName).toBe("echo");
    const committed = seen.find((e) => e.type === "bridged_tool_committed") as
      | {
          type: "bridged_tool_committed";
          toolUseId: string;
          input: Record<string, unknown>;
        }
      | undefined;
    expect(committed?.toolUseId).toBe("sdk-call-7");
    expect(committed?.input).toEqual({ k: "v" });

    // Now drive the handler — its chunk/result events must carry the same id.
    await firstHandler()({ k: "v" });
    const chunks = seen.filter((e) => e.type === "tool_output_chunk") as Array<{
      type: "tool_output_chunk";
      toolUseId: string;
      chunk: string;
    }>;
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.toolUseId === "sdk-call-7")).toBe(true);
    expect(chunks.map((c) => c.chunk)).toEqual(["partial-1", "partial-2"]);

    const resultEvt = seen.find((e) => e.type === "bridged_tool_result") as
      | {
          type: "bridged_tool_result";
          toolUseId: string;
          content: string;
          isError: boolean;
        }
      | undefined;
    expect(resultEvt?.toolUseId).toBe("sdk-call-7");
    expect(resultEvt?.content).toBe("final");
    expect(resultEvt?.isError).toBe(false);
  });

  test("handler mints a synthetic id when no ToolCall event preceded it", async () => {
    const bridge: ProviderToolBridge = async ({ onChunk }) => {
      onChunk?.("c");
      return { content: "x" };
    };
    const tools: ToolDefinition[] = [
      { name: "echo", description: "e", input_schema: { type: "object" } },
    ];
    scriptedEvents = [TURN_END]; // no ToolCall event
    const seen: ProviderEvent[] = [];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined, {
      toolBridge: bridge,
      onEvent: (e) => seen.push(e),
    });
    await firstHandler()({});
    const chunk = seen.find((e) => e.type === "tool_output_chunk") as
      | { type: "tool_output_chunk"; toolUseId: string }
      | undefined;
    expect(chunk?.toolUseId).toMatch(/^kimi-bridge-/);
  });
});

// ---------------------------------------------------------------------------
// systemPrompt → agentFile temp file
// ---------------------------------------------------------------------------

describe("systemPrompt → agentFile", () => {
  test("when systemPrompt is set, agentFile is passed to createSession", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], "You are a helpful assistant.");
    const opts = lastSessionOptions();
    expect(typeof opts.agentFile).toBe("string");
    expect((opts.agentFile as string).length).toBeGreaterThan(0);
  });

  test("agentFile is a restrictive agent.yaml; the systemPrompt lives in a sibling system.md", async () => {
    let capturedSpec: string | undefined;
    let capturedPrompt: string | undefined;
    // Use a plain function cast to avoid fighting bun's mock type for the
    // implementation arg — we only care that the runtime behaviour is correct.

    (createSession as any).mockImplementationOnce(() => {
      // Capture the options passed to this mock via the shared spy's call list.
      // We return a session whose `prompt` reads the spec + prompt before cleanup.
      return {
        prompt: mock(() => {
          // The most-recent createSession call holds the opts we want.
          const call =
            createSession.mock.calls[createSession.mock.calls.length - 1];

          const opts = (call as any)?.[0] as Record<string, unknown>;
          if (typeof opts?.agentFile === "string") {
            capturedSpec = readFileSync(opts.agentFile, "utf-8");
            capturedPrompt = readFileSync(
              join(dirname(opts.agentFile), "system.md"),
              "utf-8",
            );
          }
          return makeTurn(scriptedEvents);
        }),
        close: mock(async () => {}),
      };
    });
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], "You are pyxis.");
    // The agentFile is the YAML spec, NOT the raw prompt.
    expect(capturedSpec).toContain("system_prompt_path: ./system.md");
    // Vellum-native posture + ONLY kimi's free SearchWeb enabled natively;
    // write/exec and FetchURL excluded (those route through Vellum / stay off).
    expect(capturedSpec).toContain("kimi_cli.tools.web:SearchWeb");
    expect(capturedSpec).not.toContain("Shell");
    expect(capturedSpec).not.toContain("FetchURL");
    expect(capturedSpec).toContain("subagents: {}");
    // The prompt content lives in system.md, wrapped for Jinja safety.
    expect(capturedPrompt).toContain("You are pyxis.");
    expect(capturedPrompt).toContain("{% raw %}");
  });

  test("agentFile is ALWAYS passed (even with no systemPrompt) so kimi-cli never falls back to its ungated default agent", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], undefined);
    const opts = lastSessionOptions();
    expect(typeof opts.agentFile).toBe("string");
    expect((opts.agentFile as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ApprovalRequest — allowlist-based approve/reject (isolation gate)
//
// The SDK's ApprovalRequest payload shape (from schema.cjs:319-332):
//   id:          request ID (used when responding)
//   tool_call_id: associated tool call ID
//   sender:      tool name, e.g. "Shell", "WriteFile"   ← THE TOOL NAME
//   action:      action description, e.g. "run shell command"  ← description only
//   description: detailed description
//
// The gate MUST key off `sender` (the tool name), not `action` (description).
// ---------------------------------------------------------------------------

describe("ApprovalRequest isolation (allowlist)", () => {
  test("non-allowlisted sender (e.g. 'Shell') causes turn.approve to be called with 'reject'", async () => {
    const tools: ToolDefinition[] = [
      { name: "my_tool", description: "t", input_schema: { type: "object" } },
    ];
    scriptedEvents = [
      {
        type: "ApprovalRequest",
        payload: {
          id: "req-1",
          tool_call_id: "t1",
          sender: "Shell",
          action: "run shell command",
          description: "Run command `rm -rf /`",
        },
      },
      TURN_END,
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined);
    const turn = lastTurn();
    expect(turn.approve.mock.calls.length).toBeGreaterThan(0);
    const approveCalls = turn.approve.mock.calls as unknown as Array<
      [string, string]
    >;
    // Shell is NOT in the allowlist — must be rejected.
    const req = approveCalls.find((c) => c[0] === "req-1");
    expect(req?.[1]).toBe("reject");
  });

  test("allowlisted sender causes turn.approve to be called with 'approve'", async () => {
    const tools: ToolDefinition[] = [
      { name: "my_tool", description: "t", input_schema: { type: "object" } },
    ];
    scriptedEvents = [
      {
        type: "ApprovalRequest",
        payload: {
          id: "req-2",
          tool_call_id: "t2",
          sender: "my_tool",
          action: "invoke Vellum tool",
          description: "Calling registered Vellum tool my_tool",
        },
      },
      TURN_END,
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], tools, undefined);
    const turn = lastTurn();
    const approveCalls = turn.approve.mock.calls as unknown as Array<
      [string, string]
    >;
    // my_tool IS in the allowlist — must be approved.
    const req = approveCalls.find((c) => c[0] === "req-2");
    expect(req?.[1]).toBe("approve");
  });
});

// ---------------------------------------------------------------------------
// Denial recovery — a turn that ends with NO text after ≥1 approval denial
// must synthesize explanatory content instead of returning content: [].
// Otherwise the outer loop persists a silent empty assistant message
// (root-caused 2026-06-05: ambient MCP browser_tabs denials → blank replies).
// ---------------------------------------------------------------------------

describe("Denial recovery text (empty turn after approval denials)", () => {
  test("denied-only turn with no text synthesizes content naming the denied tool + streams text_delta", async () => {
    scriptedEvents = [
      {
        type: "ApprovalRequest",
        payload: {
          id: "req-d1",
          tool_call_id: "t1",
          sender: "browser_tabs",
          action: "list browser tabs",
          description: "List open tabs",
        },
      },
      TURN_END,
    ];
    const seen: ProviderEvent[] = [];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage(
      [userText("list my tabs")],
      [],
      undefined,
      {
        onEvent: (e) => seen.push(e),
      },
    );
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.content).toHaveLength(1);
    const text = (resp.content[0] as { text: string }).text;
    expect(text).toContain("browser_tabs");
    expect(text).toContain("not permitted");
    // The synthesized text must also stream so the UI shows it live.
    const textDeltas = seen.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(
      textDeltas.map((e) => (e as { text: string }).text).join(""),
    ).toContain("browser_tabs");
  });

  test("no synthesis when the model already produced text after a denial", async () => {
    scriptedEvents = [
      {
        type: "ApprovalRequest",
        payload: {
          id: "req-d2",
          tool_call_id: "t1",
          sender: "browser_tabs",
          action: "a",
          description: "d",
        },
      },
      {
        type: "ContentPart",
        payload: { type: "text", text: "I could not access your tabs." },
      },
      TURN_END,
    ];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    expect(resp.content).toEqual([
      { type: "text", text: "I could not access your tabs." },
    ]);
  });

  test("repeated denials of the same tool are named once; distinct tools all named", async () => {
    const deny = (id: string, sender: string) => ({
      type: "ApprovalRequest",
      payload: { id, tool_call_id: id, sender, action: "a", description: "d" },
    });
    scriptedEvents = [
      deny("req-1", "browser_navigate"),
      deny("req-2", "browser_navigate"),
      deny("req-3", "browser_tabs"),
      TURN_END,
    ];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    const text = (resp.content[0] as { text: string }).text;
    expect(text).toContain("browser_tabs");
    expect(text.split("browser_navigate").length - 1).toBe(1);
  });

  test("approved (allowlisted) senders do not trigger synthesis", async () => {
    const tools: ToolDefinition[] = [
      { name: "my_tool", description: "t", input_schema: { type: "object" } },
    ];
    scriptedEvents = [
      {
        type: "ApprovalRequest",
        payload: {
          id: "req-ok",
          tool_call_id: "t1",
          sender: "my_tool",
          action: "a",
          description: "d",
        },
      },
      TURN_END,
    ];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], tools, undefined);
    expect(resp.content).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// max_turns note — an interrupted turn must tell the user it was cut off
// instead of silently dumping accumulated text (or nothing at all).
// ---------------------------------------------------------------------------

describe("max_turns step-limit note", () => {
  const steps = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: "StepBegin",
      payload: { n: i + 1 },
    }));

  test("max-turns interrupt appends a step-limit note to accumulated text", async () => {
    scriptedEvents = [
      { type: "ContentPart", payload: { type: "text", text: "partial work" } },
      ...steps(81),
      TURN_END,
    ];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    expect(resp.stopReason).toBe("max_turns");
    expect(resp.content).toHaveLength(1);
    const text = (resp.content[0] as { text: string }).text;
    expect(text).toContain("partial work");
    expect(text).toContain("80-step limit");
    expect(text).toContain("continue");
  });

  test("max-turns interrupt with NO accumulated text yields the note alone (never empty content)", async () => {
    scriptedEvents = [...steps(81), TURN_END];
    const seen: ProviderEvent[] = [];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined, {
      onEvent: (e) => seen.push(e),
    });
    expect(resp.stopReason).toBe("max_turns");
    expect(resp.content).toHaveLength(1);
    const text = (resp.content[0] as { text: string }).text;
    expect(text).toContain("80-step limit");
    // Streamed live too.
    const textDeltas = seen.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  test("StepBegin guard honors maxTurnsOverride (not just the mode preset)", async () => {
    scriptedEvents = [...steps(6), TURN_END];
    const p = new KimiAgentProvider("kimi-k2", { maxTurnsOverride: 5 });
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    const turn = lastTurn();
    expect(turn.interrupt.mock.calls.length).toBeGreaterThan(0);
    expect(resp.stopReason).toBe("max_turns");
    expect((resp.content[0] as { text: string }).text).toContain(
      "5-step limit",
    );
  });

  test("denial + max-turns on the same turn → denial text first, then the step-limit note", async () => {
    // Both synthesis branches mutate the same finalText in sequence:
    // denial recovery runs first (fires only when no text accumulated),
    // then the max_turns note appends. Pin the order.
    scriptedEvents = [
      {
        type: "ApprovalRequest",
        payload: {
          id: "req-both",
          tool_call_id: "t1",
          sender: "browser_tabs",
          action: "a",
          description: "d",
        },
      },
      ...steps(81),
      TURN_END,
    ];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    expect(resp.stopReason).toBe("max_turns");
    const text = (resp.content[0] as { text: string }).text;
    expect(text).toContain("browser_tabs");
    expect(text).toContain("80-step limit");
    expect(text.indexOf("browser_tabs")).toBeLessThan(
      text.indexOf("80-step limit"),
    );
  });

  test("agent mode raises the cap to 95: interrupts at step 96, not at 81", async () => {
    scriptedEvents = [...steps(96), TURN_END];
    const p = new KimiAgentProvider("kimi-k2.6-agent");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    expect(resp.stopReason).toBe("max_turns");
    expect((resp.content[0] as { text: string }).text).toContain(
      "95-step limit",
    );
  });

  test("agent mode does NOT interrupt at 81 steps (instant cap does not apply)", async () => {
    scriptedEvents = [...steps(81), TURN_END];
    const p = new KimiAgentProvider("kimi-k2.6-agent");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    expect(resp.stopReason).toBe("end_turn");
  });
});

// ---------------------------------------------------------------------------
// Empty-turn nudge capability flag
// ---------------------------------------------------------------------------

describe("supportsEmptyTurnNudge capability", () => {
  test("kimi-agent does NOT declare nudge support until session continuity ships", () => {
    // client.ts only resumes the inner session when
    // `options.conversationKey` is set — and nothing in the daemon's send
    // path sets it today (session-continuity plumbing is a planned,
    // unshipped feature). Until then a nudge retry would hit a FRESH inner
    // session, re-running the tool loop — the same re-execution risk that
    // keeps the gate closed for claude-subscription. Flip this (and the
    // provider flag) when conversationKey plumbing lands.
    const p: Provider = new KimiAgentProvider("kimi-k2");
    expect(p.supportsEmptyTurnNudge ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// QuestionRequest — auto-responded with empty answers
// ---------------------------------------------------------------------------

describe("QuestionRequest auto-response", () => {
  test("QuestionRequest is auto-answered with respondQuestion so loop does not hang", async () => {
    scriptedEvents = [
      {
        type: "QuestionRequest",
        payload: {
          id: "qr-1",
          tool_call_id: "tc-q",
          questions: [{ question: "continue?", options: [{ label: "yes" }] }],
        },
      },
      TURN_END,
    ];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], undefined);
    const turn = lastTurn();
    expect(turn.respondQuestion.mock.calls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// StatusUpdate — token usage aggregation
// ---------------------------------------------------------------------------

describe("StatusUpdate token usage aggregation", () => {
  test("input/output tokens are aggregated from StatusUpdate token_usage", async () => {
    scriptedEvents = [
      {
        type: "StatusUpdate",
        payload: {
          token_usage: {
            input_other: 100,
            output: 50,
            input_cache_read: 30,
            input_cache_creation: 20,
          },
        },
      },
      TURN_END,
    ];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    // inputTokens = input_other + input_cache_read + input_cache_creation
    expect(resp.usage.inputTokens).toBe(100 + 30 + 20);
    expect(resp.usage.outputTokens).toBe(50);
    expect(resp.usage.cacheReadInputTokens).toBe(30);
    expect(resp.usage.cacheCreationInputTokens).toBe(20);
  });

  test("multi-step turns SUM per-step StatusUpdates (kimi emits one per kosong step, not cumulative)", async () => {
    // kimi-cli emits StatusUpdate(token_usage=result.usage) once per LLM
    // step (kimisoul.py — each step is a separately-billed API call), so a
    // multi-step turn must accumulate, not last-write-win.
    scriptedEvents = [
      {
        type: "StatusUpdate",
        payload: {
          token_usage: {
            input_other: 100,
            output: 50,
            input_cache_read: 30,
            input_cache_creation: 20,
          },
        },
      },
      {
        type: "StatusUpdate",
        payload: {
          token_usage: {
            input_other: 10,
            output: 5,
            input_cache_read: 200,
            input_cache_creation: 0,
          },
        },
      },
      TURN_END,
    ];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    expect(resp.usage.inputTokens).toBe(150 + 210);
    expect(resp.usage.outputTokens).toBe(55);
    expect(resp.usage.cacheReadInputTokens).toBe(230);
    expect(resp.usage.cacheCreationInputTokens).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// StepBegin > MAX_TURNS → interrupt + stopReason
// ---------------------------------------------------------------------------

describe("StepBegin MAX_TURNS guard", () => {
  test("more than 80 StepBegin events causes turn.interrupt() and stopReason='max_turns'", async () => {
    // Build 81 StepBegin events (n = 1 .. 81) then a TurnEnd.
    const steps = Array.from({ length: 81 }, (_, i) => ({
      type: "StepBegin",
      payload: { n: i + 1 },
    }));
    scriptedEvents = [...steps, TURN_END];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    const turn = lastTurn();
    expect(turn.interrupt.mock.calls.length).toBeGreaterThan(0);
    expect(resp.stopReason).toBe("max_turns");
  });

  test("exactly 80 StepBegin events do NOT trigger interrupt", async () => {
    const steps = Array.from({ length: 80 }, (_, i) => ({
      type: "StepBegin",
      payload: { n: i + 1 },
    }));
    scriptedEvents = [...steps, TURN_END];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    const turn = lastTurn();
    expect(turn.interrupt.mock.calls.length).toBe(0);
    expect(resp.stopReason).toBe("end_turn");
  });
});

// ---------------------------------------------------------------------------
// Abort propagation
// ---------------------------------------------------------------------------

describe("Abort propagation", () => {
  test("pre-aborted signal: turn.interrupt() is called immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], undefined, {
      signal: controller.signal,
    });
    const turn = lastTurn();
    expect(turn.interrupt.mock.calls.length).toBeGreaterThan(0);
  });

  test("signal aborted mid-call: turn.interrupt() is eventually called", async () => {
    const controller = new AbortController();
    // Abort after a tick so the listener has been registered.
    setImmediate(() => controller.abort());
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], undefined, {
      signal: controller.signal,
    });
    // Let microtasks drain.
    await new Promise((r) => setImmediate(r));
    const turn = lastTurn();
    // Interrupt should have been called at least once.
    expect(turn.interrupt.mock.calls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ContentPart text → text_delta
// ---------------------------------------------------------------------------

describe("ContentPart streaming", () => {
  test("text ContentPart emits text_delta events and builds content in response", async () => {
    scriptedEvents = [
      { type: "ContentPart", payload: { type: "text", text: "Hello " } },
      { type: "ContentPart", payload: { type: "text", text: "world" } },
      TURN_END,
    ];
    const seen: ProviderEvent[] = [];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined, {
      onEvent: (e) => seen.push(e),
    });
    const textDeltas = seen.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { text: string }).text).toBe("Hello ");
    expect((textDeltas[1] as { text: string }).text).toBe("world");
    expect(resp.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("think ContentPart emits thinking_delta events", async () => {
    scriptedEvents = [
      {
        type: "ContentPart",
        payload: { type: "think", think: "reasoning..." },
      },
      TURN_END,
    ];
    const seen: ProviderEvent[] = [];
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], undefined, {
      onEvent: (e) => seen.push(e),
    });
    const thinkDeltas = seen.filter((e) => e.type === "thinking_delta");
    expect(thinkDeltas).toHaveLength(1);
    expect((thinkDeltas[0] as { thinking: string }).thinking).toBe(
      "reasoning...",
    );
  });

  test("empty events list → empty content and end_turn stopReason", async () => {
    scriptedEvents = [TURN_END];
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    expect(resp.content).toEqual([]);
    expect(resp.stopReason).toBe("end_turn");
  });
});

// ---------------------------------------------------------------------------
// Message flattening
// ---------------------------------------------------------------------------

describe("Message flattening (flattenForSdk)", () => {
  test("single user message: prompt is just the text", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hello kimi")], [], undefined);
    const session = createSession.mock.results[
      createSession.mock.results.length - 1
    ]?.value as {
      prompt: ReturnType<typeof mock>;
    };
    const promptArg = session.prompt.mock.calls[0]?.[0] as string;
    expect(promptArg).toBe("hello kimi");
  });

  test("multi-turn history: prompt includes Prior conversation header", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage(
      [
        userText("first"),
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        userText("second"),
      ],
      [],
      undefined,
    );
    const session = createSession.mock.results[
      createSession.mock.results.length - 1
    ]?.value as {
      prompt: ReturnType<typeof mock>;
    };
    const promptArg = session.prompt.mock.calls[0]?.[0] as string;
    expect(promptArg).toContain("# Prior conversation");
    expect(promptArg).toContain("first");
    expect(promptArg).toContain("reply");
    expect(promptArg).toContain("# Current user message");
    expect(promptArg).toContain("second");
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — Multi-turn fidelity: native ContentPart[] prompt input.
//
// `prompt()` accepts `string | ContentPart[]`. When the message history
// carries media (images in messages or in prior-turn tool results), the
// provider passes a ContentPart[] so the media reaches the model — rather
// than dropping it as the flattened-string path does. The text-only path
// still returns a plain string (asserted above).
// ---------------------------------------------------------------------------

type AnyPart = {
  type: string;
  text?: string;
  image_url?: { url: string };
  audio_url?: { url: string };
  video_url?: { url: string };
};

const imageBlock = (mediaType: string, data: string) => ({
  type: "image" as const,
  source: { type: "base64" as const, media_type: mediaType, data },
});

describe("Multi-turn fidelity (native ContentPart[])", () => {
  test("user message with an image → prompt is a ContentPart[] with a text and image_url part", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this picture?" },
            imageBlock("image/png", "AAAApng"),
          ],
        },
      ],
      [],
      undefined,
    );
    const session = createSession.mock.results[
      createSession.mock.results.length - 1
    ]?.value as {
      prompt: ReturnType<typeof mock>;
    };
    const promptArg = session.prompt.mock.calls[0]?.[0] as AnyPart[];
    expect(Array.isArray(promptArg)).toBe(true);
    const textParts = promptArg.filter((x) => x.type === "text");
    const imageParts = promptArg.filter((x) => x.type === "image_url");
    expect(textParts[0]?.text).toContain("what is in this picture?");
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]?.image_url?.url).toBe("data:image/png;base64,AAAApng");
  });

  test("prior-turn image passes through (not dropped)", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            imageBlock("image/jpeg", "JJJ"),
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "a cat" }] },
        { role: "user", content: [{ type: "text", text: "and now?" }] },
      ],
      [],
      undefined,
    );
    const session = createSession.mock.results[
      createSession.mock.results.length - 1
    ]?.value as {
      prompt: ReturnType<typeof mock>;
    };
    const promptArg = session.prompt.mock.calls[0]?.[0] as AnyPart[];
    expect(Array.isArray(promptArg)).toBe(true);
    const imageParts = promptArg.filter((x) => x.type === "image_url");
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]?.image_url?.url).toBe("data:image/jpeg;base64,JJJ");
    // The text part still preserves the conversational structure.
    const text = (promptArg.find((x) => x.type === "text") as AnyPart).text!;
    expect(text).toContain("# Prior conversation");
    expect(text).toContain("and now?");
  });

  test("image inside a prior tool_result contentBlock passes through", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage(
      [
        {
          role: "user",
          content: [{ type: "text", text: "screenshot the page" }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "screenshot captured",
              contentBlocks: [imageBlock("image/png", "SHOT")],
            },
          ],
        },
      ],
      [],
      undefined,
    );
    const session = createSession.mock.results[
      createSession.mock.results.length - 1
    ]?.value as {
      prompt: ReturnType<typeof mock>;
    };
    const promptArg = session.prompt.mock.calls[0]?.[0] as AnyPart[];
    const imageParts = promptArg.filter((x) => x.type === "image_url");
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]?.image_url?.url).toBe("data:image/png;base64,SHOT");
  });

  test("audio and video file blocks map to audio_url / video_url", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "transcribe these" },
            {
              type: "file",
              source: {
                type: "base64",
                media_type: "audio/mp3",
                data: "AUD",
                filename: "a.mp3",
              },
            },
            {
              type: "file",
              source: {
                type: "base64",
                media_type: "video/mp4",
                data: "VID",
                filename: "v.mp4",
              },
            },
          ],
        },
      ],
      [],
      undefined,
    );
    const session = createSession.mock.results[
      createSession.mock.results.length - 1
    ]?.value as {
      prompt: ReturnType<typeof mock>;
    };
    const promptArg = session.prompt.mock.calls[0]?.[0] as AnyPart[];
    const audio = promptArg.filter((x) => x.type === "audio_url");
    const video = promptArg.filter((x) => x.type === "video_url");
    expect(audio[0]?.audio_url?.url).toBe("data:audio/mp3;base64,AUD");
    expect(video[0]?.video_url?.url).toBe("data:video/mp4;base64,VID");
  });

  test("text-only history still passes a plain string (no array wrapping)", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("just text")], [], undefined);
    const session = createSession.mock.results[
      createSession.mock.results.length - 1
    ]?.value as {
      prompt: ReturnType<typeof mock>;
    };
    const promptArg = session.prompt.mock.calls[0]?.[0];
    expect(typeof promptArg).toBe("string");
    expect(promptArg).toBe("just text");
  });
});

// ---------------------------------------------------------------------------
// Model passthrough
// ---------------------------------------------------------------------------

describe("Model in response", () => {
  test("response.model matches the constructor model", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    const resp = await p.sendMessage([userText("hi")], [], undefined);
    expect(resp.model).toBe("kimi-k2");
  });
});

// ---------------------------------------------------------------------------
// M2: agentFile temp dir cleanup
// ---------------------------------------------------------------------------

describe("agentFile temp dir cleanup", () => {
  test("temp dir is removed after sendMessage resolves", async () => {
    let capturedAgentFile: string | undefined;

    (createSession as any).mockImplementationOnce(() => {
      return {
        prompt: mock(() => {
          const call =
            createSession.mock.calls[createSession.mock.calls.length - 1];

          const opts = (call as any)?.[0] as Record<string, unknown>;
          if (typeof opts?.agentFile === "string") {
            capturedAgentFile = opts.agentFile;
          }
          return makeTurn(scriptedEvents);
        }),
        close: mock(async () => {}),
      };
    });

    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], "system prompt for cleanup test");

    expect(capturedAgentFile).toBeDefined();
    const tmpDir = dirname(capturedAgentFile!);
    // After sendMessage resolves, the temp dir must be gone.
    expect(existsSync(tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M2: executable branch — createSession receives the resolved kimi CLI path
// ---------------------------------------------------------------------------

describe("executable branch (CLI path resolution)", () => {
  test("createSession receives the resolved kimi CLI path as executable", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], undefined);
    const opts = lastSessionOptions();
    // The child_process mock at the top of this file makes `which kimi` return
    // FAKE_KIMI_PATH — the provider should forward that as `executable`.
    expect(opts.executable).toBe(FAKE_KIMI_PATH);
  });
});

// ---------------------------------------------------------------------------
// M2: session.close() is called once per sendMessage
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  test("session.close() is called exactly once per sendMessage", async () => {
    const p = new KimiAgentProvider("kimi-k2");
    await p.sendMessage([userText("hi")], [], undefined);
    const session = createSession.mock.results[
      createSession.mock.results.length - 1
    ]?.value as {
      close: ReturnType<typeof mock>;
    };
    expect(session.close.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// M1: streamTimeoutMs — wall-clock guard fires interrupt() when stream hangs
// ---------------------------------------------------------------------------

describe("streamTimeoutMs wall-clock guard", () => {
  test("when the stream never ends, the timeout fires interrupt()", async () => {
    // Build a turn whose async iterator never yields TurnEnd — it stays open
    // until interrupt() is called, after which it yields TurnEnd and exits.
    let interruptCalled = false;
    let resolveInterrupt: () => void;
    const interruptPromise = new Promise<void>((r) => {
      resolveInterrupt = r;
    });

    (createSession as any).mockImplementationOnce(() => {
      const turn = {
        approve: mock(async () => {}),
        interrupt: mock(async () => {
          interruptCalled = true;
          resolveInterrupt();
        }),
        respondQuestion: mock(async () => {}),
        result: Promise.resolve({ status: "finished" as const }),
        async *[Symbol.asyncIterator]() {
          // Block until interrupt() is called, then emit TurnEnd to unblock
          // the for-await in the provider.
          await interruptPromise;
          yield { type: "TurnEnd", payload: {} };
        },
      };
      return {
        prompt: mock(() => turn),
        close: mock(async () => {}),
      };
    });

    // Use a very short timeout so the test runs quickly.
    const p = new KimiAgentProvider("kimi-k2", { streamTimeoutMs: 50 });
    await p.sendMessage([userText("hi")], [], undefined);

    expect(interruptCalled).toBe(true);
    const turn = lastTurn();
    expect(turn.interrupt.mock.calls.length).toBeGreaterThan(0);
  });
});
