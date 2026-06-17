import SwiftUI
import MaxAssistantShared

/// Bundle of the per-conversation inference-profile state and the persistence
/// callback the composer threads through to ``ChatProfilePicker``. A single optional
/// parameter on ``ComposerView`` / ``ComposerSection`` toggles the pill.
struct ChatProfilePickerConfiguration {
    /// The current per-conversation inference-profile override. `nil` means
    /// the conversation inherits `activeProfile`.
    let current: String?

    /// Profiles available to pick from — typically `SettingsStore.profiles`.
    let profiles: [InferenceProfile]

    /// The workspace `llm.activeProfile`. Rendered in the pill label when
    /// `current` is `nil`.
    let activeProfile: String

    /// Snapshot of `SettingsStore.connectionReachability`. Carried through the
    /// composer view chain instead of threading the whole `SettingsStore` so
    /// `ComposerView` / `ComposerSection` don't need to know about it — only
    /// the picker (and `ComposerSettingsMenu`, the production render site)
    /// consumes this map. Empty by default so existing call sites that don't
    /// care about reachability stay one-line.
    var connectionReachability: [String: ConnectionReachability] = [:]

    /// Snapshot of `SettingsStore.providerAvailability`. Drives the disabled-row
    /// hint for providers whose setup is incomplete (currently claude-subscription).
    /// Empty by default so existing call sites stay one-line.
    var providerAvailability: [String: ProviderAvailabilityStatus] = [:]

    /// Optional handle to the `SettingsStore` so the picker can trigger a
    /// `refreshProviderAvailability()` when the menu opens. Production paths
    /// (`PanelCoordinator` → `ChatView`) wire this; tests leave it `nil` and
    /// the refresh hook becomes a no-op.
    weak var settingsStoreForRefresh: SettingsStore? = nil

    /// Persists a selection. Passing `nil` clears the override so the
    /// conversation falls back to `activeProfile`.
    let onSelect: (String?) -> Void

    /// Mirrors `SettingsStore.isConnectionReachable(_:)` against the carried
    /// `connectionReachability` snapshot. See that method's docstring for the
    /// full contract; in short: `nil` and absent-from-map → `true`,
    /// false-in-map → `false`.
    func isConnectionReachable(_ name: String?) -> Bool {
        guard let name, !name.isEmpty else { return true }
        guard let entry = connectionReachability[name] else { return true }
        return entry.reachable
    }
}

/// A compact pill button in the composer action bar that lets the user pick a
/// per-conversation inference profile override. Draft conversations stage the
/// selected profile locally until the first message creates the conversation.
/// Opens a dropdown with every profile defined in `SettingsStore.profiles`,
/// plus a "Reset to default" item that clears the override and falls back to
/// `llm.activeProfile`.
///
/// State ownership: the pill is stateless. The label is derived from the
/// `current` override plus `activeProfile`; selection is forwarded straight to
/// `ConversationManager.setConversationInferenceProfile(id:profile:)` which
/// updates the local conversation model and persists to the daemon.
///
/// Reachability filter: profiles whose `providerConnection` resolves to a
/// connection with `reachable: false` (per `SettingsStore.connectionReachability`)
/// are filtered out of the dropdown — typically Ollama auto-discovery profiles
/// when the local Ollama daemon is offline. When at least one profile is
/// hidden for that reason, a non-interactive "Ollama offline — N model(s)
/// hidden" notice surfaces at the bottom of the menu. Profiles whose
/// connection is `nil` (legacy) or whose `reachable` is unknown (never probed
/// yet) remain visible — see `SettingsStore.isConnectionReachable(_:)`.
@MainActor
struct ChatProfilePicker: View {
    /// Whether the picker can be opened. The actual persistence or staging
    /// destination is captured into ``onSelect`` by the parent.
    let isEnabled: Bool

    /// The current per-conversation inference-profile override. `nil` means
    /// the conversation inherits `activeProfile`.
    let current: String?

    /// Profiles available to pick from — typically `SettingsStore.profiles`.
    let profiles: [InferenceProfile]

    /// The workspace `llm.activeProfile`. Surfaced in the pill label when
    /// `current` is `nil` so the user can see which profile the conversation
    /// will inherit.
    let activeProfile: String

    /// Persists a selection. Passing `nil` clears the override so the
    /// conversation falls back to `activeProfile`.
    let onSelect: (String?) -> Void

