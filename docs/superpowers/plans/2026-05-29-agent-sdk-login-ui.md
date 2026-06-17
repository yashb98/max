# Agent SDK Login UI (OAuth token capture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user sign into an agentic LLM provider (claude-subscription, kimi-agent) directly from the Max macOS composer settings menu — Max drives the login, opens the OAuth URL in the host browser, and persists the resulting credential so the provider becomes available without the user touching a terminal.

**Architecture:** A new daemon route `POST /v1/provider-login` invokes provider-specific login orchestration in `provider-login.ts`. For **kimi-agent** it calls the SDK's `login({ onUrl })` (the SDK runs OAuth and writes the token to `~/.kimi/config.toml`). For **claude-subscription** it drives `claude setup-token` and captures the printed long-lived token into the Max vault. Both deliver the OAuth URL to the macOS client via the existing `openInHostBrowser()` → `open_url` event mechanism. The macOS composer settings menu turns the existing disabled "unavailable" provider rows into actionable "Sign in" rows that call the route and refresh availability on success.

**Tech Stack:** TypeScript daemon (Bun, shared `ROUTES` array), `@moonshot-ai/kimi-agent-sdk` `login()`, `claude` CLI `setup-token`, `secure-keys` vault, SwiftUI macOS client, `bun:test`.

---

## Verified facts (do not re-litigate)

- **kimi-agent login is programmatic:** `import { login, isLoggedIn, type LoginResult, type LoginOptions } from "@moonshot-ai/kimi-agent-sdk"`. `login(options?: LoginOptions): Promise<LoginResult>`; `LoginOptions extends CliOptions { onUrl?: (url: string) => void }`; `LoginResult = { success: boolean; error?: string }`. SDK writes the token to `~/.kimi/config.toml` on success. (`node_modules/@moonshot-ai/kimi-agent-sdk/dist/index.d.ts:106-121`.)
- **claude-subscription has NO programmatic login.** `@anthropic-ai/claude-agent-sdk` exports no `login()`. The only paths are the interactive CLI: `claude setup-token` (prints a long-lived token, requires a Claude subscription) and `claude auth login` (writes to the macOS Keychain). `claude setup-token --help` shows no non-interactive flag.
- **Browser redirection mechanism already exists:** `openInHostBrowser(url)` (`src/util/browser.ts`) does NOT call `open` locally — it writes `{ type: "open_url", url }` to the signals `emit-event` file; the daemon's ConfigWatcher publishes it to the macOS app, which opens the browser. This is the "UI redirection." Both login flows MUST route browser-opening through `openInHostBrowser`.
- **Availability + reasons already wired** (`src/providers/provider-availability.ts`): `getProviderAvailabilityStatus(provider, probes)` returns `{ available, reason? }` with reasons `missing-cli | not-logged-in | not-enabled | no-api-key`. claude-subscription uses `not-logged-in`; kimi-agent uses `no-api-key`. Caches are bust via `clearClaudeSubscriptionAvailabilityCache()` / `clearKimiAgentAvailabilityCache()`.
- **Vault writes:** `setSecureKeyAsync(...)` / `getProviderKeyAsync(provider)` in `src/security/secure-keys.ts:446/544`.
- **Routes:** shared `ROUTES` array pattern (`assistant/CLAUDE.md`). Handlers are transport-agnostic, return plain data, throw `RouteError` subclasses. Aggregated in `src/runtime/routes/index.ts`. Existing analog: `src/runtime/routes/provider-availability-routes.ts`.
- **macOS UI:** `clients/macos/max-assistant/Features/Chat/ComposerSettingsMenu.swift` already renders `claudeSubscriptionUnavailableRow(reason:)` — a disabled `VMenuItem` with reason-specific trailing text ("Run `claude login`", "Install Claude Code"). This is the row to make actionable. Provider grouping maps `"claude-subscription" → .claudeSubscription`, `"kimi"/"moonshot" → .kimi`; `kimi-agent` is NOT yet mapped (handled in Task 8).
- **No PTY dependency** exists (`shell.ts` uses plain `child_process`; no `node-pty`). This is the central risk for the claude path — see Task 5.

