# Kimi Agent SDK — Session Notes (2026-06-03 → 06-04)

Everything done and discovered this session: the kimi-agent provider, the isolation
breach + fix, enabling it, the app rebuild + crash, running the backend on the
Gigabyte box, and **why "Kimi Agent SDK" doesn't work in the picker**.

---

## TL;DR — why kimi-agent wasn't in the picker (full root cause)

The backend was **fine the whole time** — the live endpoint reports
`kimi-agent -> {available: true}` (flag on, CLI installed, managed login present).
The problem was **two client-side gaps**, now fixed:

**Gap 1 — the macOS picker only renders kimi-agent if a model profile binds it.**
`ComposerSettingsMenu.swift:177-184` surfaces a standalone "Kimi (Agent SDK)" row
*only* when the provider is **unavailable-but-actionable** (to nudge install/sign-in).
When it's **available with no bound profile** (your exact case), that row is suppressed,
and kimi-agent is expected to appear via a profile whose `provider == "kimi-agent"`.
**Every profile you had used `provider: "kimi"`** (the plain chat API) — none pointed at
`kimi-agent` — so the row never rendered. (This is an asymmetry vs `claude-subscription`,
whose empty row shows whenever the provider is merely *reported*.)

**Gap 2 — catalog model id ≠ your CLI's model id.** The Max catalog calls
kimi-agent's model **`kimi-k2.6`** (the api.moonshot.ai name), but your CLI login is the
**managed kimi-code coding plan**, whose model id is **`kimi-code/kimi-for-coding`**.
`kimi --model kimi-k2.6` → **"LLM not set"**; `kimi --model kimi-code/kimi-for-coding`
→ works. So even a correctly-wired profile would fail at inference unless it uses the
CLI's real model id.

**FIX APPLIED (this session):** added profile **`kimi-agent-real`** to your live config
(`llm.profiles`) → `provider: "kimi-agent"`, `model: "kimi-code/kimi-for-coding"`,
label **"Kimi (Agent SDK)"**. Reopen the model picker → it now appears as its own row →
select it. Routes through the real SDK provider on the managed plan (tested working).

### Also note: the OTHER "Kimi Agent SDK" entry is a decoy
The entry labeled **"Kimi Agent SDK"** (no parentheses) under the **Kimi** submenu is a
hand-made profile (`kimi-agent-sdk`) wired to `provider: "kimi"` + connection
`kimi-personal` (your `ak-…` key). That account is **suspended (HTTP 429, insufficient
balance)** — so it and every other plain-kimi profile (`kimi`, `kimi-fast`, `moonshot-*`)
fail on billing. It is **not** the SDK. Ignore it (or delete it / recharge the account).

| Picker entry | What it is | Status |
|---|---|---|
| **"Kimi (Agent SDK)"** (own row, parens) | The **real** SDK provider (`provider: kimi-agent`), now bound via the `kimi-agent-real` profile | ✅ Works — managed kimi-code plan |
| **"Kimi Agent SDK"** (Kimi submenu, no parens) | Decoy profile on `provider: kimi` + suspended `ak-` key | ❌ 429 billing |

### Picker fix — APPLIED (2026-06-04)
1. **Regenerated the client catalog** (`bun assistant/scripts/sync-llm-catalog.ts`) →
   `clients/shared/Resources/llm-provider-catalog.json` now includes kimi-agent
   (`kimi-k2.6` / "Kimi K2.6 (agent)"); the submenu was empty because the bundled catalog
   was stale.
2. **Provider model fix** (`client.ts`): only forward `--model` when a `MOONSHOT_API_KEY`
   is set; otherwise omit it so the CLI uses its `default_model`. Fixes the
   `kimi-k2.6` → "LLM not set" failure on the managed plan. Test updated; 54 kimi tests pass.
3. **Bound a profile** `kimi-agent-real` (`provider: kimi-agent`, `model: kimi-k2.6`) so
   the row renders.
4. **Rebuilt + relaunched** the app with full PATH. Verified: daemon PATH has
   `~/.local/bin`, `kimi-agent` available, bundle catalog includes kimi-agent.
   → Reopen picker → **"Kimi (Agent SDK)" → "Kimi K2.6 (agent)"** is selectable and works.

Still-open (optional): make the picker surface kimi-agent whenever the daemon *reports*
it (mirror `includeEmptyClaudeSubscription`) so no bound profile is needed.

## Which model is it actually using?
**Kimi K2.6**, model id `kimi-code/kimi-for-coding` (display "Kimi-k2.6"), 256K context,
on the **managed kimi-code coding plan** — driven by the **Kimi Code CLI agentic runtime**
(the "Agent" mode). **Thinking is OFF through Max** (provider passes `thinking: false`,
though the CLI default is on). **No Agent Swarm / subagents** (provider sets
`subagents: {}`). Not "Instant" (a separate fast model). Optional follow-up: make
`thinking` read from the profile so K2.6 Thinking can be used in Max (needs a rebuild).

