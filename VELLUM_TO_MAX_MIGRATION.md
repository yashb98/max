# Vellum → Max Migration Inventory

System-wide audit of every "Vellum" / "vellum" / "VELLUM" surface that must be
considered when re-branding to **Max**.

**Scope.** Excludes `node_modules/`, `.build/`, `snapshots/`, `dist/`, and `.git/`.
The raw counts below are post-exclusion. **Lists are illustrative, not exhaustive
for every category** — re-run the ripgrep commands at the end of each section
after any rename pass; static lists go stale fast (2,266 files contain the
string).

**Generated:** 2026-05-16  
**Repo root:** `/Users/yashbishnoi/Downloads/vellum-assistant-main`

---

## 0. READ THIS FIRST — Open questions / risks

### 0.1 Question: does `max.app` already exist?

`~/.claude/.../memory/` notes that **`max.app` already uses
`~/.local/share/vellum-dev/`** while the CLI uses `~/.local/share/vellum/`.
That implies one of:

  - You already started this rename and `max.app` is the half-renamed macOS app, **or**
  - `max.app` is a separate product/CLI that coexists with Vellum.

Resolve this before touching anything. If the former: the rename plan must
account for whatever has already shipped (data dirs, bundle IDs, settings
keys may already be partly renamed and need backwards-compatibility shims).

### 0.2 Collision warning: `Max` / `max` are already common tokens

| Where                              | Count           | Examples |
|------------------------------------|-----------------|----------|
| `max` (lowercase) in Swift/JSON    | **310**         | `maxWidth`, `maxHeight`, `Math.max(...)`, `max-steps`, `maxAge` |
| `Max` (PascalCase) in Swift/JSON   | **12**          | `SentryMaxAttachmentSizeTests.swift`, `MaxAttachmentSize` |
| Existing files containing `max`    | `SentryMaxAttachmentSizeTests.swift`, `008-voice-timeout-and-max-steps.ts` | unrelated to branding |

**Do not run a naïve `sed s/[Vv]ellum/[Mm]ax/g`** — it will not collide directly
(no token is literally `vellum` that overlaps `max`), but the resulting diff
will be hard to review because `Max*` and `max*` already appear ~322 times for
totally unrelated reasons. Use **word-boundary** patterns:

```bash
# safe replacements
rg -l '\bvellum\b'   # lowercase whole-word
rg -l '\bVellum\b'   # PascalCase
rg -l '\bVELLUM\b'   # SCREAMING
rg -l '\bvellumai\b' # npm scope token
```

---

## 1. Migration-risk tiers (use this to plan order)

| Tier | What it covers | Why it's risky | Approach |
|------|----------------|----------------|----------|
| **T1: External** | Things outside this repo (GitHub org, npm scope, domains, Docker registry, sibling repos, Sparkle appcast, Sentry, LaunchDarkly) | Renames need infra changes + lead time + DNS + auth | Plan first, change last |
| **T2: Coordinated in-repo** | Things that break the build if half-done: Xcode targets, bundle IDs, Swift module names, package.json names, custom URL scheme, plist keys | One PR per group, must land atomic | Bigger PRs, full CI |
| **T3: Safe find/replace** | `VELLUM_*` env vars, code identifiers, doc strings, display strings, comments | Mostly mechanical with word-boundary regex | Tooled rename + review |

---

## 2. Tier 1 — External surfaces (rename outside the repo)

### 2.1 GitHub
| Surface | Current | File reference |
|--------|---------|----------------|
| GitHub org | `vellum-ai` | `README.md`, `CONSTITUTION.md`, `assistant/**/*.md`, plists |
| Repo | `vellum-ai/vellum-assistant` | LICENSE URL, README banners, Sparkle appcast |
| Sibling repo | `vellum-ai/vellum-assistant-platform` | Heavily referenced — Django backend, OAuth/CES contracts, feature flags |
| Other org repos | `vellum-ai/claude-skills`, `vellum-ai/velly` | scripts, docs |

Sparkle appcast URL (macOS auto-update — `Info.plist`):  
`https://github.com/vellum-ai/vellum-assistant/releases/latest/download/appcast.xml`

### 2.2 npm scope `@vellumai/*`
**24+ scoped packages** (must be re-published under new scope):

```
@vellumai/assistant            @vellumai/assistant-client   @vellumai/ces-client
@vellumai/chrome-extension     @vellumai/cli                @vellumai/cool-plugin
@vellumai/credential-executor  @vellumai/credential-storage @vellumai/egress-proxy
@vellumai/gateway-client       @vellumai/ipc-server-utils   @vellumai/meet-bot
@vellumai/meet-controller-ext  @vellumai/meet-skill         @vellumai/plugin-api
@vellumai/plugin-echo-example  @vellumai/scripts            @vellumai/service-contracts
@vellumai/simple-memory        @vellumai/skill-host-contracts @vellumai/slack-text
@vellumai/twilio-client        @vellumai/vellum-gateway     @vellumai/web
```