---

## File structure

- **Create** `assistant/src/providers/provider-login.ts` — login orchestration. `loginProvider(provider, { onUrl }): Promise<ProviderLoginResult>`. Dispatches kimi-agent → SDK `login`; claude-subscription → `claude setup-token` capture.
- **Create** `assistant/src/runtime/routes/provider-login-routes.ts` — `POST /v1/provider-login` shared route.
- **Modify** `assistant/src/runtime/routes/index.ts` — import + spread `PROVIDER_LOGIN_ROUTES`.
- **Create** `assistant/src/__tests__/provider-login.test.ts` — unit tests (kimi path mocked SDK; claude path mocked spawn).
- **Create** `assistant/src/__tests__/provider-login-routes.test.ts` — route handler tests.
- **Modify** `clients/macos/max-assistant/.../ProviderLoginClient.swift` (new) or existing client layer — call the route.
- **Modify** `clients/macos/max-assistant/Features/Chat/ComposerSettingsMenu.swift` — actionable "Sign in" rows + kimi-agent mapping.

---

## Task 1: ProviderLoginResult type + module skeleton

**Files:**
- Create: `assistant/src/providers/provider-login.ts`
- Test: `assistant/src/__tests__/provider-login.test.ts`

- [ ] **Step 1: Write failing test for the unsupported-provider branch**

```ts
import { describe, expect, it } from "bun:test";
import { loginProvider } from "../providers/provider-login.js";

describe("loginProvider", () => {
  it("returns success:false with reason for an unknown provider", async () => {
    const result = await loginProvider("openai", { onUrl: () => {} });
    expect(result.success).toBe(false);
    expect(result.reason).toBe("unsupported-provider");
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** — `cd assistant && bun test src/__tests__/provider-login.test.ts` → fails (module/export missing).

- [ ] **Step 3: Implement skeleton**

```ts
import { getLogger } from "../util/logger.js";

const log = getLogger("provider-login");

export type ProviderLoginReason =
  | "unsupported-provider"
  | "cli-error"
  | "cancelled"
  | "no-token-captured"
  | "subscription-required";

export interface ProviderLoginResult {
  success: boolean;
  reason?: ProviderLoginReason;
  error?: string;
}

export interface ProviderLoginOptions {
  onUrl: (url: string) => void;
}

export async function loginProvider(
  provider: string,
  options: ProviderLoginOptions,
): Promise<ProviderLoginResult> {
  switch (provider) {
    case "kimi-agent":
      return loginKimiAgent(options);
    case "claude-subscription":
      return loginClaudeSubscription(options);
    default:
      log.warn({ provider }, "login requested for unsupported provider");
      return { success: false, reason: "unsupported-provider" };
  }
}

// Defined in later tasks.
async function loginKimiAgent(_o: ProviderLoginOptions): Promise<ProviderLoginResult> {
  throw new Error("not implemented");
}
async function loginClaudeSubscription(_o: ProviderLoginOptions): Promise<ProviderLoginResult> {
  throw new Error("not implemented");
}
```

- [ ] **Step 4: Run test, expect PASS.**

---

## Task 2: kimi-agent login via SDK `login({ onUrl })`

**Files:**
- Modify: `assistant/src/providers/provider-login.ts`
- Test: `assistant/src/__tests__/provider-login.test.ts`

- [ ] **Step 1: Write failing tests (mock the SDK)**

```ts
import { afterEach, describe, expect, it, mock } from "bun:test";

const loginMock = mock(async (_opts: { onUrl?: (u: string) => void }) => ({ success: true }));
mock.module("@moonshot-ai/kimi-agent-sdk", () => ({ login: loginMock }));
// Spy on cache-bust so we assert availability is re-evaluated after login.
const clearKimiCache = mock(() => {});
mock.module("../providers/provider-availability.js", () => ({
  clearKimiAgentAvailabilityCache: clearKimiCache,
}));

afterEach(() => { loginMock.mockReset(); clearKimiCache.mockReset(); });

