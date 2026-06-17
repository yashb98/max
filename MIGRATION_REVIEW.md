# Vellum → Max migration — review (2026-06-14)

> **UPDATE 2026-06-16 — feature-test failures fixed.** Beyond the rebrand
> verification below, on request I also fixed the pre-existing kimi-agent /
> claude-subscription test failures that were safe to fix. **Fixed + verified green
> (9 assistant files + the 8 packages from earlier):** `inference` (ran migration
> 247 in test setup → reachable column), `disk-pressure-tools` (mock the new
> `activateBridgedSkill` export), `openai-responses-cutover-guard` (scoped the
> ban to the openai entry so kimi/Moonshot's legit OpenAIChatCompletionsProvider
> isn't flagged), `provider-registry-ollama` + `provider-platform-proxy-integration`
> + `secret-routes-platform-proxy` (filter the always-on defaultEnabled cli-login
> providers claude-subscription/kimi-agent from the managed-set assertions),
> `guard-tests` (added `provider-availability`→settings.read / `provider-login`→
> settings.write route-policy entries, matching sibling provider endpoints,
> fail-closed), `conversation-history-web-search` (added `web_search_tool_result`
> handling alongside `tool_result` in the kimi-agent + claude-subscription
> `textOf`/media flatteners), `llm-resolver` (point the test at the anthropic-only
> `claude-opus-4-6` instead of the now-ambiguous `claude-haiku-4-5`). Full assistant
> typecheck stays at **0 errors** after the source edits.
>
> **Deliberately NOT fixed (need the feature owner's decision, not the rebrand):**
> `kimi-agent-provider` ×5 — the working tree raised `MAX_TURNS` 80/95 → 100000 and
> removed the clamp; a cap of 100000 makes the step-cap tests untestable, so 100000
> looks like a debug leftover. If it's final, delete/rewrite the cap tests; if temp,
> revert it and the 5 tests pass — your call, I won't mask or revert it.
> `shell-credential-ref` ×1 — credential-ref resolution behavior (proxied vs
> non-proxied); security-adjacent credential-feature decision. `qdrant-manager` ×1
> + the gateway/gateway-client socket tests — environmental (real qdrant process /
> macOS socket-path limit), pass in CI.


Reviewed the in-progress, **uncommitted** rebrand in the working tree of branch
`kimi-agent-feature-pack`. Verdict: **the mechanical text rename is thorough, but
the migration is NOT safe to commit or ship as-is.** Three critical defects and
two high/medium issues below.

_Method: **static review only** (grep + git). A `bunx tsc --noEmit` typecheck was
attempted but crashed in the local Node runtime (native stack-overflow trace —
toolchain/resource issue, inconclusive), so type/build correctness was NOT verified.
No native (Swift) compile or test suite was run. **Run CI before merging** — a clean
grep invariant cannot catch a renamed type referenced inconsistently or a broken
import._

## Fixes applied (2026-06-15)

Decisions taken with the maintainer: org/repo/scope = **`max-ai` / `max-assistant` /
`@maxai`**; channel mismatch resolved by **keeping code on `"max"` + adding a data
migration**.

- **C2 + L1 — DONE.** Rewrote all 22 files: `github.com/a/Max` →
  `github.com/max-ai/max-assistant` and `github.com/a/<rest>` →
  `github.com/max-ai/<rest>` (covers `max-assistant-platform`, `max-claude-skills`).
  Sparkle `SUFeedURL`, `AppURLs.swift`, and the `release.yml` cross-repo dispatch
  now resolve. Fixed the `@max/openclaw-adapter` → `@maxai/openclaw-adapter` outlier.
- **C3 — DONE (data-migration path).** Reverted the rebrand's in-migration literal
  edits back to `'vellum'` (`126`, `registry.ts` 020 description, the `229` test,
  and `db-migration-rollback.test.ts`) so the immutable chain is consistent again.
  Code stays on channel `"max"`. Added forward migration
  `249-rename-vellum-channel-to-max.ts` (+ `down`) that rewrites every stored
  `'vellum'` channel value → `'max'` across all channel-bearing columns
  (schema-driven scan, robust to the table renames since 144; `UPDATE OR IGNORE`
  so it never throws). Wired into the registry (v48), the `index.ts` barrel, and
  the `db-init.ts` runner (runs last). New test passes; **102 migration tests + 76
  URL-touched tests green** via `bun test`.

**H1 — resolved as a deliberate NON-GOAL.** This is a pre-release rebrand with no
existing installs whose `vellum` data must be preserved (maintainer decision,
2026-06-15), so the back-compat shims (legacy `~/.vellum` / `~/.config/vellum` data
dirs, `VELLUM_*` env fallback, `vellum://` URL scheme alias) are **intentionally not
built** — a clean break is acceptable. Revisit only if the product ships to users
on the old paths before this lands.

Still open (left to you — they change git state): **C1** (stage the renames with
`git add -A` before committing) and **M2** (move the rebrand to its own branch off
`main`).

## Full test-suite verification + fixes (2026-06-15)

Ran **every** test suite (all packages + the 1,264-file assistant suite) and triaged
every failure. **The rebrand introduced exactly one test failure, now fixed; zero
rebrand-induced failures remain.**

**Fixed + verified green (9):**
- **Rebrand-induced (1):** `assistant-attachments.test.ts` asserted the directive
  partial-prefix `"<vel"` (a partial of the old `<vellum-attachment`); the word-boundary
  `\bvellum\b` rename couldn't catch the partial literal while the source tag became
  `<max-attachment`. Updated to `"<max"`.
- **Pre-existing, isolated, stable bugs (8) — unrelated to the rebrand but fixed to make
  the suites green:** cli `moonshot/kimi` provider parity; gateway-client stale
  `trust-rules.ts` in a hardcoded list + over-long UNIX socket path; credential-storage
  `CES` substring filter false-positiving on `*AccessToken*`; skill-host-contracts test
  script pointing at the wrong dir; gateway over-long socket path; **credential-executor
  `validateContainedPath` not collapsing `..` in its realpath fallback (a real
  path-traversal hole)**; assistant-client Bun timeout-reason drop (module-level singleton
  reason); clients/web `--pass-with-no-tests`.
- All 7 edited TS packages re-typecheck clean (0 errors); all re-run green.

**NOT fixed — 41 pre-existing + 2 environmental failures, all active kimi-agent /
claude-subscription feature work, NOT the rebrand:** deliberately-raised `MAX_TURNS`
(step-cap tests expect 80/95), new flag-gated providers changing registry counts (tests
hardcode 3), a new uncommitted `activateBridgedSkill` export the test mock doesn't track,
a duplicate `claude-haiku-4-5` catalog id across the anthropic + claude-subscription
blocks, `web_search_tool_result`/`openai-responses` structural guards over-matching the
kimi provider, telemetry/inference provider churn; + 2 environmental (qdrant process
lifecycle, a credential-ref env test). These were left untouched on purpose: the branch
is `kimi-agent-feature-pack` and this is in-flight feature code (some uncommitted in the
working tree) — "fixing" the tests would mean reverting the developer's intentional
changes or guessing intent for mid-development features. They should be resolved as part
of that feature work, not the rebrand. (11 other files that failed under parallel
8-worker load passed clean on focused re-run — those were timeout flakiness, not bugs.)

## End-to-end verification (2026-06-15)

Ran every compilable/runnable signal available locally. **The rebrand introduced zero
failures.** Summary:

| Signal | Result |
|---|---|
| **TS typecheck — `assistant`** (largest; needed `--max-old-space-size=8192`) | ✅ 0 errors |
| **TS typecheck — 15 packages** (cli, gateway, credential-executor, clients/web, chrome-ext, all `packages/*`) | ✅ 0 errors |
| **TS typecheck — `apps/web`** | ✅ 0 errors (after `bun install`; its earlier failure was missing deps) |
| **TS test suites** | ✅ **0 rebrand-induced failures** — chrome-ext (120), service-contracts (96), ces-client (35), twilio (5), egress (3), slack (13), ipc-server-utils (9) all pass |
| **Swift `Package.swift`** resolve + target paths | ✅ valid, all paths exist |
| **Swift full build** — `MaxAssistantShared` (329) + `MaxAssistantLib` (472) + executable + test targets (`max-assistantTests` 240, `MaxAssistantSharedTests` 58) | ✅ **Build complete, 0 errors** (2851 steps, ~844s) |
| **CLI runtime** — `max --help` | ✅ boots (exit 0), fully rebranded, 0 `vellum` leftovers |

**The 17 test failures that exist are NOT from the rebrand** (verified by per-package
triage against HEAD): 6 pre-existing kimi-agent-branch issues (cli `moonshot` provider
parity drift, credential-storage substring-filter test bug matching "ac**ces**s",
skill-host-contracts wrong test dir in script, clients/web has no test files,
gateway-client `trust-rules.ts` ENOENT, assistant-client Bun-timer `signal.reason`
quirk) and 11 environmental (macOS 104-byte UNIX-socket-path limit on `tmpdir`, `/root`
absent on macOS). All present in HEAD independent of the rename; left untouched.

### Verification ceiling (NOT done — needs your environment / CI)
- A true **live round-trip** (launch the packaged+signed macOS app + daemon + gateway
  with real credentials and exchange a message) — needs `clients/macos/build.sh`, config,
  credentials, and the external infra below. Not reproducible in this sandbox.
- **External infra doesn't exist yet:** the `max-ai` GitHub org + repos, the published
  `@maxai/*` npm packages, and the `max.ai` domains / Sparkle appcast must be stood up
  before the app actually functions against them.

## Multi-agent audit (2026-06-15)

Ran a 9-dimension parallel audit (URLs/domains, npm/workspace deps, Swift/Xcode/bundle-IDs,
env vars, URL scheme, Docker/CI, display strings, internal-refs/build integrity, completeness
sweep), each finding adversarially verified by an independent skeptic. **5 confirmed, 11
rejected** as false-positive/intentional residue. All confirmed items resolved or flagged:

- **`.claude/README.md` — FIXED.** The Setup cluster kept the stale `claude-skills` slug
  (clone URL + `path/to/.../setup` placeholders + comment) while lines 7/13 already used the
  canonical `max-claude-skills`. Renamed the cluster to `max-claude-skills`. (3 of the 5
  findings were this one root cause.)
- **`assets/banner.svg` + `assets/banner.png` — FIXED (redrawn).** The README hero banner
  still displayed **"VELLUM ASSISTANT"**. Important correction to the audit: the rebrand had
  changed only an SVG *comment* (`<!-- VELLUM -->`→`<!-- MAX -->`) — the dot-matrix `<rect>`
  letters (and the rasterized `.png`) were untouched, so the SVG itself still read VELLUM
  (verified by rendering). Redrew line 1 to "MAX" (reused the existing M/A glyphs, drew a
  matching X, centered at x=600), kept "ASSISTANT", and regenerated `banner.png` (2400×600)
  via `rsvg-convert`. Visually verified the render reads "MAX ASSISTANT".
- **`assets/what-it-does.png` — RESOLVED by removing the README reference.** This feature
  collage is a product **screenshot** (top-left panel reads "…the vellum-assistant
  CONTRIBUTING.md…") with no SVG source, so it can't be faithfully regenerated without
  re-capturing the rebranded app's UI. Rather than ship old-brand imagery on the landing page,
  the `<img src="assets/what-it-does.png">` block was removed from README.md (the feature
  table directly above already conveys Memory/Identity/Proactivity/Security). The orphaned PNG
  is left in `assets/` untouched — regenerate it from the rebranded app and re-add the README
  block if you want the collage back.

## What was done well ✅

- **Content rename is near-complete.** Only 6 files still contain `vellum`
  (case-insensitive): 5 DB-migration files + `VELLUM_TO_MAX_MIGRATION.md`. The
  migration files are *correctly* preserved (see below).
- **Env vars** `VELLUM_*` → `MAX_*`: 0 `VELLUM_*` remain in code.
- **npm scope** `@vellumai/*` → `@maxai/*`: complete in code (the 26 `@vellumai`
  hits are all inside the inventory doc, not real code). Root packages are
  `@maxai/web`, `@maxai/assistant`.
- **Bundle IDs** `com.vellum.*` → `com.max.*`: complete in code (the 31
  `com.vellum.*` hits are all inside the inventory doc).
- **macOS source tree physically moved**: `clients/macos/vellum-assistant{,-app,Tests}`
  → `max-assistant{,-app,Tests}`, `VellumQL{Preview,Thumbnail}` → `MaxQL*`.
- **Migration `020-rename-...-to-vellum.ts` left immutable** — filename and its
  `'vellum'` literals untouched. Correct (shipped migrations must not change).

## Critical defects 🔴

### C1 — Renames are UNTRACKED; nothing is staged
The moved macOS files (547) show in git as **deletions with no matching rename**,
because the new `max-assistant/` copies are untracked (`??`) and nothing is in the
index. A naïve `git commit -am` would **delete the entire macOS app** from history.
Fix: `git add -A` so the moves register as renames, and verify
`git status` shows renames (R) not delete+add, before committing.

### C2 — GitHub org rename is botched: `vellum-ai` → `a`
`vellum-ai` was replaced with the garbage token **`a`** in 44 places across
**real, shipped files** (not just docs):
- `clients/macos/max-assistant/App/AppURLs.swift:113`
  `repositoryURL = "https://github.com/a/Max"` — broken in-app link.
- `clients/macos/max-assistant/Resources/Info.plist:46`
  `SUFeedURL = https://github.com/a/Max/releases/latest/download/appcast.xml`
  — **Sparkle auto-update feed points at a nonexistent org; the shipped app
  cannot find updates.**
- `.github/workflows/release.yml` and other workflows — cross-repo dispatch to
  `a/max-assistant-platform` (nonexistent).
- `README.md`, `CONSTITUTION.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.claude/README.md`, etc.

Also **inconsistent**: a second replacement produced `github.com/repos/max-ai`,
and the repo slug became PascalCase **`Max`** in URLs while directories use
`max-assistant`. The real org/repo name must be decided and applied consistently
(`max-ai/max-assistant` or whatever the actual org is), replacing every
`github.com/a/...` and `Max` slug.

### C3 — Channel identifier: code says `"max"`, existing data says `'vellum'`
**The headline bug:** working-tree code now compares the desktop channel as `"max"`
(`assistant/src/runtime/assistant-event-hub.ts:587` →
`if (sourceChannel === "max") return "desktop"`, plus
`calls/guardian-dispatch.ts:220`, `access-request-helper.ts:255`,
`local-actor-identity.ts` default, guardian route handlers). But the channel value
stored for **existing users** is `'vellum'`, written by immutable migration `020`
(which renames `'macos'`/`'ios'` → `'vellum'`). So on the **upgrade path**, an
existing install's rows say `'vellum'` while the new code only matches `'max'` →
guardian routing and desktop-surface classification silently break for real users
with real history.

Scope note: **fresh installs are fine.** `020` only touches `'macos'`/`'ios'` rows,
which a fresh DB doesn't have (it's a no-op there); new rows are written as `'max'`
and everything is internally consistent. This is purely an existing-user upgrade
regression — which makes it *more* serious, not less.

Symptom: the rename also edited `'vellum'`→`'max'` literals **inside already-numbered
migration `126-backfill-guardian-principal-id.ts`** (and the `229-…test.ts` fixture).
If `126` shipped in a release, that's a migration-immutability violation; either way
it leaves `020` (writes `'vellum'`) and `126` (queries `'max'`) contradicting each
other within one chain.

**Fix — two options, prefer the first (cheaper + safer):**
1. **Revert the constant.** The channel value is an *internal opaque identifier*,
   not user-facing branding — `assistant-event-hub.ts` maps it to a
   `"desktop"|"channel"|"voice"` label and the raw token never reaches UI or an
   external API contract (verified). So revert the `'vellum'`→`'max'` edits in the
   runtime constants **and** in migration `126`/fixtures, and keep the stored value
   `'vellum'`. No data migration, no `020` contradiction, no risk to existing rows.
2. **Migrate the data** (riskier): keep code on `"max"`, revert the in-migration
   literal edits, and add a new forward migration `NNN-rename-vellum-channel-to-max.ts`
   that rewrites every stored `'vellum'` row → `'max'`. Touches all existing users'
   data and still leaves `020` writing `'vellum'`. The inventory doc §3.7 anticipated
   this path, but option 1 is strictly safer here.

## High / medium issues 🟠

### H1 — No back-compat shims for existing user data (doc §3.8)
No code reads the legacy `~/.local/share/vellum/`, `~/.config/vellum/`, `VELLUM_*`
env vars, or the `vellum://` URL scheme. Existing installs will **orphan their
data/config** and old deep links break. The inventory doc flagged this as critical;
a first-launch migration shim (read old path → copy/symlink to new) was not added.

### M1 — `VELLUM_*` → `MAX_*` namespace collision (readability, not correctness)
Brand env vars (`MAX_ASSISTANT_IMAGE`, …) now sit alongside pre-existing numeric
limits (`MAX_ACCEPTABLE_RATIO`, `MAX_ARCHIVE_BYTES`, `MAX_ASSISTANT_ATTACHMENT_BYTES`).
This is **not** a correctness risk — the rename matched on `vellum`, so unrelated
`maxWidth`/`Math.max`/`MaxAttachmentSize` tokens could not have been swept in. It is
a namespace/readability concern: you can no longer grep-distinguish a brand `MAX_*`
from a numeric-limit `MAX_*`. Consider a distinct brand prefix if that matters.

### M2 — Rebrand is commingled on an unrelated branch
The entire rebrand is **uncommitted working-tree changes** sitting on
`kimi-agent-feature-pack`, whose HEAD commits are all `claude-subscription`/`kimi-agent`
work — nothing rebrand-related is committed. The inventory doc (§7) explicitly says
"don't try to land everything in one branch — separate PR series per tier." Move the
rebrand to its own branch off `main` and split per tier; don't let it ride along with
kimi-agent changes.

### L1 — npm scope inconsistency
`@max/openclaw-adapter` (was `@vellum/openclaw-adapter`) uses `@max`, while the rest
use `@maxai/*`. Pick one scope.

### L2 — This review file self-pollutes the `vellum` count
`MIGRATION_REVIEW.md` (and `VELLUM_TO_MAX_MIGRATION.md`) themselves contain `vellum`.
They're untracked/doc-only — keep them out of any rebrand commit so they don't show
up in the verification grep.

## Suggested order to land
1. Move the rebrand onto its own branch off `main`, split per tier (M2).
2. `git add -A`; confirm renames register as R, not delete+add (C1).
3. Decide the real org/repo + scope; fix all `github.com/a/...` and `Max` slugs (C2, L1).
4. Resolve the channel identifier — prefer reverting the constant to `'vellum'` (C3).
5. Add data/config/env/URL-scheme back-compat shims (H1).
6. Run CI / typecheck before merge (this review is static-only).