Also: `@vellum/openclaw-adapter`, `@vellumai/ces`, `@vellumai/ces-contracts`.

### 2.3 Domains (DNS + cert work)
| Domain | Used in |
|--------|---------|
| `vellum.ai`, `www.vellum.ai` | Primary brand site, docs (`VELLUM_DOCS_BASE_URL`) |
| `app.vellum.ai`, `api.vellum.ai`, `platform.vellum.ai` | Production platform |
| `dev-platform.vellum.ai`, `staging-platform.vellum.ai`, `qa.vellum.ai`, `test.vellum.ai` | Non-prod tiers |
| `dev-assistant.vellum.ai`, `staging-assistant.vellum.ai` | Non-prod assistant |
| `*.vellum.cloud` (e.g., `rt.vellum.cloud`) | Realtime/runtime traffic |
| `vellum.app` | (referenced in env defaults and memory) |
| `vellum.local`, `*.vellum.local` | Local-dev hostnames |
| `vellum.me`, `mybot.vellum.me` | Bot subdomain |
| Test/fixture hosts: `velay.vellum.ai`, `velay-dev.vellum.ai`, `surface.vellum.local`, etc. | tests only — safe to rename |

`.env.example` references: `PROXY_ALLOWED_HOSTS=*.vellum.ai`, `VELLUM_DOCS_BASE_URL=https://staging.vellum.ai/docs`.

### 2.4 Docker images / registries
- `vellum-meet-bot:dev` (meet bot)
- `vellum-sandbox:latest` (sandbox runner)
- `vellum-multiarch`, `vellum-gcr-multiarch` (publish targets in `scripts/gcr-publish.ts`)
- `VELLUM_ASSISTANT_IMAGE`, `VELLUM_GATEWAY_IMAGE`, `VELLUM_CREDENTIAL_EXECUTOR_IMAGE` (env-var image overrides)

### 2.5 Other external systems
- **Sentry**: org/project named `vellum-*` (see `com.vellum.sentry-capture`, `com.vellum.sentry-log-reporter`). Inspect Sentry DSN(s) in `.env` / k8s secrets.
- **LaunchDarkly / Terraform feature flags**: `safe-storage-limits` and others. Provisioned in sibling `vellum-assistant-platform` Terraform.
- **GitHub App** for automation: `VELLUM_AUTOMATION_GITHUB_APP_ID`, `VELLUM_AUTOMATION_GITHUB_PRIVATE_KEY`.
- **AWS role**: `VELLUM_AWS_ROLE_ARN`.

```bash
# Re-discover external surfaces
rg -oE 'https?://[a-zA-Z0-9.-]*vellum[a-zA-Z0-9.-]*' -g '!node_modules' -g '!.build' --no-filename | sort -u
rg -oE '@vellum[a-z]*/[a-z0-9-]+' -g '!node_modules' --no-filename | sort -u
rg -oE 'vellum-ai/[a-z0-9_-]+'   -g '!node_modules' --no-filename | sort -u
```

---

## 3. Tier 2 — Coordinated in-repo renames (atomic per group)

### 3.1 macOS app — bundle identifiers (`com.vellum.*`)
**Touches**: Info.plist, entitlements, Xcode project, code signing, App Group, keychain access groups.

Distinct prefixes in use:
```
com.vellum.app-bundle           com.vellum.assistant
com.vellum.assistant.audio-playback   com.vellum.audio
com.vellum.bootstrap-state-tests com.vellum.cli.line-buffer
com.vellum.daemon               com.vellum.internal
com.vellum.jit.always           com.vellum.meet
com.vellum.memory-pressure-monitor    com.vellum.mgmt-socket
com.vellum.objc-exception       com.vellum.prechat-onboarding-tests
com.vellum.screen-recorder.output     com.vellum.sentry-capture
com.vellum.sentry-log-reporter  com.vellum.stall-detector
com.vellum.test.blocked-main    com.vellum.test.sampling
com.vellum.vellum-assistant     com.vellum.vellum-assistant-dev
com.vellum.vellum-assistant-local    com.vellum.vellum-assistant-staging
com.vellum.vellum-assistant.QLPreview com.vellum.vellum-assistant.QLThumbnail
com.vellum.vellum-assistant.Sparkle  com.vellum.vellum-assistant.swiftpackage
```

Also the **process-internal dispatch queue names** (`com.vellum.audioEngine.*`, `com.vellum.theme.*`, `com.vellum.feature-flag`, `com.vellum.confirm`, etc.) — these are not strictly identifiers but appear as `DispatchQueue(label:)` strings in Swift.

### 3.2 macOS app — Info.plist keys (3 plists)

| File | `CFBundleIdentifier` | `CFBundleName` | `CFBundleDisplayName` |
|------|---------------------|----------------|----------------------|
| `clients/macos/vellum-assistant/Resources/Info.plist` | `$(PRODUCT_BUNDLE_IDENTIFIER)` | `$(PRODUCT_NAME)` | — |
| `clients/macos/VellumQLPreview/Info.plist` | `com.vellum.vellum-assistant.QLPreview` | `VellumQLPreview` | `Vellum Quick Look Preview` |
| `clients/macos/VellumQLThumbnail/Info.plist` | `com.vellum.vellum-assistant.QLThumbnail` | `VellumQLThumbnail` | `Vellum Quick Look Thumbnail` |

