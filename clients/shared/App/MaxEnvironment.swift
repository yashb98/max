import Foundation

/// Runtime environment identifier derived from the `MAX_ENVIRONMENT` value
/// embedded at build time. See AGENTS.md "Build Environment" for the full matrix.
///
/// Values: `local`, `dev`, `test`, `staging`, `production`.
/// Falls back to `.production` when the variable is unset (e.g. in unit
/// tests or when launched outside the normal build pipeline).
public enum MaxEnvironment: String, CaseIterable {
    case local
    case dev
    case test
    case staging
    case production

    /// The current environment, read once from `ProcessInfo`.
    ///
    /// When `MAX_ENVIRONMENT` is set, that value is used directly.
    /// When unset, iOS Simulator builds default to `.local` so that
    /// developers get localhost without needing to regenerate the
    /// Xcode project from `project.yml` after every pull.  All other
    /// targets (device, release, macOS) default to `.production`.
    public static let current: MaxEnvironment = {
        let raw = ProcessInfo.processInfo.environment["MAX_ENVIRONMENT"]
        if let raw {
            // Env var is explicitly set — use it, falling back to
            // .production for unrecognised values (e.g. typos).
            return MaxEnvironment(rawValue: raw) ?? .production
        }
        // Env var is absent entirely.
        #if targetEnvironment(simulator)
        return .local
        #else
        return .production
        #endif
    }()

    /// Resolve from an arbitrary environment dictionary (for testability).
    public static func resolve(from environment: [String: String]) -> MaxEnvironment {
        if let raw = environment["MAX_ENVIRONMENT"],
           let env = MaxEnvironment(rawValue: raw) {
            return env
        }
        return .production
    }

    /// Human-readable label for display in the About panel.
    /// Returns `nil` for production so callers can omit the label entirely.
    public var displayLabel: String? {
        switch self {
        case .local: return "Local"
        case .dev: return "Dev"
        case .test: return "Test"
        case .staging: return "Staging"
        case .production: return nil
        }
    }

    /// The macOS bundle identifier for this environment.
    ///
    /// Production uses the bare `com.max.max-assistant`; all other
    /// environments append a suffix (e.g. `com.max.max-assistant-dev`)
    /// so that preferences, log streams, and keychain items stay isolated.
    public var bundleIdentifier: String {
        switch self {
        case .production:
            return "com.max.max-assistant"
        default:
            return "com.max.max-assistant-\(rawValue)"
        }
    }

    /// The directory name used under `~/Library/Application Support/` for
    /// this environment.
    ///
    /// Production uses `max-assistant`; other environments append a
    /// suffix (e.g. `max-assistant-dev`) so that multiple builds can
    /// coexist without sharing data files.
    public var appSupportDirectoryName: String {
        switch self {
        case .production:
            return "max-assistant"
        default:
            return "max-assistant-\(rawValue)"
        }
    }

    /// The canonical Max platform API base URL for this environment.
    public var platformURL: String {
        switch self {
        case .local:
            return "http://localhost:8000"
        case .dev:
            return "https://dev-platform.max.ai"
        case .test:
            return "https://test-platform.max.ai"
        case .staging:
            return "https://staging-platform.max.ai"
        case .production:
            return "https://platform.max.ai"
        }
    }

    /// The current resolved platform URL.
    ///
    /// Resolution order:
    /// 1. `MAX_PLATFORM_URL` environment variable (explicit override)
    /// 2. `MAX_ENVIRONMENT`-based canonical URL
    public static var resolvedPlatformURL: String {
        let environment = ProcessInfo.processInfo.environment
        if let raw = environment["MAX_PLATFORM_URL"] {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = trimmed.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            if !normalized.isEmpty { return normalized }
        }
        return current.platformURL
    }

    /// The canonical Max web app (Next.js) base URL for this environment.
    /// This is where browser-facing pages like `/account/login` live.
    public var webURL: String {
        switch self {
        case .local:
            return "http://localhost:3000"
        case .dev:
            return "https://dev-assistant.max.ai"
        case .test:
            return "https://dev-assistant.max.ai"
        case .staging:
            return "https://staging-assistant.max.ai"
        case .production:
            return "https://www.max.ai"
        }
    }

    /// The current resolved web app URL.
    ///
    /// Resolution order:
    /// 1. `MAX_WEB_URL` environment variable (explicit override)
    /// 2. `MAX_ENVIRONMENT`-based canonical URL
    public static var resolvedWebURL: String {
        let environment = ProcessInfo.processInfo.environment
        if let raw = environment["MAX_WEB_URL"] {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = trimmed.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            if !normalized.isEmpty { return normalized }
        }
        return current.webURL
    }

    /// The platform URL to inject into containerized assistants.
    ///
    /// For local Docker containers setup, we can use `host.docker.internal`
    /// to target platform services running locally on the host,
    /// or else attach the assistants to the actual Docker network.
    ///
    /// This doesn't apply to Apple Containers: VMs can reach the host via the vmnet
    /// bridge gateway IP. This is only known after the pod network is created,
    /// and will require some refactoring to support.
    public var dockerHostPlatformURL: String {
        switch self {
        case .local:
            return "http://host.docker.internal:8000"
        default:
            return platformURL
        }
    }
}
