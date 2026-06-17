// swift-tools-version: 6.2
import PackageDescription

let appVersion = "0.8.1"

let package = Package(
    name: "max-assistant",
    platforms: [
        .macOS("15.0")
    ],
    products: [
        .library(
            name: "MaxAssistantLib",
            targets: ["MaxAssistantLib"]
        ),
        .library(
            name: "MaxAssistantShared",
            targets: ["MaxAssistantShared"]
        ),
        .library(
            name: "ObjCExceptionCatcher",
            targets: ["ObjCExceptionCatcher"]
        ),
        .executable(
            name: "max-assistant",
            targets: ["max-assistant"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/apple/containerization.git", exact: "0.30.1"),
        .package(url: "https://github.com/getsentry/sentry-cocoa.git", exact: "8.58.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.8.1"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.11.2"),
        .package(url: "https://github.com/mgriebling/SwiftMath.git", exact: "1.7.3"),
    ],
    targets: [
        .target(
            name: "ObjCExceptionCatcher",
            dependencies: [],
            path: "shared/ObjCExceptionCatcher",
            publicHeadersPath: "include"
        ),
        .target(
            name: "MaxAssistantShared",
            dependencies: ["ObjCExceptionCatcher"],
            path: "shared",
            exclude: ["Tests", "ObjCExceptionCatcher"],
            resources: [
                .copy("Resources/LucideIcons"),
                .copy("Resources/LUCIDE-LICENSE"),
                .copy("Resources/lucide-icon-manifest.json"),
                .copy("Resources/lucide-version.txt"),
                .copy("Resources/IntegrationLogos"),
                .copy("Resources/INTEGRATION-LOGOS-LICENSE"),
                .copy("Resources/integration-logos-manifest.json"),
                .copy("Resources/llm-provider-catalog.json"),
                .copy("Resources/web-search-provider-catalog.json"),
            ],
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
                .enableUpcomingFeature("BareSlashRegexLiterals")
            ],
            linkerSettings: [
                .linkedFramework("Network"),  // Required for NWError (ChatErrorManager, ChatViewModel)
                .linkedFramework("AuthenticationServices"),  // Required for shared AuthManager (ASWebAuthenticationSession)
            ]
        ),
        .target(
            name: "MaxAssistantLib",
            dependencies: [
                "MaxAssistantShared",
                .product(name: "Containerization", package: "containerization"),
                .product(name: "ContainerizationOCI", package: "containerization"),
                "Sparkle",
                .product(name: "Sentry", package: "sentry-cocoa"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
                .product(name: "SwiftMath", package: "SwiftMath"),
            ],
            path: "macos/max-assistant",
            exclude: ["Resources/Info.plist", "Resources/MaxDocument.icns"],
            resources: [
                .process("Resources/Assets.xcassets"),
                .process("Resources/Fonts"),
                .copy("Resources/Recipes"),
                .process("Resources/Onboarding"),
                .process("Resources/max-design-system.css"),
                .process("Resources/max-widgets.js"),
                .process("Resources/max-edit-animator.js"),
                .copy("Resources/editor"),
                .process("Resources/initial-avatar.png"),
                .process("Resources/welcome-characters.png")
            ],
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
            ],
            linkerSettings: [
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AppKit"),
                .linkedFramework("Security"),
                .linkedFramework("Speech"),
                .linkedFramework("Vision"),
                .linkedFramework("Network"),
                .linkedFramework("SpriteKit"),
                .linkedFramework("AVKit"),
                .linkedFramework("AuthenticationServices"),
            ]
        ),
        .executableTarget(
            name: "max-assistant",
            dependencies: ["MaxAssistantLib"],
            path: "macos/max-assistant-app"
        ),
        .testTarget(
            name: "max-assistantTests",
            dependencies: ["MaxAssistantLib"],
            path: "macos/max-assistantTests"
        ),
        .testTarget(
            name: "MaxAssistantSharedTests",
            dependencies: ["MaxAssistantShared"],
            path: "shared/Tests"
        )
    ],
    // swift-tools-version 6.2 is required by the `containerization` dependency,
    // but the codebase isn't yet migrated to Swift 6 strict concurrency.
    swiftLanguageModes: [.v5]
)