    /// Source of provider-connection reachability. Drives both the dropdown
    /// filter and the "Ollama offline" notice. `@ObservedObject` so SwiftUI
    /// re-renders when the daemon flips `reachable` on a poll tick — a plain
    /// `let` would freeze the picker on whatever snapshot existed at first
    /// open and the notice would never update without a forced rebuild.
    @ObservedObject var settingsStore: SettingsStore

    /// Pill label: the override profile's display name when set, otherwise
    /// "Default (`<activeProfile>`)". Internal so tests can assert on it
    /// without spinning up a SwiftUI host.
    static func label(current: String?, profiles: [InferenceProfile], activeProfile: String) -> String {
        if let current {
            return profiles.first(where: { $0.name == current })?.displayName ?? current
        }
        let activeDisplay = profiles.first(where: { $0.name == activeProfile })?.displayName ?? activeProfile
        return "Default (\(activeDisplay))"
    }

    var body: some View {
        let activeProfiles = profiles.filter { profile in
            !profile.isDisabled
                && settingsStore.isConnectionReachable(profile.providerConnection)
        }
        // Profiles hidden specifically because their connection's `reachable`
        // is *explicitly* false. `nil`/never-probed connections don't count
        // here — they pass the filter above, so they can't reach this branch.
        // This means the count is "models hidden by a confirmed-offline
        // connection," which is exactly what the user notice claims.
        let hiddenUnreachableCount = profiles.filter { profile in
            guard !profile.isDisabled, let conn = profile.providerConnection else { return false }
            return !settingsStore.isConnectionReachable(conn)
        }.count
        // Pick any one of the unreachable connections to source the "Last
        // seen" timestamp from. The single-Ollama-connection case the spec
        // targets means there's only one in practice; if there are multiple
        // unreachable connections (rare), we surface the most recently-seen
        // one so the notice stays useful.
        let unreachableEntry: ConnectionReachability? = settingsStore.connectionReachability.values
            .filter { !$0.reachable }
            .max { (lhs, rhs) in
                (lhs.lastSeenAt ?? .distantPast) < (rhs.lastSeenAt ?? .distantPast)
            }
        let pillLabel = Self.label(current: current, profiles: activeProfiles, activeProfile: activeProfile)
        #if os(macOS)
        ComposerPillMenu(
            isEnabled: isEnabled,
            accessibilityLabel: "Inference profile",
            accessibilityValue: pillLabel,
            tooltip: "Inference profile for this conversation"
        ) {
            VIconView(.sparkles, size: 14)
                .foregroundStyle(VColor.contentSecondary)
            Text(pillLabel)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
                .lineLimit(1)
        } menu: {
            ForEach(activeProfiles) { profile in
                VMenuItem(
                    icon: VIcon.sparkles.rawValue,
                    label: profile.displayName,
                    isActive: current == profile.name,
                    size: .regular
                ) {
                    onSelect(profile.name)
                } trailing: {
                    VStack(alignment: .trailing, spacing: 2) {
                        if current == profile.name {
                            VIconView(.check, size: 12)
                                .foregroundStyle(VColor.primaryBase)
                        }
                    }
                }
            }
            VMenuItem(
                icon: VIcon.rotateCcw.rawValue,
                label: "Reset to default (\(activeProfiles.first { $0.name == activeProfile }?.displayName ?? activeProfile))",
                isActive: current == nil,
                size: .regular
            ) {
                onSelect(nil)
            } trailing: {
                VStack(alignment: .trailing, spacing: 2) {
                    if current == nil {
                        VIconView(.check, size: 12)
                            .foregroundStyle(VColor.primaryBase)
                    }
                }
            }
            if hiddenUnreachableCount > 0 {
                let lastSeenAgo = unreachableEntry?.lastSeenAt.map(Self.relativeAgoString) ?? "—"
                let plural = hiddenUnreachableCount == 1 ? "" : "s"
                VMenuItem(
                    icon: VIcon.triangleAlert.rawValue,
                    label: "Ollama offline — \(hiddenUnreachableCount) model\(plural) hidden",
                    isActive: false,
                    size: .regular
                ) {
                    // No-op tap closure: the item is non-interactive
                    // (`.disabled(true)` below) so the action is never
                    // invoked, but VMenuItem's `action` param is required.
                } trailing: {
                    Text("Last seen: \(lastSeenAgo)")
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .disabled(true)
            }
        }
        #endif
    }

    /// Short relative-time string used in the offline notice's trailing
    /// "Last seen: …" subtitle. Returns "—" for an absent `lastSeenAt`, which
    /// the caller substitutes via `?? "—"` at the call site rather than
    /// burying the placeholder here.
    static func relativeAgoString(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
