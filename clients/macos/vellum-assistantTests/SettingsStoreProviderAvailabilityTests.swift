import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SettingsStoreProviderAvailabilityTests: XCTestCase {

    private final class StubClient: ProviderAvailabilityClientProtocol {
        let result: [String: ProviderAvailabilityStatus]?
        init(result: [String: ProviderAvailabilityStatus]?) { self.result = result }
        func fetchProviderAvailability(fresh: Bool) async -> [String: ProviderAvailabilityStatus]? {
            return result
        }
    }

    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    private var missingConfigPath: String {
        tempDir.appendingPathComponent("nonexistent.json").path
    }

    func test_loadProviderAvailability_publishesMap() {
        let store = SettingsStore(configPath: missingConfigPath)
        let map: [String: ProviderAvailabilityStatus] = [
            "claude-subscription": ProviderAvailabilityStatus(available: false, reason: .missingCli),
            "ollama": ProviderAvailabilityStatus(available: true, reason: nil),
        ]
        store.loadProviderAvailability(map: map)
        XCTAssertEqual(store.providerAvailability["claude-subscription"]?.reason, .missingCli)
        XCTAssertTrue(store.providerAvailability["ollama"]?.available ?? false)
    }

    func test_refreshProviderAvailability_keepsMapOnTransportFailure() async {
        let store = SettingsStore(configPath: missingConfigPath)
        let initial: [String: ProviderAvailabilityStatus] = [
            "claude-subscription": ProviderAvailabilityStatus(available: true, reason: nil),
        ]
        store.loadProviderAvailability(map: initial)

        await store.refreshProviderAvailability(client: StubClient(result: nil))

        XCTAssertEqual(
            store.providerAvailability["claude-subscription"]?.available,
            true,
            "Expected last-known map to be preserved on transport failure"
        )
    }
}
