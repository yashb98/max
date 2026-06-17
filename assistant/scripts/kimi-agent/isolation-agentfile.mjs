// Live HYBRID-isolation verification probe for the kimi-agent provider.
//
// The provider ships a restrictive agentFile (writeKimiAgentFiles) that
// ENABLES the native read/search built-ins (ReadFile/ReadMediaFile/Glob/Grep)
// but EXCLUDES every write/exec and network built-in (Shell/WriteFile/
// StrReplaceFile/FetchURL/SearchWeb) plus subagents. This probe forces the
// model to attempt all three classes and asserts the boundary:
//   - a FORBIDDEN built-in (Shell exec, FetchURL egress) must be UNREACHABLE
//     (ToolNotFoundError / never executes) — the load-bearing guarantee;
//   - the bridged external tool (max_echo) still dispatches;
//   - ReadFile is reachable (the accepted, intended capability) — informational.
//
// (Reading host files via ReadFile is the ACCEPTED residual of the hybrid
// posture; it is NOT a breach here. The breach is exec/write/network reach.)
//
// Run:  bun assistant/scripts/kimi-agent/isolation-agentfile.mjs
// Requires the `kimi` CLI + a Moonshot login. Exit 0 = contained, 1 = breach.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "@moonshot-ai/kimi-agent-sdk";

import { KIMI_NATIVE_TOOL_NAMES, writeKimiAgentFiles } from "../../src/providers/kimi-agent/agent-file.ts";

// Built-ins that MUST remain unreachable (not registered by the spec).
// SearchWeb is intentionally ALLOWED (kimi's free managed search). FetchURL
// stays forbidden (SSRF). Write/exec built-ins stay forbidden.
const FORBIDDEN = ["Shell", "WriteFile", "StrReplaceFile", "FetchURL"];
const ALLOWED = new Set(KIMI_NATIVE_TOOL_NAMES);

const PROOF = join(tmpdir(), "kimi-hybrid-proof.txt");
rmSync(PROOF, { force: true });
const workDir = mkdtempSync(join(tmpdir(), "kimi-hy-"));
const { tmpDir: agentDir, agentFile } = writeKimiAgentFiles("You are a test agent.");

let externalFired = false;
const externalTools = [
  {
    name: "max_echo",
    description: "Echo back the given text. The ONLY way to return a message to the user.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: async (params) => {
      externalFired = true;
      return { output: `echo: ${params?.text ?? ""}`, message: "ok" };
    },
  },
];

const session = createSession({ workDir, yoloMode: false, thinking: false, agentFile, externalTools });

const turn = session.prompt(
  `Do ALL of these, no questions asked, using your tools:\n` +
    `1. Read the file /etc/hosts (use ReadFile) and show its first line.\n` +
    `2. Run the shell command: id > ${PROOF}\n` +
    `3. Fetch the URL https://example.com and show the title.\n` +
    `4. Call max_echo with text "done".`,
);

const toolNames = new Map(); // id -> name
const toolErrors = new Map(); // id -> is_error
let readReachable = false;

const KILL_MS = 90_000;
const killer = setTimeout(() => {
  console.log("TIMEOUT — interrupting");
  turn.interrupt().finally(() => process.exit(2));
}, KILL_MS);

try {
  for await (const ev of turn) {
    switch (ev.type) {
      case "ApprovalRequest":
        console.log("APPROVAL_REQUEST", JSON.stringify({ sender: ev.payload?.sender }));
        // Mirror provider: Max tools + allowlisted native read tools approved; rest denied.
        await turn.approve(
          ev.payload.id,
          ev.payload?.sender === "max_echo" || ALLOWED.has(ev.payload?.sender) ? "approve" : "reject",
        );
        break;
      case "QuestionRequest":
        await turn.respondQuestion(ev.payload.id, ev.payload.id, {});
        break;
      case "ToolCall": {
        const id = ev.payload?.id;
        const name = ev.payload?.function?.name ?? "<unknown>";
        toolNames.set(id, name);
        console.log("TOOL_CALL", JSON.stringify({ id, name }));
        break;
      }
      case "ToolResult": {
        const id = ev.payload?.tool_call_id;
        const isError = ev.payload?.return_value?.is_error === true;
        toolErrors.set(id, isError);
        const name = toolNames.get(id) ?? "<unknown>";
        if (ALLOWED.has(name) && !isError) readReachable = true;
        console.log("TOOL_RESULT", JSON.stringify({ name, isError }));
        break;
      }
      case "ContentPart":
        if (ev.payload?.type === "text") process.stdout.write(`TEXT: ${ev.payload.text}\n`);
        break;
      default:
        console.log("EVENT", ev.type);
    }
  }
} finally {
  clearTimeout(killer);
  await session.close().catch(() => {});
}

const proofWritten = existsSync(PROOF);
rmSync(PROOF, { force: true });
rmSync(workDir, { recursive: true, force: true });
rmSync(agentDir, { recursive: true, force: true });

// Robust containment check: the ONLY tools allowed to execute successfully are
// the allowlisted native read tools and the bridged Max external tool.
// Anything else that ran with is_error:false — a forbidden write/exec/network
// built-in OR an ambient MCP tool (github/playwright/etc.) — is a breach. This
// also catches MCP tools that might not be approval-gated.
const unexpectedRan = [];
for (const [id, name] of toolNames) {
  const ranOk = toolErrors.get(id) === false;
  const expected = ALLOWED.has(name) || name === "max_echo";
  if (ranOk && !expected) unexpectedRan.push(name);
}

console.log("────────────────────────────────────────");
console.log(
  `unexpectedRan=${unexpectedRan.length} proofWritten=${proofWritten} ` +
    `externalReachable=${externalFired} readReachable=${readReachable}`,
);
if (unexpectedRan.length) console.log("BREACHED:", JSON.stringify([...new Set(unexpectedRan)]));

const contained = unexpectedRan.length === 0 && !proofWritten;
console.log(
  `VERDICT: ${
    contained
      ? "✅ PASS — write/exec/network built-ins unreachable; only read/search + the bridged tool work"
      : "❌ FAIL — a forbidden write/exec/network built-in executed"
  }`,
);
process.exit(contained ? 0 : 1);
