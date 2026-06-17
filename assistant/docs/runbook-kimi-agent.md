# Runbook — kimi-agent provider

Operational guide for diagnosing the `kimi-agent` LLM provider (the
agentic provider that drives `@moonshot-ai/kimi-agent-sdk` / the `kimi`
Code CLI in-process). For the design record see
[`architecture/kimi-agent-bridge.md`](architecture/kimi-agent-bridge.md);
for the pattern being mirrored see
[`architecture/claude-subscription-bridge.md`](architecture/claude-subscription-bridge.md).

The provider is gated behind the default-off `kimi-agent-provider`
feature flag and only appears in the picker when the availability probe
(`src/providers/provider-availability.ts`) reports `available: true`.

---

## Quick triage

| Symptom | Most likely cause | Jump to |
| --- | --- | --- |
| Provider missing from the picker | flag off, or CLI / login probe failed | [Provider not selectable](#provider-not-selectable) |
| "Kimi membership is inactive" banner | managed plan lapsed (HTTP 402) | [Membership / auth errors](#membership--auth-errors) |
| "Kimi is not signed in" banner | no `~/.kimi` session and no key | [Membership / auth errors](#membership--auth-errors) |
| Model replies but never runs tools | the core failure — bridge / approval | [Tools not running](#tools-not-running) |
| Stale model or endpoint after re-login | cached `~/.kimi/config.toml` | [Clearing stale config](#clearing-stale-config) |
| Need a working chat path right now | use the OpenAI-compatible fallback | [Falling back to kimi chat](#falling-back-to-the-kimi-chat-provider) |

---

## Provider not selectable

The picker hides `kimi-agent` unless **all** of these hold:

1. The `kimi-agent-provider` feature flag is enabled
   (`src/config/feature-flag-registry.json`). It is default-off.
2. The `kimi` CLI is on `PATH` (`isKimiCliInstalled`). On this machine
   it lives at `~/.local/bin/kimi`; check with `kimi --version`.
3. An auth credential is present — either a vault key for `kimi-agent`,
   or a `~/.kimi/config.toml` login session (`isKimiLoginPresent`).

The availability check caches its result. After installing the CLI or
logging in, restart the daemon (or trigger a re-probe) so the cache
clears — a stale `available: false` keeps the provider hidden even once
the underlying problem is fixed.

The unavailability `reason` (`missing-cli` / `no-api-key` /
`not-enabled`) drives the picker's setup hint, so the badge text tells
you which precondition failed.

---

## Membership / auth errors

The SDK surfaces auth failures as generic `Error` / `CliError` objects;
the provider classifies them into a `KimiAgentBridgeError` with a `kind`
and a friendly message (`src/providers/kimi-agent/errors.ts`). The
banner you see maps to one of:

- **`membership-inactive`** — HTTP 402 / `code: "CHAT_PROVIDER_ERROR"` /
  numericCode `-32003` ("unable to verify your membership benefits").
  The managed "kimi-code" plan lapsed. OAuth resolves but no model
  output is produced. **Fix:** renew the Kimi membership, then retry.
- **`not-logged-in`** — no resolvable session. **Fix:** run
  `kimi /login` in a terminal (or set `MOONSHOT_API_KEY`), then retry.
- **`auth-failed`** — session present but rejected. **Fix:** re-run
  `kimi /login` to re-authenticate.
- **`cli-not-installed`** — the `kimi` binary is gone from `PATH`.
  **Fix:** reinstall the CLI; verify with `kimi --version`.

> **Note on off-iterator throws.** The 402 is raised from the SDK's
> readline callback, i.e. asynchronously *outside* the `for await`
> async-iterator — a `try/catch` around the iterator does NOT catch it.
> The provider wraps SDK calls in a boundary that classifies through
> `errors.ts`. If you ever see the daemon crash instead of a banner,
> that boundary has a gap — capture the stack and check
> `KimiAgentBridgeError.fromUnknown`.

Re-confirm raw auth from a terminal, independent of Max:

```bash
kimi --version          # CLI present?
kimi /login             # (re)authenticate
```

---

## Tools not running

The signature failure mode: **the model streams text but never executes
a Max tool.** The kimi-agent bridge has no MCP server — each Max
tool is registered as an SDK `ExternalTool` whose `handler` calls the
bridge. Work down this chain:

1. **Is the tool in the allowlist?** The provider passes only the
   enabled Max tools as `externalTools`. A tool absent from that
   array is never offered to the model. Confirm the tool is enabled for
   the conversation.

2. **Is the model emitting a built-in instead?** With `yoloMode:false`
   and a non-allowlisted built-in (`Shell`, `Read`, …), the SDK raises
   an `ApprovalRequest` that the provider **rejects** (keyed off
   `payload.sender` = tool name). That is correct isolation, not a bug:
   the model tried a tool we don't bridge and was denied. Re-run the
   isolation probe to confirm the gate still holds:

   ```bash
   KIMI_AGENT_PROBES_ENABLED=1 bun test \
     src/__tests__/kimi-agent-isolation-probes.test.ts
   # expect VERDICT: ✅ PASS
   ```

   (Requires an active membership; otherwise the probe hits HTTP 402.)

3. **Is the handler returning an error shape?** The kimi `ExternalTool`
   handler return has **no `is_error` field** — Max tool errors are
   encoded into `output`/`message` (bridge `isError:true` →
   `message: "tool error"`). If the model sees repeated tool errors and
   gives up, inspect the bridged-tool-call telemetry rather than
   guessing.

4. **Check the telemetry.** Every bridge call emits a structured log
   line `event: "kimi_agent.tool_call"` (provider-derived in
   `agent/loop.ts`) and a row in the `bridged_tool_call_events` store
   (when `collectUsageData` is on). Grep the daemon log:

   ```bash
   grep kimi_agent.tool_call ~/.local/share/max/logs/max.log
   ```

   No rows at all → the bridge never fired (problem is upstream: the
   model isn't calling tools, or the allowlist is empty). Rows with
   `isError:true` → the tools ran but failed; read the tool result.

5. **Step exhaustion.** The CLI bounds turns at
   `max_steps_per_turn = 100` and the provider caps at `MAX_TURNS = 25`;
   a turn ending in `RunResult.status: "max_steps_reached"` means the
   model looped without converging, not that tools are broken.

---

## Clearing stale config

`~/.kimi/config.toml` holds the login provider, base URL, model, and
`default_yolo`. After switching accounts, renewing membership, or
changing endpoints, a stale config can pin the old model/endpoint and
produce confusing "works in terminal, not in Max" splits.

```bash
# Inspect first — do NOT blindly delete a working session.
cat ~/.kimi/config.toml

# Back up, then clear if it is the culprit.
mv ~/.kimi/config.toml ~/.kimi/config.toml.bak
kimi /login            # regenerate a fresh session
```

After regenerating, restart the daemon so the availability cache
re-probes the new session.

---

## Falling back to the kimi chat provider

If the agentic `kimi-agent` provider is wedged (membership lapsed, CLI
broken) but you still need Kimi models, the separate **`kimi` chat
provider** is an independent path. It is a plain OpenAI-compatible chat
adapter (`src/providers/inference/adapter-factory.ts`, base
`https://api.moonshot.ai/v1`) authenticated by a raw **Moonshot API
key** — it does NOT use the `kimi` CLI, the managed "kimi-code" plan, or
the agent SDK, so it is unaffected by CLI/membership failures.

Trade-off: the chat provider is **not agentic** — it has no in-process
tool bridge, so Max tools won't run through it. Use it as a
text/chat fallback while you fix the agent path, not as a permanent
substitute.

To use it, configure a Moonshot API key for the `kimi` provider and
select it in the picker.

---

## Related

- Isolation guarantee & API surface:
  [`architecture/kimi-agent-bridge.md`](architecture/kimi-agent-bridge.md)
- In-tree probe: `scripts/kimi-agent/isolation.mjs`
  (+ bridge `src/__tests__/kimi-agent-isolation-probes.test.ts`)
- Error classification: `src/providers/kimi-agent/errors.ts`
- Provider implementation: `src/providers/kimi-agent/client.ts`
