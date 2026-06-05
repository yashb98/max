# LLM-Driven Ollama Setup — Design Doc

**Status:** Draft for review (plan only — no implementation)
**Date:** 2026-05-19
**Goal:** Detect when Ollama is not reachable, and let the user trigger an LLM-driven setup flow that uses whichever Claude/Kimi/OpenAI/Gemini provider they already have configured to install Ollama locally or set up an SSH tunnel to a remote Ollama, by taking screenshots, typing into Terminal, and verifying success.

> This is the v1 design for what the user described as "ask us to connect the local ollama or ssh tunnel by itself, using the computer use". The Ollama auto-discovery feature (spec `2026-05-16-ollama-auto-discovery-design.md`) covers the happy path once Ollama is reachable. This doc covers the *unhappy path*: what happens when it isn't.

---

## Problem

Today, when the Ollama daemon isn't reachable, the picker shows an "Ollama offline" status row (post-Phase C of auto-discovery) but offers no path to fix it. The user has to remember how to:

- install Ollama (`brew install ollama` or download), and `ollama serve`, OR
- open a Terminal and run `ssh -N -L 11434:localhost:11434 user@host` against the remote machine running Ollama

For new users (and for the principal user after a reboot when their tunnel dropped), this is friction. The goal is: one click in the macOS app, and the LLM walks the user through (or autonomously executes) the setup.

## Scope (v1)

**In scope:**
- Two recipes: "install local Ollama" (`brew` route) and "open SSH tunnel" (uses an SSH config the user already has, OR asks for host/user/remote port).
- Provider-agnostic: works with whichever LLM the user has currently selected as their active inference profile, *if that provider supports computer-use*.
- Permission grant flow for macOS Accessibility / Screen Recording (one-time prompt).
- Stream progress events to the macOS app so the user can watch the LLM work.
- Auditable: every action is logged with a screenshot, so a curious user (or a security review) can replay the session.

**Out of scope (v1):**
- Provider auto-fallback ("if Anthropic is rate-limited, try OpenAI"). User picks one provider; the recipe runs there.
- Generalizing the recipe engine to non-Ollama tasks (deferred to v2 — see §11).
- Headless execution. The macOS app must be focused for screenshots and keyboard control.

## Glossary

| Term | Meaning |
|---|---|
| **Action** | A single primitive operation the LLM emits: `screenshot`, `click(x, y)`, `type("text")`, `key("ctrl+t")`, `wait(ms)`, `scroll(±n)`. |
| **Adapter** | Provider-specific translation between the abstract `Action` and the provider's native computer-use tool schema. |
| **Session** | One execution of a recipe by one LLM-provider pairing. Has a fixed turn budget and a deterministic end (success / abort / budget exceeded). |
| **Recipe** | A high-level goal expressed as (system prompt + verification predicates + safety policy). Currently two recipes: `install-local-ollama`, `open-ssh-tunnel`. |
| **Verifier** | A pure-function check that runs against external state (Ollama API reachable, tunnel process alive) to decide if the recipe is done. |

## Provider landscape (what each one supports)

| Provider | Computer-use? | API surface | Notes |
|---|---|---|---|
| **Anthropic** | Yes — native | `computer_20250124` tool + `bash_20250124` tool, used inside a normal `messages.create` agentic loop. Models: Opus 4.x, Sonnet 4.x. | Most mature. Has separate `bash` and `text_editor` tools that can be safer than driving Terminal via screenshots. |
| **OpenAI** | Yes — preview | `computer-use-preview` tool, region-gated, `gpt-4o`-class. Action shape similar to Anthropic. | Newer, less reliable on macOS than Anthropic. Tool schema differs in field names. |
| **Gemini** | Yes — preview | `gemini-2.5-computer-use` model with structured `Action` JSON output. | Different mental model: returns predicted next action as a JSON object, no agent loop on Google's side. |
| **Kimi / Moonshot** | No first-party computer-use | OpenAI-compatible function calling + vision (kimi-k2.6 has vision). | Would require wrapping with a custom action loop: vision prompt → text output → parse → execute → re-screenshot. Lower fidelity than first-party tools. **Recommend NOT supporting in v1**, surface a clear "not supported" message when the user's active provider is Kimi. |
| **Ollama** | No computer-use | Local models, vision varies. No first-party tool schema for action emission. | Same constraint as Kimi. **Recommend NOT supporting in v1**. (Bootstrapping Ollama with Ollama is also chicken-and-egg.) |

**v1 supported set:** Anthropic, OpenAI, Gemini. The flow gracefully degrades for Kimi / Ollama users with a "your provider doesn't support setup automation — here are the manual steps" panel.

