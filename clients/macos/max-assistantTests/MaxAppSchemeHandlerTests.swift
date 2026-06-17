import XCTest
@testable import MaxAssistantLib

final class MaxAppSchemeHandlerTests: XCTestCase {

    func testSchemeIsMaxApp() {
        XCTAssertEqual(MaxAppSchemeHandler.scheme, "maxapp")
    }
}
