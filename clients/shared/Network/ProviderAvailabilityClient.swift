import Foundation

/// Hermetic-test seam for `SettingsStore.refreshProviderAvailability`.
/// Mirrors the `ProviderConnectionClientProtocol` pattern.
public protocol ProviderAvailabilityClientProtocol: Sendable {
    /// Returns the daemon's full availability map. Returns `nil` on transport
    /// failure so callers preserve their last-known snapshot rather than blanking.
    func fetchProviderAvailability(fresh: Bool) async -> [String: ProviderAvailabilityStatus]?
}

/// Production client. Calls `GET /v1/provider-availability[?fresh=true]` on the
/// daemon's HTTP server. The route is global (not scoped under an assistant),
/// so we pass `unprefixed: true`.
public struct ProviderAvailabilityClient: ProviderAvailabilityClientProtocol {
    public init() {}

    public func fetchProviderAvailability(
        fresh: Bool
    ) async -> [String: ProviderAvailabilityStatus]? {
        let params: [String: String]? = fresh ? ["fresh": "true"] : nil
        do {
            let (map, response): ([String: ProviderAvailabilityStatus]?, GatewayHTTPClient.Response) =
                try await GatewayHTTPClient.get(
                    path: "provider-availability",
                    params: params,
                    unprefixed: true
                )
            guard response.isSuccess else { return nil }
            return map
        } catch {
            return nil
        }
    }
}
