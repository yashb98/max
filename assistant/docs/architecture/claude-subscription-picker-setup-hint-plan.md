# Claude Subscription — Picker Setup-Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `provider-availability.ts`'s claude-subscription check through a new daemon HTTP route and into the macOS picker so unavailable states render as a disabled row with a reason-specific hint, mirroring the existing Ollama-offline UX.

**Architecture:** Three thin layers. (1) Daemon refactors `provider-availability.ts` to expose a typed `ProviderAvailabilityStatus` and exposes a new shared `GET /v1/provider-availability` route. (2) Swift `SettingsStore` mirrors the existing `connectionReachability` pattern (`@Published` map + tolerant refresh). (3) `ComposerSettingsMenu.providerRow` gains a `claudeSubscription`-unavailable branch that renders a disabled `VMenuItem` with reason-specific copy.

**Tech Stack:** TypeScript (Bun + zod), bun:test, SwiftUI, swift test (XCTest), shared `RouteDefinition` types from `assistant/src/runtime/routes/types.ts`.

**Companion docs:** Spec at `assistant/docs/architecture/claude-subscription-picker-setup-hint.md`; parent doc at `assistant/docs/architecture/claude-subscription-bridge.md`.

**Git posture:** Leave uncommitted per user preference. Each phase ends with a verification command, not a commit. The implementer is free to `git add` for staging but does not commit.

**User directive:** Every phase ends with a concrete verification command proving the change works in production: `bunx tsc`, `bun test`, `swift test`, or `./build.sh test`. A phase is **not** done until its verification passes.

---

## File Structure

### Daemon (TypeScript)

| Path | Action | Responsibility |
|---|---|---|
| `assistant/src/providers/provider-availability.ts` | Modify | Add `ProviderAvailabilityStatus` type + `getProviderAvailabilityStatus` + `getAllProviderAvailability` + feature-flag branch. Keep `isProviderAvailable` boolean wrapper. |
| `assistant/src/providers/__tests__/provider-availability.test.ts` | Create | Unit tests for the typed status, the 4-state matrix, the back-compat wrapper. |
| `assistant/src/runtime/routes/provider-availability-routes.ts` | Create | `GET /v1/provider-availability` and `GET /v1/provider-availability/:id` with optional `?fresh=true`. |
| `assistant/src/runtime/routes/__tests__/provider-availability-routes.test.ts` | Create | Route-handler unit tests. |
| `assistant/src/runtime/routes/index.ts` | Modify | Register the new `PROVIDER_AVAILABILITY_ROUTES` bundle. |

### Swift (macOS client)

| Path | Action | Responsibility |
|---|---|---|
| `clients/shared/Models/ProviderAvailabilityStatus.swift` | Create | Codable model matching the daemon wire shape. |
| `clients/shared/Network/ProviderAvailabilityClient.swift` | Create | Protocol-based HTTP client (`ProviderAvailabilityClientProtocol`) for hermetic tests, mirroring `ProviderConnectionClient`. |
| `clients/macos/max-assistant/Features/Settings/SettingsStore.swift` | Modify | New `@Published providerAvailability` map + `loadProviderAvailability` + `refreshProviderAvailability` + refresh on app-launch and picker-open. |
| `clients/macos/max-assistant/Features/Chat/ChatProfilePicker.swift` | Modify | Add `providerAvailability` field to `ChatProfilePickerConfiguration`. |
| `clients/macos/max-assistant/Features/Chat/ComposerSettingsMenu.swift` | Modify | New `claudeSubscriptionProviderRow(...)` helper rendering the disabled-row branch; new pure `claudeSubscriptionTrailingText` + `claudeSubscriptionRowLabel` helpers. |
| `clients/macos/max-assistantTests/Features/Chat/ChatProfilePickerTests.swift` | Modify | Extend with 4 cases for each `Reason` plus the available case. |
| `clients/macos/max-assistantTests/SettingsStoreProviderAvailabilityTests.swift` | Create | Asserts publish + tolerant-on-failure refresh. |

---

## Phase 0 — Pre-flight verification

**Files:** none modified.

- [ ] **Step 1: Confirm foundation still passes**

```bash
cd assistant
bun test src/__tests__/claude-subscription-provider.test.ts src/__tests__/claude-subscription-concurrency.test.ts
```

Expected: `38 pass / 0 fail / 1103 expect() calls`. Any deviation: stop and resolve before continuing.

- [ ] **Step 2: Confirm tsc baseline**

```bash
cd assistant
NODE_OPTIONS="--max-old-space-size=8192" bunx tsc --noEmit
echo "EXIT=$?"
```

Expected: `EXIT=0`.

- [ ] **Step 3: Confirm macOS build baseline**

```bash
cd clients/macos
./build.sh
```

Expected: `dist/Max.app` produced without errors. If the build is already cached, force-clean: `./build.sh clean && ./build.sh`.

