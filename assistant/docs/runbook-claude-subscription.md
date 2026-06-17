# Runbook — Claude Subscription Provider

Operational runbook for the `claude-subscription` LLM provider (Phase 3.6 in [`architecture/claude-subscription-bridge.md`](./architecture/claude-subscription-bridge.md)). Covers the common failure modes the on-call engineer will see and the actions that resolve them.

The provider runs Claude on the user's Max subscription via the local `claude` CLI subprocess (spawned by `@anthropic-ai/claude-agent-sdk`). Bridge tool execution is routed back into Max's `ToolExecutor` through an in-process MCP server — so every gate (allowlist, trust, approval, CES, sandbox, audit) still fires on tool calls.

---

## Quick diagnostic checklist

When a user reports "claude-subscription doesn't work", walk this list top-to-bottom:

1. **Is the row greyed out in the picker?** If so, the daemon's `provider-availability` check has already classified the failure. Read the trailing hint:
   - **"Install Claude Code"** → CLI is not on PATH. Install from [claude.com/code](https://claude.com/code), then **fully quit and reopen the Max app** (the daemon caches the probe result; reopening clears it).
   - **"Run `claude login`"** → CLI installed but no OAuth credential on the host. Have the user run `claude login` in a terminal, then reopen the picker.
   - **"Feature flag off"** → `claude-subscription-provider` is disabled. See [Rollout & feature flag](#rollout--feature-flag) below.
2. **Is it failing at call time with a banner?** The banner message is the `ClaudeSubscriptionBridgeError.message`. Map it to a kind from [Error kinds](#error-kinds) below and follow that section.
3. **Is the user's `claude` CLI version current?** `claude --version` should report a recent build. Old versions sometimes mismatch the SDK and produce confusing `EPIPE`/exit errors. Recommend upgrading via the same install URL as step 1.
4. **Is the daemon log surfacing a `claude_subscription.tool_call` warning?** See [Logs & telemetry](#logs--telemetry) for filters.

---

## Error kinds

Each error surfaces as a `ClaudeSubscriptionBridgeError` with one of these `kind` discriminators (defined in `assistant/src/providers/claude-subscription/errors.ts`). The friendly user-facing copy is in `CLAUDE_SUBSCRIPTION_FRIENDLY_MESSAGES`.

### `cli-not-installed`

- **Trigger:** `spawn claude ENOENT` / `command not found` from the SDK's process spawn.
- **What the user sees:** "Claude Code is not installed. Install it from claude.com/code, then retry."
- **Fix:** Install the Claude Code CLI. After install, run `which claude` to confirm it's on PATH. Fully quit and reopen Max so the daemon re-probes availability.
- **Why the picker setup-hint didn't catch this first:** the picker probes at app launch and on menu open. If the user uninstalled `claude` between picker-open and send, the picker's cached "available" state is stale and you only see this at send time.

### `not-logged-in`

- **Trigger:** Messages matching `not (logged|signed) in`, `no credentials`, `please run claude login`.
- **What the user sees:** "Claude Code is not signed in. Run `claude login` in your terminal to authenticate your Max subscription, then retry."
- **Fix:** Run `claude login` in a terminal. This drives an OAuth flow against Anthropic and writes an entry to the macOS Keychain (`Claude Code-credentials`) or `~/.claude/.credentials.json` (Linux/Windows).

### `token-expired`

- **Trigger:** Messages matching `token expired`, `oauth expired`, `credential expired`, OR any generic auth-shaped error (`401`, `unauthorized`, `invalid_credentials`) that wasn't caught by `not-logged-in` first.
- **What the user sees:** "Your Claude subscription token has expired. Run `claude login` in your terminal to refresh, then retry."
- **Fix:** Same as `not-logged-in` — run `claude login`. The CLI usually rotates tokens silently on each spawn; if you're seeing this repeatedly, the user's refresh token may have been revoked by Anthropic (rotate by re-logging).
- **Defense in depth:** The provider auto-retries once on auth errors (D-5 in the bridge doc). If you're seeing this surface to the user, it's because either (a) the retry also failed, or (b) the first attempt streamed partial output before failing — in which case the retry would double-apply side effects, so the bridge fails fast instead.

### `sdk-timeout`

- **Trigger:** Messages matching `timed out`, `timeout`, `deadline exceeded`.
- **What the user sees:** "The Claude subprocess took too long to respond. Check your network connection and retry."
- **Fix:** Most common cause is network. Check the user can hit `api.anthropic.com` from their host (`curl -I https://api.anthropic.com/` should respond). If timeouts persist on healthy networks, look for a long-running tool call inside the SDK loop — the per-call `maxTurns: 25` cap should prevent runaway loops but doesn't prevent a single slow tool. Cross-check `tool_invocations` rows for the user's recent conversations.

### `subprocess-crashed`

- **Trigger:** `EPIPE`, `ECONNRESET`, `process exited with signal`, `spawn failed`.
- **What the user sees:** "The Claude subprocess crashed unexpectedly. Retry the request; if it persists, run `claude --version` to verify your installation."
- **Fix:** Usually transient — the next send re-spawns. If it persists for the same user, ask them to run `claude --version` to confirm the install is healthy, then `claude` (no args) to see if the CLI itself can run interactively. Persistent crashes often correlate with a corrupted Claude Code install (reinstall) or an outdated SDK build mismatching the CLI.

### `unknown`

- **Trigger:** Anything that doesn't match the patterns above.
- **What the user sees:** `Claude subscription provider error: <underlying message>` — the underlying SDK error message is preserved verbatim so the user can act on it.
- **Fix:** Inspect the underlying message. If you're seeing a pattern that should have been classified (e.g. a new shape of auth error), add the regex to `errors.ts` so it routes to a specific kind next time. New patterns should be PR'd, not patched in production.

---

## Fall back to API-key Anthropic

If the user has both `claude-subscription` and an `anthropic` API-key provider configured, they can switch quickly:

1. **Per conversation:** open the composer picker, select "Anthropic" or any `claude-*` model under the Anthropic group. The next send uses the API-key provider. No restart needed.
2. **Default for new conversations:** Settings → Inference profile picker → set a default profile that uses Anthropic API.
3. **If the user has NO API key yet:** Max's managed-proxy fallback (`managedFallbackEnabledFor`) may already give them access to Anthropic without configuring a key. Check `getProviderAvailabilityStatus("anthropic")` — if `available: true`, the picker will list it.

The `claude-subscription` row stays in the picker even after fallback so the user can switch back once they've fixed the underlying issue. There's no global "disable" toggle for a single user — disabling requires flipping the feature flag, which affects everyone.

---

## Clear stale OAuth

If `claude login` succeeded but the daemon still reports `not-logged-in`:

1. **Re-probe**: the daemon's `provider-availability` check is cached for the process lifetime. Force a refresh by reopening the picker (the macOS app's `SettingsStore.refreshProviderAvailability` fires on menu open with `?fresh=true`, which calls `clearClaudeSubscriptionAvailabilityCache()` in the daemon).
2. **Inspect the Keychain entry (macOS)**:
   ```bash
   security find-generic-password -s "Claude Code-credentials"
   ```
   If this returns "no such item", `claude login` did not write a credential — investigate at the CLI level. If it returns a record but Max still fails auth, the token may be malformed; try `claude logout && claude login` to write a fresh entry.
3. **Inspect the credentials file (Linux/Windows)**:
   ```bash
   ls -la ~/.claude/.credentials.json
   ```
   File missing → re-run `claude login`. File present but unreadable → permission issue; check `chmod` of the user's home directory.
4. **Last resort — fully reset**:
   ```bash
   claude logout
   rm -f ~/.claude/.credentials.json        # Linux/Windows only
   security delete-generic-password -s "Claude Code-credentials"  # macOS only
   claude login
   ```
   Then reopen Max.

---

## Logs & telemetry

### Real-time logs

The daemon log lives at `~/.max/workspace/data/logs/max.log` (or, if `logFile.dir` is configured, `assistant-YYYY-MM-DD.log` in that directory). Useful filters:

```bash
# All bridge tool calls (Phase 3.1 structured logs)
tail -f ~/.max/workspace/data/logs/max.log | grep claude_subscription.tool_call

# Auth retries (the D-5 path that swallows transient 401s)
tail -f ~/.max/workspace/data/logs/max.log | grep 'Auth error from Agent SDK'

# canUseTool denials (account-MCP tools the SDK tried to surface)
tail -f ~/.max/workspace/data/logs/max.log | grep 'canUseTool denied'

# All claude-subscription-client module logs
tail -f ~/.max/workspace/data/logs/max.log | grep claude-subscription-client
```

### Local telemetry table

Per-bridge-tool-call rows land in `bridged_tool_call_events` in the daemon's SQLite. Sample query for the last hour, grouped by tool:

```sql
SELECT
  tool_name,
  COUNT(*)              AS calls,
  SUM(is_error)         AS errors,
  AVG(duration_ms)      AS avg_ms,
  MAX(duration_ms)      AS max_ms
FROM bridged_tool_call_events
WHERE created_at > (CAST(strftime('%s', 'now') AS INTEGER) - 3600) * 1000
GROUP BY tool_name
ORDER BY calls DESC;
```

Rows are flushed to the platform telemetry endpoint by `UsageTelemetryReporter` every 5 minutes (matches the LLM-usage flush cadence). If the user has `collectUsageData: false` in their config, the store stays silent — the platform never sees their bridge calls.

---

## Rollout & feature flag

The provider is gated by `claude-subscription-provider` in `meta/feature-flags/feature-flag-registry.json`. Current default: **`defaultEnabled: true`** (GA — see Phase 3.7 in the bridge doc).

To disable globally without a code change, flip `defaultEnabled` to `false` in the registry and restart the daemon. The picker will hide the row (or show "Feature flag off" depending on which path runs first); existing conversations pinned to this provider will start failing at call time with `not-enabled` from `getProviderAvailabilityStatus`.

To roll back the rollout per-user: there is no per-user override today. If you need to disable for a single user, ask them to switch the conversation's inference profile to a non-claude-subscription one.

---

## Known operational quirks

- **Picker shows "available" but call fails with `cli-not-installed`.** The picker cache is process-lifetime. If the user uninstalled the CLI between picker-open and send, you'll see this. Reopening Max re-probes. Not a bug.
- **First call after `claude login` may fail once with a token error, then succeed on retry.** The D-5 auth-retry path handles this silently — if you're seeing it surface to the user, it's because partial output streamed before the failure (so retry would double-apply side effects).
- **`maxTurns: 25` cap can produce `error_max_turns` on legitimately complex flows.** This is intentional — without it, sub-agent recursion ran for 20+ minutes empirically (see §I-19 in the bridge doc). If a user hits this regularly, lower the recursion depth in their request rather than raising the cap.
- **Account-level Anthropic MCP integrations (Gmail, Drive, Notion, etc.) are denied at the SDK boundary.** The `canUseTool` callback rejects every tool not on Max's allowlist — this is load-bearing security, not a bug. If a user expects to use a Gmail action that's only in their Anthropic-account MCP config, they need to install the equivalent Max skill instead.

---

## Escalation

If after this runbook the issue is unresolved:

1. **Repro on a known-good host.** Have the user copy their conversation id; spin up a fresh `claude login`-authenticated dev box; reproduce.
2. **Check the SDK version.** `npm ls @anthropic-ai/claude-agent-sdk` in `assistant/`. Compare against `0.3.144` (the version locked at the time of the bridge build). Newer SDKs may have changed error shapes.
3. **Open an issue** with: the user's `claude --version`, the daemon's `max.log` excerpt around the failure, the `kind` from the error class, and the `bridged_tool_call_events` row(s) from the failing turn.
