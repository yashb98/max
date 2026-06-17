import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Canonical kimi-cli agent-spec generation (load-bearing isolation) ──────
//
// kimi-cli builds its tool set from the agent spec's POSITIVE `tools`
// allowlist: `kimi_cli/soul/agent.py` does `toolset.load_tools(agent_spec.tools)`,
// and `toolset.handle()` returns `ToolNotFoundError` (without executing) for
// any tool name not registered. So a built-in omitted from `tools` is a TRUE
// pre-execution disable — the model cannot invoke it at all.
//
// MAX-NATIVE POSTURE (2026-06-05) with ONE exception: kimi's free managed
// `SearchWeb` is enabled natively (saves the user's paid Max web_search
// key). Every OTHER tool call routes through Max's native tool system:
//
//   - ReadFile → Max's file_read (audited, permission-gated)
//   - ReadMediaFile → Max's ReadMediaFile (audited, permission-gated)
//   - Glob → Max's Glob (audited, permission-gated)
//   - Grep → Max's Grep (audited, permission-gated)
//   - Shell → Max's bash (audited, permission-gated)
//   - WriteFile → Max's file_write (audited, permission-gated)
//   - StrReplaceFile → Max's file_edit (audited, permission-gated)
//   - FetchURL → Max's web_fetch (audited, permission-gated)
//   - SearchWeb → Max's web_search (audited, permission-gated)
//   - Task / subagents → disabled entirely (subagents: {})
//
// Every tool call goes through Max's full allowlist → permission → approval
// → audit pipeline. No tool runs ungated. No tool bypasses Max's audit log.
// The model uses Max's tool schemas for all operations.

/**
 * Native kimi built-in tools the model may use directly.
 *
 * Only kimi's FREE managed web search (`SearchWeb`, included in the kimi-code
 * subscription) is enabled — so searches use it instead of the user's own paid
 * Max `web_search` key. It runs UNGATED (no Max audit), accepted as a
 * trusted single-user trade. Everything else (file/shell/edit/`FetchURL`) stays
 * disabled and routes through Max's audited tools. NEVER add `FetchURL`
 * (SSRF) or any write/exec tool here without re-running the isolation probe.
 */
export const KIMI_BUILTIN_TOOL_ALLOWLIST: readonly string[] = [
  "kimi_cli.tools.web:SearchWeb",
];

/** Bare registered name(s) of the allowlisted native tool(s). */
export const KIMI_NATIVE_TOOL_NAMES: readonly string[] = ["SearchWeb"];

/**
 * Render the agent.yaml spec: the read/search `tools` allowlist plus
 * `subagents: {}`. Subagents are dropped because kimi's default `sub.yaml`
 * does NOT exclude the write/exec/network built-ins — a spawned subagent would
 * re-introduce them one level down.
 */
function buildAgentSpecYaml(): string {
  const toolsBlock =
    KIMI_BUILTIN_TOOL_ALLOWLIST.length === 0
      ? "  tools: []"
      : [
          "  tools:",
          ...KIMI_BUILTIN_TOOL_ALLOWLIST.map(
            (t) => `    - ${JSON.stringify(t)}`,
          ),
        ].join("\n");
  return [
    "version: 1",
    "agent:",
    '  name: "max-kimi-agent"',
    "  system_prompt_path: ./system.md",
    toolsBlock,
    "  subagents: {}",
    "",
  ].join("\n");
}

/**
 * kimi-cli renders the system prompt through Jinja2 with `StrictUndefined`,
 * variable syntax `${VAR}`, and the default block (`{% %}`) and comment
 * (`{# #}`) tags active. Arbitrary prompt text containing `${`, `{%`, or `{#`
 * would raise `SystemPromptTemplateError` (or, worse, interpolate). Wrap the
 * whole prompt in `{% raw %}` so it is emitted verbatim. (A prompt that
 * literally contains the string `{% endraw %}` would still break, but that is
 * not a realistic system-prompt string.)
 */
function jinjaRawWrap(prompt: string): string {
  return `{% raw %}\n${prompt}\n{% endraw %}\n`;
}

/**
 * Tool-environment guidance appended to EVERY system prompt.
 *
 * Why: kimi-cli auto-loads ambient MCP servers from `~/.kimi/mcp.json`
 * independent of the agent-spec `tools:` allowlist, so the model can SEE
 * tools (browser_*, github_*, …) it is never allowed to run — the
 * ApprovalRequest deny fires only AFTER the model commits to the call, and
 * kimi-cli ends the turn on a rejected tool without re-inferring. Telling the
 * model up front what is unavailable prevents wasted steps and denial-killed
 * turns (see KIMI_AGENT_ROOT_CAUSE_REPORT.md). Contains no Jinja-special
 * sequences, so it is safe inside the `{% raw %}` wrap.
 */
const TOOL_ENVIRONMENT_GUIDANCE = [
  "## Tool environment (read carefully)",
  "Your ONLY available tools are the external tools provided in this session",
  "(for example: bash, file_read, file_write, file_edit, web_fetch) plus the",
  "native SearchWeb tool. Everything else is DISABLED and any attempt to call",
  "it will be rejected and may end your turn:",
  "- Built-in tools: Shell, ReadFile, ReadMediaFile, WriteFile, StrReplaceFile,",
  "  Glob, Grep, FetchURL — use the session's external tools instead (run",
  "  shell commands via bash, read files via file_read, fetch URLs via",
  "  web_fetch).",
  "- ALL MCP tools (browser_*, github_*, canva_*, context7_*, and any other",
  "  MCP-provided tool) — never call them, not even once to test. For browser",
  "  or web-page work, use the approach your host instructions describe (or",
  "  bash + the tools above); do NOT reach for browser_* tools.",
  "Do not retry a rejected tool. Choose an allowed tool and continue.",
].join("\n");

export interface KimiAgentFiles {
  /** Temp dir holding agent.yaml + system.md. Caller MUST clean this up. */
  tmpDir: string;
  /** Absolute path to agent.yaml, to pass as `createSession({ agentFile })`. */
  agentFile: string;
}

/**
 * Write the restrictive agent spec + system-prompt file into a fresh temp dir
 * and return the agent.yaml path.
 *
 * ALWAYS call this — even when `systemPrompt` is empty. Omitting the agent
 * file makes kimi-cli fall back to its DEFAULT agent spec, which registers the
 * full built-in set (including Shell + the network tools) and a `Task`
 * subagent. The caller is responsible for removing `tmpDir` after the session
 * ends.
 */
export function writeKimiAgentFiles(
  systemPrompt: string | undefined,
): KimiAgentFiles {
  const tmpDir = mkdtempSync(join(tmpdir(), "kimi-agent-"));
  const fullPrompt = [systemPrompt, TOOL_ENVIRONMENT_GUIDANCE]
    .filter(Boolean)
    .join("\n\n");
  writeFileSync(join(tmpDir, "system.md"), jinjaRawWrap(fullPrompt), "utf-8");
  const agentFile = join(tmpDir, "agent.yaml");
  writeFileSync(agentFile, buildAgentSpecYaml(), "utf-8");
  return { tmpDir, agentFile };
}

/** Exposed for tests/probes that need the spec content without writing files. */
export const __testing = { buildAgentSpecYaml, jinjaRawWrap };
