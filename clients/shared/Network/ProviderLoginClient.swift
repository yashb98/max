import Foundation

/// Hermetic-test seam for driving an agentic provider's OAuth/login flow from
/// the macOS UI. Mirrors the `ProviderAvailabilityClientProtocol` pattern.
public protocol ProviderLoginClientProtocol: Sendable {
    /// Asks the daemon to run `provider`'s login flow and persist the captured
    /// credential. The daemon opens the OAuth URL in the host browser. Returns
    /// `nil` on transport failure so callers can distinguish "couldn't reach the
    /// daemon" from a structured login failure (`ProviderLoginResult.success ==
    /// false`).
    func login(provider: String) async -> ProviderLoginResult?
}

/// Production client. Calls `POST /v1/provider-login` on the daemon's HTTP
/// server. The route is global (not scoped under an assistant), so we pass
/// `unprefixed: true`. The timeout is generous because the call blocks for the
/// duration of the user's interactive OAuth flow.
public struct ProviderLoginClient: ProviderLoginClientProtocol {
    public init() {}

    public func login(provider: String) async -> ProviderLoginResult? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "provider-login",
                json: ["provider": provider],
                timeout: 180,
                unprefixed: true
            )
            guard response.isSuccess else { return nil }
            return try JSONDecoder().decode(ProviderLoginResult.self, from: response.data)
        } catch {
            return nil
        }
    }
}