---

## Phase 1 — Daemon: typed `ProviderAvailabilityStatus` + per-id getter

**Files:**
- Modify: `assistant/src/providers/provider-availability.ts`
- Create: `assistant/src/providers/__tests__/provider-availability.test.ts`

- [ ] **Step 1: Write the failing test**

Create `assistant/src/providers/__tests__/provider-availability.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  clearClaudeSubscriptionAvailabilityCache,
  getProviderAvailabilityStatus,
  isProviderAvailable,
  type ProviderAvailabilityStatus,
} from "../provider-availability.js";

describe("getProviderAvailabilityStatus", () => {
  beforeEach(() => {
    clearClaudeSubscriptionAvailabilityCache();
  });

  test("ollama is always available with no reason", async () => {
    const status: ProviderAvailabilityStatus =
      await getProviderAvailabilityStatus("ollama");
    expect(status.available).toBe(true);
    expect(status.reason).toBeUndefined();
  });

  test("unknown provider returns { available: false, reason: 'no-api-key' }", async () => {
    const status = await getProviderAvailabilityStatus("definitely-not-a-real-provider");
    expect(status.available).toBe(false);
    expect(status.reason).toBe("no-api-key");
  });

  test("isProviderAvailable matches getProviderAvailabilityStatus(...).available", async () => {
    const bool = await isProviderAvailable("ollama");
    const status = await getProviderAvailabilityStatus("ollama");
    expect(bool).toBe(status.available);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd assistant
bun test src/providers/__tests__/provider-availability.test.ts
```

Expected: FAIL — `getProviderAvailabilityStatus` is not exported.

- [ ] **Step 3: Implement the typed status + per-id getter**

In `assistant/src/providers/provider-availability.ts`, add the type and function (place after the existing `isClaudeSubscriptionAvailable` block, before `isProviderAvailable`):

```typescript
export type ProviderAvailabilityReason =
  | "missing-cli"
  | "not-logged-in"
  | "not-enabled"
  | "no-api-key";

export interface ProviderAvailabilityStatus {
  available: boolean;
  reason?: ProviderAvailabilityReason;
}

export async function getProviderAvailabilityStatus(
  provider: string,
): Promise<ProviderAvailabilityStatus> {
  if (provider === "ollama") return { available: true };
  if (provider === "claude-subscription") {
    // Phase 2 replaces this stub with the feature-flag-aware branch.
    const available = await isProviderAvailable("claude-subscription");
    return available ? { available: true } : { available: false, reason: "not-logged-in" };
  }
  const ok =
    !!(await getProviderKeyAsync(provider)) ||
    !!(await managedFallbackEnabledFor(provider));
  return ok ? { available: true } : { available: false, reason: "no-api-key" };
}
```

Keep `isProviderAvailable` unchanged — it stays as the boolean back-compat wrapper.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd assistant
bun test src/providers/__tests__/provider-availability.test.ts
```

Expected: 3 pass / 0 fail.

- [ ] **Step 5: Verify tsc still clean**

```bash
cd assistant
NODE_OPTIONS="--max-old-space-size=8192" bunx tsc --noEmit
echo "EXIT=$?"
```

Expected: `EXIT=0`.

---

## Phase 2 — Daemon: feature-flag-aware claude-subscription branch + all-providers map

**Files:**
- Modify: `assistant/src/providers/provider-availability.ts`
- Modify: `assistant/src/providers/__tests__/provider-availability.test.ts`

- [ ] **Step 1: Write failing tests for the claude-subscription 4-state matrix**

Add to `provider-availability.test.ts`:

```typescript
import { isAssistantFeatureFlagEnabled } from "../../config/feature-flags.js";

mock.module("../../config/feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: mock(() => true),
}));

describe("claude-subscription availability matrix", () => {
  beforeEach(() => {
    clearClaudeSubscriptionAvailabilityCache();
    (isAssistantFeatureFlagEnabled as ReturnType<typeof mock>).mockReturnValue(true);
  });

  test("flag off → { available: false, reason: 'not-enabled' }", async () => {
    (isAssistantFeatureFlagEnabled as ReturnType<typeof mock>).mockReturnValue(false);
    const status = await getProviderAvailabilityStatus("claude-subscription");
    expect(status.available).toBe(false);
    expect(status.reason).toBe("not-enabled");
  });
});