Also in the main `Info.plist`:
- `NSScreenCaptureUsageDescription`, `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription` — strings say "Vellum needs …"
- `CFBundleURLTypes` → `CFBundleURLSchemes` contains literal `"vellum"` (see §3.3)

### 3.3 Custom URL scheme `vellum://`
**Handler:** `clients/macos/vellum-assistant/Features/Surfaces/VellumAppSchemeHandler.swift`  
**Tests:** `clients/macos/vellum-assistantTests/VellumAppSchemeHandlerTests.swift`

Registered scheme: `vellum`  
Known deep-link paths:
```
vellum://create-skill
vellum://enable-integration
vellum://send
```

Renaming the scheme breaks any external bookmarks/links and any code (browser extension, web app) that issues these URLs.

### 3.4 Swift module / target / type names (Xcode)

`Package.swift` and Xcode targets:

```
vellum-assistant              vellum-assistant-app
vellum-assistant-entitlement.plist    vellum_assistant.build
vellum-assistant_VellumAssistantLib.bundle
vellum-assistant_VellumAssistantShared.bundle
vellum-assistant.dSYM         vellum-assistant.product
vellum_assistantTests         vellum_assistantPackageTests
VellumAssistantLib            VellumAssistantShared
VellumAssistantSharedTests    VellumQLPreview   VellumQLThumbnail
```

Type declarations (verified via `grep -E '^(class|struct|enum|protocol|extension) Vellum…'`):

```swift
enum   VellumContainerEnv
enum   VellumContainerPorts
enum   VellumMountPaths
enum   VellumServiceName
extension VellumServiceName
struct VellumAssistantApp: App
struct VellumImageReference
```

Other Swift symbols referenced throughout:

```
VellumApp, VellumAppScheme, VellumAppSchemeHandler, VellumAppSchemeHandlerTests,
VellumAssistantApp, VellumAssistantLib, VellumAssistantShared, VellumAssistantSharedTests,
VellumCategory, VellumCli, VellumCloud, VellumCommitSHA, VellumContainerEnv,
VellumContainerPorts, VellumDocument, VellumEnvironment, VellumFrontmost,
VellumImageReference, VellumMenuBar, VellumMountPaths, VellumPaths, VellumPathsTests,
VellumRemoteImages, VellumSection, VellumServiceName, VellumVariantForManagedAssistant,
VellumView, VellumWindow
```

Swift source files (verbatim):
```
clients/shared/App/VellumEnvironment.swift
clients/shared/Utilities/VellumPaths.swift
clients/macos/vellum-assistant/App/VellumCli.swift
clients/macos/vellum-assistant-app/VellumAssistantApp.swift
clients/macos/vellum-assistant/Features/Settings/AboutVellumWindow.swift
clients/macos/vellum-assistant/Features/Surfaces/VellumAppSchemeHandler.swift
clients/macos/vellum-assistantTests/VellumPathsTests.swift
clients/macos/vellum-assistantTests/VellumAppSchemeHandlerTests.swift
```

### 3.5 TypeScript module / type names (assistant + gateway)

`Vellum*` PascalCase identifiers (35+):
```
VellumAcpClientHandler, VellumAdapter, VellumAssistant, VellumAssistantMetadata,
VellumAssistantShared, VellumAvatar, VellumCatalogProvider, VellumConfigDirName,
VellumDaemonProcess, VellumDev, VellumDir, VellumEmailPayload, VellumEnvironment,
VellumError, VellumGuardian, VellumGuardianBinding, VellumInjected,
VellumMetadataFromCes, VellumMetadataSchema, VellumPaths, VellumPayload,
VellumPlatform, VellumPlatformClient, VellumPlatformUrl, VellumPluginRuntime,
VellumProcess, VellumProvider, VellumQdrantClient, VellumRecords, VellumRoot,
VellumRootRoute, VellumSignature, VellumSkillDetail, VellumSlimSkill, VellumSymlink
```

### 3.6 package.json names (31 files have one)
24 scoped packages under `@vellumai/*` (see §2.2). Plus root and meta `"name": "vellum"`. Workspace dependencies use `file:../packages/<name>` — rename must update both `name` and every `dependencies[*]` reference together.

### 3.7 Database migrations referencing Vellum
- `assistant/src/memory/migrations/020-rename-macos-ios-channel-to-vellum.ts` — memory channel rename **into** "vellum" name. Will need a new migration `021-rename-vellum-channel-to-max.ts` (do NOT edit 020 — migrations are immutable once shipped).
- `assistant/src/runtime/guardian-vellum-migration.ts` — runtime migration logic.
- `assistant/src/runtime/routes/__tests__/migration-vellum-metadata-reconcile.test.ts`
- `assistant/src/__tests__/vellum-self-knowledge-inline-command.test.ts`

