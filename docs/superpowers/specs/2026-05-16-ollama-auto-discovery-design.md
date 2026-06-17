# Ollama Auto-Discovery for Inference Profiles — Design Doc

**Status:** Draft for review
**Date:** 2026-05-16
**Approach:** A — daemon-side background poll

## Problem

Every Ollama model surfaces in the picker only after a manual edit to `config.json`. Adding, removing, and tuning entries by hand is slow, error-prone, and gets stale every time the user pulls or removes a model in Ollama. The macOS app reports nothing when Ollama is offline — profiles continue to show up and silently fail.

**Goal:** the picker (and every other surface that reads `llm.profiles`) always reflects what's pulled in the local Ollama daemon, with zero manual config edits, and hides those entries cleanly when Ollama isn't reachable.

## 1. Architecture overview

A long-lived service `assistant/src/providers/ollama/discovery-service.ts` owned by the daemon. It polls Ollama every 60s plus once immediately on startup, reconciles auto-managed profiles in `config.json`, and updates a `reachable` flag on the Ollama connection row.

**Data flow:**

```
Ollama HTTP (:11434)
    │
    ▼
discovery-service (daemon)
    │   writes auto-ollama-* profiles via saveRawConfig()
    ▼
config.json  ──►  GET /v1/config  ──►  Swift SettingsStore  ──►  picker, callsite editor, etc.
    │
    └── reachability flag piggy-backs on the existing config-push channel
```

**Lifecycle:**
- **Start:** wired into `daemon/main.ts` after config + connections are loaded. Reads the *active Ollama connection's* base URL — defined as: the connection whose name matches `llm.default.provider_connection` when that connection's provider is `"ollama"`; otherwise the first row in the `connections` table where `provider == "ollama"`, ordered alphabetically by name. If no Ollama connection exists, the service starts in a no-op state and logs once.
- **Tick (60s + immediate on start):** `GET /api/tags` with a 3s timeout → per-model `GET /api/show` (max 4 concurrent) → reconcile against on-disk config → update `reachable` + `lastSeenAt`.
- **Unreachable:** flip the connection's `reachable` flag, leave auto profiles on disk untouched (only the UI hides them).
- **Stop:** clears the interval on daemon shutdown.

Daemon-side, not Swift-side: the daemon owns `config.json` writes. The app reads the merged result via the existing config-push and gets these for free.

## Safety rails (no surprise data loss)

### Config writes
- All writes go through `saveRawConfig()` using atomic `write-tmp + rename`. Verify (and fix if absent) before merge.
- Single in-process mutex guards every `config.json` writer: the discovery tick, the seeder, and the `PATCH /v1/config` route. No torn writes.

### One-shot migration
- Gated on `llm.autoOllamaMigratedAt: <ISO>` in workspace config. Never runs twice.
- Before the first byte is migrated: dump full config to `config.json.bak-pre-auto-ollama-<ts>` next to the live file.
- Failure mid-migration → restore from `.bak`, leave the flag unset, log loudly, try again next boot.
- Migration **only runs** when Ollama is reachable AND `/api/tags` returns ≥1 model — never migrates against an empty list.

### Steady-state reconciliation
- Touches only profiles tagged `source: "auto-ollama"`. Anything else is invisible to the service.
- Removes an auto profile only after **2 consecutive ticks confirm the model is absent** — single hiccup never wipes entries.
- No-write-if-no-diff: most ticks are silent file reads.

### `activeProfile` fallback cascade
1. auto-key for the same model id, if it now exists,
2. else first remaining `auto-ollama-*` in `profileOrder`,
3. else `"balanced"`.

### Failure containment & kill switch
- Service wrapped in a top-level `try/catch` — Ollama unreachable, JSON malformed, schema drift, anything is logged and the daemon stays up.
- `llm.autoOllamaDiscovery: false` disables the entire service. Default `true`.

### First-run dry-run
The first migration logs every change it would make BEFORE writing, then commits. Reviewable in the daemon startup log.

## 2. Reconciliation algorithm

