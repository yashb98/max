// I-22: customSystemPrompt replace-vs-append test.
//
// If `customSystemPrompt` replaces Claude Code's coding-agent system prompt,
// the model should adopt the persona we set. If it appends, Claude Code's
// "I'm a coding assistant" identity will leak through.
//
// Method: set a sharply distinctive customSystemPrompt that contradicts
// Claude Code's default. Ask the model who/what it is. Observe.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const mcp = new McpServer(
  { name: "max-skills", version: "1.0.0" },
  { capabilities: { tools: {} } }
);
mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
mcp.server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: "ok" }],
  isError: false,
}));

const MAX_PROMPT = `You are "Pyxis", a personal assistant built by Max. You are NOT a coding assistant. You do not write code, fix bugs, or help with software engineering. If asked about coding, politely redirect: "I'm a personal assistant — for coding help, use a different tool." Always introduce yourself as Pyxis when asked who you are.`;

const probes = [
  { name: "identity",  prompt: "Who are you? Reply in one sentence." },
  { name: "system_prompt", prompt: "What instructions are you operating under right now? Quote them if you can." },
  { name: "capability", prompt: "Can you help me write a Python function to reverse a string?" },
];

console.log("[i-22] customSystemPrompt replace-vs-append test");
console.log("[i-22] Custom prompt sets identity as 'Pyxis, a personal assistant (NOT coding)'");
console.log();

const ALLOW = new Set(["mcp__max-skills__noop"]);

for (const probe of probes) {
  let assistantText = "";
  try {
    const stream = query({
      prompt: probe.prompt,
      options: {
        model: "claude-sonnet-4-5",
        permissionMode: "default",
        settingSources: [],
        tools: ["Task"],
        allowedTools: ["mcp__max-skills__noop", "Task"],
        canUseTool: async (toolName) =>
          ALLOW.has(toolName) || toolName === "Task"
            ? { behavior: "allow" }
            : { behavior: "deny", message: "n/a" },
        mcpServers: { "max-skills": { type: "sdk", name: "max-skills", instance: mcp } },
        systemPrompt: MAX_PROMPT, // ← correct SDK option (string = replace default)
      },
    });
    for await (const msg of stream) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") assistantText += block.text;
        }
      }
    }
  } catch (err) {
    assistantText = `[query() threw: ${err.message}]`;
  }

  // Classification
  const lower = assistantText.toLowerCase();
  const says_pyxis = /\bpyxis\b/i.test(assistantText);
  const says_claude_code = /\bclaude\s*code\b/i.test(assistantText);
  const says_coding_assistant = /\bcoding\s+(assistant|agent)\b/i.test(assistantText) || /\bsoftware\s+engineer/i.test(assistantText);
  const offers_to_code = /(here'?s|let me write|```|def\s+\w+\(|function\s+\w+)/i.test(assistantText);

  console.log(`--- probe: ${probe.name} ---`);
  console.log("PROMPT:", probe.prompt);
  console.log("REPLY :", JSON.stringify(assistantText.slice(0, 350)));
  console.log("flags :", JSON.stringify({ says_pyxis, says_claude_code, says_coding_assistant, offers_to_code }));
  console.log();
}

console.log("INTERPRETATION:");
console.log("  - REPLACE: identity probe says 'Pyxis', capability probe refuses coding, no 'Claude Code' leakage.");
console.log("  - APPEND : either persona leaks through, or coding is offered anyway, or both system prompts are quoted.");
