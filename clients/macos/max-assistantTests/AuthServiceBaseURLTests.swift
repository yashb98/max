import XCTest
@testable import MaxAssistantShared

@MainActor
final class AuthServiceBaseURLTests: XCTestCase {
    /// MAX_ENVIRONMENT=local resolves to localhost.
    func testResolvePlatformURLUsesLocalhostForLocalEnvironment() {
        let resolved = MaxEnvironment.resolve(from: ["MAX_ENVIRONMENT": "local"]).platformURL
        XCTAssertEqual(resolved, "http://localhost:8000")
    }

    /// With no MAX_ENVIRONMENT set, defaults to production.
    func testResolvePlatformURLDefaultsToProductionWhenNoEnvironmentSet() {
        let resolved = MaxEnvironment.resolve(from: [:]).platformURL
        XCTAssertEqual(resolved, "https://platform.max.ai")
    }

    /// MAX_ENVIRONMENT=dev resolves to the dev platform.
    func testResolvePlatformURLUsesDevPlatformForDevEnvironment() {
        let resolved = MaxEnvironment.resolve(from: ["MAX_ENVIRONMENT": "dev"]).platformURL
        XCTAssertEqual(resolved, "https://dev-platform.max.ai")
    }

    /// MAX_ENVIRONMENT=staging resolves to the staging platform.
    func testResolvePlatformURLUsesStagingPlatformForStagingEnvironment() {
        let resolved = MaxEnvironment.resolve(from: ["MAX_ENVIRONMENT": "staging"]).platformURL
        XCTAssertEqual(resolved, "https://staging-platform.max.ai")
    }

    /// MAX_ENVIRONMENT=test resolves to the test platform.
    func testResolvePlatformURLUsesTestPlatformForTestEnvironment() {
        let resolved = MaxEnvironment.resolve(from: ["MAX_ENVIRONMENT": "test"]).platformURL
        XCTAssertEqual(resolved, "https://test-platform.max.ai")
    }
}
