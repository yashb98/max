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