Channel/source-name string constants (used in stored records, so must be migrated, not just renamed in code):
```
vellum-actor, vellum-anchor, vellum-assistant, vellum-auth, vellum-backup,
vellum-client, vellum-daemon, vellum-design, vellum-export, vellum-gateway,
vellum-import, vellum-interface, vellum-memory, vellum-memv, vellum-migration,
vellum-page, vellum-principal, vellum-profiler, vellum-prompt, vellum-qdrant,
vellum-router, vellum-transcribe
```

Drizzle schema SQL file: `assistant/drizzle/0000_dizzy_maggott.sql` — verify no column/table names contain `vellum` (initial scan showed none, but worth a final grep).

### 3.8 Workspace directories (runtime user data)
| Path | Used by |
|------|---------|
| `~/.local/share/vellum/` | CLI |
| `~/.local/share/vellum-dev/` | `max.app` (per memory) — already partly renamed? |
| `~/.config/vellum/`, `$VELLUM_CONFIG_DIR` | settings |
| `~/.cache/vellum/` (typical), `$VELLUM_DATA_DIR`, `$VELLUM_ROOT_DIR` | data/state |
| `.vellum/`, `.vellum.lock.json`, `.vellum.lockfile.json` | per-project lockfiles |

**Critical for end users**: renaming these orphans their existing data. Plan a migration shim that reads from the old path and copies/symlinks to the new on first launch.

### 3.9 GitHub Actions workflows (`.github/workflows/`)
Workflows referencing Vellum:
```
release.yml                cherry-pick-to-release.yml    socket-autofix.yml
create-release-branch.yml  linear-release-sync.yml       build-chrome-extension.yaml
ci-main-cli.yaml          ci-main-macos.yaml             dev-release.yaml
pr-macos.yaml
```

Artifact names from these workflows:
```
vellum-assistant
vellum-assistant-${{ steps.version.outputs.dev_version }}.dmg
vellum-assistant-pr-${{ github.event.pull_request.number }}.dmg
vellum-credential-executor
vellum-gateway
```

Plus a cross-repo `repository_dispatch` to `vellum-ai/vellum-assistant-platform` for iOS builds.

```bash
# Re-discover Tier 2 surfaces
rg -oE 'com\.vellum[a-z._-]*' -g '!node_modules' -g '!.build' --no-filename | sort -u
rg -oE 'Vellum[A-Z][A-Za-z0-9_]*' -g '*.swift' -g '*.ts' -g '*.tsx' --no-filename | sort -u
rg 'CFBundle(Name|DisplayName|Identifier|URLSchemes)' -g '*.plist' -A1
rg 'vellum://' -g '!node_modules'
```

---

## 4. Tier 3 — Safe find/replace (mostly mechanical)

### 4.1 Environment variables: `VELLUM_*` (≈110 distinct)
Full list (de-duplicated): see Appendix A. Categories:

| Subgroup | Sample |
|---|---|
| **Identity / paths** | `VELLUM_DIR`, `VELLUM_ROOT`, `VELLUM_ROOT_DIR`, `VELLUM_DATA_DIR`, `VELLUM_CONFIG_DIR`, `VELLUM_BACKUP_DIR`, `VELLUM_LOCKFILE_DIR`, `VELLUM_COMP_DIR` |
| **Hosts / URLs** | `VELLUM_PLATFORM_URL`, `VELLUM_WEB_URL`, `VELLUM_DAEMON_URL`, `VELLUM_DOCS_BASE_URL`, `VELLUM_CUSTOM_HOST`, `VELLUM_PUBLIC_BASE_URL` |
| **Cloud / deployment** | `VELLUM_CLOUD`, `VELLUM_CLOUD_VALUES`, `VELLUM_ENV`, `VELLUM_ENVIRONMENT`, `VELLUM_DEV`, `VELLUM_SERVICE`, `VELLUM_AWS_ROLE_ARN`, `VELLUM_MINIKUBE_STORAGE_SIZE` |
| **Docker / sandbox** | `VELLUM_ASSISTANT_IMAGE`, `VELLUM_GATEWAY_IMAGE`, `VELLUM_CREDENTIAL_EXECUTOR_IMAGE`, `VELLUM_SANDBOX_RUNTIME`, `VELLUM_CPU_LIMIT`, `VELLUM_MEMORY_LIMIT` |
| **Apt mirror (kata)** | `VELLUM_APT_DATA_MIRROR`, `VELLUM_APT_DATA_ROOT`, `VELLUM_APT_DATA_SUITE` |
| **Invite codes** | `VELLUM_ASSISTANT_INVITE_CODE_*` (test fixtures) |
| **Feature flags / runtime** | `VELLUM_FLAG_*` (15 variants), `VELLUM_DEBUG`, `VELLUM_NO_WATCH`, `VELLUM_NO_AUTO_TMUX`, `VELLUM_DESKTOP_APP`, `VELLUM_DAEMON_AUTOSTART`, `VELLUM_HEADER_PREFIX`, `VELLUM_HATCHED_BY` |
| **Hook protocol** | `VELLUM_HOOK_EVENT`, `VELLUM_HOOK_NAME`, `VELLUM_HOOK_SETTINGS` |
| **Skills protocol** | `VELLUM_SKILL_ID`, `VELLUM_SKILL_IPC_SOCKET` |
| **Profiler** | `VELLUM_PROFILER_MODE`, `VELLUM_PROFILER_MAX_BYTES`, `VELLUM_PROFILER_MAX_RUNS`, `VELLUM_PROFILER_MIN_FREE_MB`, `VELLUM_PROFILER_RUN_ID` |
| **Exec markers** (output protocol) | `VELLUM_EXEC_START_*`, `VELLUM_EXEC_END_*`, `VELLUM_EXIT_*`, `VELLUM_UNTRUSTED_SHELL` |
| **Test gates** | `VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS`, `VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS`, `VELLUM_TEST_*` |
| **Misc** | `VELLUM_AVATAR_DEVICE`, `VELLUM_MEET_AVATAR_DEVICE`, `VELLUM_SSH_USER`, `VELLUM_CONTENT_CHECK_PATTERNS`, `VELLUM_RELAY_TOKEN_*`, `VELLUM_DEFAULTS_DOMAIN`, `VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH`, `VELLUM_PIDS`, `VELLUM_VARS`, `VELLUM_EXTENSION_FIELDS`, `VELLUM_FIELDS`, `VELLUM_PLATFORM_IDENTITY_FIELDS`, `VELLUM_CONFIG_EOF`, `VELLUM_ENTRY`, `VELLUM_BACKUP_KEY_PATH` |