it("kimi-agent: forwards onUrl, returns success, busts availability cache", async () => {
  loginMock.mockImplementation(async ({ onUrl }) => { onUrl?.("https://kimi.com/oauth?x=1"); return { success: true }; });
  const urls: string[] = [];
  const result = await loginProvider("kimi-agent", { onUrl: (u) => urls.push(u) });
  expect(result.success).toBe(true);
  expect(urls).toEqual(["https://kimi.com/oauth?x=1"]);
  expect(clearKimiCache).toHaveBeenCalledTimes(1);
});

it("kimi-agent: maps SDK failure to cli-error with message", async () => {
  loginMock.mockImplementation(async () => ({ success: false, error: "membership inactive" }));
  const result = await loginProvider("kimi-agent", { onUrl: () => {} });
  expect(result).toEqual({ success: false, reason: "cli-error", error: "membership inactive" });
});
```

- [ ] **Step 2: Run tests, expect FAIL** (kimi path throws "not implemented").

- [ ] **Step 3: Implement `loginKimiAgent`**

```ts
import { login as kimiLogin } from "@moonshot-ai/kimi-agent-sdk";
import { clearKimiAgentAvailabilityCache } from "./provider-availability.js";

async function loginKimiAgent(options: ProviderLoginOptions): Promise<ProviderLoginResult> {
  try {
    const result = await kimiLogin({ onUrl: (url) => options.onUrl(url) });
    if (!result.success) {
      return { success: false, reason: "cli-error", error: result.error };
    }
    // Token is now in ~/.kimi/config.toml; re-evaluate availability.
    clearKimiAgentAvailabilityCache();
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, "kimi-agent login threw");
    return { success: false, reason: "cli-error", error: message };
  }
}
```

- [ ] **Step 4: Run tests, expect PASS.**

---

## Task 3: claude `setup-token` I/O — EMPIRICAL VERIFICATION (gate)

> This task is verification, not implementation. The claude token-capture parser in Task 5 cannot be written correctly until the exact I/O of `claude setup-token` is known, and there is no PTY dependency in the repo. **This is the make-or-break gate for the claude path.** If it fails, the claude path falls back to Task 6 (launch-only) and the unified-flow requirement is partially descoped — surface that to the human.

- [ ] **Step 1: Determine TTY requirement.** Run, with a hard timeout so it cannot hang, in a scratch shell:

```bash
# Non-TTY probe: does setup-token refuse without a terminal, or print a URL?
echo "" | timeout 15 claude setup-token 2>&1 | head -40 || true
```

Record: does it (a) error "requires a TTY"/similar, (b) print an OAuth URL to stdout, (c) hang until timeout?

- [ ] **Step 2: If it runs, capture the exact format.** Complete one real login in a terminal and record verbatim (redacting the token value): the line/prefix that carries the OAuth **URL**, and the line/prefix that carries the **token** (e.g. is it `sk-ant-oat...`? on its own line? labelled?). Save these to the architecture note (Task 9) as the regexes Task 5 will use.

- [ ] **Step 3: Decide the mechanism and write it into Task 5's spec before implementing:**
  - If `setup-token` works on a non-TTY pipe → Task 5 uses `child_process.spawn` and parses stdout. No new dependency.
  - If it strictly requires a PTY → escalate to the human: either (a) add `node-pty` (native dep — needs explicit approval), or (b) descope claude to Task 6 (launch interactive `claude auth login`, keep reading the Keychain; Max does not capture the token string).

- [ ] **Step 4: Record the verdict** (mechanism + regexes OR descope decision) in `assistant/docs/architecture/agent-sdk-login.md` (created in Task 9). Do not proceed to Task 5 until this verdict exists.

---

## Task 4: `POST /v1/provider-login` route

**Files:**
- Create: `assistant/src/runtime/routes/provider-login-routes.ts`
- Modify: `assistant/src/runtime/routes/index.ts`
- Test: `assistant/src/__tests__/provider-login-routes.test.ts`

- [ ] **Step 1: Write failing route-handler test**

```ts
import { describe, expect, it, mock } from "bun:test";

