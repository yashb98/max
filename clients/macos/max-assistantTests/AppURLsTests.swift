import XCTest
@testable import MaxAssistantLib

final class AppURLsTests: XCTestCase {
    private var originalEnvValue: String?
    private var originalWebEnvValue: String?

    override func setUp() {
        super.setUp()
        originalEnvValue = ProcessInfo.processInfo.environment["MAX_DOCS_BASE_URL"]
        unsetenv("MAX_DOCS_BASE_URL")
        originalWebEnvValue = ProcessInfo.processInfo.environment["MAX_WEB_URL"]
        unsetenv("MAX_WEB_URL")
    }

    override func tearDown() {
        if let value = originalEnvValue {
            setenv("MAX_DOCS_BASE_URL", value, 1)
        } else {
            unsetenv("MAX_DOCS_BASE_URL")
        }
        if let value = originalWebEnvValue {
            setenv("MAX_WEB_URL", value, 1)
        } else {
            unsetenv("MAX_WEB_URL")
        }
        super.tearDown()
    }

    // MARK: - Base URL behavior

    func testDocsBaseURLDefaultsToProduction() {
        XCTAssertEqual(AppURLs.docsBaseURL, "https://www.max.ai/docs")
    }

    func testDocsBaseURLHonorsEnvOverride() {
        setenv("MAX_DOCS_BASE_URL", "https://staging.max.ai/docs", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://staging.max.ai/docs")
    }

    func testDocsBaseURLStripsTrailingSlash() {
        setenv("MAX_DOCS_BASE_URL", "https://staging.max.ai/docs/", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://staging.max.ai/docs")
    }

    func testDocsBaseURLEmptyEnvFallsBackToDefault() {
        setenv("MAX_DOCS_BASE_URL", "  ", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://www.max.ai/docs")
    }

    func testDocsBaseURLRejectsMalformedURLAndFallsBack() {
        setenv("MAX_DOCS_BASE_URL", "not a url", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://www.max.ai/docs")
    }

    func testDocsBaseURLRejectsURLWithoutSchemeAndFallsBack() {
        setenv("MAX_DOCS_BASE_URL", "max.ai/docs", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://www.max.ai/docs")
    }

    func testDocsBaseURLRejectsNonHTTPSchemeAndFallsBack() {
        setenv("MAX_DOCS_BASE_URL", "ftp://files.max.ai/docs", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://www.max.ai/docs")
    }

    func testDocsBaseURLAcceptsHTTPScheme() {
        setenv("MAX_DOCS_BASE_URL", "http://localhost:3000/docs", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "http://localhost:3000/docs")
    }

    func testDocsBaseURLRejectsBaseWithQueryAndFallsBack() {
        setenv("MAX_DOCS_BASE_URL", "https://example.com/docs?build=123", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://www.max.ai/docs")
    }

    func testDocsBaseURLRejectsBaseWithFragmentAndFallsBack() {
        setenv("MAX_DOCS_BASE_URL", "https://example.com/docs#section", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://www.max.ai/docs")
    }

    func testConcreteURLsFallBackOnMalformedEnv() {
        setenv("MAX_DOCS_BASE_URL", "not a url", 1)
        XCTAssertEqual(AppURLs.pricingDocs.absoluteString, "https://www.max.ai/docs/pricing")
        XCTAssertEqual(AppURLs.hostingOptionsDocs.absoluteString, "https://www.max.ai/docs/hosting-options")
    }

    // MARK: - Concrete URL constructions

    func testPricingDocsURLConstruction() {
        XCTAssertEqual(AppURLs.pricingDocs.absoluteString, "https://www.max.ai/docs/pricing")
    }

    func testHostingOptionsDocsURLConstruction() {
        XCTAssertEqual(AppURLs.hostingOptionsDocs.absoluteString, "https://www.max.ai/docs/hosting-options")
    }

    func testTermsOfUseDocsURLConstruction() {
        XCTAssertEqual(AppURLs.termsOfUseDocs.absoluteString, "https://www.max.ai/docs/max-terms-of-use")
    }

    func testPrivacyPolicyDocsURLConstruction() {
        XCTAssertEqual(AppURLs.privacyPolicyDocs.absoluteString, "https://www.max.ai/docs/privacy-policy")
    }

    // MARK: - Env override propagates to concrete URLs

    func testConcreteURLsHonorEnvOverride() {
        setenv("MAX_DOCS_BASE_URL", "https://staging.max.ai/docs", 1)
        XCTAssertEqual(AppURLs.pricingDocs.absoluteString, "https://staging.max.ai/docs/pricing")
        XCTAssertEqual(AppURLs.hostingOptionsDocs.absoluteString, "https://staging.max.ai/docs/hosting-options")
        XCTAssertEqual(AppURLs.termsOfUseDocs.absoluteString, "https://staging.max.ai/docs/max-terms-of-use")
        XCTAssertEqual(AppURLs.privacyPolicyDocs.absoluteString, "https://staging.max.ai/docs/privacy-policy")
    }

    // MARK: - Source repository

    func testRepositoryURL() {
        XCTAssertEqual(AppURLs.repositoryURL.absoluteString, "https://github.com/max-ai/max-assistant")
    }

    // MARK: - UTM helper

    func testUTMHelperBuildsBaseURLWithQueryParams() {
        let url = AppURLs.docsURL(utmSource: "macos-app", utmMedium: "help-menu")
        XCTAssertEqual(url.absoluteString, "https://www.max.ai/docs?utm_source=macos-app&utm_medium=help-menu")
    }

    func testUTMHelperWithPath() {
        let url = AppURLs.docsURL(path: "/pricing", utmSource: "macos-app", utmMedium: "settings")
        XCTAssertEqual(url.absoluteString, "https://www.max.ai/docs/pricing?utm_source=macos-app&utm_medium=settings")
    }

    func testUTMHelperHonorsEnvOverride() {
        setenv("MAX_DOCS_BASE_URL", "https://staging.max.ai/docs", 1)
        let url = AppURLs.docsURL(utmSource: "macos-app", utmMedium: "help-menu")
        XCTAssertEqual(url.absoluteString, "https://staging.max.ai/docs?utm_source=macos-app&utm_medium=help-menu")
    }

    // MARK: - Path helper

    func testDocsURLHelperNormalizesLeadingSlash() {
        XCTAssertEqual(AppURLs.docsURL(path: "/pricing").absoluteString, "https://www.max.ai/docs/pricing")
        XCTAssertEqual(AppURLs.docsURL(path: "pricing").absoluteString, "https://www.max.ai/docs/pricing")
    }

    // MARK: - Billing settings web URL

    func testBillingSettingsHonorsWebURLOverride() {
        setenv("MAX_WEB_URL", "https://staging-assistant.max.ai", 1)
        XCTAssertEqual(
            AppURLs.billingSettings.absoluteString,
            "https://staging-assistant.max.ai/assistant/settings/billing"
        )
    }

    func testBillingSettingsStripsTrailingSlash() {
        setenv("MAX_WEB_URL", "https://staging-assistant.max.ai/", 1)
        XCTAssertEqual(
            AppURLs.billingSettings.absoluteString,
            "https://staging-assistant.max.ai/assistant/settings/billing"
        )
    }

    func testBillingSettingsFallsBackWhenWebURLOverrideMalformed() {
        setenv("MAX_WEB_URL", "not a url with spaces", 1)
        // Should fall back to the env-default web URL rather than crash.
        let result = AppURLs.billingSettings.absoluteString
        XCTAssertTrue(result.hasSuffix("/assistant/settings/billing"))
        XCTAssertFalse(result.contains("not a url with spaces"))
    }

    func testBillingSettingsFallsBackWhenWebURLOverrideHasNoScheme() {
        setenv("MAX_WEB_URL", "example.com/path", 1)
        let result = AppURLs.billingSettings.absoluteString
        XCTAssertTrue(result.hasSuffix("/assistant/settings/billing"))
        XCTAssertFalse(result.contains("example.com"))
    }

    func testBillingSettingsFallsBackWhenWebURLOverrideHasQuery() {
        setenv("MAX_WEB_URL", "https://example.com?foo=bar", 1)
        let result = AppURLs.billingSettings.absoluteString
        XCTAssertTrue(result.hasSuffix("/assistant/settings/billing"))
        XCTAssertFalse(result.contains("?foo=bar"))
    }

    func testBillingSettingsFallsBackWhenWebURLOverrideHasFragment() {
        setenv("MAX_WEB_URL", "https://example.com#section", 1)
        let result = AppURLs.billingSettings.absoluteString
        XCTAssertTrue(result.hasSuffix("/assistant/settings/billing"))
        XCTAssertFalse(result.contains("#section"))
    }
}