`VELLUM_ASSISTANT_NAME` is the display name override — important to keep working for users who already set it.

### 4.2 Skill folders (`skills/<name>/`) — 11 first-party skills
Mirror copies live in `clients/macos/daemon-bin/first-party-skills/`.

```
skills/vellum-avatar
skills/vellum-browser-use
skills/vellum-conversation-management
skills/vellum-github-app-setup
skills/vellum-heartbeat
skills/vellum-memory-v2-migration
skills/vellum-oauth-integrations
skills/vellum-self-knowledge
skills/vellum-skills-catalog
skills/vellum-sounds
skills/vellum-terminal-sessions
```

These are referenced by **name string** (not just folder) in `skills/catalog.json` and the SkillLoader middleware — search there too. Also `.claude/skills/vellum-skills` (Claude Code project-local).

### 4.3 Scripts / binaries
```
scripts/vellum-runtime-tunnel.sh
meta/bin/vellum.js
clients/macos/assistant-bin/vellum-assistant
clients/macos/cli-bin/vellum-cli
clients/macos/daemon-bin/vellum-daemon
clients/macos/gateway-bin/vellum-gateway
clients/chrome-extension/vellum-browser-relay.zip
```

### 4.4 Resource files (CSS / JS / icons)
```
clients/macos/vellum-assistant/Resources/vellum-design-system.css
clients/macos/vellum-assistant/Resources/vellum-edit-animator.js
clients/macos/vellum-assistant/Resources/vellum-widgets.js
clients/macos/vellum-assistant/Resources/VellumDocument.icns      ← regenerate icon
clients/macos/vellum-assistant/Resources/Info.plist
assets/banner.png, assets/what-it-does.png                        ← regenerate brand art
```

### 4.5 User-facing display strings (Markdown + Swift + plists + UI)
| Form | Where |
|------|-------|
| `Vellum Assistant` | README banners, ARCHITECTURE.md, plist `CFBundleDisplayName`, Swift About window, marketing copy |
| `Vellum AI` | LICENSE, footer text |
| `Vellum Platform` | CONSTITUTION.md, glossary |
| `Vellum Cloud`, `Vellum Local`, `Vellum Dev`, `Vellum Staging` | environment labels |
| `Vellum Meet`, `Vellum Bridge`, `Vellum Bot` | meet integration |
| `Vellum Constitution`, `Vellum Doctor`, `Vellum Guardian` | concepts in CONSTITUTION/GLOSSARY |
| `Vellum Chat`, `Vellum CLI`, `Vellum Discord`, `Vellum OAuth`, `Vellum Setup`, `Vellum Skills`, `Vellum Thread`, `Vellum UI` | scattered docs |
| Permission prompts: `"Vellum needs Screen Recording access …"`, `"Vellum needs microphone access …"` | `Info.plist` (`NSScreenCaptureUsageDescription`, etc.) |

Top-level doc files with the most mentions (counts of `vellum|Vellum`):

```
CONSTITUTION.md     27
ARCHITECTURE.md     47
README.md           31
GLOSSARY.md         16
AGENTS.md           14
CONTRIBUTING.md     13
SECURITY.md          3
CODE_OF_CONDUCT.md   1
```

