import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";

import { parse as parseYaml } from "yaml";

import {
  __testing,
  KIMI_BUILTIN_TOOL_ALLOWLIST,
  KIMI_NATIVE_TOOL_NAMES,
  writeKimiAgentFiles,
} from "../agent-file.js";

// Max-native posture with ONE exception: kimi's free `SearchWeb` is enabled.
// Write/exec built-ins and `FetchURL` (SSRF) must NEVER be registered natively.
const FORBIDDEN_BUILTINS = ["Shell", "WriteFile", "StrReplaceFile", "FetchURL"];

describe("kimi-agent agent-file (Max-native + free SearchWeb isolation spec)", () => {
  test("allowlist enables ONLY kimi's free SearchWeb", () => {
    // Load-bearing invariant. If this changes, you MUST re-run
    // scripts/kimi-agent/isolation-agentfile.mjs and confirm the forbidden
    // write/exec/FetchURL built-ins are still unreachable before shipping.
    expect([...KIMI_BUILTIN_TOOL_ALLOWLIST]).toEqual([
      "kimi_cli.tools.web:SearchWeb",
    ]);
    expect([...KIMI_NATIVE_TOOL_NAMES]).toEqual(["SearchWeb"]);
  });

  test("agent.yaml parses: registers ONLY SearchWeb, ZERO subagents, and NO forbidden built-in", () => {
    const yaml = __testing.buildAgentSpecYaml();
    const parsed = parseYaml(yaml) as {
      version: number;
      agent: {
        system_prompt_path: string;
        tools: string[];
        subagents: Record<string, unknown>;
      };
    };
    expect(parsed.version).toBe(1);
    expect(parsed.agent.system_prompt_path).toBe("./system.md");
    expect(parsed.agent.tools).toEqual(["kimi_cli.tools.web:SearchWeb"]);
    expect(parsed.agent.subagents).toEqual({});
    for (const banned of FORBIDDEN_BUILTINS) {
      expect(yaml).not.toContain(banned);
    }
  });

  test("system prompt is wrapped in {% raw %} so Jinja-special content is literal", () => {
    const hostile =
      "Use ${HOME} and {% if x %}y{% endif %} and {# comment #} verbatim";
    const wrapped = __testing.jinjaRawWrap(hostile);
    expect(wrapped.startsWith("{% raw %}\n")).toBe(true);
    expect(wrapped.trimEnd().endsWith("{% endraw %}")).toBe(true);
    expect(wrapped).toContain(hostile);
  });

  test("writeKimiAgentFiles writes agent.yaml + system.md and returns the spec path", () => {
    const { tmpDir, agentFile } = writeKimiAgentFiles("You are pyxis.");
    try {
      expect(existsSync(agentFile)).toBe(true);
      expect(agentFile.endsWith("agent.yaml")).toBe(true);
      const promptPath = join(dirname(agentFile), "system.md");
      expect(existsSync(promptPath)).toBe(true);
      expect(readFileSync(promptPath, "utf-8")).toContain("You are pyxis.");
      const parsed = parseYaml(readFileSync(agentFile, "utf-8")) as {
        agent: { tools: string[] };
      };
      expect(parsed.agent.tools).toEqual(["kimi_cli.tools.web:SearchWeb"]);
      expect(readFileSync(agentFile, "utf-8")).not.toContain(
        "kimi_cli.tools.shell:Shell",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("system.md always carries the tool-environment guidance (steers the model off built-ins/MCP)", () => {
    // The model can SEE ambient MCP tools (~/.kimi/mcp.json loads independent
    // of the agent-spec allowlist) and may guess at built-ins. The system
    // prompt must say those are unavailable so it doesn't waste steps — or
    // kill the turn — reaching for them.
    const { tmpDir, agentFile } = writeKimiAgentFiles("Base prompt.");
    try {
      const sys = readFileSync(join(dirname(agentFile), "system.md"), "utf-8");
      expect(sys).toContain("Base prompt.");
      // Names the unavailable surfaces…
      expect(sys).toContain("MCP");
      expect(sys).toMatch(/browser_\*/);
      expect(sys).toContain("Shell");
      // …and steers to the sanctioned path.
      expect(sys).toContain("external tools");
      expect(sys).toContain("SearchWeb");
      // Guidance must sit INSIDE the raw wrap so Jinja never sees it.
      expect(sys.indexOf("{% raw %}")).toBeLessThan(sys.indexOf("MCP"));
      expect(sys.indexOf("MCP")).toBeLessThan(sys.indexOf("{% endraw %}"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("tool-environment guidance is present even with NO caller system prompt", () => {
    const { tmpDir, agentFile } = writeKimiAgentFiles(undefined);
    try {
      const sys = readFileSync(join(dirname(agentFile), "system.md"), "utf-8");
      expect(sys).toContain("external tools");
      expect(sys).toMatch(/browser_\*/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("empty systemPrompt still produces the restrictive agent.yaml (no default-agent fallback)", () => {
    const { tmpDir, agentFile } = writeKimiAgentFiles(undefined);
    try {
      const yaml = readFileSync(agentFile, "utf-8");
      const parsed = parseYaml(yaml) as {
        agent: { tools: string[]; subagents: Record<string, unknown> };
      };
      expect(parsed.agent.tools).toEqual(["kimi_cli.tools.web:SearchWeb"]);
      expect(parsed.agent.subagents).toEqual({});
      for (const banned of FORBIDDEN_BUILTINS) {
        expect(yaml).not.toContain(banned);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