## Skill created
`skills/kimi-agent/SKILL.md` (display "Kimi Agent SDK", user-invocable) — a reference for
Kimi K2.6 + the Kimi Code CLI/SDK: model capabilities, built-in tools, CLI/SDK features,
how Max's provider uses them, and gotchas (installed CLI is 1.12.0 vs latest ~1.46.0;
managed-plan model id; thinking off; etc.). Registered via
`node scripts/skills/generate-catalog.mjs` (66 skills, validates clean).

---

## 1. What the kimi-agent provider is

A real LLM provider (`id: "kimi-agent"`, displayName **"Kimi (Agent SDK)"**) that drives
`@moonshot-ai/kimi-agent-sdk` (the Kimi Code CLI) as an in-process agentic runtime,
mirroring the `claude-subscription` provider. Tool calls bridge to Max's ToolExecutor
via the SDK's `externalTools`. Auth = the kimi CLI's managed `kimi-code` OAuth login
(`~/.kimi/`), **not** a Moonshot `ak-`/`sk-` API key.

Code-complete before this session (client, errors, catalog, factory, flag, tests, docs).

---

## 2. Isolation breach — FOUND and FIXED (the core work)

### The breach
The provider's only containment was rejecting non-allowlisted tools at the SDK's
`ApprovalRequest` event. But verified against the installed kimi-cli 1.12.0 source:
**only 3 of 9 built-ins emit an `ApprovalRequest`** (`Shell`, `WriteFile`,
`StrReplaceFile`). The other six — `ReadFile`, `ReadMediaFile`, `Glob`, `Grep`,
`FetchURL`, `SearchWeb` — **run ungated**, bypassing Max's ToolExecutor /
permission / audit layer entirely (a forced probe read `/etc/hosts` ungated).

It was a **false negative, not a regression**: `read.py` never had an approval call on
any version. The 2026-06-02 "PASS" only ever exercised `Shell` (which *is* gated).

### The fix (HYBRID posture — your choice)
kimi-cli builds its tool set from the agent spec's **positive `tools` allowlist**
(`kimi_cli/soul/agent.py` → `toolset.load_tools`); an omitted built-in is never
registered → `ToolNotFoundError`. The provider now **always** writes a restrictive
`agentFile` (`assistant/src/providers/kimi-agent/agent-file.ts`):

- **Enabled** (native, for performance): `ReadFile`, `ReadMediaFile`, `Glob`, `Grep`
- **Excluded** → routed through Max's audited tools: `Shell`, `WriteFile`,
  `StrReplaceFile` (write/exec) and `FetchURL`, `SearchWeb` (network)
