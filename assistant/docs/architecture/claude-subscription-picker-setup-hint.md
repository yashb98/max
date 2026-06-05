# Claude Subscription — Picker Setup-Hint Design Spec

> **Status:** Design — not yet implemented.
> **Companion doc:** [`claude-subscription-bridge.md`](./claude-subscription-bridge.md) (priority queue task #2).
> **Audience:** Provider/runtime engineers and macOS client engineers.
> **Goal:** When a user opens the model-profile picker and the `claude-subscription` provider is unavailable, surface an inline hint that tells them *why* and what to do — without introducing a new modal or setup sheet.

## 1. Why this exists

`ProviderGroup.claudeSubscription` already renders in the picker as "Claude (Max Plan)". The catalog entry has `setupMode: "cli-login"`. But there is **no path from the daemon's existing `isProviderAvailable("claude-subscription")` check to the picker UI**, so:

- A user on a machine without the `claude` CLI sees "Claude (Max Plan)" as if it were ready, picks it, and gets a confusing call-time error.
- A user with the CLI but no `claude login` session sees the same.
- Engineers dogfooding with the feature flag off see a row that maps to a provider that isn't registered.

This spec wires availability data through the existing settings/reachability pattern and adds the inline-hint UX.

## 2. Constraints

- **Mirror the existing `ConnectionReachability` pipeline.** Don't invent a new pattern for the same shape of data (per-key boolean state + reason, refreshed periodically, threaded through `ChatProfilePickerConfiguration`).
- **No new SwiftUI surface.** Disabled row + trailing text, the same as Ollama-offline. No modal, no sheet, no banner.
- **`getProviderAvailability` GET must be side-effect-free.** Per `assistant/src/runtime/CLAUDE.md`: GETs are safe and idempotent. The optional cache-bust query (`?fresh=true`) is bounded and observable.
- **No regressions to other providers.** API-key providers continue to render unchanged; the new branch only fires for `claudeSubscription` when its availability is `false`.

## 3. Architecture

Three layers, each thin:

```
provider-availability.ts (daemon)
       │  refactor: add ProviderAvailabilityStatus { available, reason? }
       ▼
shared ROUTE: GET /v1/provider-availability  (new)
       │  HTTP + IPC (per the shared ROUTES array — see assistant/CLAUDE.md)
       ▼
SettingsStore.providerAvailability (Swift, @Published)
       │  snapshot threaded through ChatProfilePickerConfiguration
       ▼
ComposerSettingsMenu.providerRow
       │  new branch for .claudeSubscription unavailable states
       ▼
Disabled VMenuItem + red dot + reason-specific trailing text
```

Each layer's responsibility is local. The daemon owns the OS-level checks; the route owns serialization; `SettingsStore` owns caching and refresh; the picker owns rendering.

## 4. Backend (daemon) changes

### 4.1 `assistant/src/providers/provider-availability.ts`

Add a typed status:

```ts
export type ProviderAvailabilityReason =
  | "missing-cli"        // claude CLI not on PATH
  | "not-logged-in"      // CLI present, no Keychain entry / credentials file
  | "not-enabled"        // feature flag off (claude-subscription only)
  | "no-api-key";        // api-key provider with no key in secure storage

export interface ProviderAvailabilityStatus {
  available: boolean;
  reason?: ProviderAvailabilityReason;
}

export async function getProviderAvailabilityStatus(
  provider: string,
): Promise<ProviderAvailabilityStatus>;

export async function getAllProviderAvailability(): Promise<
  Record<string, ProviderAvailabilityStatus>
>;
```

`isProviderAvailable(provider): Promise<boolean>` stays as a back-compat wrapper that returns `status.available`.

The claude-subscription branch returns specific reasons:

- CLI absent → `{ available: false, reason: "missing-cli" }`
- CLI present, no credentials → `{ available: false, reason: "not-logged-in" }`
- Feature flag off → `{ available: false, reason: "not-enabled" }`
- All present → `{ available: true }`

Other providers return `{ available: bool, reason?: "no-api-key" }` (omit reason when available, set to `"no-api-key"` when unavailable so the response shape is uniform).

Cache: the existing `claudeSubscriptionAvailabilityCache` mechanism stays. The new functions read through the same cache. `?fresh=true` on the route invalidates via `clearClaudeSubscriptionAvailabilityCache()`.

### 4.2 New shared route — `assistant/src/runtime/routes/provider-availability-routes.ts`

```ts
export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getProviderAvailability",
    endpoint: "/v1/provider-availability",
    method: "GET",
    handler: async ({ query }) => {
      if (query?.fresh === "true") clearClaudeSubscriptionAvailabilityCache();
      return getAllProviderAvailability();
    },
    summary: "Per-provider availability for setup-hint UX",
    tags: ["providers"],
  },
  {
    operationId: "getProviderAvailabilityById",
    endpoint: "/v1/provider-availability/:id",
    method: "GET",
    handler: async ({ params, query }) => {
      if (query?.fresh === "true") clearClaudeSubscriptionAvailabilityCache();
      return getProviderAvailabilityStatus(params.id);
    },
    summary: "Single-provider availability lookup",
    tags: ["providers"],
  },
];
```

Registered in `assistant/src/runtime/routes/index.ts`. Per `assistant/CLAUDE.md`, the route is automatically exposed over both HTTP and IPC.

### 4.3 Feature-flag handling

When `claude-subscription-provider` flag is off:

- Registry already skips provider registration.
- `getProviderAvailabilityStatus("claude-subscription")` must explicitly check the flag and return `{ available: false, reason: "not-enabled" }` — this is the **only** new flag-aware branch.
- Tests assert the picker shows the "Feature flag off" hint in this state.

This surfaces internal flag state to the user, which is a deliberate trade-off: the user audience (engineering team dogfooding) benefits from the explicit signal; if the flag ever ships to non-engineers, the copy can be rewritten to something less internal-y without changing the wire contract.

## 5. Swift client changes

### 5.1 New Codable model in `clients/shared/Models/`

```swift
public struct ProviderAvailabilityStatus: Codable, Equatable, Sendable {
    public enum Reason: String, Codable, Sendable {
        case missingCli = "missing-cli"
        case notLoggedIn = "not-logged-in"
        case notEnabled = "not-enabled"
        case noApiKey = "no-api-key"
    }
    public let available: Bool
    public let reason: Reason?
}
```

### 5.2 `GatewayHTTPClient` extension

```swift
extension GatewayHTTPClient {
    func getProviderAvailability(fresh: Bool = false) async throws
        -> [String: ProviderAvailabilityStatus]
}
```

### 5.3 `SettingsStore.swift`

Add the publish + load/refresh pair, mirroring `connectionReachability`:

```swift
@Published public private(set) var providerAvailability:
    [String: ProviderAvailabilityStatus] = [:]

func loadProviderAvailability(map: [String: ProviderAvailabilityStatus]) { ... }
func refreshProviderAvailability(client: GatewayHTTPClient, fresh: Bool = false)
    async { ... }  // tolerant: on transport failure, keeps last-known map
```

Refresh triggers:

1. App launch (existing settings-load hook in `SettingsStore`).
2. When `ComposerSettingsMenu` is opened (new `.task` modifier).

A "manual recheck" button is **out of scope** for v1.

### 5.4 `ChatProfilePickerConfiguration`

Add an optional snapshot field with a default value so existing call sites stay one-line:

```swift
var providerAvailability: [String: ProviderAvailabilityStatus] = [:]
```

### 5.5 `ComposerSettingsMenu.swift` — `providerRow`

Add a branch keyed off `group.kind == .claudeSubscription` AND
`providerAvailability["claude-subscription"]?.available == false`. Render as a disabled `VMenuItem` (no submenu) with red dot + reason-specific trailing text. The available-state path stays on the existing `VSubMenuItem` branch (parity with `.anthropic`).

Pure helper for the trailing text (testable without a SwiftUI host):

```swift
static func claudeSubscriptionTrailingText(
    reason: ProviderAvailabilityStatus.Reason?
) -> String {
    switch reason {
    case .missingCli:   return "Install Claude Code"
    case .notLoggedIn:  return "Run `claude login`"
    case .notEnabled:   return "Feature flag off"
    case .noApiKey, nil: return "Not available"  // defensive fallback
    }
}
```

Row label uses a parallel helper returning `"Claude (Max Plan) · <suffix>"` for each reason; suffix examples: `"not installed"`, `"not signed in"`, `"disabled"`.

## 6. Data flow

1. App launch → `SettingsStore.refreshProviderAvailability(client:)` fires.
2. Daemon serves cached `getAllProviderAvailability()` (first call populates the cache).
3. SettingsStore publishes the map; UI rebuilds.
4. User opens `ComposerSettingsMenu` → `.task` modifier triggers a refresh with `fresh: false` (cheap; cache hit).
5. `providerRow` reads `config.providerAvailability["claude-subscription"]` and routes through the appropriate render branch.

On transport failure during refresh: `SettingsStore` keeps its last-known map. First-render edge case (no map yet): the picker assumes `available: true` until proven otherwise (avoids a flash of "not installed" during initial load).

## 7. Copy strings

| State | Row label | Trailing text |
|---|---|---|
| `missing-cli` | `"Claude (Max Plan) · not installed"` | `"Install Claude Code"` |
| `not-logged-in` | `"Claude (Max Plan) · not signed in"` | `"Run `claude login`"` |
| `not-enabled` | `"Claude (Max Plan) · disabled"` | `"Feature flag off"` |
| `available` | `"Claude (Max Plan)"` (existing) | (none) |

Wording is first-draft; revisit before user-facing release.

## 8. Error handling

| Failure | Behavior |
|---|---|
| Daemon route returns 500 | `SettingsStore.refreshProviderAvailability` catches, logs, keeps last-known map. UI never shows the hint unless the daemon has *confirmed* unavailability. |
| Daemon route times out | Same as 500. |
| Initial app load before first refresh | UI treats `available: true` by default; the false-state branch only fires once the daemon has been polled. |
| Cache stale after `claude logout` | Bounded by picker-open cadence + the daemon's process-lifetime cache. v1 accepts this; FSEvents watcher is out of scope. |
| Feature flag toggled at runtime | The daemon evaluates the flag per `getProviderAvailabilityStatus` call. Next picker open picks up the new state. |

## 9. Testing

### 9.1 TypeScript (daemon)

- `provider-availability.test.ts` (new): the 4-state matrix for claude-subscription (CLI × login × flag) + the back-compat assertion that `isProviderAvailable` returns the same boolean as `getProviderAvailabilityStatus(...).available`.
- `provider-availability-routes.test.ts` (new): route returns correct shape; `?fresh=true` invalidates cache; unknown provider id returns `{ available: false }` without throwing.

**Open dependency:** the `which`/`security` DI fragility documented in `claude-subscription-bridge.md` §9 affects these tests. If the refactor lands as part of this work, write tests with the injected variant. If deferred, the route tests can mock at the function boundary (`getProviderAvailabilityStatus` rather than `execFile`) and pick up the underlying tests when task #3 lands.

### 9.2 Swift

- `ChatProfilePickerTests.swift`: extend with cases for each reason. Assert (a) row renders as disabled, (b) trailing text matches the helper output, (c) submenu is not constructible.
- `SettingsStoreTests.swift` (or equivalent): assert `loadProviderAvailability` publishes the map; `refreshProviderAvailability` keeps the last-known map on transport failure.

### 9.3 Manual smoke

Per the bridge doc's stance on CI: the end-to-end picker state can't be CI-gated (needs a credentialed `claude` install or its deliberate absence). Document in the bridge doc's runbook section how to validate each state locally — uninstall `claude` for state 1, `claude logout` for state 2, flip the feature flag for state 3.

## 10. Out of scope

- Setup modal / sheet (Ollama-parity disabled-row is the chosen pattern).
- Manual "Recheck" button.
- `claude logout` FS-watcher to invalidate cache proactively.
- Telemetry on availability checks (belongs with bridge-doc Phase 3).
- "Add API key" hint for api-key providers — the wire format supports it (`reason: "no-api-key"`) but the picker UI branch for that case is a separate future task; the route just exposes the data.
- Per-conversation override behavior — the picker change does not affect how profiles are persisted or applied.

## 11. Open items

1. **Copy text wording** — first-draft strings; revisit before non-engineer rollout.
2. **DI refactor sequencing** — bundle with this task (recommended for test hermetism) or defer to priority queue task #3 separately. Has to be decided before writing the implementation plan.
3. **macOS-only?** Linux/Windows Swift clients are not in this repo, but the Codable model and route are platform-neutral. No action required; flagged for completeness.

## 12. Cross-references

- [`claude-subscription-bridge.md`](./claude-subscription-bridge.md) — parent doc; priority queue task #2.
- `assistant/src/runtime/CLAUDE.md` — GET handler idempotency rules; HTTP-only transport.
- `assistant/CLAUDE.md` — shared `ROUTES` array architecture (HTTP+IPC dual exposure).
- `clients/macos/vellum-assistant/Features/Settings/SettingsStore.swift` — `connectionReachability` reference pattern.
