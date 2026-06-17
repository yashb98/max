import XCTest
@testable import MaxAssistantLib

final class AssistantStatusTests: XCTestCase {

    func testAuthFailedMenuTitleContainsAuthenticationAndAssistantName() {
        let title = AssistantStatus.authFailed.menuTitle(assistantName: "Max")
        XCTAssertTrue(title.contains("Authentication"), "menuTitle should mention Authentication: \(title)")
        XCTAssertTrue(title.contains("Max"), "menuTitle should include the assistant name: \(title)")
    }

    func testAuthFailedStatusColorIsDistinctFromDisconnected() {
        XCTAssertNotEqual(
            AssistantStatus.authFailed.statusColor,
            AssistantStatus.disconnected.statusColor,
            "authFailed and disconnected should be visually distinct"
        )
    }

    func testAuthFailedDoesNotPulse() {
        XCTAssertFalse(AssistantStatus.authFailed.shouldPulse, "authFailed is a steady state, not animated")
    }
}
