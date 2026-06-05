# Claude Subscription Bridge — Isolation Probes

Empirical regression scripts for the `claude-subscription` LLM provider. They
exercise `@anthropic-ai/claude-agent-sdk` directly (no Vellum runtime) to verify
the security claims documented in
[`assistant/docs/architecture/claude-subscription-bridge.md`](../../docs/architecture/claude-subscription-bridge.md).

The 38 unit tests in `assistant/src/__tests__/claude-subscription-{provider,concurrency}.test.ts`
mock the SDK and assert config shape. These probes hit the real SDK and assert
*behavior* under that config. They are the only empirical evidence that the
isolation invariants actually hold end-to-end.

## Prerequisites

- `claude` CLI on PATH and a logged-in OAuth session (`claude login`)
- An active Claude Max subscription with available quota
- Network access to `api.anthropic.com`

These probes spawn the `claude` subprocess and consume subscription tokens. They
will not pass in headless CI without a credentialed `claude` install.

## Probes

| File | Audit ID | Verifies | Exit codes |
|---|---|---|---|
| `i-11-isolation.mjs` | I-11, I-23, I-24 | With `tools: []` + `settingSources: []` + `permissionMode: "default"` + `canUseTool` deny, the model cannot execute Bash on the host and cannot reach account-level MCP integrations. | `0` ✅ ISOLATION HOLDS · `2` ❌ ISOLATION BROKEN |
| `i-11b-subagent-isolation.mjs` | I-11b, I-19 (containment) | With `Task` enabled in the allowlist, sub-agents spawned by the model inherit the parent's tool restrictions and cannot escape via Bash. | `0` ✅ SUB-AGENT CONTAINED · `2` ❌ SUB-AGENT ESCAPED |
| `i-22-system-prompt.mjs` | I-22 | `systemPrompt: <string>` (the documented SDK option) **replaces** Claude Code's coding-agent system prompt — verified after the bug where `customSystemPrompt` was silently ignored. | Always `0`; interpret the per-probe flags printed at the end |

## Running manually

```bash
node assistant/scripts/claude-subscription/i-11-isolation.mjs
node assistant/scripts/claude-subscription/i-11b-subagent-isolation.mjs
node assistant/scripts/claude-subscription/i-22-system-prompt.mjs
```

Each probe logs its config at startup and a `========== I-NN RESULT ==========`
block at the end. i-11 and i-11b print `VERDICT: ✅ …` or `VERDICT: ❌ …`.

## Running via the test suite

A `bun:test` wrapper at
`assistant/src/__tests__/claude-subscription-isolation-probes.test.ts` spawns
each probe and asserts on exit code + verdict line.

The wrapper is **default-skipped** so plain `bun test` is unaffected. To opt in:

```bash
CLAUDE_SUBSCRIPTION_PROBES_ENABLED=1 bun test src/__tests__/claude-subscription-isolation-probes.test.ts
```

## Historical artifact: `customSystemPrompt`

`i-11-isolation.mjs` and `i-11b-subagent-isolation.mjs` set
`customSystemPrompt` rather than the documented `systemPrompt`. This predates
the I-22 finding and is a no-op for those probes (they don't assert on persona).

**Do not "fix" the option name in these files.** They are empirical record
under the SDK version (`@anthropic-ai/claude-agent-sdk@0.3.144`) at which they
passed; the production provider in `client.ts` uses the correct `systemPrompt`,
and `i-22-system-prompt.mjs` exists specifically to keep that property under
test. Changing the probes would invalidate them as regression evidence without
re-running on the original SDK version.

## When to re-run

Per the architecture doc's "Things to not change without re-running the
empirical probes" section, re-run after touching any of:

- `tools`, `permissionMode`, `settingSources`, or `canUseTool` in `client.ts`
- `MAX_CONCURRENT_CALLS`, `maxTurns: 25`, or `MCP_SERVER_NAME = "vellum-skills"`
- The `systemPrompt` option in `client.ts`
- The `@anthropic-ai/claude-agent-sdk` version

## Not ported

`i-19-bounded-fanout-test.mjs` and `i-19-subagent-fanout-test.mjs` from the
original demo workspace are not in tree: the bounded run was documented as
inconclusive (model hallucinated sub-agent execution) and the unbounded run
hung 20+ minutes. The I-19 mitigation lives in code as `maxTurns: 25` in
`client.ts`. See architecture doc §3 for the full operational finding.
