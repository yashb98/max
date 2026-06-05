/**
 * Bridge between bun:test and the standalone isolation probes in
 * `assistant/scripts/claude-subscription/`. Default-skipped because the
 * probes spawn the real `claude` CLI subprocess, consume Claude Max
 * subscription quota, and require a live OAuth session.
 *
 * Opt in: `CLAUDE_SUBSCRIPTION_PROBES_ENABLED=1 bun test
 *   src/__tests__/claude-subscription-isolation-probes.test.ts`
 *
 * Re-run after touching any of the load-bearing options in
 * `providers/claude-subscription/client.ts` — see the README in the probe
 * directory for the full list.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENABLED = process.env.CLAUDE_SUBSCRIPTION_PROBES_ENABLED === "1";
// 270s ceiling: i-22 chains 3 sequential `claude` subprocess calls; the
// single-shot probes (i-11, i-11b) are unaffected by a higher cap.
const PROBE_TIMEOUT_MS = 270_000;

const ASSISTANT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROBE_DIR = join(ASSISTANT_ROOT, "scripts", "claude-subscription");

interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProbe(filename: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const proc = spawn("node", [join(PROBE_DIR, filename)], {
      cwd: ASSISTANT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

function failureDetail(r: ProbeResult): string {
  const tail = (s: string, n = 60): string =>
    s.split("\n").slice(-n).join("\n");
  return [
    `exitCode=${r.exitCode} timedOut=${r.timedOut}`,
    `--- stdout (tail) ---\n${tail(r.stdout)}`,
    `--- stderr (tail) ---\n${tail(r.stderr)}`,
  ].join("\n");
}

if (ENABLED) {
  describe("claude-subscription isolation probes (live SDK)", () => {
    test(
      "i-11 — SDK isolation: Bash and account MCP integrations are denied",
      async () => {
        const r = await runProbe("i-11-isolation.mjs");
        if (r.exitCode !== 0 || r.timedOut) throw new Error(failureDetail(r));
        expect(r.stdout).toContain("VERDICT: ✅ ISOLATION HOLDS");
      },
      PROBE_TIMEOUT_MS + 30_000,
    );

    test(
      "i-11b — sub-agent containment with Task enabled",
      async () => {
        const r = await runProbe("i-11b-subagent-isolation.mjs");
        if (r.exitCode !== 0 || r.timedOut) throw new Error(failureDetail(r));
        expect(r.stdout).toContain("VERDICT: ✅ SUB-AGENT CONTAINED");
      },
      PROBE_TIMEOUT_MS + 30_000,
    );

    test(
      "i-22 — systemPrompt replaces Claude Code's persona (all 3 sub-probes ran)",
      async () => {
        const r = await runProbe("i-22-system-prompt.mjs");
        if (r.exitCode !== 0 || r.timedOut) throw new Error(failureDetail(r));
        expect(r.stdout).toContain("--- probe: identity ---");
        expect(r.stdout).toContain("--- probe: system_prompt ---");
        expect(r.stdout).toContain("--- probe: capability ---");
      },
      PROBE_TIMEOUT_MS + 30_000,
    );
  });
} else {
  test.skip(
    "claude-subscription isolation probes — set CLAUDE_SUBSCRIPTION_PROBES_ENABLED=1 to enable",
    () => {
      // Marker so the skip is visible in test output.
    },
  );
}
