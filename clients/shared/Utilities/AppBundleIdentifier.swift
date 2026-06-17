import Foundation

extension Bundle {
    /// The app's bundle identifier, guaranteed non-nil.
    ///
    /// Falls back to the production identifier for contexts where
    /// `Bundle.main.bundleIdentifier` is unavailable (e.g. SPM test builds).
    /// At runtime the value is environment-specific (e.g.
    /// `com.max.max-assistant-dev`, `com.max.max-assistant-staging`)
    /// because `build.sh` stamps the bundle ID per `MAX_ENVIRONMENT`.
    public static let appBundleIdentifier: String = main.bundleIdentifier ?? "com.max.max-assistant"
}