These are concept-heavy docs — read each manually; some "Vellum Assistant" phrasings make philosophical claims that may not translate verbatim to "Max" (e.g., "A Vellum Assistant is their own being…").

### 4.6 Tests with vellum in the filename
```
clients/macos/vellum-assistantTests/VellumPathsTests.swift
clients/macos/vellum-assistantTests/VellumAppSchemeHandlerTests.swift
assistant/src/__tests__/vellum-self-knowledge-inline-command.test.ts
assistant/src/runtime/routes/__tests__/migration-vellum-metadata-reconcile.test.ts
```

```bash
# Re-discover Tier 3 surfaces
rg -oE 'VELLUM_[A-Z][A-Z0-9_]*' -g '!node_modules' -g '!.build' --no-filename | sort -u
rg -l '\bVellum\s+[A-Z][a-z]+'   -g '*.md' -g '*.swift'
```

---

## 5. The numbers (verification baseline)

Re-run these after every rename pass; the count for each should decrease toward zero.

| Metric | Current count | Command |
|---|---|---|
| Files containing any vellum form | **2,266** | `rg -li vellum -g '!node_modules' -g '!.build' -g '!snapshots' -g '!dist' --files-with-matches \| wc -l` |
| Files/folders whose **name** contains vellum | **152** | `find . -path ./.git -prune -o -path '*/node_modules' -prune -o -path '*/.build' -prune -o -path '*/snapshots' -prune -o -path '*/dist' -prune -o -iname '*vellum*' -print \| wc -l` |
| Distinct `VELLUM_*` constants | **~110** | `rg -oE 'VELLUM_[A-Z][A-Z0-9_]*' --no-filename \| sort -u \| wc -l` |
| Distinct `com.vellum.*` bundle IDs | **28** | `rg -oE 'com\.vellum[a-z._-]*' --no-filename \| sort -u \| wc -l` |
| `@vellumai/*` packages | **24+** | `rg -oE '@vellum[a-z]*/[a-z0-9-]+' --no-filename \| sort -u \| wc -l` |
| `vellum.*` domains in use | **31** | `rg -oE 'https?://[a-zA-Z0-9.-]*vellum[a-zA-Z0-9.-]*' --no-filename \| sort -u \| wc -l` |
| Swift `Vellum*` symbols | **28** | `rg -oE 'Vellum[A-Z][A-Za-z0-9_]*' -g '*.swift' --no-filename \| sort -u \| wc -l` |
| TS `Vellum*` symbols | **35+** | `rg -oE 'Vellum[A-Z][A-Za-z0-9_]*' -g '*.ts' -g '*.tsx' --no-filename \| sort -u \| wc -l` |

---

## 6. Suggested rename mapping (for your decision)

| From | Proposed → | Notes |
|------|------------|-------|
| `vellum` (lowercase token) | `max` | Word-boundary regex only |
| `Vellum` (PascalCase) | `Max` | Word-boundary; collides visually with existing `Max…Attachment…` etc. — review diffs |
| `VELLUM` (SCREAMING) | `MAX` | Word-boundary; ~110 env vars |
| `vellumai` | `maxai` (or your scope) | npm scope decision |
| `vellum-ai` | `max-ai` (or your org) | GitHub org decision |
| `com.vellum.*` | `com.<your-domain>.max.*` | Reverse-DNS — needs your real org domain |
| `vellum://` | `max://` | Custom URL scheme — coordinate with web/extension |
| `vellum.ai` / `vellum.app` | (your domain) | Needs DNS + cert |
| `VellumDocument.icns` | `MaxDocument.icns` (regen) | Rebrand asset |

Open the decision for each tier as a separate PR series — don't try to land everything in one branch.

---

## 7. Migration playbook (recommended order)