## Architecture

Four layers, bottom up:

```
┌─────────────────────────────────────────────────────────┐
│  Recipe (install-local-ollama | open-ssh-tunnel)         │  Layer 4
│  - System prompt                                          │
│  - Verifier (external state predicate)                    │
│  - Safety policy (allow/deny action lists)                │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│  Session                                                  │  Layer 3
│  - Turn loop: take screenshot → ask LLM → execute action │
│    → verify → repeat                                      │
│  - Turn budget, abort conditions                          │
│  - Event stream (for UI)                                  │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│  Provider adapters                                        │  Layer 2
│  - Anthropic / OpenAI / Gemini                            │
│  - Each translates abstract Action ↔ native tool schema  │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│  Action primitives + macOS executor                       │  Layer 1
│  - screenshot, click, type, key, scroll, wait             │
│  - Native CGEvent / ScreenCaptureKit on macOS             │
│  - Permission gates (Accessibility, Screen Recording)     │
└─────────────────────────────────────────────────────────┘
```

The recipe is the only Ollama-specific thing. Layers 1–3 are general computer-use infrastructure that future v2 recipes can reuse.

### Layer 1: Action primitives + executor

A single Swift module in the macOS app (NOT in the daemon — keyboard/mouse control and screenshots are macOS APIs that require running in the user's UI session):

`clients/macos/vellum-assistant/Features/ComputerUse/ActionExecutor.swift`

```swift
public enum ComputerAction {
    case screenshot
    case click(x: Int, y: Int, button: MouseButton)
    case type(text: String)
    case key(combo: String)  // "cmd+t", "return", "esc"
    case scroll(dx: Int, dy: Int)
    case wait(ms: Int)
}

public enum ActionResult {
    case ok
    case screenshot(Data, width: Int, height: Int)  // PNG bytes
    case denied(reason: String)
    case error(message: String)
}

public protocol ActionExecutor {
    func execute(_ action: ComputerAction) async -> ActionResult
}
```

Implementation uses:
- **Screenshots:** `ScreenCaptureKit` (modern, sandboxed, no deprecation warnings).
- **Mouse:** `CGEvent` with `CGEventCreateMouseEvent` + `kCGEventMouseMoved/LeftMouseDown/Up`.
- **Keyboard:** `CGEvent` with key-code translation via `Carbon` framework's `UCKeyTranslate` (need to handle non-ASCII via `setUnicodeString`).

Permission gates:
- Screen Recording → `CGRequestScreenCaptureAccess()`, surfaced as a one-time onboarding modal.
- Accessibility (needed for sending events to other apps) → `AXIsProcessTrusted()` check + `AXIsProcessTrustedWithOptions` prompt; on first decline, point the user at System Settings → Privacy & Security → Accessibility and re-check on app foreground.

### Layer 2: Provider adapters

In the daemon, since the LLM calls go through the daemon's existing provider plumbing (auth, rate-limiting, retry).

`assistant/src/providers/computer-use/`
- `adapter.ts` — abstract interface
- `anthropic-adapter.ts` — uses `computer_20250124` tool
- `openai-adapter.ts` — uses `computer_use_preview` tool
- `gemini-adapter.ts` — uses `gemini-2.5-computer-use` with structured output

```ts
export interface ComputerUseAdapter {
  /**
   * Send the current conversation + a screenshot to the LLM, get back the
   * next action (or done signal).
   *
   * Returns either the next Action for the executor to run, or a "done"
   * signal with a natural-language summary.
   */
  nextAction(input: {
    systemPrompt: string;
    history: ChatTurn[];
    latestScreenshot: { data: Buffer; width: number; height: number };
    allowedActions: ReadonlySet<ActionKind>;
  }): Promise<AdapterStep>;
}

export type AdapterStep =
  | { kind: "action"; action: ComputerAction; rationale: string }
  | { kind: "ask-user"; question: string }  // for clarifications mid-flow
  | { kind: "done"; summary: string };
```

Each adapter knows ONE provider's native tool schema and translates `ComputerAction` ↔ that schema. The session layer above doesn't know which provider it's talking to.

**Daemon ↔ macOS app split:** the *adapter* runs in the daemon (TS). The *executor* runs in the macOS app (Swift). They communicate over the existing IPC channel:
- macOS sends a screenshot → daemon
- Daemon asks the LLM, gets next action → sends action back to macOS
- macOS executes, captures new screenshot → daemon
- Loop

This split is important because:
- macOS app has the screen + keyboard control APIs
- Daemon has the LLM credentials + retry / rate-limiting plumbing
- We already have a working IPC channel between them

### Layer 3: Session

`assistant/src/providers/computer-use/session.ts`

```ts
export interface SessionOptions {
  recipe: Recipe;
  adapter: ComputerUseAdapter;
  ipcClient: MacOSAppIpcClient;
  maxTurns: number;          // default 30
  maxWallClockMs: number;    // default 5 * 60_000
}

export class ComputerUseSession {
  /**
   * Drives the agentic loop until the recipe's verifier returns true OR
   * the budget is exhausted OR the user cancels OR a safety guard fires.
   *
   * Emits SessionEvent on the existing event bus so the UI can render
   * progress (current action, latest screenshot thumbnail, elapsed turns).
   */
  async run(signal: AbortSignal): Promise<SessionOutcome>;
}

type SessionOutcome =
  | { kind: "success"; recipe: string; turns: number; elapsedMs: number }
  | { kind: "user-aborted"; reason: string }
  | { kind: "budget-exceeded"; turns: number; elapsedMs: number }
  | { kind: "safety-deny"; action: ComputerAction; reason: string }
  | { kind: "verifier-timeout"; turns: number }
  | { kind: "provider-error"; error: string };

interface SessionEvent {
  ts: string;
  kind:
    | "action-proposed"  // LLM said "do this"
    | "action-executed"  // macOS ran it
    | "screenshot"       // new frame captured
    | "verifier-checked" // recipe's verifier ran
    | "ask-user"         // LLM wants user input
    | "outcome";
  payload: unknown;
}
```

**Turn budget = 30, wall clock = 5 min.** These are sized for the recipes we're shipping:
- `install-local-ollama` (brew install + start service) is ~6–10 steps in practice.
- `open-ssh-tunnel` is ~4–7 steps.
- Doubling that for slop gives us 30 turns; users can extend via Settings if they need to.

**Safety policy** lives on the recipe (Layer 4). The session enforces it: any action emitted by the LLM that isn't in the recipe's `allowedActions` set gets dropped, logged, and the session aborts with `safety-deny`. This is the load-bearing safety mechanism — see §7 below.

### Layer 4: Recipes

`assistant/src/providers/computer-use/recipes/`
- `install-local-ollama.ts`
- `open-ssh-tunnel.ts`
- `types.ts` (shared `Recipe` interface)

```ts
export interface Recipe {
  id: string;                    // "install-local-ollama"
  displayName: string;
  systemPrompt: string;          // LLM-facing instructions
  allowedActions: ReadonlySet<ActionKind>;
  allowedKeyCombos?: ReadonlySet<string>;   // narrower than allowedActions
  bannedPatterns?: RegExp[];     // text patterns the LLM is not allowed to type
  verifier: () => Promise<{ done: boolean; reason?: string }>;
  parameters?: RecipeParam[];    // user-supplied inputs (e.g. SSH host)
}
```

#### Recipe: `install-local-ollama`

- **Pre-flight:** check `brew --version`. If `brew` isn't installed, the recipe aborts early with a "Homebrew is required" panel and a one-click link to https://brew.sh. (We don't try to install Homebrew via computer-use; too risky.)
- **System prompt:** "You are helping the user install Ollama on their Mac. Open Terminal (Spotlight: Cmd+Space, type 'Terminal', return). Run `brew install ollama`. When that finishes, run `brew services start ollama`. Verify by running `ollama --version`. Stop when the version prints."
- **Allowed actions:** `screenshot`, `click`, `type`, `key` (limited to `cmd+space`, `return`, `esc`, alphanumeric typing).
- **Allowed key combos:** explicit allowlist — `cmd+space`, `return`, `esc`. No `cmd+q`, no `cmd+w`.
- **Banned patterns:** `rm -rf`, `sudo`, `curl ... | sh`, anything matching `>\s*/`. If the LLM proposes typing any of these, the session aborts.
- **Verifier:** the daemon polls `127.0.0.1:11434/api/version` every 5s. When it returns 200, the recipe is done.

