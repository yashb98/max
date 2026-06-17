/**
 * Bridge between bun:test and the standalone isolation probe in
 * `assistant/scripts/kimi-agent/`. Default-skipped because the probe
 * spawns the real `kimi` CLI subprocess, consumes Moonshot API quota,
 * and requires a resolvable `~/.kimi` auth session.
 *
 * Opt in: `KIMI_AGENT_PROBES_ENABLED=1 bun test
 *   src/__tests__/kimi-agent-isolation-probes.test.ts`
 *
 * Re-run after touching any of the load-bearing isolation options in
 * `providers/kimi-agent/client.ts` (`yoloMode`, `externalTools`, the
 * ApprovalRequest reject path).
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENABLED = process.env.KIMI_AGENT_PROBES_ENABLED === "1";
// The probe enforces its own 90s wall-clock cap; give the bridge a bit
// more headroom before SIGKILL so we read its VERDICT line rather than
// killing it mid-print.
const PROBE_TIMEOUT_MS = 120_000;

const ASSISTANT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROBE_DIR = join(ASSISTANT_ROOT, "scripts", "kimi-agent");

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
  describe("kimi-agent isolation probe (live SDK)", () => {
    test(
      "isolation — built-in Shell/Read tools are gated by approval-deny",
      async () => {
        const r = await runProbe("isolation.mjs");
        if (r.exitCode !== 0 || r.timedOut) throw new Error(failureDetail(r));
        expect(r.stdout).toContain("VERDICT: ✅ PASS");
      },
      PROBE_TIMEOUT_MS + 30_000,
    );
  });
} else {
  test.skip(
    "kimi-agent isolation probe — set KIMI_AGENT_PROBES_ENABLED=1 to enable",
    () => {
      // Marker so the skip is visible in test output.
    },
  );
}
