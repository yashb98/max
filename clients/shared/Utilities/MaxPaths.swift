import Foundation

/// Env-aware filesystem path helpers for client-owned state. Mirrors
/// `cli/src/lib/environments/paths.ts` so the Swift client and the TS
/// daemon/CLI produce byte-identical paths for production users while
/// sharing the same convention for non-production environments.
///
/// **Production is grandfathered**: every getter returns the legacy
/// `~/.max/...` path (or the existing `~/.config/max/...` path for
/// things that were already XDG-compliant). No migration for existing
/// installs.
///
/// **Non-production environments** use env-scoped XDG paths
/// (`$XDG_CONFIG_HOME/max-<env>/...`). These are dormant today — no
/// build currently bakes a non-production `MAX_ENVIRONMENT` into
/// `Info.plist` for end users.
///
/// Production code reads `MaxPaths.current` (cached singleton). Tests
/// construct their own `MaxPaths` with explicit roots so they don't
/// depend on the surrounding process state.
public struct MaxPaths {
    public let environment: MaxEnvironment
    public let homeDirectory: URL
    public let xdgConfigHome: URL

    /// Resolved path bundle for the current process environment.
    ///
    /// `NSHomeDirectory()` is used intentionally to match the existing
    /// convention in `LockfilePaths.swift` (for unsandboxed macOS apps,
    /// this is equivalent to `FileManager.default.homeDirectoryForCurrentUser`).
    public static let current: MaxPaths = {
        MaxPaths(
            environment: .current,
            homeDirectory: URL(fileURLWithPath: NSHomeDirectory()),
            xdgConfigHome: Self.resolveXdgConfigHome()
        )
    }()

    public init(
        environment: MaxEnvironment,
        homeDirectory: URL,
        xdgConfigHome: URL
    ) {
        self.environment = environment
        self.homeDirectory = homeDirectory
        self.xdgConfigHome = xdgConfigHome
    }

    /// One `MaxPaths` per `MaxEnvironment`, all sharing the same
    /// home + XDG roots. Used by recovery flows that need to operate on
    /// every env's config dir (e.g. sweeping stale tokens across siblings).
    public static func allEnvs(
        homeDirectory: URL = current.homeDirectory,
        xdgConfigHome: URL = current.xdgConfigHome
    ) -> [MaxPaths] {
        MaxEnvironment.allCases.map { env in
            MaxPaths(
                environment: env,
                homeDirectory: homeDirectory,
                xdgConfigHome: xdgConfigHome
            )
        }
    }

    // MARK: - Path getters

    /// `~/.config/max/` for production, `~/.config/max-<env>/` otherwise.
    public var configDir: URL {
        let dirName: String
        if environment == .production {
            dirName = "max"
        } else {
            dirName = "max-\(environment.rawValue)"
        }
        return xdgConfigHome.appendingPathComponent(dirName)
    }

    /// Shared with the TypeScript daemon.
    public var deviceIdFile: URL {
        if environment == .production {
            return homeDirectory.appendingPathComponent(".max/device.json")
        }
        return configDir.appendingPathComponent("device.json")
    }

    /// macOS-client-owned; not read by the daemon.
    public var signingKeyFile: URL {
        if environment == .production {
            return homeDirectory.appendingPathComponent(
                ".max/protected/app-signing-key"
            )
        }
        return configDir.appendingPathComponent("app-signing-key")
    }

    /// macOS-client-owned; not read by the daemon.
    public var credentialsDir: URL {
        if environment == .production {
            return homeDirectory.appendingPathComponent(
                ".max/protected/credentials"
            )
        }
        return configDir.appendingPathComponent("credentials")
    }

    /// Shared with the daemon. Always XDG-rooted (no legacy branch).
    public var platformTokenFile: URL {
        configDir.appendingPathComponent("platform-token")
    }

    /// Priority order: current name first, legacy fallback second.
    /// Production returns both; non-prod returns only the current.
    public var lockfileCandidates: [URL] {
        if environment == .production {
            return [
                homeDirectory.appendingPathComponent(".max.lock.json"),
                homeDirectory.appendingPathComponent(".max.lockfile.json"),
            ]
        }
        return [configDir.appendingPathComponent("lockfile.json")]
    }

    // MARK: - Internals

    // Accept the raw XDG_CONFIG_HOME value even if relative, matching
    // cli/src/lib/environments/paths.ts:xdgConfigHome() and
    // assistant/src/util/platform.ts:getXdgPlatformTokenPath which both
    // honor whatever the env var says. In practice real-world XDG paths
    // are always absolute; this exists only for edge-case parity.
    internal static func resolveXdgConfigHome() -> URL {
        if let raw = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty
        {
            return URL(fileURLWithPath: raw)
        }
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".config")
    }
}
