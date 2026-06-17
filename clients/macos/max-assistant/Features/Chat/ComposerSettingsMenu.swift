import SwiftUI
import MaxAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ComposerSettingsMenu")

/// A single icon-button in the composer action bar that opens a combined popover
/// with risk-threshold presets ("Assistant Access") and inference-profile options
/// ("Performance Mode"). Replaces the separate ``ComposerThresholdPicker`` and
/// ``ChatProfilePicker`` pills with a single sliders icon.
@MainActor
struct ComposerSettingsMenu: View {
    // MARK: - Threshold inputs

    let showThresholdSection: Bool
    let assistantConversationId: String?
    let draftInteractiveOverride: String?
    let onDraftInteractiveOverrideChange: ((String?) -> Void)?
    var thresholdClient: ThresholdClientProtocol = ThresholdClient()

    // MARK: - Profile inputs

    let inferenceProfilePicker: ChatProfilePickerConfiguration?
    var loginClient: ProviderLoginClientProtocol = ProviderLoginClient()

    // MARK: - Threshold state (mirrors ComposerThresholdPicker)

    @State private var currentPreset: ThresholdPreset = .relaxed
    @State private var globalInteractive: String = RiskThreshold.medium.rawValue
    @State private var writeTask: Task<Void, Never>?
    @State private var writeVersion: UInt64 = 0
    @State private var loadTask: Task<Void, Never>?
    @State private var selectionVersion: UInt64 = 0

    // MARK: - Panel state

    #if os(macOS)
    @State private var isMenuOpen = false
    @State private var activePanel: VMenuPanel?
    @State private var triggerFrame: CGRect = .zero
    @State private var providerLoginInProgress: Set<String> = []
    #endif

    private let buttonSize: CGFloat = 32

    var body: some View {
        #if os(macOS)
        Button {
            if isMenuOpen {
                activePanel?.close()
                activePanel = nil
                isMenuOpen = false
            } else {
                showMenu()
            }
        } label: {
            VIconView(.slidersHorizontal, size: 18)
                .foregroundStyle(isMenuOpen ? VColor.contentDefault : VColor.contentTertiary)
                .frame(width: buttonSize, height: buttonSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .vTooltip("Conversation settings")
        .accessibilityLabel("Conversation settings")
        .overlay {
            GeometryReader { geo in
                Color.clear
                    .onAppear { triggerFrame = geo.frame(in: .global) }
                    .onChange(of: geo.frame(in: .global)) { _, newFrame in
                        triggerFrame = newFrame
                    }
            }
        }
        .task(id: assistantConversationId ?? "draft") {
            await loadThresholdState()
        }
        .onChange(of: draftInteractiveOverride) { _, newValue in
            guard assistantConversationId == nil else { return }
            currentPreset = ThresholdPreset.from(
                override: newValue,
                globalInteractive: globalInteractive
            )
        }
        .onReceive(NotificationCenter.default.publisher(for: .globalRiskThresholdsDidChange)) { _ in
            Task { @MainActor in
                await loadThresholdState()
            }
        }
        #endif
    }

    // MARK: - Menu

    #if os(macOS)
    private func showMenu() {
        guard !isMenuOpen else { return }
        isMenuOpen = true

        // Refresh provider availability when the menu opens. Cache-cheap on the
        // daemon side; the published map updates and SwiftUI redraws the row.
        // Production wires this through ChatView/PanelCoordinator; tests
        // leave it nil and the call is a no-op.
        if let store = inferenceProfilePicker?.settingsStoreForRefresh {
            Task { @MainActor in
                await store.refreshProviderAvailability()
            }
        }

        NSApp.keyWindow?.makeFirstResponder(nil)

        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) else {
            isMenuOpen = false
            return
        }

        let triggerInWindow = CGPoint(x: triggerFrame.minX, y: triggerFrame.maxY)
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: triggerInWindow.x,
            y: window.frame.height - triggerInWindow.y
        ))

        let triggerScreenOrigin = window.convertPoint(toScreen: NSPoint(
            x: triggerFrame.minX,
            y: window.frame.height - triggerFrame.maxY
        ))
        let triggerScreenRect = CGRect(
            origin: triggerScreenOrigin,
            size: CGSize(width: triggerFrame.width, height: triggerFrame.height)
        )

        let appearance = window.effectiveAppearance
        let currentPreset = currentPreset
        let config = inferenceProfilePicker
        let showThreshold = showThresholdSection