- **`subagents: {}`** (no `Task` subagent — its default `sub.yaml` wouldn't exclude the unsafe tools)
- The approval-deny loop is kept as defense-in-depth (it also rejects ambient MCP tools)

**Security argument:** ungated native *reads* are acceptable **because the egress tools
are unreachable** — an injected "read `~/.ssh/id_rsa`" has no way to leave through kimi's
own tools. Residual exfil channels by design: the model's own output, and any
network-capable Max `externalTool` the caller passes. Rests on **trusted, single-user,
local** use.

**Also fixed a latent bug:** the old code wrote the system prompt as raw `.md` into
`agentFile` (which expects a YAML spec → `yaml.safe_load` mis-parses). Now writes a real
`agent.yaml` + a sibling `system.md`, wrapped in `{% raw %}` (kimi renders prompts via
Jinja2 `StrictUndefined`, `${VAR}` syntax).

### Verification
- 93/93 kimi tests pass · `tsc` clean (only the pre-existing unrelated `backfill.ts` error)
- Live probe `scripts/kimi-agent/isolation-agentfile.mjs` **3/3 PASS**: only the
  allowlisted read tools + the bridged tool execute; `Shell`/`FetchURL`/ambient MCP
  (`browser_navigate`) all unreachable; no host side-effect.

### Ambient MCP (hygiene, not a hole)
kimi-cli auto-loads `~/.kimi/mcp.json` (github/playwright/canva/context7) into every
session, independent of the `tools` allowlist. **Contained** because every `MCPTool`
calls `approval.request()` → rejected by the approval-deny loop. Residual is perf
(npx subprocess spawn per session), not security. Suppressing it would need an
`executable` wrapper passing `--mcp-config-file <empty>` (the SDK's fixed `buildArgs`
can't) — optional follow-up.

### Files changed
- `assistant/src/providers/kimi-agent/agent-file.ts` (NEW — the allowlist + spec writer)
- `assistant/src/providers/kimi-agent/client.ts` (always write restrictive agentFile; native names in approval allowlist)
- `assistant/src/providers/kimi-agent/__tests__/agent-file.test.ts` (NEW)
- `assistant/src/__tests__/kimi-agent-provider.test.ts` (updated assertions)
- `assistant/scripts/kimi-agent/isolation-agentfile.mjs` (NEW — live hybrid probe)
- `assistant/docs/architecture/kimi-agent-bridge.md` (breach + fix recorded)
- `meta/feature-flags/feature-flag-registry.json` (+ synced assistant/gateway copies)

---

## 3. Feature flag

`kimi-agent-provider` set to **`defaultEnabled: true`** in the canonical
`meta/feature-flags/feature-flag-registry.json` and synced to the assistant + gateway
copies (`bun meta/feature-flags/sync-bundled-copies.ts`). Flag/sync guard tests pass.
Roll back = flip to `false` + restart daemon.

> ⚠️ This means the provider is default-ON for **all** users. If you'd rather it be
> opt-in, flip `defaultEnabled` back to `false` (one line).

---

## 4. App rebuild + the crash you saw

Ran `/update` (Case D — branch `master`, no git pull, rebuilt from the working tree so
the uncommitted fix is preserved). Services healthy, app relaunched (the bundle has
`kimi-agent-provider: true`).

**The crash report (`max`, `CODESIGNING, Code 2, Invalid Page`) was benign:** it was the
**old** app instance (pid 709, running since the previous day) getting killed when
`build.sh` replaced + re-signed the `max` binary underneath it. A fresh, correctly-signed
instance launched right after and is healthy.

**Root cause of the crash:** the `/update` skill's stop step uses
`pkill -f "Max.*\.app/Contents/MacOS/"`, which does **not** match this dev bundle
(`max.app` / binary `max`), so the old app was never stopped before the rebuild.
**Suggested fix:** broaden the skill's pattern to also match `max.app`/`max`.

---

## 5. Running the backend on the Gigabyte AI TOP ATOM (remote, Option B)

**Verdict:** viable for the **macOS app** (the web app's remote auth adapter is an empty
scaffold — not usable yet). Both risky assumptions were adversarially confirmed:
ARM64 images are published multi-arch, and self-hosted remote-connect is a real
supported client path.

**On the Gigabyte** (install the Max CLI there):
```bash
export OLLAMA_BASE_URL=http://host.docker.internal:11434/v1   # NOT localhost (container-local)
max hatch --remote docker --name gigabyte
```
Pulls the 3 arm64 images (`maxai/max-{assistant,gateway,credential-executor}`),
creates network + 6 volumes + secrets, starts **assistant + gateway + CES** (CES is
**mandatory**), leases a guardian token. Gateway = **:7830** (only port to expose);
assistant runtime = :7821 (internal).

**On the Mac:**
```bash
ssh -N -L 7830:localhost:7830 you@gigabyte                    # same as your Ollama tunnel
# add to ~/.max.lock.json "assistants":
#   { "assistantId": "gigabyte", "cloud": "docker", "runtimeUrl": "http://localhost:7830" }
max use gigabyte
scp you@gigabyte:~/.config/max/assistants/gigabyte/guardian-token.json \
    ~/.config/max/assistants/gigabyte/guardian-token.json
curl -i http://localhost:7830/readyz                          # expect 200
```

**Gotchas:** web app not supported yet; no push-button bare-SSH deploy
(`max hatch --remote custom` is "not yet supported"); set `RUNTIME_HTTP_PORT=7821`
explicitly if hand-running containers; Ollama from inside the container =
`host.docker.internal`, not `127.0.0.1`; inbound webhooks need a public tunnel, not `ssh -L`.

---

## 6. Open items / billing

- **Moonshot personal account suspended** (`ak-fa5q…`, insufficient balance) → blocks the
  plain `kimi` chat profiles incl. the mislabeled "Kimi Agent SDK" one. Recharge or
  replace if you want those.
- **Managed `kimi-code` plan = active** (tested) → the real **"Kimi (Agent SDK)"** works.
- Nothing here is committed yet — the kimi-agent fix is in the working tree (branch `master`).
- Optional follow-ups: fix the `/update` pkill pattern; suppress ambient MCP loading;
  decide flag default-on vs opt-in.

## 2026-06-04 additions

### Tool-produced images reach the model
The SDK external-tool handler return is string-only, but K2.6 IS multimodal (proven: it
read back the secret `TEAL-OWL-9173` from a test image via `ReadMediaFile`). Fix:
`combineBridgeOutput` (`client.ts`) saves tool image/PDF/video to `<tmpDir>/tool-media/`
and appends *"You MUST call ReadMediaFile with this path"* — the model loads it within the
same turn via the allowlisted native `ReadMediaFile`. Additive (cross-turn tool media
already flowed via the prompt). Lets the kimi-agent model SEE `max-browser-use`
screenshots.

### K2.6 mode picker (Instant / Thinking / Agent)
The "Kimi (Agent SDK)" submenu now lists three modes (like claude-subscription's models):
- **K2.6 Instant** — reasoning off (the prior default).
- **K2.6 Thinking** — reasoning **on**; thinking streams to the UI.
- **K2.6 Agent** — reasoning on + 2× step budget (50) + autonomy nudge.

A `KIMI_MODE_CONFIG` table in `client.ts` maps each fabricated picker id → real model
(`kimi-k2.6`) + `thinking` + `maxTurns` + optional system nudge; the picker id is never
forwarded to `createSession({model})` (would fail on the API-key path). Catalog regenerated
(`bun assistant/scripts/sync-llm-catalog.ts`). **Agent Swarm intentionally NOT added** — no
SDK lever; re-enabling subagents would reopen the isolation hole; it is kimi.com-hosted
only. 99 kimi tests pass.