#### Recipe: `open-ssh-tunnel`

- **Parameters (user-supplied via form before session starts):**
  - `sshHost: string` (e.g. `192.168.0.188`)
  - `sshUser: string` (e.g. `yashb98`)
  - `remotePort: number` (default 11434)
  - `localPort: number` (default 11434)
  - `identityFile?: string` (path to private key, optional — defaults to ssh-agent)
- **Pre-flight:** check `ssh -V` exists (basically guaranteed on macOS).
- **System prompt:** "You are helping the user open an SSH tunnel to a remote Ollama. Open Terminal. Type exactly: `ssh -N -L {localPort}:localhost:{remotePort} {sshUser}@{sshHost}` and press Return. If a password prompt appears, do NOT try to type a password — emit an `ask-user` step requesting the password. Wait for the SSH connection to establish. The verifier will tell you when it's done."
- **Allowed actions:** `screenshot`, `click`, `type`, `key` (allowlist: `cmd+space`, `return`, `esc`).
- **Banned patterns:** anything that's not the literal SSH command interpolated with the user's params. We enforce this by template-checking the LLM's proposed `type` action — the first `type` call must equal the exact computed command string. Subsequent `type` calls aren't permitted in the happy path.
- **Verifier:** daemon polls `127.0.0.1:{localPort}/api/version` every 5s. When 200, recipe is done.
- **Ask-user escape hatch:** if SSH prompts for a password and the LLM emits `ask-user`, the session pauses, the macOS app shows a secure password field, the user types, we send the password back to the LLM via the next message (NOT typed via computer-use, to avoid screen-recording capture), the LLM continues with one `type` of the password followed by `return`.

