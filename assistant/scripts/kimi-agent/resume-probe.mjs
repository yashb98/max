// Live probe: cross-call session resume via sessionId + staged shareDir.
//
// Gates the session-continuity integration (Gap D). Verifies against the
// REAL managed kimi-code plan that:
//   1. SEED: session 1 (fresh sessionId) accepts a recall code and answers.
//   2. RESUME: after session.close(), a SECOND createSession with the SAME
//      sessionId + a fresh staged shareDir restores context.jsonl — the
//      model recalls the recall code WITHOUT it being re-sent.
//   3. The staged kimi.json seeding makes Session.find succeed even though
//      each call stages a fresh ephemeral share dir (the CLI's own
//      work_dirs registration died with the previous staged dir).
//
// Run:  bun assistant/scripts/kimi-agent/resume-probe.mjs
// Requires the `kimi` CLI + managed kimi-code login. Exit 0 = PASS.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "@moonshot-ai/kimi-agent-sdk";

import { writeKimiAgentFiles } from "../../src/providers/kimi-agent/agent-file.ts";
import { stageMcpFreeShareDir } from "../../src/providers/kimi-agent/share-dir.ts";

const RECALL_CODE = "MAUVE-HERON-7319";
const SESSION_ID = `vellum-resume-probe-${Date.now().toString(36)}`;
// ONE workDir for both calls — sessions are keyed by md5(workDir).
const workDir = mkdtempSync(join(tmpdir(), "kimi-resume-"));

async function runTurn(promptText, label) {
  const stagingParent = mkdtempSync(
    join(tmpdir(), `kimi-resume-stage-${label}-`),
  );
  const { tmpDir: agentDir, agentFile } = writeKimiAgentFiles(
    "You are a test agent.",
  );
  const staged = stageMcpFreeShareDir(stagingParent, workDir);
  if (!staged) throw new Error("staging failed");
  const session = createSession({
    workDir,
    yoloMode: false,
    thinking: false,
    agentFile,
    externalTools: [],
    shareDir: staged,
    sessionId: SESSION_ID,
  });
  let text = "";
  const timeout = setTimeout(() => {
    console.error(`FAIL: turn ${label} timed out`);
    process.exit(1);
  }, 180_000);
  try {
    const turn = session.prompt(promptText);
    for await (const ev of turn) {
      if (ev.type === "ApprovalRequest") {
        await turn.approve(ev.payload.id, "reject");
      } else if (ev.type === "ContentPart" && ev.payload?.type === "text") {
        text += ev.payload.text;
      }
    }
  } finally {
    clearTimeout(timeout);
    await session.close().catch(() => {});
    rmSync(stagingParent, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
  return text;
}

const t1 = await runTurn(
  `Remember this recall code: ${RECALL_CODE}. Reply with exactly: STORED`,
  "seed",
);
console.log(`turn1 (${t1.length} chars): ${t1.slice(0, 120)}`);

const t2 = await runTurn(
  "What was the recall code I told you earlier in this conversation? Reply with just the code.",
  "resume",
);
console.log(`turn2 (${t2.length} chars): ${t2.slice(0, 200)}`);

rmSync(workDir, { recursive: true, force: true });

if (t2.includes(RECALL_CODE)) {
  console.log(
    "PASS: session resumed across calls — code recalled from context.jsonl",
  );
  process.exit(0);
} else {
  console.error(
    "FAIL: resumed session did not recall the code (resume not working)",
  );
  process.exit(1);
}
