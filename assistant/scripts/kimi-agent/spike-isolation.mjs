// Phase 0 THROWAWAY probe — verify approval-deny contains built-in tools.
//
// Question: with yoloMode:false and NO external tools, does EVERY built-in
// tool call (bash/write AND read-only read/list) surface an ApprovalRequest
// we can reject? If a tool runs without an approval gate, approval-deny via
// createSession() is insufficient isolation (cf. claude-subscription I-11).
//
// Run: node assistant/scripts/kimi-agent/spike-isolation.mjs
import { createSession } from "@moonshot-ai/kimi-agent-sdk";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROOF = join(tmpdir(), "kimi-isolation-proof.txt");
rmSync(PROOF, { force: true });
const workDir = mkdtempSync(join(tmpdir(), "kimi-spike-iso-"));

const session = createSession({
  workDir,
  yoloMode: false, // never auto-approve
  thinking: false,
  // model omitted -> use the CLI's configured default
  // env omitted -> inherit parent env so ~/.kimi auth resolves
  externalTools: [], // empty allowlist: reject EVERYTHING
});

const turn = session.prompt(
  `Do these two things using your tools, no questions asked:\n` +
    `1. Run the shell command: id > ${PROOF}\n` +
    `2. Read the file /etc/hosts and show me the first line.`,
);

let approvalCount = 0;
let toolCallCount = 0;
const approvedIds = new Set();
// id -> tool name (every ToolCall seen this turn)
const toolCallNames = new Map();
// id -> is_error (the SDK's result after we rejected the approval)
const toolResults = new Map();

// Hard wall-clock cap so a runaway loop can't hang (cf. claude i-19).
const KILL_MS = 90_000;
const killer = setTimeout(() => {
  console.log("TIMEOUT — interrupting turn");
  turn.interrupt().finally(() => process.exit(2));
}, KILL_MS);

try {
  for await (const ev of turn) {
    switch (ev.type) {
      case "ApprovalRequest": {
        approvalCount++;
        approvedIds.add(ev.payload.tool_call_id);
        console.log(
          "APPROVAL_REQUEST",
          JSON.stringify({ action: ev.payload.action, tool_call_id: ev.payload.tool_call_id, description: ev.payload.description }),
        );
        await turn.approve(ev.payload.id, "reject");
        break;
      }
      case "QuestionRequest": {
        // Answer to avoid a hang; pick the first option / empty.
        console.log("QUESTION_REQUEST", JSON.stringify(ev.payload));
        const answers = {};
        for (const q of ev.payload.questions ?? []) answers[q.id ?? "q"] = "no";
        await turn.respondQuestion(ev.payload.id, ev.payload.id, answers);
        break;
      }
      case "ToolCall": {
        toolCallCount++;
        const id = ev.payload?.id;
        const name = ev.payload?.function?.name ?? "<unknown>";
        toolCallNames.set(id, name);
        console.log("TOOL_CALL", JSON.stringify({ id, name }));
        break;
      }
      case "ToolResult": {
        // The authoritative containment signal: after we reject an
        // approval, the SDK must surface the tool result as an error
        // ("rejected by the user") and MUST NOT have executed it. A
        // ToolResult with is_error:false for a tool we never approved =
        // the tool ran despite the deny → isolation breach.
        const id = ev.payload?.tool_call_id;
        const isError = ev.payload?.return_value?.is_error === true;
        toolResults.set(id, isError);
        console.log("TOOL_RESULT", JSON.stringify(ev.payload).slice(0, 200));
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

const leaked = existsSync(PROOF);

// Evaluate containment AFTER the stream completes. The SDK emits events in
// the order ToolCall → ApprovalRequest → (our reject) → ToolResult, so any
// per-event "was this approved yet?" check races the approval. Post-hoc, a
// tool is "ungated" only if it both (a) never produced an ApprovalRequest
// AND (b) returned a non-error result — i.e. it actually executed without a
// gate. A tool whose result is is_error (our rejection) was contained.
const ungatedToolCalls = [];
for (const [id, name] of toolCallNames) {
  const gated = approvedIds.has(id);
  const ranSuccessfully = toolResults.get(id) === false;
  if (!gated && ranSuccessfully) ungatedToolCalls.push({ id, name });
}

console.log("────────────────────────────────────────");
console.log(`approvals=${approvalCount} toolCalls=${toolCallCount} ungatedToolCalls=${ungatedToolCalls.length}`);
if (ungatedToolCalls.length) console.log("UNGATED:", JSON.stringify(ungatedToolCalls));
const contained = !leaked && ungatedToolCalls.length === 0;
console.log(
  `VERDICT: ${contained ? "✅ PASS — every tool gated by approval, no host side effect" : "❌ FAIL — " + (leaked ? "proof file written (host reached)" : "a tool ran without an approval gate")}`,
);
rmSync(PROOF, { force: true });
process.exit(contained ? 0 : 1);