const loginProviderMock = mock(async (_p: string, _o: { onUrl: (u: string) => void }) => ({ success: true }));
mock.module("../../providers/provider-login.js", () => ({ loginProvider: loginProviderMock }));
const openInHostBrowser = mock(async (_u: string) => {});
mock.module("../../util/browser.js", () => ({ openInHostBrowser }));

import { handleProviderLogin } from "../runtime/routes/provider-login-routes.js";

it("invokes loginProvider with an onUrl that opens the host browser", async () => {
  loginProviderMock.mockImplementation(async (_p, o) => { o.onUrl("https://x/oauth"); return { success: true }; });
  const result = await handleProviderLogin({ body: { provider: "kimi-agent" } });
  expect(result).toEqual({ success: true });
  expect(openInHostBrowser).toHaveBeenCalledWith("https://x/oauth");
});

it("throws a 400 RouteError when provider is missing", async () => {
  await expect(handleProviderLogin({ body: {} })).rejects.toThrow();
});
```

- [ ] **Step 2: Run test, expect FAIL** (module missing).

- [ ] **Step 3: Implement the route** (mirror `provider-availability-routes.ts` shape; transport-agnostic handler returning plain data, throwing `RouteError`)

```ts
import { loginProvider, type ProviderLoginResult } from "../../providers/provider-login.js";
import { openInHostBrowser } from "../../util/browser.js";
import { BadRequestError } from "./errors.js";
import type { RouteDefinition } from "./types.js";

interface ProviderLoginParams { body?: { provider?: string } }