## Data flow (end-to-end)

```
User clicks "Set up Ollama" in picker offline-notice
   │
   ▼
macOS shows recipe picker [install local | open tunnel]
   │
   ▼
User picks "open tunnel", fills form, clicks Connect
   │
   ▼
macOS sends start-session RPC to daemon:
   { recipe: "open-ssh-tunnel", params: {...}, providerProfile: activeProfile }
   │
   ▼
Daemon spawns ComputerUseSession with the right adapter for the active provider
   │
   ▼  ┌────────────────────────────────────────────────────────────────┐
   │  │ session.run() loop:                                             │
   │  │   1. Ask macOS for screenshot                                   │
   │  │   2. Send (system prompt + history + screenshot) to LLM         │
   │  │   3. Parse next action                                          │
   │  │   4. Safety check (allowed action? banned pattern?)             │
   │  │   5. If allowed: send action to macOS executor                  │
   │  │   6. Wait for action result                                     │
   │  │   7. Verifier check: is Ollama reachable?                       │
   │  │   8. If yes → done. If no → loop. If budget exhausted → abort.  │
   │  └────────────────────────────────────────────────────────────────┘
   │
   ▼
Session events streamed to macOS app over existing WS channel
   │
   ▼
macOS app renders progress: current step, latest screenshot thumbnail, elapsed
   │
   ▼
On success: daemon updates `ollama-personal` connection's reachable flag,
            discovery service ticks immediately, auto profiles appear in picker
```

## Safety policy (the most important section)

Driving keyboard and mouse from an LLM is a real foot-gun. Mitigations:

1. **Allowlist actions, not denylist.** Recipes declare exactly which actions and key combos are permitted. Anything else from the LLM = `safety-deny` + session abort. Default-deny.

2. **Template-checking dangerous strings.** For the SSH recipe, the FIRST `type` action must equal the computed command exactly. We compute it server-side and compare to what the LLM proposes. If they don't match, abort. The LLM doesn't get free-form typing into Terminal.

3. **Banned-pattern regexes.** Even within `type` actions, we scan for `rm -rf`, `sudo`, pipe-to-shell patterns, redirect-to-root. These never reach the executor.

4. **Per-session budget.** 30 turns / 5 minutes. Hard cap. A confused LLM in a loop can't burn $50 of API credits and tab through every app on the machine.

5. **Wall-clock visibility.** The macOS app shows a live ticker. User can hit Cancel at any moment, which raises the AbortSignal and the executor refuses any in-flight action.

6. **Screenshots are scoped.** v1 captures the FULL screen. v2 should consider capturing only the active window — but that adds complexity. Document that the LLM will see whatever's on screen during the session, so users should close their banking tab.

7. **Audit log.** Every action proposed (whether executed or denied) is written to `~/.local/share/vellum-dev/.../workspace/data/logs/computer-use-<sessionId>.jsonl` with a thumbnail of the screenshot at decision time. A user (or a security review) can replay the session post-hoc.

8. **No persistent state.** Sessions are stateless across runs. The LLM never sees past sessions' screenshots. Each recipe execution is a fresh agent.

9. **Provider key isolation.** The LLM doesn't see the user's other API keys, OAuth tokens, or workspace contents. The system prompt mentions only the recipe goal; the message history contains only screenshots + proposed actions.

## UX touchpoints (changes to existing surfaces)