One pure function: `reconcile(currentConfig, ollamaModels) → nextConfig + events`. Same inputs always produce the same outputs.

**Slug rule (deterministic).** `modelKey(tag)` lowercases the tag, replaces `.` and `:` with `-`, prefixes `auto-ollama-`:
- `qwen3.6:35b` → `auto-ollama-qwen3-6-35b`
- `qwen3-vl:8b` → `auto-ollama-qwen3-vl-8b`
- `qwen3:latest` → `auto-ollama-qwen3-latest`

Collisions: suffix `-2`, `-3`, … and emit a warning.

**Manual vs auto, defined precisely.**
- *Auto:* `source == "auto-ollama"` — only the discovery service writes these.
- *Manual:* `provider == "ollama"` AND `source != "auto-ollama"`.

### Phase 1 — one-shot migration

For each Ollama model `m`:
- Find every manual profile with `provider: "ollama"` and `model == m.tag`.
- **Winner rule:** latest in `profileOrder` (ties → alphabetical key).
- Create `auto-ollama-<slug>` carrying over `effort / maxTokens / thinking / contextWindow / description` from the winner. Set `label: m.tag`, `source: "auto-ollama"`, `provider_connection`.
- Delete every matching manual profile (winner included — the auto entry replaces it).

Manual profiles pointing at a model not currently pulled are **preserved** in Phase 1.

### Phase 2 — steady-state (every 60s, idempotent)

| Action | Trigger | Effect |
|---|---|---|
| Add | Ollama has model M, no `auto-ollama-<slug(M)>` exists | Create with capability-derived defaults |
| Remove | Auto profile's model missing from `/api/tags` for 2 consecutive ticks | Delete profile, cascade `activeProfile` if needed |
| Don't touch | Auto profile's model still in Ollama | Preserve user edits via the Inference Profile editor |

**Definition of "user-tunable" fields.** Discovery manages only the creation and deletion of auto profiles, plus the *initial values* of `provider`, `provider_connection`, `model`, `source`, and `label`. Every other field (`effort`, `maxTokens`, `thinking.*`, `contextWindow.*`, `description`) is treated as user-owned after the profile is created — the reconciler reads but never overwrites them on subsequent ticks.

`profileOrder`: migrated keys replaced in-place; new auto keys appended; stale auto keys stripped.

## 3. Defaults & capability mapping

When the reconciler creates an auto profile with no manual ancestor, every field is derived from `GET /api/show`:

| Field | Rule |
|---|---|
| `provider` | `"ollama"` |
| `provider_connection` | Active Ollama connection name |
| `model` | Raw tag |
| `label` | Raw tag |
| `description` | `"Auto-discovered: 36.0B, vision/tools/thinking"` |
| `source` | `"auto-ollama"` (load-bearing — drives reconciliation identity) |
| `thinking.enabled` | `true` iff `"thinking" ∈ capabilities` |
| `thinking.streamThinking` | mirrors `thinking.enabled` |
| `effort` | `"high"` |
| `maxTokens` | `8192` |
| `contextWindow.maxInputTokens` | `min(reported context_length, 131072)` · fallback `32768` |

### Catalog extension at runtime

The wider system reads model capabilities from `PROVIDER_CATALOG`. Today it has only `llama3.2` under Ollama — anything else is invisible to vision routing and tool-call dispatch. Fix: discovery service mutates `PROVIDER_CATALOG[ollama].models` in memory each successful tick to append every discovered model with its `supportsVision / supportsToolUse / supportsThinking` derived from `/api/show`.

Catalog file stays static and checked into git — auto-discovered models would clutter source control. Pricing: `0` for local models.

## 4. Offline-state wiring

One fact drives everything: `connections.ollama-personal.reachable`. Set by the discovery service every tick.

**Daemon.** Each tick updates two fields on the Ollama connection row:

```json
{ "reachable": true, "lastSeenAt": "2026-05-16T12:34:56Z" }
```

Row already part of `GET /v1/config` and the config-push WS event — no new endpoint. Daemon does NOT filter profiles from its HTTP response; hiding is a UI policy, not a data policy.