export async function handleProviderLogin(
  params: ProviderLoginParams = {},
): Promise<ProviderLoginResult> {
  const provider = params.body?.provider;
  if (!provider || typeof provider !== "string") {
    throw new BadRequestError("provider is required");
  }
  return loginProvider(provider, {
    onUrl: (url) => { void openInHostBrowser(url); },
  });
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "providerLogin",
    endpoint: "/v1/provider-login",
    method: "POST",
    handler: handleProviderLogin,
    summary: "Drive an agentic provider's OAuth login and capture the credential",
  },
];
```

> Confirm the exact `RouteError` subclass name (`BadRequestError` vs `InvalidParamsError`) by reading `src/runtime/routes/errors.ts`, and the `RouteDefinition` field set by reading `src/runtime/routes/types.ts`. Use the real names.

- [ ] **Step 4: Register in `index.ts`** — add `import { ROUTES as PROVIDER_LOGIN_ROUTES } from "./provider-login-routes.js";` and spread it into the aggregated array alongside the other `..._ROUTES`.

- [ ] **Step 5: Run tests, expect PASS.** Then `cd assistant && bun test src/__tests__/provider-login-routes.test.ts`.

---

## Task 5: claude `setup-token` token capture (GATED on Task 3 verdict = "non-TTY works" or "PTY approved")

**Files:**
- Modify: `assistant/src/providers/provider-login.ts`
- Test: `assistant/src/__tests__/provider-login.test.ts`

> Use the exact URL/token regexes recorded in Task 3. The test below mocks the spawn boundary; substitute the verified output lines.

- [ ] **Step 1: Write failing test (mock the spawn boundary)** — simulate child stdout emitting the URL line then the token line; assert `onUrl` fired and `setSecureKeyAsync` was called with the captured token, and result is `{ success: true }`.

- [ ] **Step 2: Run test, expect FAIL.**

- [ ] **Step 3: Implement `loginClaudeSubscription`** — spawn `claude setup-token` (via the mechanism Task 3 verified), stream stdout, match the URL line → `options.onUrl(url)`, match the token line → `setSecureKeyAsync` (vault key for `claude-subscription`), then `clearClaudeSubscriptionAvailabilityCache()`. On non-zero exit / no token → `{ success: false, reason: "no-token-captured" | "subscription-required", error }`. Map the "requires subscription" message to `subscription-required`.

- [ ] **Step 4: Run tests, expect PASS.**

---

## Task 6: claude fallback — launch interactive login (only if Task 3 verdict = descope)

> Implement this INSTEAD of Task 5 only if Task 3 concluded `setup-token` needs a PTY and the human declined adding `node-pty`. `loginClaudeSubscription` spawns `claude auth login` detached, returns `{ success: true }` immediately (the CLI manages its own browser + Keychain write); the macOS client then polls availability. No token is captured by Max. Document the descope in Task 9's note.

---

## Task 7: macOS `ProviderLoginClient` (call the route)

**Files:**
- Create: `clients/macos/max-assistant/.../ProviderLoginClient.swift` (place beside the existing provider-availability client; mirror its networking layer)

- [ ] **Step 1:** Read the existing client that calls `/v1/provider-availability` to copy the request pattern (base URL, auth header, JSON decode).
- [ ] **Step 2:** Implement `func login(provider: String) async throws -> ProviderLoginResult` POSTing `{ provider }` to `/v1/provider-login`, decoding `{ success, reason?, error? }`.
- [ ] **Step 3:** Add a `ProviderLoginResult` Codable mirroring the TS shape.

---

## Task 8: macOS composer "Sign in" rows + kimi-agent mapping

**Files:**
- Modify: `clients/macos/max-assistant/Features/Chat/ComposerSettingsMenu.swift`

- [ ] **Step 1:** In `claudeSubscriptionUnavailableRow(reason:)`, when `reason == .notLoggedIn` AND the CLI is present, render an ENABLED row ("Claude (Max Plan) · Sign in") whose action calls `ProviderLoginClient.login("claude-subscription")`, shows an in-progress state, and calls `store.refreshProviderAvailability()` on completion. Keep the disabled row for `.missingCli` ("Install Claude Code") and `.notEnabled`.
- [ ] **Step 2:** Add a `kimi-agent` branch to provider grouping (`providerGroup(for:)` → map `"kimi-agent"` to `.kimi`) and an unavailable/sign-in row for kimi-agent mirroring the claude one: when `providerAvailability["kimi-agent"].available == false` with reason `.noApiKey` and CLI present → enabled "Kimi · Sign in" row calling `ProviderLoginClient.login("kimi-agent")`.
- [ ] **Step 3:** Verify the `open_url` event is already handled by the app (it is used by MCP auth); the browser opens via the existing event path — no new client handling needed. If not handled, wire the `open_url` event to `NSWorkspace.shared.open`.
- [ ] **Step 4:** Build the macOS app and exercise both rows manually (kimi end-to-end; claude per Task 3 verdict). Report results — type-check alone is not sufficient for UI.

---

## Task 9: Architecture note + safe-env check

**Files:**
- Create: `assistant/docs/architecture/agent-sdk-login.md`
- Check: `assistant/src/tools/terminal/safe-env.ts`

- [ ] **Step 1:** Write the architecture note: the unified login flow, the kimi (programmatic) vs claude (CLI) asymmetry, the `openInHostBrowser` redirection mechanism, the Task 3 verdict (mechanism + regexes OR descope), and where credentials land (kimi → `~/.kimi/config.toml`; claude → vault or Keychain).
- [ ] **Step 2:** safe-env: do NOTHING for credential material. The login flow does not introduce a new non-secret env var the agent's child processes need. If Task 5 reads `MOONSHOT_API_KEY`/token material, it stays isolated (NOT added to safe-env).

---

## Self-review checklist (run before final review)

- Spec coverage: kimi programmatic login ✅ (Task 2); claude token capture ✅ (Task 5) or documented descope (Task 6); macOS entry point in composer settings menu ✅ (Task 8); browser redirection via `openInHostBrowser` ✅ (Tasks 2/4).
- Type consistency: `ProviderLoginResult { success, reason?, error? }` identical in TS (Task 1) and Swift (Task 7); reason strings match.
- No placeholders: claude parser regexes come from Task 3's empirical verdict — do not invent them.
- Feature flags: kimi-agent stays behind `kimi-agent-provider` (default-off) until the isolation probe passes; login can still be built/tested behind the flag.
