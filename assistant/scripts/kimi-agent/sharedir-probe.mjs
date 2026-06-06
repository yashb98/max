// Live probe: ambient-MCP suppression via a staged KIMI_SHARE_DIR.
//
// Gates the integration of `stageMcpFreeShareDir` into the provider
// (KIMI_AGENT_ROOT_CAUSE_REPORT.md fix #2). Verifies, against the REAL
// managed kimi-code plan:
//   1. AUTH: a session under the staged share dir authenticates and returns
//      assistant text (OAuth resolves through the symlinked credentials/).
//   2. SUPPRESSION: the ambient browser_* MCP tools are NOT loaded — the
//      model is told to call browser_navigate; with mcp.json empty, NO
//      ApprovalRequest may fire for it (an ApprovalRequest would mean the
//      MCP server was loaded and reached).
//   3. BRIDGE: the Vellum external tool still dispatches.
//   4. NO SIDE EFFECTS: the real ~/.kimi/mcp.json is byte-identical after.
//
// Run:  bun assistant/scripts/kimi-agent/sharedir-probe.mjs
// Requires the `kimi` CLI + managed kimi-code login. Exit 0 = PASS.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "@moonshot-ai/kimi-agent-sdk";

import { writeKimiAgentFiles } from "../../src/providers/kimi-agent/agent-file.ts";
import { stageMcpFreeShareDir } from "../../src/providers/kimi-agent/share-dir.ts";

const realMcpPath = join(homedir(), ".kimi", "mcp.json");
const realMcpBefore = readFileSync(realMcpPath, "utf-8");

const workDir = mkdtempSync(join(tmpdir(), "kimi-sd-"));
const stagingParent = mkdtempSync(join(tmpdir(), "kimi-sd-stage-"));
const { tmpDir: agentDir, agentFile } = writeKimiAgentFiles(
  "You are a test agent.",
);

const staged = stageMcpFreeShareDir(stagingParent, workDir);
if (!staged) {
  console.error("FAIL: stageMcpFreeShareDir returned undefined (no ~/.kimi?)");
  process.exit(1);
}
console.log(`staged share dir: ${staged}`);

let externalFired = false;
const externalTools = [
  {
    name: "vellum_echo",
    description: "Echo back the given text.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    handler: async (params) => {
      externalFired = true;
      return { output: `echo: ${params?.text ?? ""}`, message: "ok" };
    },
  },
];

const session = createSession({
  workDir,
  yoloMode: false,
  thinking: false,
  agentFile,
  externalTools,
  shareDir: staged,
});

const turn = session.prompt(
  `Do BOTH of these, in order, no questions asked:\n` +
    `1. Call the browser_navigate tool with url "https://example.com". If the\n` +
    `   tool does not exist, say exactly TOOL-MISSING and move on.\n` +
    `2. You MUST invoke the vellum_echo TOOL with text "done" — actually call\n` +
    `   the tool; writing the word done as plain text does NOT count.`,
);

const approvalSenders = [];
const toolCallNames = [];
let assistantText = "";
let steps = 0;

const timeout = setTimeout(() => {
  console.error("FAIL: probe timed out after 180s");
  process.exit(1);
}, 180_000);

try {
  for await (const ev of turn) {
    const { type, payload } = ev;
    if (type === "ApprovalRequest") {
      approvalSenders.push(payload?.sender);
      // Deny anything that asks (mirrors the provider) — but seeing browser_*
      // here AT ALL means suppression failed.
      await turn.approve(payload.id, "reject");
    } else if (type === "ToolCall") {
      toolCallNames.push(payload?.function?.name);
    } else if (type === "ContentPart" && payload?.type === "text") {
      assistantText += payload.text;
    } else if (type === "StepBegin") {
      steps++;
      if (steps > 15) {
        await turn.interrupt().catch(() => {});
        break;
      }
    }
  }
} finally {
  clearTimeout(timeout);
  await session.close().catch(() => {});
}

const realMcpAfter = readFileSync(realMcpPath, "utf-8");

console.log("--- probe results ---");
console.log(
  `assistant text (${assistantText.length} chars): ${assistantText.slice(0, 300)}`,
);
console.log(`tool calls observed: ${JSON.stringify(toolCallNames)}`);
console.log(`approval senders observed: ${JSON.stringify(approvalSenders)}`);
console.log(`external bridge fired: ${externalFired}`);
console.log(`real mcp.json unchanged: ${realMcpAfter === realMcpBefore}`);

let pass = true;
if (assistantText.length === 0) {
  console.error(
    "FAIL(auth): no assistant text — auth or model resolution broke under staged shareDir",
  );
  pass = false;
}
const browserApprovals = approvalSenders.filter(
  (s) => typeof s === "string" && s.startsWith("browser_"),
);
if (browserApprovals.length > 0) {
  console.error(
    `FAIL(suppression): browser MCP reached approval: ${browserApprovals.join(",")}`,
  );
  pass = false;
}
if (!externalFired) {
  console.error("FAIL(bridge): vellum_echo never dispatched");
  pass = false;
}
if (realMcpAfter !== realMcpBefore) {
  console.error("FAIL(side-effect): real ~/.kimi/mcp.json changed");
  pass = false;
}

rmSync(workDir, { recursive: true, force: true });
rmSync(stagingParent, { recursive: true, force: true });
rmSync(agentDir, { recursive: true, force: true });

console.log(
  pass
    ? "PASS: staged shareDir suppresses ambient MCP with working auth"
    : "PROBE FAILED",
);
process.exit(pass ? 0 : 1);