| Surface | Change |
|---|---|
| `ComposerSettingsMenu` Ollama-offline row | Becomes clickable. Opens the recipe picker sheet. |
| New: `OllamaSetupSheet.swift` | Two cards: "Install Ollama locally" / "Connect to remote via SSH". On click, advances to form (SSH) or starts session immediately (install). |
| New: `ComputerUseSessionView.swift` | Live progress: current action, latest screenshot thumbnail, turns / elapsed, Cancel button, scrollable event log. |
| Settings → Providers | New "Computer-use" section explaining what it does, which providers support it, with a permissions status (Screen Recording / Accessibility granted or not). |
| `~/.vellum/preferences` | New keys: `computerUse.enabled` (default `false`, opt-in), `computerUse.maxTurns`, `computerUse.maxWallClockMs`. |

## Why opt-in default

Driving mouse and keyboard from an LLM is high-leverage and high-risk. v1 ships with `computerUse.enabled: false`. Users opt in via Settings the first time they want to use it. The opt-in flow includes:

- A 1-page explainer of what computer-use does + what could go wrong.
- The permission grant flow (Screen Recording + Accessibility).
- A "what providers support this" table that mirrors §provider-landscape above.
- The default safety policy summary.

After opting in, the offline-notice row in the picker becomes clickable.

## Decomposition into sub-projects

This is a big enough build to warrant breaking it into shippable phases. Each phase produces a working artifact even if subsequent phases are deferred.

### Phase 1 — Foundations (largest)
- Action primitives + executor (Layer 1, Swift, macOS)
- Permission-grant flow (one-time modal + status display)
- IPC schema for start-session, action-proposed, action-executed, session-event
- Sub-deliverable: a debug menu that lets you fire individual actions (click x,y; type "foo") without an LLM. Confirms the executor works.

### Phase 2 — Single-provider session (Anthropic only)
- Adapter for Anthropic computer-use
- Session loop with budget + safety policy enforcement
- `install-local-ollama` recipe + its verifier
- UX: setup sheet + session-progress view
- Ships as: "Install Ollama" button in the offline notice, Anthropic-only.

### Phase 3 — SSH-tunnel recipe
- `open-ssh-tunnel` recipe + form + verifier
- Ask-user escape hatch for SSH password
- Audit log

### Phase 4 — Multi-provider
- Adapters for OpenAI computer-use-preview and Gemini computer-use
- "Provider not supported" fallback panel for Kimi / Ollama / unsupported

### Phase 5 (out of v1) — Generalize the recipe engine
- Recipe registry, third-party recipes via plugins
- Cross-recipe composition

## Open questions for the user (before starting Phase 1)

1. **Default-on or default-off?** I assumed opt-in default. Worth confirming — defaulting to on would mean users opt OUT, which is more invasive but less friction.
2. **Single-provider or multi-provider in v1?** If you want to ship faster, single-provider (Anthropic, since it's the most mature) is half the build.
3. **Where to store opt-in state?** Per-workspace (workspace config) or per-app (`~/Library/Preferences`)?
4. **Local Ollama recipe — `brew` or download?** `brew install ollama` is one path. The other is downloading the `.dmg` from ollama.com and dragging to Applications. The brew route is more deterministic; the dmg route works for users without Homebrew.
5. **Cancel semantics during a tool call?** If the user clicks Cancel mid-`type`, do we let the partial text stand or try to undo it? Default: let it stand — undo is brittle.
6. **Telemetry?** Do we measure how often sessions succeed / fail / time out / get cancelled? If yes, anonymous metrics format TBD.

## Estimated effort

Hand-wavy ranges, assuming one engineer at our quality bar:

| Phase | Engineer-days |
|---|---|
| Phase 1 (foundations) | 5–8 |
| Phase 2 (Anthropic + install recipe) | 4–6 |
| Phase 3 (SSH-tunnel recipe) | 3–4 |
| Phase 4 (multi-provider) | 5–7 |
| **Total v1** | **17–25 engineer-days** |

This is a real product feature, not a weekend build. If the user wants a smaller step that delivers value sooner, ship just Phases 1 + 2 — that already covers the most common case (new user, no Ollama installed, has an Anthropic key) and the rest can land incrementally.

## What this does NOT replace

- The Phase B auto-discovery work (already shipped). That continues to be the steady-state once Ollama IS reachable. This feature is purely a one-time setup helper.
- The eventual `baseUrl` column on the connections table — for users who want a permanent remote Ollama (instead of an SSH tunnel they re-establish each session), we still need that column. Adding it is a small follow-up to auto-discovery, not bundled here.
- Manual Settings entry — the user can still type SSH params into Settings without using the LLM-driven flow. The LLM-driven flow is a convenience, not a requirement.

---

## Next step

Brainstorm the open questions in §10 with the user, then write a per-phase implementation plan (`docs/superpowers/plans/2026-MM-DD-llm-driven-ollama-setup.md`) for whichever phases get prioritized.