1. **Decide the Tier 1 answers first** — scope name, GitHub org, domains. Without these you can't write Tier 2 PRs.
2. **Stand up a redirect / alias** for old → new domains and the old GitHub org redirect, so external links keep working.
3. **Add data-migration shims** for workspace dirs (`~/.local/share/vellum*` → new path). Run on first launch of the renamed app.
4. **Tier 2 rename PRs**, one logical group per PR:
   - macOS app (Xcode + bundle IDs + plists + URL scheme + Swift types) — biggest, single PR
   - npm scope + package.json + workspace deps — single PR
   - Skills folders + catalog.json + daemon-bin mirror — single PR
   - Drizzle/runtime migration adding the channel rename (new migration file, don't edit 020)
5. **Tier 3 mechanical rename** — env vars, identifiers, docs, display strings. Multiple smaller PRs.
6. **Rebrand assets** — icons (`.icns`), banners (`assets/banner.png`), `vellum-design-system.css` token names.
7. **Final pass**: re-run §5 commands, confirm counts ≈ 0, leave deliberate residue documented (e.g., a temporary back-compat shim that still reads `VELLUM_*` env vars).

---

## Appendix A — Full `VELLUM_*` env var list

```
VELLUM_ALLOW_REAL_GATEWAY_SECURITY_IN_TESTS  VELLUM_ALLOW_REAL_WORKSPACE_IN_TESTS
VELLUM_APP_CONTROL_USE_DISPLAY_FILTER        VELLUM_APP_REMOVED
VELLUM_APT_DATA_MIRROR                       VELLUM_APT_DATA_ROOT
VELLUM_APT_DATA_SUITE                        VELLUM_ASSISTANT_IMAGE
VELLUM_ASSISTANT_INVITE_CODE_AAAA1111        VELLUM_ASSISTANT_INVITE_CODE_AB12CD34
VELLUM_ASSISTANT_INVITE_CODE_ABCD1234        VELLUM_ASSISTANT_INVITE_CODE_BBBB2222
VELLUM_ASSISTANT_INVITE_CODE_STRM5678        VELLUM_ASSISTANT_INVITE_CODE_TEST1234
VELLUM_ASSISTANT_NAME                        VELLUM_ASSISTANT_PLATFORM_URL
VELLUM_AUTOMATION_GITHUB_APP_ID              VELLUM_AUTOMATION_GITHUB_PRIVATE_KEY
VELLUM_AVATAR_DEVICE                         VELLUM_AWS_ROLE_ARN
VELLUM_BACKUP_DIR                            VELLUM_BACKUP_KEY_PATH
VELLUM_CLOUD                                 VELLUM_CLOUD_VALUES
VELLUM_COMP_DIR                              VELLUM_CONFIG_DIR
VELLUM_CONFIG_EOF                            VELLUM_CONTENT_CHECK_PATTERNS
VELLUM_CPU_LIMIT                             VELLUM_CREDENTIAL_EXECUTOR_IMAGE
VELLUM_CREDENTIAL_SPEC                       VELLUM_CUSTOM_HOST
VELLUM_DAEMON_AUTOSTART                      VELLUM_DAEMON_URL
VELLUM_DATA_DIR                              VELLUM_DEBUG
VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH         VELLUM_DEFAULTS_DOMAIN
VELLUM_DESKTOP_APP                           VELLUM_DEV
VELLUM_DIR                                   VELLUM_DOCS_BASE_URL
VELLUM_ENTRY                                 VELLUM_ENV
VELLUM_ENVIRONMENT                           VELLUM_ENVIRONMENT_VALUE
VELLUM_EXEC_END_                             VELLUM_EXEC_START_
VELLUM_EXIT_0                                VELLUM_EXIT_1                VELLUM_EXIT_127
VELLUM_EXTENSION_FIELDS                      VELLUM_FIELDS
VELLUM_FLAG_ALPHA      VELLUM_FLAG_BETA      VELLUM_FLAG_DARK_MODE       VELLUM_FLAG_DISABLED
VELLUM_FLAG_FEATURE    VELLUM_FLAG_GAMMA     VELLUM_FLAG_LOCAL_DOCKER_ENABLED
VELLUM_FLAG_MY_FEATURE VELLUM_FLAG_OFF       VELLUM_FLAG_PADDED
VELLUM_FLAG_PLATFORM_HOSTED_ENABLED          VELLUM_FLAG_REAL
VELLUM_FLAG_TEMP                             VELLUM_FLAG_VERBOSE
VELLUM_GATEWAY_IMAGE                         VELLUM_HATCHED_BY
VELLUM_HEADER_PREFIX                         VELLUM_HOOK_EVENT
VELLUM_HOOK_NAME                             VELLUM_HOOK_SETTINGS
VELLUM_LOCKFILE_DIR                          VELLUM_MEET_AVATAR_DEVICE
VELLUM_MEMORY_LIMIT                          VELLUM_MINIKUBE_STORAGE_SIZE
VELLUM_NO_AUTO_TMUX                          VELLUM_NO_WATCH
VELLUM_PIDS                                  VELLUM_PLATFORM_IDENTITY_FIELDS
VELLUM_PLATFORM_URL                          VELLUM_PROFILER_MAX_BYTES
VELLUM_PROFILER_MAX_RUNS                     VELLUM_PROFILER_MIN_FREE_MB
VELLUM_PROFILER_MODE                         VELLUM_PROFILER_RUN_ID
VELLUM_PUBLIC_BASE_URL_                      VELLUM_RELAY_TOKEN_
VELLUM_ROOT                                  VELLUM_ROOT_DIR
VELLUM_SANDBOX_RUNTIME                       VELLUM_SERVICE
VELLUM_SKILL_ID                              VELLUM_SKILL_IPC_SOCKET
VELLUM_SSH_USER                              VELLUM_TEST_REAL_GATEWAY_SECURITY_DIR
VELLUM_TEST_REAL_WORKSPACE_DIR               VELLUM_TEST_UNLISTED_VAR
VELLUM_UNTRUSTED_SHELL                       VELLUM_VARS
VELLUM_WEB_URL                               VELLUM_WORKSPACE_DIR
```

## Appendix B — Files/folders with vellum in their name (excluding build/deps)

51 paths (verified):

```
.claude/skills/vellum-skills
assistant/src/__tests__/vellum-self-knowledge-inline-command.test.ts
assistant/src/memory/migrations/020-rename-macos-ios-channel-to-vellum.ts
assistant/src/runtime/guardian-vellum-migration.ts
assistant/src/runtime/routes/__tests__/migration-vellum-metadata-reconcile.test.ts
clients/chrome-extension/vellum-browser-relay.zip
clients/macos/assistant-bin/vellum-assistant
clients/macos/cli-bin/vellum-cli
clients/macos/daemon-bin/first-party-skills/meet-join/bot/native-messaging/com.vellum.meet.json
clients/macos/daemon-bin/first-party-skills/vellum-avatar
clients/macos/daemon-bin/first-party-skills/vellum-browser-use
clients/macos/daemon-bin/first-party-skills/vellum-conversation-management
clients/macos/daemon-bin/first-party-skills/vellum-github-app-setup
clients/macos/daemon-bin/first-party-skills/vellum-heartbeat
clients/macos/daemon-bin/first-party-skills/vellum-memory-v2-migration
clients/macos/daemon-bin/first-party-skills/vellum-oauth-integrations
clients/macos/daemon-bin/first-party-skills/vellum-self-knowledge
clients/macos/daemon-bin/first-party-skills/vellum-skills-catalog
clients/macos/daemon-bin/first-party-skills/vellum-sounds
clients/macos/daemon-bin/first-party-skills/vellum-terminal-sessions
clients/macos/daemon-bin/vellum-daemon
clients/macos/gateway-bin/vellum-gateway
clients/macos/vellum-assistant
clients/macos/vellum-assistant-app
clients/macos/vellum-assistant-app/VellumAssistantApp.swift
clients/macos/vellum-assistant/App/VellumCli.swift
clients/macos/vellum-assistant/Features/Settings/AboutVellumWindow.swift
clients/macos/vellum-assistant/Features/Surfaces/VellumAppSchemeHandler.swift
clients/macos/vellum-assistant/Resources/vellum-design-system.css
clients/macos/vellum-assistant/Resources/vellum-edit-animator.js
clients/macos/vellum-assistant/Resources/vellum-widgets.js
clients/macos/vellum-assistant/Resources/VellumDocument.icns
clients/macos/vellum-assistantTests
clients/macos/vellum-assistantTests/VellumAppSchemeHandlerTests.swift
clients/macos/vellum-assistantTests/VellumPathsTests.swift
clients/macos/VellumQLPreview
clients/macos/VellumQLThumbnail
clients/shared/App/VellumEnvironment.swift
clients/shared/Utilities/VellumPaths.swift
meta/bin/vellum.js
scripts/vellum-runtime-tunnel.sh
skills/meet-join/bot/native-messaging/com.vellum.meet.json
skills/vellum-avatar
skills/vellum-browser-use
skills/vellum-conversation-management
skills/vellum-github-app-setup
skills/vellum-heartbeat
skills/vellum-memory-v2-migration
skills/vellum-oauth-integrations
skills/vellum-self-knowledge
skills/vellum-skills-catalog
skills/vellum-sounds
skills/vellum-terminal-sessions
```

## Appendix C — Verification commands (copy/paste)

```bash
# 1. Files whose name contains vellum (any case)
find . -path ./.git -prune -o -path '*/node_modules' -prune -o -path '*/.build' -prune \
  -o -path '*/snapshots' -prune -o -path '*/dist' -prune \
  -o -iname '*vellum*' -print

# 2. File-count of vellum content (de-duplicated)
rg -li 'vellum' -g '!node_modules' -g '!.build' -g '!snapshots' -g '!dist' --files-with-matches | wc -l

# 3. Distinct VELLUM_* constants
rg -oE 'VELLUM_[A-Z][A-Z0-9_]*' -g '!node_modules' -g '!.build' --no-filename | sort -u

# 4. Distinct com.vellum.* bundle IDs
rg -oE 'com\.vellum[a-z._-]*' -g '!node_modules' -g '!.build' --no-filename | sort -u

# 5. Swift Vellum* symbols
rg -oE 'Vellum[A-Z][A-Za-z0-9_]*' -g '*.swift' --no-filename | sort -u

# 6. TS/JS Vellum* symbols
rg -oE 'Vellum[A-Z][A-Za-z0-9_]*' -g '*.ts' -g '*.tsx' -g '*.js' -g '*.mjs' \
  -g '!node_modules' -g '!dist' --no-filename | sort -u

# 7. Domains
rg -oE 'https?://[a-zA-Z0-9.-]*vellum[a-zA-Z0-9.-]*' -g '!node_modules' --no-filename | sort -u

# 8. npm scoped packages
rg -oE '@vellum[a-z]*/[a-z0-9-]+' -g '!node_modules' --no-filename | sort -u

# 9. Custom URL scheme references
rg 'vellum://' -g '!node_modules' -g '!.build'

# 10. Info.plist branding keys
rg 'CFBundle(Name|DisplayName|Identifier|URLSchemes)' -g '*.plist' -A1
```
