# Agentic Provider Login — UI Redirection & Token Capture

> **Status:** kimi-agent and claude-subscription login paths implemented and unit-tested (daemon side). The macOS UI seam is wired but unbuilt here (no Swift toolchain run).
> Plan: `docs/superpowers/plans/2026-05-29-agent-sdk-login-ui.md`.

## What this is

A login flow triggered from the Max macOS UI that drives an agentic provider's OAuth/login, opens the auth URL in the host browser ("the redirection"), and persists the captured credential so the provider becomes usable without leaving the composer.

Two agentic providers, **asymmetric** login capabilities:

| Provider | Login mechanism | Token storage |
|----------|-----------------|---------------|
| `kimi-agent` | programmatic `login({ onUrl })` from `@moonshot-ai/kimi-agent-sdk` | SDK writes `~/.kimi/config.toml` |
| `claude-subscription` | **no SDK login** — only interactive CLI (`claude setup-token` / `claude auth login`) | macOS Keychain (`Claude Code-credentials`) |

## Redirection mechanism (reused, not new)

`openInHostBrowser(url)` in `src/util/browser.ts` does **not** open a browser in the daemon. It writes `{ type: "open_url", url }` to the signals `emit-event` file; the daemon's ConfigWatcher publishes it to the macOS app, which opens the user's browser. The login flow wires each provider's `onUrl` callback to this — that is the "UI redirection".

## Daemon flow

```
macOS "Sign in" row
  → ProviderLoginClient.login(provider)           clients/shared/Network/ProviderLoginClient.swift
  → POST /v1/provider-login { provider }           src/runtime/routes/provider-login-routes.ts
  → loginProvider(provider, { onUrl })             src/providers/provider-login.ts
      onUrl → openInHostBrowser(url) → open_url event → browser
  → on success: clear availability cache
  → { success, reason?, error? }                   (ProviderLoginResult, mirrored in Swift)
```

- `provider-login-routes.ts` is a **POST** (side-effecting: spawns a login flow, may persist a credential) — never a GET. Registered in the shared `ROUTES` array (`src/runtime/routes/index.ts`), so it is served over both HTTP and IPC by design.
- `loginProvider` switches on provider: `kimi-agent` → SDK `login`; `claude-subscription` → CLI token capture (gated, see below); unknown → `{ success: false, reason: "unsupported-provider" }`.
- The kimi SDK can throw **off the async path** (see `kimi-agent-bridge.md`), so `loginKimiAgent` is wrapped in try/catch mapping throws to `reason: "cli-error"`.

## macOS UI (`ComposerSettingsMenu.swift`)

When a cli-login/subscription provider is selected but unavailable with reason `not-logged-in`, the composer settings menu renders an actionable **"Sign in"** row (`providerSignInRow`) instead of the disabled status row. Tapping it calls `signInToProvider`, which awaits `ProviderLoginClient.login` (180 s timeout for the interactive OAuth), then refreshes `refreshProviderAvailability()` on success so the row redraws as the model submenu. `loginClient` is an injected protocol (`ProviderLoginClientProtocol`) for test seams, mirroring `ProviderAvailabilityClient`.

Currently only `claude-subscription`'s `not-logged-in` is wired (the surfaced, `ProviderGroup`-mapped provider). Surfacing `kimi-agent` in the picker is separate Phase 3 work; the row helper is parameterized by provider string so it reuses without change.

## claude-subscription: detect-and-refresh (empirically grounded)

`claude-subscription` has no programmatic OAuth. Empirical verification of the CLI (`claude` 2.1.x) settled the design:

- `claude setup-token` is a **TTY-only UI**: under a non-TTY pipe it emits nothing on stdout and blocks. A plain `child_process` (the repo has **no PTY dependency**) cannot parse a URL or token from it.
- `claude auth status` prints login state as **JSON on stdout** and works fine non-TTY: `{ "loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max", ... }`. This is the stable contract.
- The credential lives in the **macOS Keychain** (`Claude Code-credentials`), CLI-managed — there is no token for the daemon to capture.

So `loginClaudeSubscription` resolves the `claude` binary (`/usr/bin/which claude`, mirroring `claude-subscription/client.ts`), reads `claude auth status`, and:
- `loggedIn === true` → `clearClaudeSubscriptionAvailabilityCache()`, return `{ success: true }` (the availability probe re-reads the Keychain and reports available).
- `loggedIn === false` → `{ success: false, reason: "no-token-captured" }` with guidance to run `claude auth login` in a terminal.
- status unreadable (CLI missing / unparseable) → `{ success: false, reason: "cli-error" }`.

This covers the common real case (user authed via the CLI; Max just needs to notice) without a PTY. Driving a *fresh* browser OAuth from inside Max for Claude would require a PTY (`node-pty`, native dep) or launching `claude auth login` in a real terminal — deliberately out of scope; the terminal guidance covers it. The `onUrl` callback is therefore unused on the claude path (only kimi-agent surfaces a URL).

## Security

- No new runtime env var is introduced, so `src/tools/terminal/safe-env.ts` needs **no change**. Credential material (tokens, `MOONSHOT_API_KEY`, `ANTHROPIC_API_KEY`) must never be added to the safe-env allowlist — it stays isolated to CES.
- Tokens are persisted via the existing vault (`setSecureKeyAsync`) / provider stores; the login route returns only `{ success, reason?, error? }`, never the credential.