**Swift (ChatProfilePicker).** Extend filter at `ChatProfilePicker.swift:69`:

```swift
let activeProfiles = profiles.filter { profile in
  !profile.isDisabled
    && settingsStore.isConnectionReachable(profile.providerConnection)
}
```

`isConnectionReachable` returns `true` for cloud providers (no reachability concept), `true` for an Ollama connection with `reachable == true`, and `true` when the connection field is missing (legacy profiles preserved).

**Offline notice (picker dropdown, bottom row, disabled `VMenuItem`):**

```
⚠ Ollama offline — 7 models hidden
Last seen: 4 min ago
```

Count and timestamp are derived client-side from the connection state.

**Inference Profile editor.** Different policy: shows all auto-ollama profiles regardless of reachability, with an `(offline)` badge next to ones whose connection is unreachable.

## 5. Testing strategy

### Unit (pure functions, fast, no I/O)
- `reconcile.test.ts` — empty + no-op, 1 discovered + no manual, 1 discovered + manual match (field carry-over asserted), 2 manuals same model (winner rule), manual referencing missing model preserved, 1-tick missing still present, 2-tick missing removed, user edits preserved across reconcile, idempotence, activeProfile cascade at all 4 levels, profileOrder maintenance.
- `slugify.test.ts` — standard cases + collision suffixing.
- `capability-mapping.test.ts` — thinking/vision/tools → catalog flags, context_length parsed across architecture prefixes, fallback + clamp.

### Integration (stub Ollama HTTP server)
- `discovery-service.integration.test.ts` — happy path, reach/unreach/reach cycle, migration with pre-seeded manual profiles (assert `.bak` exists + correct fields carried), `/api/show` timeout drops that model only, kill switch `autoOllamaDiscovery: false` respected.

### API-show schema canary
- `api-show-schema.test.ts` — runs against live Ollama in pre-merge local runs (skipped if `OLLAMA_BASE_URL` unreachable in CI). Asserts: `capabilities` is an array subset of `["completion","vision","tools","thinking"]`; `modelinfo` contains some `*.context_length`; `details.parameter_size` matches `\d+(\.\d+)?[BM]`.
- Captured fixtures live in `__tests__/fixtures/api-show/*.json` (qwen3, llama, mistral, gemma) and feed every other unit test.

### Concurrency
- `config-write-mutex.test.ts` — two concurrent `saveRawConfig` writers serialize; discovery tick racing with `PATCH /v1/config` never tears; kill mid-write leaves original intact.

### Swift
- `ChatProfilePickerTests.swift` — ollama profile hidden when `reachable == false`; cloud profile NOT hidden when its connection lacks `reachable`; offline notice rendered iff ≥1 profile filtered; "Last seen N min ago" relative-time snapshot.

### Manual end-to-end checklist (in PR description)
1. Fresh workspace + Ollama with 3 models → 3 auto profiles within 60s.
2. `ollama pull` new model → appears within 60s.
3. `ollama rm` model → disappears after ~2 min (2 ticks).
4. Stop Ollama → auto profiles gone, "Ollama offline" notice shown.
5. Restart Ollama → profiles return, notice gone.
6. Existing user with manual `ollama-large / ollama-deep / qwen3-6-35b` → migration runs ONCE, `.bak-pre-auto-ollama-<ts>` exists, `effort/maxTokens` carried (exact values match pre-state).
7. `llm.autoOllamaDiscovery: false` → service no-ops.
8. Set `activeProfile` to `ollama-deep` before upgrade → after migration, `activeProfile` cascaded to migrated auto-key for same model.

**Coverage targets:** 90% on the reconciler, 80% overall.

## Out of scope for v1

- "Retry connection now" button on the picker — 60s loop is fast enough.
- Settings → Providers reachability dashboard.
- Native macOS notification when Ollama goes offline.
- Auto-launching of Ollama from Max.
- Surfacing models from multiple Ollama connections simultaneously (v1 assumes one active Ollama connection per workspace).
