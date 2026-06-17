import Foundation

/// Wire-shape mirror of the daemon's `ProviderLoginResult`. Decoded from
/// `POST /v1/provider-login` (see `ProviderLoginClient`). The daemon drives the
/// provider's OAuth/login flow and opens the auth URL in the host browser; this
/// result reports whether the login succeeded and, if not, why.
public struct ProviderLoginResult: Codable, Equatable, Sendable {
    public enum Reason: String, Codable, Sendable, CaseIterable {
        case unsupportedProvider = "unsupported-provider"
        case cliError = "cli-error"
        case cancelled
        case noTokenCaptured = "no-token-captured"
        case subscriptionRequired = "subscription-required"
    }

    public let success: Bool
    public let reason: Reason?
    public let error: String?

    public init(success: Bool, reason: Reason? = nil, error: String? = nil) {
        self.success = success
        self.reason = reason
        self.error = error
    }
}