describe("getAllProviderAvailability", () => {
  test("returns a map containing ollama", async () => {
    const { getAllProviderAvailability } = await import("../provider-availability.js");
    const map = await getAllProviderAvailability();
    expect(map["ollama"]).toEqual({ available: true });
  });

  test("includes claude-subscription with a reason when unavailable", async () => {
    (isAssistantFeatureFlagEnabled as ReturnType<typeof mock>).mockReturnValue(false);
    const { getAllProviderAvailability } = await import("../provider-availability.js");
    const map = await getAllProviderAvailability();
    expect(map["claude-subscription"]?.available).toBe(false);
    expect(map["claude-subscription"]?.reason).toBe("not-enabled");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd assistant
bun test src/providers/__tests__/provider-availability.test.ts
```

Expected: FAIL — `getAllProviderAvailability` not exported; flag-off branch returns wrong reason.

- [ ] **Step 3: Implement the feature-flag branch and the all-providers map**

In `assistant/src/providers/provider-availability.ts`, add the import at top:

```typescript
import { isAssistantFeatureFlagEnabled } from "../config/feature-flags.js";
import type { AssistantConfig } from "../config/loader.js";
import { PROVIDER_CATALOG } from "./model-catalog.js";
```

Replace the claude-subscription branch in `getProviderAvailabilityStatus`:

```typescript
if (provider === "claude-subscription") {
  if (
    !isAssistantFeatureFlagEnabled(
      "claude-subscription-provider",
      {} as AssistantConfig,
    )
  ) {
    return { available: false, reason: "not-enabled" };
  }
  const cliPresent = await isClaudeCliInstalled();
  if (!cliPresent) return { available: false, reason: "missing-cli" };
  const loggedIn = await isClaudeCliLoggedIn();
  if (!loggedIn) return { available: false, reason: "not-logged-in" };
  return { available: true };
}
```

Add the all-providers map function at the end of the file:

```typescript
export async function getAllProviderAvailability(): Promise<
  Record<string, ProviderAvailabilityStatus>
> {
  const result: Record<string, ProviderAvailabilityStatus> = {};
  for (const entry of PROVIDER_CATALOG) {
    result[entry.id] = await getProviderAvailabilityStatus(entry.id);
  }
  // Ollama is always in the catalog already; guard for redundancy.
  if (!result["ollama"]) result["ollama"] = { available: true };
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd assistant
bun test src/providers/__tests__/provider-availability.test.ts
```

Expected: all pass.

- [ ] **Step 5: Verify the existing 38 still pass and tsc still clean**

```bash
cd assistant
bun test src/__tests__/claude-subscription-provider.test.ts src/__tests__/claude-subscription-concurrency.test.ts && \
  NODE_OPTIONS="--max-old-space-size=8192" bunx tsc --noEmit
```

Expected: 38 pass / 0 fail; `EXIT=0` on tsc.

---

## Phase 3 — Daemon: new shared route

**Files:**
- Create: `assistant/src/runtime/routes/provider-availability-routes.ts`
- Create: `assistant/src/runtime/routes/__tests__/provider-availability-routes.test.ts`
- Modify: `assistant/src/runtime/routes/index.ts`

- [ ] **Step 1: Write the failing test**

Create `assistant/src/runtime/routes/__tests__/provider-availability-routes.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { ROUTES } from "../provider-availability-routes.js";

describe("provider-availability-routes", () => {
  test("exports two routes: list + by-id", () => {
    expect(ROUTES).toHaveLength(2);
    expect(ROUTES.map((r) => r.operationId).sort()).toEqual([
      "provider_availability_get",
      "provider_availability_list",
    ]);
  });

  test("list handler returns a map keyed by provider id", async () => {
    const list = ROUTES.find((r) => r.operationId === "provider_availability_list");
    expect(list).toBeDefined();
    const result = await list!.handler({ queryParams: {}, pathParams: {} } as never);
    expect(typeof result).toBe("object");
    expect(result["ollama"]).toEqual({ available: true });
  });

  test("by-id handler returns the single-provider status", async () => {
    const byId = ROUTES.find((r) => r.operationId === "provider_availability_get");
    expect(byId).toBeDefined();
    const result = await byId!.handler({
      queryParams: {},
      pathParams: { id: "ollama" },
    } as never);
    expect(result).toEqual({ available: true });
  });

  test("?fresh=true invalidates cache without throwing", async () => {
    const list = ROUTES.find((r) => r.operationId === "provider_availability_list");
    const result = await list!.handler({
      queryParams: { fresh: "true" },
      pathParams: {},
    } as never);
    expect(result["ollama"]).toEqual({ available: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd assistant
bun test src/runtime/routes/__tests__/provider-availability-routes.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `assistant/src/runtime/routes/provider-availability-routes.ts`:

```typescript
/**
 * GET /v1/provider-availability  → map keyed by provider id
 * GET /v1/provider-availability/:id  → single-provider status
 *
 * Both accept `?fresh=true` to invalidate the daemon's process-lifetime
 * cache before evaluation. GET handlers are otherwise side-effect-free
 * per assistant/src/runtime/CLAUDE.md.
 */

import { z } from "zod";

import {
  clearClaudeSubscriptionAvailabilityCache,
  getAllProviderAvailability,
  getProviderAvailabilityStatus,
} from "../../providers/provider-availability.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const STATUS_SHAPE = z.object({
  available: z.boolean(),
  reason: z
    .enum(["missing-cli", "not-logged-in", "not-enabled", "no-api-key"])
    .optional(),
});

function maybeBustCache({ queryParams }: RouteHandlerArgs): void {
  if (queryParams?.fresh === "true") clearClaudeSubscriptionAvailabilityCache();
}

async function handleList(args: RouteHandlerArgs) {
  maybeBustCache(args);
  return getAllProviderAvailability();
}

async function handleGet(args: RouteHandlerArgs) {
  maybeBustCache(args);
  const id = args.pathParams?.id;
  if (!id) return { available: false, reason: "no-api-key" as const };
  return getProviderAvailabilityStatus(id);
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "provider_availability_list",
    endpoint: "provider-availability",
    method: "GET",
    summary: "Per-provider availability for setup-hint UX",
    description:
      "Returns a map keyed by provider id. Each value is { available, reason? } where reason narrows the cause when unavailable.",
    tags: ["providers"],
    queryParams: [
      {
        name: "fresh",
        type: "string",
        description: "Set to 'true' to invalidate the daemon's availability cache before evaluation.",
      },
    ],
    responseBody: z.record(z.string(), STATUS_SHAPE),
    handler: handleList,
  },
  {
    operationId: "provider_availability_get",
    endpoint: "provider-availability/:id",
    method: "GET",
    summary: "Single-provider availability lookup",
    tags: ["providers"],
    queryParams: [
      {
        name: "fresh",
        type: "string",
        description: "Set to 'true' to invalidate the daemon's availability cache before evaluation.",
      },
    ],
    responseBody: STATUS_SHAPE,
    handler: handleGet,
  },
];
```

- [ ] **Step 4: Wire the new bundle into the shared array**

In `assistant/src/runtime/routes/index.ts`, add the import in alphabetical order (between `PLATFORM_ROUTES` and `PLAYGROUND_ROUTES`):

```typescript
import { ROUTES as PROVIDER_AVAILABILITY_ROUTES } from "./provider-availability-routes.js";
```

And register it in the `ROUTES` spread block (alphabetical order, same neighborhood):

```typescript
  ...PROVIDER_AVAILABILITY_ROUTES,
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd assistant
bun test src/runtime/routes/__tests__/provider-availability-routes.test.ts
```

Expected: 4 pass / 0 fail.

- [ ] **Step 6: Full daemon verification**

```bash
cd assistant
bun test src/__tests__/claude-subscription-provider.test.ts src/__tests__/claude-subscription-concurrency.test.ts src/providers/__tests__/provider-availability.test.ts src/runtime/routes/__tests__/provider-availability-routes.test.ts && \
  NODE_OPTIONS="--max-old-space-size=8192" bunx tsc --noEmit
```

Expected: all suites pass; `EXIT=0` on tsc.

---

## Phase 4 — Swift: Codable model for `ProviderAvailabilityStatus`

**Files:**
- Create: `clients/shared/Models/ProviderAvailabilityStatus.swift`

- [ ] **Step 1: Create the model**

Create `clients/shared/Models/ProviderAvailabilityStatus.swift`:

```swift
import Foundation

/// Wire-shape mirror of the daemon's `ProviderAvailabilityStatus`. Decoded
/// from `GET /v1/provider-availability` and stored in `SettingsStore.providerAvailability`.
public struct ProviderAvailabilityStatus: Codable, Equatable, Sendable {
    public enum Reason: String, Codable, Sendable, CaseIterable {
        case missingCli = "missing-cli"
        case notLoggedIn = "not-logged-in"
        case notEnabled = "not-enabled"
        case noApiKey = "no-api-key"
    }

    public let available: Bool
    public let reason: Reason?

    public init(available: Bool, reason: Reason? = nil) {
        self.available = available
        self.reason = reason
    }
}
```

- [ ] **Step 2: Verify the model compiles**

```bash
cd clients
swift build --target MaxAssistantShared 2>&1 | tail -20
echo "EXIT=$?"
```

Expected: builds cleanly, `EXIT=0`.

---

## Phase 5 — Swift: protocol-based availability client

**Files:**
- Create: `clients/shared/Network/ProviderAvailabilityClient.swift`

- [ ] **Step 1: Create the protocol + concrete client**

Create `clients/shared/Network/ProviderAvailabilityClient.swift`:

```swift
import Foundation

/// Hermetic-test seam for `SettingsStore.refreshProviderAvailability`.
/// Mirrors the `ProviderConnectionClientProtocol` pattern.
public protocol ProviderAvailabilityClientProtocol: Sendable {
    /// Returns the daemon's full availability map. Returns `nil` on transport
    /// failure so callers preserve their last-known snapshot rather than blanking.
    func fetchProviderAvailability(fresh: Bool) async -> [String: ProviderAvailabilityStatus]?
}

/// Production client. Calls `GET /v1/provider-availability[?fresh=true]`.
public struct ProviderAvailabilityClient: ProviderAvailabilityClientProtocol {
    public init() {}

    public func fetchProviderAvailability(fresh: Bool) async -> [String: ProviderAvailabilityStatus]? {
        do {
            let params: [String: String]? = fresh ? ["fresh": "true"] : nil
            let map: [String: ProviderAvailabilityStatus] = try await GatewayHTTPClient.get(
                path: "provider-availability",
                params: params
            )
            return map
        } catch {
            // Tolerant on transport failure — caller keeps last-known map.
            return nil
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd clients
swift build --target MaxAssistantShared 2>&1 | tail -20
echo "EXIT=$?"
```

Expected: builds cleanly, `EXIT=0`.

---

## Phase 6 — Swift: `SettingsStore.providerAvailability`

**Files:**
- Modify: `clients/macos/max-assistant/Features/Settings/SettingsStore.swift`
- Create: `clients/macos/max-assistantTests/SettingsStoreProviderAvailabilityTests.swift`

- [ ] **Step 1: Write the failing test**

Create `clients/macos/max-assistantTests/SettingsStoreProviderAvailabilityTests.swift`:

```swift
import XCTest
@testable import MaxAssistantLib
@testable import MaxAssistantShared

final class SettingsStoreProviderAvailabilityTests: XCTestCase {

    private final class StubClient: ProviderAvailabilityClientProtocol {
        let result: [String: ProviderAvailabilityStatus]?
        init(result: [String: ProviderAvailabilityStatus]?) { self.result = result }
        func fetchProviderAvailability(fresh: Bool) async -> [String: ProviderAvailabilityStatus]? {
            return result
        }
    }

    @MainActor
    func test_loadProviderAvailability_publishesMap() {
        let store = SettingsStore.makeForTests()
        let map: [String: ProviderAvailabilityStatus] = [
            "claude-subscription": ProviderAvailabilityStatus(available: false, reason: .missingCli),
            "ollama": ProviderAvailabilityStatus(available: true, reason: nil),
        ]
        store.loadProviderAvailability(map: map)
        XCTAssertEqual(store.providerAvailability["claude-subscription"]?.reason, .missingCli)
        XCTAssertTrue(store.providerAvailability["ollama"]?.available ?? false)
    }

    @MainActor
    func test_refreshProviderAvailability_keepsMapOnTransportFailure() async {
        let store = SettingsStore.makeForTests()
        let initial: [String: ProviderAvailabilityStatus] = [
            "claude-subscription": ProviderAvailabilityStatus(available: true, reason: nil),
        ]
        store.loadProviderAvailability(map: initial)

        await store.refreshProviderAvailability(client: StubClient(result: nil))

        XCTAssertEqual(store.providerAvailability["claude-subscription"]?.available, true,
                       "Expected last-known map to be preserved on transport failure")
    }
}
```

> **Note:** `SettingsStore.makeForTests()` is the existing test-helper used by other `SettingsStore*Tests` files. If it does not exist or has a different name, use whichever initializer the sibling `SettingsStoreMediaLoadTests` uses — open that file first to confirm the seed pattern, then mirror it here.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd clients/macos
./build.sh test 2>&1 | tail -20
```

Expected: FAIL — `providerAvailability` / `loadProviderAvailability` / `refreshProviderAvailability` not defined.

- [ ] **Step 3: Implement the published map + load/refresh**

In `clients/macos/max-assistant/Features/Settings/SettingsStore.swift`, alongside `connectionReachability` (around line 138):

```swift
/// Mirror of `connectionReachability` for provider *setup* state. Populated
/// from `GET /v1/provider-availability` and consumed by `ComposerSettingsMenu`
/// to render the disabled-with-hint row for unavailable providers
/// (currently claude-subscription).
@Published public private(set) var providerAvailability: [String: ProviderAvailabilityStatus] = [:]
```

Add the load + refresh methods (place near `loadConnectionReachability` / `refreshConnectionReachability`, around line 3340):

```swift
/// Replace the published map atomically with the daemon's snapshot.
func loadProviderAvailability(map: [String: ProviderAvailabilityStatus]) {
    self.providerAvailability = map
}

/// Tolerant refresh — on transport failure (`client` returns nil) the existing
/// snapshot is preserved. Matches the contract of `refreshConnectionReachability`.
func refreshProviderAvailability(
    client: ProviderAvailabilityClientProtocol = ProviderAvailabilityClient(),
    fresh: Bool = false
) async {
    guard let map = await client.fetchProviderAvailability(fresh: fresh) else { return }
    loadProviderAvailability(map: map)
}
```

Wire app-launch refresh near the existing call site at line ~4918 (where `refreshConnectionReachability` fires):

```swift
await self?.refreshConnectionReachability()
await self?.refreshProviderAvailability()
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd clients/macos
./build.sh test 2>&1 | tail -20
```

Expected: both new tests pass; no existing tests regress.

- [ ] **Step 5: Full Swift verification**

```bash
cd clients/macos
./build.sh test 2>&1 | tail -5
```

Expected: full test suite green.

---

## Phase 7 — Swift: thread availability through `ChatProfilePickerConfiguration`

**Files:**
- Modify: `clients/macos/max-assistant/Features/Chat/ChatProfilePicker.swift`

- [ ] **Step 1: Add the field to `ChatProfilePickerConfiguration`**

In `clients/macos/max-assistant/Features/Chat/ChatProfilePicker.swift`, inside the `ChatProfilePickerConfiguration` struct (alongside `connectionReachability` at line ~25):

```swift
/// Snapshot of `SettingsStore.providerAvailability`. Drives the disabled-row
/// hint for providers whose setup is incomplete (currently claude-subscription).
/// Empty by default so existing call sites stay one-line.
var providerAvailability: [String: ProviderAvailabilityStatus] = [:]
```

- [ ] **Step 2: Update construction sites that build the configuration**

Find every site that constructs `ChatProfilePickerConfiguration` (typically inside `ComposerView` / `ComposerSection` and in chat-state observation code). For each, add the snapshot read:

```bash
cd clients/macos/max-assistant
grep -rn "ChatProfilePickerConfiguration(" --include="*.swift"
```

For each match, add `providerAvailability: settingsStore.providerAvailability` to the initializer call. Default is `[:]`, so any call site that doesn't have a `SettingsStore` in scope can be left untouched (defensive default).

- [ ] **Step 3: Verify the macOS app still builds**

```bash
cd clients/macos
./build.sh 2>&1 | tail -10
echo "EXIT=$?"
```

Expected: `EXIT=0`; `dist/Max.app` rebuilt.

---

## Phase 8 — Swift: `ComposerSettingsMenu.providerRow` branch + pure helpers

**Files:**
- Modify: `clients/macos/max-assistant/Features/Chat/ComposerSettingsMenu.swift`
- Modify: `clients/macos/max-assistantTests/Features/Chat/ChatProfilePickerTests.swift`

- [ ] **Step 1: Write the failing tests for the pure helpers**

In `clients/macos/max-assistantTests/Features/Chat/ChatProfilePickerTests.swift`, add a new `describe`-style block:

```swift
// MARK: - ComposerSettingsMenu: claude-subscription unavailable branch

func test_claudeSubscriptionTrailingText_missingCli() {
    let text = ComposerSettingsMenu.claudeSubscriptionTrailingText(reason: .missingCli)
    XCTAssertEqual(text, "Install Claude Code")
}

func test_claudeSubscriptionTrailingText_notLoggedIn() {
    let text = ComposerSettingsMenu.claudeSubscriptionTrailingText(reason: .notLoggedIn)
    XCTAssertEqual(text, "Run `claude login`")
}

func test_claudeSubscriptionTrailingText_notEnabled() {
    let text = ComposerSettingsMenu.claudeSubscriptionTrailingText(reason: .notEnabled)
    XCTAssertEqual(text, "Feature flag off")
}

func test_claudeSubscriptionTrailingText_noApiKeyFallback() {
    let text = ComposerSettingsMenu.claudeSubscriptionTrailingText(reason: .noApiKey)
    XCTAssertEqual(text, "Not available")
}

func test_claudeSubscriptionRowLabel_missingCli() {
    let label = ComposerSettingsMenu.claudeSubscriptionRowLabel(reason: .missingCli)
    XCTAssertEqual(label, "Claude (Max Plan) · not installed")
}

func test_claudeSubscriptionRowLabel_notLoggedIn() {
    let label = ComposerSettingsMenu.claudeSubscriptionRowLabel(reason: .notLoggedIn)
    XCTAssertEqual(label, "Claude (Max Plan) · not signed in")
}

func test_claudeSubscriptionRowLabel_notEnabled() {
    let label = ComposerSettingsMenu.claudeSubscriptionRowLabel(reason: .notEnabled)
    XCTAssertEqual(label, "Claude (Max Plan) · disabled")
}

func test_claudeSubscriptionRowLabel_availableFallsBack() {
    let label = ComposerSettingsMenu.claudeSubscriptionRowLabel(reason: nil)
    XCTAssertEqual(label, "Claude (Max Plan)")
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd clients/macos
./build.sh test 2>&1 | tail -20
```

Expected: FAIL — helpers not defined.

- [ ] **Step 3: Implement the pure helpers**

In `clients/macos/max-assistant/Features/Chat/ComposerSettingsMenu.swift`, add inside `ComposerSettingsMenu` (place near the existing `ollamaStatusTrailingText` static at line ~549):

```swift
/// Trailing text shown next to the disabled claude-subscription row.
/// Pure so tests can assert without a SwiftUI host.
static func claudeSubscriptionTrailingText(
    reason: ProviderAvailabilityStatus.Reason?
) -> String {
    switch reason {
    case .missingCli:   return "Install Claude Code"
    case .notLoggedIn:  return "Run `claude login`"
    case .notEnabled:   return "Feature flag off"
    case .noApiKey, nil: return "Not available"
    }
}

/// Row label for the claude-subscription row. The `available` (nil reason)
/// case falls back to the existing label so the helper can be the single
/// source of truth without changing the available-state code path.
static func claudeSubscriptionRowLabel(
    reason: ProviderAvailabilityStatus.Reason?
) -> String {
    switch reason {
    case .missingCli:   return "Claude (Max Plan) · not installed"
    case .notLoggedIn:  return "Claude (Max Plan) · not signed in"
    case .notEnabled:   return "Claude (Max Plan) · disabled"
    case .noApiKey:     return "Claude (Max Plan) · not available"
    case .none:         return "Claude (Max Plan)"
    }
}
```

- [ ] **Step 4: Run helper tests to verify they pass**

```bash
cd clients/macos
./build.sh test 2>&1 | tail -20
```

Expected: 8 new tests pass; no regressions.

- [ ] **Step 5: Wire the unavailable branch into `providerRow`**

In `ComposerSettingsMenu.swift`'s `providerRow` body, before the existing `if group.kind == .ollama` branch (around line ~363), add:

```swift
if group.kind == .claudeSubscription,
   let status = inferenceProfilePicker?.providerAvailability["claude-subscription"],
   status.available == false {
    claudeSubscriptionUnavailableRow(reason: status.reason)
    return  // short-circuits the rest of providerRow for this group
}
```

Add the new view-builder helper near the existing `ollamaProviderRow`:

```swift
/// Disabled row for claude-subscription when the daemon reports unavailable.
/// Mirrors the offline-Ollama disabled `VMenuItem` pattern: no submenu, red
/// status dot, reason-specific trailing text.
@ViewBuilder
private func claudeSubscriptionUnavailableRow(
    reason: ProviderAvailabilityStatus.Reason?
) -> some View {
    let trailingText = Self.claudeSubscriptionTrailingText(reason: reason)
    let rowLabel = Self.claudeSubscriptionRowLabel(reason: reason)

    VMenuItem(
        icon: VIcon.sparkles.rawValue,
        label: rowLabel,
        isActive: false,
        size: .regular,
        action: {}
    ) {
        HStack(spacing: VSpacing.xs) {
            Circle()
                .fill(VColor.systemNegativeStrong)
                .frame(width: 8, height: 8)
            Text(trailingText)
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(.trailing, VSpacing.lg)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
    .disabled(true)
}
```

- [ ] **Step 6: Add picker-open refresh hook**

Inside `ComposerSettingsMenu.showMenu()` (around line ~93), after `isMenuOpen = true`, add:

```swift
// Refresh provider availability when the menu opens. Cache-cheap on the
// daemon side; the published map updates and SwiftUI redraws the row.
if let store = inferenceProfilePicker?.settingsStoreForRefresh {
    Task { @MainActor in
        await store.refreshProviderAvailability()
    }
}
```

If `ChatProfilePickerConfiguration` does not already expose a `settingsStoreForRefresh: SettingsStore?` field, add it (default `nil`) — production call sites that have the store thread it; tests don't. Wire the construction sites to set it (one-line addition to each site you touched in Phase 7).

- [ ] **Step 7: Run the full Swift test suite**

```bash
cd clients/macos
./build.sh test 2>&1 | tail -10
```

Expected: full test suite green.

- [ ] **Step 8: Rebuild the app and visually confirm**

```bash
cd clients/macos
./build.sh
echo "EXIT=$?"
```

Expected: `EXIT=0`. App bundle rebuilt at `dist/Max.app`.

---

## Phase 9 — Production-readiness verification

> The user directive: *"verify everything so that it works in production."* This phase is not optional.

**Files:** none modified. Verification-only.

- [ ] **Step 1: Full daemon test suite — every claude-subscription file**

```bash
cd assistant
bun test \
  src/__tests__/claude-subscription-provider.test.ts \
  src/__tests__/claude-subscription-concurrency.test.ts \
  src/providers/__tests__/provider-availability.test.ts \
  src/runtime/routes/__tests__/provider-availability-routes.test.ts
```

Expected: 38 + (new Phase 1/2 tests) + 4 (route tests) all pass / 0 fail.

- [ ] **Step 2: Daemon-wide tsc clean**

```bash
cd assistant
NODE_OPTIONS="--max-old-space-size=8192" bunx tsc --noEmit
echo "EXIT=$?"
```

Expected: `EXIT=0`.

- [ ] **Step 3: macOS app + tests build clean**

```bash
cd clients/macos
./build.sh test 2>&1 | tail -5
./build.sh
```

Expected: tests green; app bundle present at `dist/Max.app`.

- [ ] **Step 4: Manual smoke per state**

Launch `dist/Max.app`. For each of the 4 states, observe the picker:

| State | Setup | Expected picker row |
|---|---|---|
| `available` | `claude` CLI on PATH + `claude login` done + feature flag ON | "Claude (Max Plan)" with chevron, opens submenu |
| `missing-cli` | uninstall `claude` (or rename binary on PATH) | "Claude (Max Plan) · not installed" — disabled — red dot — "Install Claude Code" trailing |
| `not-logged-in` | `claude` present + `claude logout` | "Claude (Max Plan) · not signed in" — disabled — red dot — "Run `claude login`" trailing |
| `not-enabled` | flag off in `meta/feature-flags/feature-flag-registry.json` (set `defaultEnabled: false` and restart daemon) | "Claude (Max Plan) · disabled" — disabled — red dot — "Feature flag off" trailing |

Take a screenshot of each state for the PR description.

- [ ] **Step 5: Empirical probes still pass (foundation safety)**

If any of the load-bearing options in `client.ts` were touched during implementation, re-run per the probe README. Otherwise:

```bash
cd /Users/yashbishnoi/Downloads/max-assistant-main
node assistant/scripts/claude-subscription/i-11-isolation.mjs
node assistant/scripts/claude-subscription/i-11b-subagent-isolation.mjs
node assistant/scripts/claude-subscription/i-22-system-prompt.mjs
```

Expected: i-11 and i-11b print `VERDICT: ✅`; i-22 exits 0 with the 3 sub-probe headers. (Skip if `client.ts` is untouched and the foundation 38 still pass — the probes are insurance.)

- [ ] **Step 6: Update the bridge doc's priority queue**

In `assistant/docs/architecture/claude-subscription-bridge.md`, mark task #2 as done in the priority queue (same strikethrough + "(done)" pattern used for task #1). Cross-reference this plan's location. Also update the "Suggested opening prompt" template to point at task #3 (DI refactor for availability tests) so the next session continues the chain.

```bash
cd /Users/yashbishnoi/Downloads/max-assistant-main
git status assistant/docs/architecture/claude-subscription-bridge.md
```

Expected: file shows as modified.

- [ ] **Step 7: Final foundation check — nothing regressed**

```bash
cd assistant
bun test src/__tests__/claude-subscription-{provider,concurrency,isolation-probes}.test.ts && \
  NODE_OPTIONS="--max-old-space-size=8192" bunx tsc --noEmit && \
  echo "FOUNDATION: GREEN"
```

Expected: `38 pass / 1 skip / 0 fail`, `EXIT=0`, `FOUNDATION: GREEN`.

---

## Self-review checklist (filled in)

- **Spec coverage:** every section of the spec maps to a task. §3 architecture → Phase 1-8. §4.1-4.2 → Phases 1-3. §4.3 feature-flag → Phase 2 Step 3. §5.1-5.5 → Phases 4-8. §7 copy table → Phase 8 helpers + tests. §8 error handling → Phase 6 tolerant refresh test. §9 testing → tests embedded in every TDD step. §10 out-of-scope items deliberately omitted from the plan.
- **Placeholder scan:** no "TBD" / "implement later" / "similar to" patterns. Every code step shows code or commands. The one "open dependency" (DI refactor for live `execFile` testing) is called out in the spec §9.1 and Phase 2 sidesteps it by mocking at the function boundary (`isAssistantFeatureFlagEnabled`) rather than at `execFile`.
- **Type consistency:** `ProviderAvailabilityStatus` is identical in daemon (TS) and Swift across all phases. `Reason` cases match: `missing-cli` ↔ `.missingCli`, `not-logged-in` ↔ `.notLoggedIn`, `not-enabled` ↔ `.notEnabled`, `no-api-key` ↔ `.noApiKey`. Function names stable: `getProviderAvailabilityStatus`, `getAllProviderAvailability`, `loadProviderAvailability`, `refreshProviderAvailability`, `claudeSubscriptionTrailingText`, `claudeSubscriptionRowLabel`, `claudeSubscriptionUnavailableRow`.
- **No spec requirements without tasks.** Confirmed.

---

## Open items the spec called out (un-resolved before merge)

1. **Copy text wording** — first-draft strings; revisit before non-engineer rollout. Tracked in spec §11(1).
2. **DI refactor sequencing** — by mocking the feature-flag function rather than `execFile`, this plan sidesteps the existing DI fragility for new tests. The legacy gap noted in `claude-subscription-bridge.md` §9 remains a separate task (priority queue #3).
3. **macOS-only scope.** Plan touches only Swift in `clients/macos/`; Linux/Windows clients (out of repo) consume the same wire format with no extra work in this plan.