        activePanel = VMenuPanel.show(
            at: screenPoint,
            sourceWindow: window,
            sourceAppearance: appearance,
            excludeRect: triggerScreenRect
        ) {
            VMenu(width: 240) {
                if showThreshold {
                    sectionHeader("Assistant Access")

                    ForEach(ThresholdPreset.allCases) { option in
                        VMenuItem(
                            icon: option.icon.rawValue,
                            label: option.label,
                            tooltip: option.description,
                            isActive: currentPreset == option,
                            size: .regular
                        ) {
                            selectPreset(option)
                        } trailing: {
                            if currentPreset == option {
                                VIconView(.check, size: 12)
                                    .foregroundStyle(VColor.primaryBase)
                            }
                        }
                    }
                }

                if let config, !config.profiles.isEmpty {
                    let effectiveProfile = config.current ?? config.activeProfile
                    // Group profiles by provider for the new submenu-based
                    // top-level picker. Reachability filter is applied per
                    // group inside the submenus, but the Ollama row stays in
                    // the top-level list even when every ollama profile is
                    // hidden so the user always sees the daemon's status.
                    // Surface an empty kimi-agent row only when the daemon
                    // reports the provider AND its unavailability is something
                    // the user can act on (e.g. needs sign-in / CLI install).
                    // While the feature flag is off the daemon reports
                    // `not-enabled`; suppress the row in that case so the flag
                    // stays invisible to users who haven't opted in.
                    let kimiAgentStatus = config.providerAvailability["kimi-agent"]
                    let surfaceKimiAgent = kimiAgentStatus?.available == false
                        && kimiAgentStatus?.reason != .notEnabled
                    let groups = Self.providerGroups(
                        profiles: config.profiles,
                        connectionReachability: config.connectionReachability,
                        includeEmptyClaudeSubscription: config.providerAvailability["claude-subscription"] != nil,
                        includeEmptyKimiAgent: surfaceKimiAgent
                    )

                    if !groups.isEmpty {
                        sectionHeader("Model Profile")
                    }

                    // Determine which provider group "owns" the active
                    // profile so we can surface a checkmark on its row.
                    // Falls back to provider-group lookup on the unfiltered
                    // profile list so a disabled-by-reachability active
                    // profile still bubbles up.
                    let activeProvider: ProviderGroup? = config.profiles
                        .first(where: { $0.name == effectiveProfile })
                        .map { Self.providerGroup(for: $0) }

                    ForEach(groups, id: \.kind) { group in
                        providerRow(
                            group: group,
                            activeProvider: activeProvider,
                            effectiveProfile: effectiveProfile,
                            onSelect: config.onSelect
                        )
                    }

                    // Reset-to-default row lives at the bottom of the
                    // Model Profile section, outside every submenu. Clears
                    // the per-conversation override so the conversation
                    // falls back to `llm.activeProfile`.
                    if !groups.isEmpty {
                        let activeDisplay = config.profiles
                            .first(where: { $0.name == config.activeProfile })?.displayName
                            ?? config.activeProfile
                        VMenuItem(
                            icon: VIcon.rotateCcw.rawValue,
                            label: "Reset to default (\(activeDisplay))",
                            isActive: config.current == nil,
                            size: .regular
                        ) {
                            config.onSelect(nil)
                        } trailing: {
                            if config.current == nil {
                                VIconView(.check, size: 12)
                                    .foregroundStyle(VColor.primaryBase)
                            }
                        }
                    }
                }
            }
        } onDismiss: {
            isMenuOpen = false
            activePanel = nil
        }
    }
    #endif

    // MARK: - Section header

    /// Divider-free section header matching the Figma popover design.
    private func sectionHeader(_ title: String) -> some View {
        HStack {
            Text(title)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentDisabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.top, VSpacing.sm)
        .padding(.bottom, VSpacing.xs)
        .accessibilityAddTraits(.isHeader)
    }

    // MARK: - Provider grouping

    /// Canonical provider buckets surfaced as top-level rows in the Model
    /// Profile section. `kind` doubles as the `Identifiable` id used by the
    /// `ForEach` over groups and the deterministic sort order — providers
    /// fall in declaration order (anthropic → kimi → ollama → openai →
    /// gemini → other). `Other` collects profiles whose `provider` field
    /// is nil/empty or doesn't match any known provider.
    enum ProviderGroup: String, CaseIterable, Identifiable, Hashable {
        case anthropic
        case claudeSubscription
        case kimi
        case kimiAgent
        case ollama
        case openai
        case gemini
        case other

        var id: String { rawValue }

        /// Human-readable label rendered on the top-level provider row.
        var displayName: String {
            switch self {
            case .anthropic: return "Anthropic"
            case .claudeSubscription: return "Claude (Max Plan)"
            case .kimi: return "Kimi"
            case .kimiAgent: return "Kimi (Agent SDK)"
            case .ollama: return "Ollama"
            case .openai: return "OpenAI"
            case .gemini: return "Gemini"
            case .other: return "Other"
            }
        }
    }

    /// Snapshot of one provider group ready for rendering. Carries the
    /// reachability-filtered profile list so the row can stay declarative.
    /// `allProfiles` is the unfiltered list and powers the "Ollama offline"
    /// trailing text — the row stays visible even when every ollama
    /// profile is hidden by the reachability gate.
    struct ProviderGroupSnapshot {
        let kind: ProviderGroup
        let visibleProfiles: [InferenceProfile]
        let allProfiles: [InferenceProfile]
    }

    /// Map a profile to its canonical provider bucket. Folds `moonshot`
    /// into the `kimi` group because both providers serve the same Kimi
    /// model family from Moonshot AI; also catches user-created profiles
    /// whose `provider` is unset but whose `name` starts with `kimi-`
    /// (the auto-named ollama variants are handled by the `ollama`
    /// branch above).
    static func providerGroup(for profile: InferenceProfile) -> ProviderGroup {
        switch (profile.provider ?? "").lowercased() {
        case "anthropic": return .anthropic
        case "claude-subscription": return .claudeSubscription
        case "kimi-agent": return .kimiAgent
        case "kimi", "moonshot": return .kimi
        case "ollama": return .ollama
        case "openai": return .openai
        case "gemini", "google": return .gemini
        case "":
            if profile.name.lowercased().hasPrefix("kimi-") { return .kimi }
            return .other
        default:
            // Unknown provider string → bucket into Other so the user can
            // still find the profile, rather than dropping it on the floor.
            return .other
        }
    }

    /// Build the ordered list of provider groups to render. A group is
    /// included when:
    ///   - it has at least one reachability-visible profile, OR
    ///   - it is `.ollama` and at least one ollama profile is configured
    ///     (so the user always sees the daemon's status even when every
    ///     ollama profile is offline).
    /// Profiles within a group are sorted by `displayName` (case-insensitive),
    /// which matches the existing flat-list ordering once the visible filter
    /// is applied.
    static func providerGroups(
        profiles: [InferenceProfile],
        connectionReachability: [String: ConnectionReachability],
        includeEmptyClaudeSubscription: Bool = false,
        includeEmptyKimiAgent: Bool = false
    ) -> [ProviderGroupSnapshot] {
        // Bucket profiles by group key in one pass.
        var bucket: [ProviderGroup: [InferenceProfile]] = [:]
        for profile in profiles {
            bucket[providerGroup(for: profile), default: []].append(profile)
        }

        // Reachability lookup mirrors
        // ``ChatProfilePickerConfiguration.isConnectionReachable`` — nil
        // connection name and unknown name both treated as reachable.
        let isReachable: (String?) -> Bool = { name in
            guard let name, !name.isEmpty else { return true }
            guard let entry = connectionReachability[name] else { return true }
            return entry.reachable
        }

        var snapshots: [ProviderGroupSnapshot] = []
        for kind in ProviderGroup.allCases {
            let all = (bucket[kind] ?? [])
                .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
            let visible = all.filter { isReachable($0.providerConnection) }
            // Hide empty groups except for two surfaced-status providers:
            //   - Ollama always renders when at least one ollama profile
            //     exists, so the daemon status stays visible.
            //   - Claude (Max Plan) always renders when the daemon reports
            //     the cli-login provider exists (regardless of whether the
            //     user has configured an inference profile yet) so the
            //     setup hint / one-click-create row stays reachable from
            //     the composer.
            if visible.isEmpty {
                if kind == .ollama && !all.isEmpty {
                    snapshots.append(ProviderGroupSnapshot(kind: kind, visibleProfiles: [], allProfiles: all))
                } else if kind == .claudeSubscription && includeEmptyClaudeSubscription {
                    snapshots.append(ProviderGroupSnapshot(kind: kind, visibleProfiles: [], allProfiles: all))
                } else if kind == .kimiAgent && includeEmptyKimiAgent {
                    // Mirror the claude-subscription surfaced-status contract:
                    // when the daemon reports the kimi-agent provider exists
                    // (flag on) keep the row reachable so its Sign-in / status
                    // hint shows even before the user binds a profile.
                    snapshots.append(ProviderGroupSnapshot(kind: kind, visibleProfiles: [], allProfiles: all))
                }
                continue
            }
            snapshots.append(ProviderGroupSnapshot(kind: kind, visibleProfiles: visible, allProfiles: all))
        }
        return snapshots
    }

    // MARK: - Provider row

    /// Top-level row for one provider. Renders as a `VSubMenuItem` (cascading
    /// flyout) when there is at least one selectable profile in the group;
    /// the Ollama-with-no-visible-profiles edge case renders as a disabled
    /// `VMenuItem` so the daemon status still shows. The Ollama row also
    /// injects a coloured status dot and trailing "(N models)" / "Last seen"
    /// text inline so the previous header row can be removed.
    @ViewBuilder
    private func providerRow(
        group: ProviderGroupSnapshot,
        activeProvider: ProviderGroup?,
        effectiveProfile: String,
        onSelect: @escaping (String?) -> Void
    ) -> some View {
        let isActiveGroup = activeProvider == group.kind
        let claudeSubscriptionStatus = inferenceProfilePicker?.providerAvailability["claude-subscription"]
        let kimiAgentStatus = inferenceProfilePicker?.providerAvailability["kimi-agent"]

        if group.kind == .kimiAgent,
           let status = kimiAgentStatus,
           status.available == false {
            if status.reason == .noApiKey {
                // The Kimi Agent SDK is installed but holds no cached token.
                // Offer an in-place "Sign in" that drives the daemon's
                // programmatic `login({ onUrl })` OAuth (browser opens via the
                // daemon's open_url event); on success the SDK writes
                // ~/.kimi/config.toml and availability refreshes into the model
                // submenu without leaving the composer.
                providerSignInRow(
                    provider: "kimi-agent",
                    label: ProviderGroup.kimiAgent.displayName
                )
            } else {
                kimiAgentUnavailableRow(reason: status.reason)
            }
        } else if group.kind == .claudeSubscription,
           let status = claudeSubscriptionStatus,
           status.available == false {
            if status.reason == .notLoggedIn {
                // The CLI is installed but no token is cached. Offer an
                // in-place "Sign in" that drives the daemon's OAuth flow
                // (browser opens via the daemon's open_url event) and
                // refreshes availability on success — turning this row into
                // the model submenu without leaving the composer.
                providerSignInRow(
                    provider: "claude-subscription",
                    label: ProviderGroup.claudeSubscription.displayName
                )
            } else {
                claudeSubscriptionUnavailableRow(reason: status.reason)
            }
        } else if group.kind == .claudeSubscription {
            // Render a model picker submenu matching the Kimi/Ollama pattern
            // — every catalog model (Opus / Sonnet / Haiku) is a row. Selecting
            // a model that already has a matching profile switches to it;
            // selecting one without a matching profile creates and selects it
            // in-place. The standard Inference-Profiles editor filters cli-login
            // providers out (no connection record), so this submenu is the only
            // path from the composer to a configured Claude Max model.
            claudeSubscriptionModelsSubmenu(
                group: group,
                isActiveGroup: isActiveGroup,
                effectiveProfile: effectiveProfile,
                onSelect: onSelect
            )
        } else if group.kind == .kimiAgent {
            // Mirror the claude-subscription path: render every kimi-agent
            // catalog model as a submenu row so a conversation can bind a
            // specific Kimi (Agent SDK) model in two clicks. Selecting a model
            // with an existing matching profile switches to it; selecting one
            // without creates and selects it in-place. The standard
            // Inference-Profiles editor offers no Kimi-agent path, so this
            // submenu is the only composer route to a configured model.
            kimiAgentModelsSubmenu(
                group: group,
                isActiveGroup: isActiveGroup,
                effectiveProfile: effectiveProfile,
                onSelect: onSelect
            )
        } else if group.kind == .ollama {
            ollamaProviderRow(
                group: group,
                isActiveGroup: isActiveGroup,
                effectiveProfile: effectiveProfile,
                onSelect: onSelect
            )
        } else if group.visibleProfiles.isEmpty {
            // Defensive: non-ollama groups with zero visible profiles are
            // filtered out upstream by `providerGroups`, so this branch is
            // unreachable today. Kept as a safe disabled-row fallback
            // matching the ollama edge case below.
            VMenuItem(
                icon: VIcon.sparkles.rawValue,
                label: group.kind.displayName,
                size: .regular,
                action: {}
            )
            .disabled(true)
        } else {
            VSubMenuItem(icon: VIcon.sparkles.rawValue, label: group.kind.displayName) {
                providerSubmenuContent(
                    group: group,
                    effectiveProfile: effectiveProfile,
                    onSelect: onSelect
                )
            }
            .overlay(alignment: .trailing) {
                // VSubMenuItem has no trailing slot, so the "active group"
                // checkmark sits in a non-interactive overlay positioned
                // just inside the row's own chevron. `allowsHitTesting`
                // off so it doesn't shadow the row's tap/hover target.
                if isActiveGroup {
                    VIconView(.check, size: 12)
                        .foregroundStyle(VColor.primaryBase)
                        .padding(.trailing, VSpacing.lg)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
        }
    }

    /// Ollama-specific provider row. When at least one ollama profile is
    /// reachable, renders a `VSubMenuItem` with a green dot and "(N models)"
    /// trailing label. When every ollama profile is offline, renders a
    /// `VMenuItem` (no submenu to open) with a red dot and "Last seen: …"
    /// trailing label.
    @ViewBuilder
    private func ollamaProviderRow(
        group: ProviderGroupSnapshot,
        isActiveGroup: Bool,
        effectiveProfile: String,
        onSelect: @escaping (String?) -> Void
    ) -> some View {
        let isOnline = !group.visibleProfiles.isEmpty
        let onlineCount = group.visibleProfiles.count
        // Scope the "last seen" lookup to connections actually referenced
        // by ollama profiles so an unrelated offline cloud connection
        // can't bleed into the Ollama status row.
        let ollamaConnectionNames: Set<String> = Set(
            group.allProfiles.compactMap { $0.providerConnection }
        )
        let offlineEntry: ConnectionReachability? = (inferenceProfilePicker?.connectionReachability ?? [:])
            .filter { name, entry in
                !entry.reachable && ollamaConnectionNames.contains(name)
            }
            .values
            .max { (lhs, rhs) in
                (lhs.lastSeenAt ?? .distantPast) < (rhs.lastSeenAt ?? .distantPast)
            }

        let trailingText = Self.ollamaStatusTrailingText(
            isOnline: isOnline,
            onlineCount: onlineCount,
            offlineEntry: offlineEntry
        )

        if isOnline {
            VSubMenuItem(icon: VIcon.sparkles.rawValue, label: ollamaRowLabel(isOnline: true)) {
                providerSubmenuContent(
                    group: group,
                    effectiveProfile: effectiveProfile,
                    onSelect: onSelect
                )
            }
            .overlay(alignment: .trailing) {
                ollamaStatusTrailing(isOnline: true, trailingText: trailingText)
            }
        } else {
            // Offline: no profiles to fly out, just surface the status.
            // Disabled so the row doesn't claim a click target — matches
            // the previous non-interactive status header contract.
            VMenuItem(
                icon: VIcon.sparkles.rawValue,
                label: ollamaRowLabel(isOnline: false),
                isActive: isActiveGroup,
                size: .regular,
                action: {}
            ) {
                ollamaStatusTrailing(isOnline: false, trailingText: trailingText)
            }
            .disabled(true)
        }
    }

    /// Top-level label for the Ollama row. Online state keeps the bare
    /// provider name; offline state appends "· offline" so the status is
    /// visible even before the user looks at the trailing label.
    private func ollamaRowLabel(isOnline: Bool) -> String {
        isOnline ? "Ollama" : "Ollama · offline"
    }

    /// Trailing content for the Ollama row — a coloured status dot plus
    /// the "(N models)" / "Last seen" subtitle. The chevron from the
    /// underlying `VSubMenuItem` still renders to the right of this overlay.
    @ViewBuilder
    private func ollamaStatusTrailing(isOnline: Bool, trailingText: String) -> some View {
        let dotColor: Color = isOnline ? VColor.systemPositiveStrong : VColor.systemNegativeStrong
        HStack(spacing: VSpacing.xs) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
            Text(trailingText)
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
        }
        // Pad to clear the VSubMenuItem's own chevron (10pt + sm padding).
        // The chevron sits at the trailing edge; this overlay floats just
        // inside it.
        .padding(.trailing, VSpacing.lg)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

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

    /// Disabled row for kimi-agent when the daemon reports unavailable for a
    /// reason the user can't resolve with an in-place Sign in (missing CLI, or
    /// a stale status). Mirrors `claudeSubscriptionUnavailableRow`: no submenu,
    /// red status dot, reason-specific trailing text.
    @ViewBuilder
    private func kimiAgentUnavailableRow(
        reason: ProviderAvailabilityStatus.Reason?
    ) -> some View {
        let trailingText = Self.kimiAgentTrailingText(reason: reason)
        let rowLabel = Self.kimiAgentRowLabel(reason: reason)

        VMenuItem(
            icon: VIcon.sparkles.rawValue,
            label: rowLabel,
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

    /// Actionable "Sign in" row for an agentic provider whose CLI/SDK is
    /// installed but has no cached credential. Tapping drives the daemon's
    /// `POST /v1/provider-login` flow: the daemon opens the OAuth URL in the
    /// host browser, captures the returned token into Max's vault, and the
    /// call resolves once login completes (or is cancelled). On success we
    /// refresh provider availability so the row redraws as the model submenu.
    @ViewBuilder
    private func providerSignInRow(provider: String, label: String) -> some View {
        let inProgress = providerLoginInProgress.contains(provider)

        VMenuItem(
            icon: VIcon.sparkles.rawValue,
            label: "\(label) · not signed in",
            size: .regular,
            action: {
                guard !inProgress else { return }
                Task { @MainActor in await signInToProvider(provider) }
            }
        ) {
            HStack(spacing: VSpacing.xs) {
                if inProgress {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Text("Sign in")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.primaryBase)
                }
            }
            .padding(.trailing, VSpacing.lg)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .disabled(inProgress)
    }

    /// Drives `provider`'s OAuth/login flow through the daemon and refreshes
    /// availability on success. A `nil` result means the daemon was
    /// unreachable; `success == false` carries a structured reason. Either way
    /// we only log — the row stays visible so the user can retry.
    @MainActor
    private func signInToProvider(_ provider: String) async {
        providerLoginInProgress.insert(provider)
        defer { providerLoginInProgress.remove(provider) }

        let result = await loginClient.login(provider: provider)
        if result?.success == true {
            if let store = inferenceProfilePicker?.settingsStoreForRefresh {
                await store.refreshProviderAvailability()
            }
        } else {
            log.error(
                "provider sign-in failed: \(provider, privacy: .public) reason=\(result?.reason?.rawValue ?? "transport", privacy: .public)"
            )
        }
    }

    /// Enabled "Claude (Max Plan)" row shown when the daemon reports the
    /// cli-login provider is reachable (or hasn't reported yet) but the
    /// user has no inference profile bound to it. Selecting the row creates
    /// a default profile from the catalog entry, persists it through
    /// `SettingsStore.replaceProfile`, then forwards to `onSelect` so the
    /// composer switches to it in-place. The standard Inference-Profiles
    /// editor filters cli-login providers out (they have no connection
    /// record), so this is the only two-click path to bind Claude Max
    /// from the composer.
    @ViewBuilder
    private func claudeSubscriptionModelsSubmenu(
        group: ProviderGroupSnapshot,
        isActiveGroup: Bool,
        effectiveProfile: String,
        onSelect: @escaping (String?) -> Void
    ) -> some View {
        let models = LLMProviderRegistry.provider(id: "claude-subscription")?.models ?? []

        VSubMenuItem(icon: VIcon.sparkles.rawValue, label: ProviderGroup.claudeSubscription.displayName) {
            ForEach(models, id: \.id) { model in
                let existingProfile = group.visibleProfiles.first { $0.model == model.id }
                let activeName = existingProfile?.name
                let isActive = activeName.map { $0 == effectiveProfile } ?? false
                VMenuItem(
                    icon: VIcon.sparkles.rawValue,
                    label: Self.claudeSubscriptionModelLabel(model.displayName),
                    isActive: isActive,
                    size: .regular
                ) {
                    Task { @MainActor in
                        await selectOrCreateClaudeMaxProfile(
                            model: model,
                            existing: existingProfile,
                            onSelect: onSelect
                        )
                    }
                } trailing: {
                    if isActive {
                        VIconView(.check, size: 12)
                            .foregroundStyle(VColor.primaryBase)
                    }
                }
            }
        }
        .overlay(alignment: .trailing) {
            if isActiveGroup {
                VIconView(.check, size: 12)
                    .foregroundStyle(VColor.primaryBase)
                    .padding(.trailing, VSpacing.lg)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }

    /// Display label for a catalog model in the Claude (Max Plan) submenu.
    /// Strips the trailing " (subscription)" the catalog tags onto each model
    /// so the submenu reads "Claude Opus 4.7" rather than the redundant
    /// "Claude Opus 4.7 (subscription)" once it's already nested under the
    /// "Claude (Max Plan)" parent row.
    static func claudeSubscriptionModelLabel(_ displayName: String) -> String {
        let suffix = " (subscription)"
        if displayName.hasSuffix(suffix) {
            return String(displayName.dropLast(suffix.count))
        }
        return displayName
    }

    /// Routes a model click in the Claude (Max Plan) submenu. If a profile
    /// already binds this exact `provider=claude-subscription + model` pair,
    /// switches to it. Otherwise builds a fresh profile (named for the model)
    /// via `SettingsStore.replaceProfile` and forwards the new name to
    /// `onSelect`. Skips create when a profile with the derived name already
    /// exists. Failures log and leave the picker unchanged.
    @MainActor
    private func selectOrCreateClaudeMaxProfile(
        model: LLMModelEntry,
        existing: InferenceProfile?,
        onSelect: @escaping (String?) -> Void
    ) async {
        if let existing {
            onSelect(existing.name)
            return
        }
        guard let store = inferenceProfilePicker?.settingsStoreForRefresh else {
            log.error("claudeSubscriptionSelect: no SettingsStore reference; skipping")
            return
        }
        let profileName = Self.claudeSubscriptionModelLabel(model.displayName)
        if store.profiles.contains(where: { $0.name == profileName }) {
            onSelect(profileName)
            return
        }
        // Pin the profile to the canonical cli-login connection
        // (`claude-subscription-personal`, seeded by the daemon backfill with
        // `auth: { type: none }`). Without this, the dispatcher falls back to
        // `llm.default.provider_connection` — which is typically the user's
        // anthropic-personal row — and rejects the call with a provider
        // mismatch ("provider_connection X has provider=anthropic but resolving
        // profile declared provider=claude-subscription").
        let fragment = InferenceProfile(
            name: profileName,
            provider: "claude-subscription",
            providerConnection: "claude-subscription-personal",
            model: model.id
        )
        let success = await store.replaceProfile(name: profileName, fragment: fragment)
        if success {
            onSelect(profileName)
        } else {
            log.error("claudeSubscriptionSelect: replaceProfile failed for \(profileName, privacy: .public)")
        }
    }

    /// Model submenu for the Kimi (Agent SDK) provider, mirroring
    /// `claudeSubscriptionModelsSubmenu`. Each kimi-agent catalog model is a
    /// row; selecting an already-bound model switches to its profile, selecting
    /// an unbound model creates a fresh profile (named for the model) and
    /// switches to it in-place.
    @ViewBuilder
    private func kimiAgentModelsSubmenu(
        group: ProviderGroupSnapshot,
        isActiveGroup: Bool,
        effectiveProfile: String,
        onSelect: @escaping (String?) -> Void
    ) -> some View {
        let models = LLMProviderRegistry.provider(id: "kimi-agent")?.models ?? []

        VSubMenuItem(icon: VIcon.sparkles.rawValue, label: ProviderGroup.kimiAgent.displayName) {
            ForEach(models, id: \.id) { model in
                let existingProfile = group.visibleProfiles.first { $0.model == model.id }
                let activeName = existingProfile?.name
                let isActive = activeName.map { $0 == effectiveProfile } ?? false
                VMenuItem(
                    icon: VIcon.sparkles.rawValue,
                    label: Self.kimiAgentModelLabel(model.displayName),
                    isActive: isActive,
                    size: .regular
                ) {
                    Task { @MainActor in
                        await selectOrCreateKimiAgentProfile(
                            model: model,
                            existing: existingProfile,
                            onSelect: onSelect
                        )
                    }
                } trailing: {
                    if isActive {
                        VIconView(.check, size: 12)
                            .foregroundStyle(VColor.primaryBase)
                    }
                }
            }
        }
        .overlay(alignment: .trailing) {
            if isActiveGroup {
                VIconView(.check, size: 12)
                    .foregroundStyle(VColor.primaryBase)
                    .padding(.trailing, VSpacing.lg)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }

    /// Display label for a catalog model in the Kimi (Agent SDK) submenu.
    /// Strips the trailing " (agent)" the catalog tags onto each model so the
    /// submenu reads "Kimi K2.6" rather than the redundant "Kimi K2.6 (agent)"
    /// once it's already nested under the "Kimi (Agent SDK)" parent row.
    static func kimiAgentModelLabel(_ displayName: String) -> String {
        let suffix = " (agent)"
        if displayName.hasSuffix(suffix) {
            return String(displayName.dropLast(suffix.count))
        }
        return displayName
    }

    /// Routes a model click in the Kimi (Agent SDK) submenu. If a profile
    /// already binds this exact `provider=kimi-agent + model` pair, switches to
    /// it. Otherwise builds a fresh profile (named for the model) via
    /// `SettingsStore.replaceProfile`, pinned to the canonical
    /// `kimi-agent-personal` connection, and forwards the new name to
    /// `onSelect`. Skips create when a profile with the derived name already
    /// exists. Failures log and leave the picker unchanged.
    @MainActor
    private func selectOrCreateKimiAgentProfile(
        model: LLMModelEntry,
        existing: InferenceProfile?,
        onSelect: @escaping (String?) -> Void
    ) async {
        if let existing {
            onSelect(existing.name)
            return
        }
        guard let store = inferenceProfilePicker?.settingsStoreForRefresh else {
            log.error("kimiAgentSelect: no SettingsStore reference; skipping")
            return
        }
        let profileName = Self.kimiAgentModelLabel(model.displayName)
        if store.profiles.contains(where: { $0.name == profileName }) {
            onSelect(profileName)
            return
        }
        // Pin to the canonical `kimi-agent-personal` connection (the
        // `${provider}-personal` convention seeded for api-key providers).
        // Without this, the dispatcher falls back to
        // `llm.default.provider_connection` and rejects the call with a
        // provider mismatch.
        let fragment = InferenceProfile(
            name: profileName,
            provider: "kimi-agent",
            providerConnection: "kimi-agent-personal",
            model: model.id
        )
        let success = await store.replaceProfile(name: profileName, fragment: fragment)
        if success {
            onSelect(profileName)
        } else {
            log.error("kimiAgentSelect: replaceProfile failed for \(profileName, privacy: .public)")
        }
    }

    /// Body of every provider submenu — the reachability-filtered profile
    /// list. Long lists (>5 rows) are wrapped in a height-capped ScrollView
    /// so a Kimi-style 12-model provider doesn't overflow the screen.
    /// `VSubMenuItem` builds its own `VMenu` inside `showChild`, so we
    /// can't pass `maxHeight` upstream — wrapping the content is the
    /// closest equivalent.
    @ViewBuilder
    private func providerSubmenuContent(
        group: ProviderGroupSnapshot,
        effectiveProfile: String,
        onSelect: @escaping (String?) -> Void
    ) -> some View {
        let profileList = ForEach(group.visibleProfiles) { profile in
            VMenuItem(
                icon: VIcon.sparkles.rawValue,
                label: profile.displayName,
                isActive: effectiveProfile == profile.name,
                size: .regular
            ) {
                onSelect(profile.name)
            } trailing: {
                if effectiveProfile == profile.name {
                    VIconView(.check, size: 12)
                        .foregroundStyle(VColor.primaryBase)
                }
            }
        }

        if group.visibleProfiles.count > 5 {
            // Five 32pt rows (`VSize.rowMinHeight`) plus four 4pt gaps
            // (`VSpacing.xs`) = 176pt. Same calibration the previous
            // flat-list scroll wrapper used.
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: VSpacing.xs) {
                    profileList
                }
            }
            .frame(maxHeight: VSize.rowMinHeight * 5 + VSpacing.xs * 4, alignment: .top)
        } else {
            profileList
        }
    }

    // MARK: - Ollama status formatting

    /// Renders the trailing label for the Ollama row. Online state surfaces
    /// the model count; offline state surfaces the relative "last seen"
    /// subtitle sourced from the most-recently-seen offline ollama
    /// connection. Pure so the row body stays declarative.
    static func ollamaStatusTrailingText(
        isOnline: Bool,
        onlineCount: Int,
        offlineEntry: ConnectionReachability?
    ) -> String {
        if isOnline {
            let plural = onlineCount == 1 ? "" : "s"
            return "\(onlineCount) model\(plural)"
        }
        let lastSeenAgo = offlineEntry?.lastSeenAt.map(ChatProfilePicker.relativeAgoString) ?? "—"
        return "Last seen: \(lastSeenAgo)"
    }

    // MARK: - claude-subscription status formatting

    /// Trailing text shown next to the disabled claude-subscription row.
    /// Pure so tests can assert without a SwiftUI host.
    static func claudeSubscriptionTrailingText(
        reason: ProviderAvailabilityStatus.Reason?
    ) -> String {
        switch reason {
        case .missingCli:    return "Install Claude Code"
        case .notLoggedIn:   return "Run `claude login`"
        case .notEnabled:    return "Feature flag off"
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

    // MARK: - kimi-agent status formatting

    /// Trailing text shown next to the disabled kimi-agent row. The
    /// `noApiKey` case is handled by the actionable Sign-in row, not this
    /// disabled row, so it falls into the generic "Not available" bucket here.
    /// Pure so tests can assert without a SwiftUI host.
    static func kimiAgentTrailingText(
        reason: ProviderAvailabilityStatus.Reason?
    ) -> String {
        switch reason {
        case .missingCli:           return "Install Kimi CLI"
        case .notLoggedIn:          return "Sign in to Kimi"
        case .notEnabled:           return "Feature flag off"
        case .noApiKey, nil:        return "Not available"
        }
    }

    /// Row label for the kimi-agent row. The `available` (nil reason) case
    /// falls back to the bare provider name so the helper can be the single
    /// source of truth without changing the available-state code path.
    static func kimiAgentRowLabel(
        reason: ProviderAvailabilityStatus.Reason?
    ) -> String {
        switch reason {
        case .missingCli:   return "Kimi (Agent SDK) · not installed"
        case .notLoggedIn:  return "Kimi (Agent SDK) · not signed in"
        case .notEnabled:   return "Kimi (Agent SDK) · disabled"
        case .noApiKey:     return "Kimi (Agent SDK) · not available"
        case .none:         return "Kimi (Agent SDK)"
        }
    }

    // MARK: - Threshold selection (mirrors ComposerThresholdPicker)

    private func selectPreset(_ preset: ThresholdPreset) {
        selectionVersion &+= 1
        withAnimation(VAnimation.fast) {
            currentPreset = preset
        }

        if assistantConversationId == nil {
            onDraftInteractiveOverrideChange?(
                ComposerThresholdPicker.stagedDraftOverride(
                    for: preset,
                    globalInteractive: globalInteractive
                )
            )
        }

        writeVersion &+= 1
        let currentWriteVersion = writeVersion
        let previousWrite = writeTask
        writeTask = Task { @MainActor in
            await previousWrite?.value
            guard currentWriteVersion == writeVersion else { return }
            do {
                guard assistantConversationId != nil else { return }
                try await ComposerThresholdPicker.applyPresetSelection(
                    preset: preset,
                    globalInteractive: globalInteractive,
                    assistantConversationId: assistantConversationId,
                    thresholdClient: thresholdClient
                )
            } catch {
                guard !Task.isCancelled else { return }
                log.error("Failed to write conversation threshold override: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - Threshold load (mirrors ComposerThresholdPicker)

    private func loadThresholdState() async {
        guard showThresholdSection else { return }
        loadTask?.cancel()
        let selectionVersionAtLoadStart = selectionVersion
        let task = Task { @MainActor in
            do {
                let globals = try await thresholdClient.getGlobalThresholds()
                guard !Task.isCancelled else { return }
                globalInteractive = globals.interactive

                var override: String?
                if let conversationIdString = ComposerThresholdPicker.canonicalConversationId(assistantConversationId) {
                    let conversationOverride = try await thresholdClient.getConversationOverride(
                        conversationId: conversationIdString
                    )
                    if let diagnostic = ComposerThresholdPicker.displayOverrideDiagnostic(
                        assistantConversationId: assistantConversationId,
                        conversationOverride: conversationOverride,
                        draftInteractiveOverride: draftInteractiveOverride
                    ) {
                        log.debug(
                            "Threshold settings menu ignoring draft override for existing conversation (\(diagnostic, privacy: .public))"
                        )
                    }
                    override = ComposerThresholdPicker.displayOverride(
                        assistantConversationId: assistantConversationId,
                        conversationOverride: conversationOverride,
                        draftInteractiveOverride: draftInteractiveOverride
                    )
                } else {
                    override = ComposerThresholdPicker.displayOverride(
                        assistantConversationId: assistantConversationId,
                        conversationOverride: nil,
                        draftInteractiveOverride: draftInteractiveOverride
                    )
                }

                guard !Task.isCancelled else { return }
                guard selectionVersionAtLoadStart == selectionVersion else { return }
                currentPreset = ThresholdPreset.from(
                    override: override,
                    globalInteractive: globals.interactive
                )
            } catch {
                guard !Task.isCancelled else { return }
                log.error("Failed to load threshold state: \(error.localizedDescription, privacy: .public)")
            }
        }
        loadTask = task
        await task.value
    }
}
