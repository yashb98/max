import Foundation
import MaxAssistantShared

// MARK: - Service Names

/// The three services that make up a Max assistant stack.
enum MaxServiceName: String, CaseIterable, Sendable {
    case assistant = "max-assistant"
    case gateway = "max-gateway"
    case credentialExecutor = "max-credential-executor"
}

// MARK: - Image References

/// An OCI image reference for a Max service container.
struct MaxImageReference: Sendable, Equatable {
    let registry: String
    let repository: String
    let tag: String

    var fullReference: String {
        "\(registry)/\(repository):\(tag)"
    }

    /// Default image references for a given service group version, pulled from Docker Hub.
    /// This assumes the image tags are kept in sync.
    static func defaults(version: String) -> [MaxServiceName: MaxImageReference] {
        let org = "maxai"
        return [
            .assistant: MaxImageReference(
                registry: "docker.io",
                repository: "\(org)/max-assistant",
                tag: version
            ),
            .gateway: MaxImageReference(
                registry: "docker.io",
                repository: "\(org)/max-gateway",
                tag: version
            ),
            .credentialExecutor: MaxImageReference(
                registry: "docker.io",
                repository: "\(org)/max-credential-executor",
                tag: version
            ),
        ]
    }
}

// MARK: - Ports

/// Internal ports exposed by each service's container.
enum MaxContainerPorts {
    static let assistantHTTP: UInt16 = 3001
    static let gatewayHTTP: UInt16 = 7830
    static let cesHTTP: UInt16 = 8090
}

// MARK: - Mount Paths

/// Well-known mount paths inside the pod VM shared across services.
enum MaxMountPaths {
    /// Persistent assistant workspace data (rw for assistant + gateway, ro for CES).
    static let workspace = "/workspace"
    /// CES bootstrap unix-socket directory.
    static let cesBootstrap = "/run/ces-bootstrap"
    /// Gateway IPC socket directory (gateway↔daemon communication).
    static let gatewayIpcSocketDir = "/run/gateway-ipc"
    /// Assistant IPC socket directory (daemon↔gateway reverse communication).
    static let assistantIpcSocketDir = "/run/assistant-ipc"
    /// Gateway security directory (gateway-private).
    static let gatewaySecurityDir = "/gateway-security"
    /// CES credential security directory (CES-private).
    static let cesSecurityDir = "/ces-security"
}

// MARK: - Environment Keys

/// Environment variable keys passed to each container.
enum MaxContainerEnv {
    static func assistant(
        instanceName: String,
        signingKey: String?,
        cesServiceToken: String?,
        platformURL: String?
    ) -> [String: String] {
        var env: [String: String] = [
            "IS_CONTAINERIZED": "true",
            "MAX_ASSISTANT_NAME": instanceName,
            "MAX_CLOUD": "apple-container",
            "MAX_ENVIRONMENT": MaxEnvironment.current.rawValue,
            "RUNTIME_HTTP_HOST": "0.0.0.0",
            "MAX_WORKSPACE_DIR": MaxMountPaths.workspace,
            "CES_CREDENTIAL_URL": "http://localhost:\(MaxContainerPorts.cesHTTP)",
            "GATEWAY_INTERNAL_URL": "http://localhost:\(MaxContainerPorts.gatewayHTTP)",
            "GATEWAY_IPC_SOCKET_DIR": MaxMountPaths.gatewayIpcSocketDir,
            "ASSISTANT_IPC_SOCKET_DIR": MaxMountPaths.assistantIpcSocketDir,
        ]
        if let signingKey {
            env["ACTOR_TOKEN_SIGNING_KEY"] = signingKey
        }
        if let cesServiceToken {
            env["CES_SERVICE_TOKEN"] = cesServiceToken
        }
        if let platformURL {
            env["MAX_PLATFORM_URL"] = platformURL
        }
        return env
    }

    static func gateway(
        signingKey: String?,
        bootstrapSecret: String?,
        cesServiceToken: String?,
        platformURL: String?
    ) -> [String: String] {
        var env: [String: String] = [
            "IS_CONTAINERIZED": "true",
            "MAX_ENVIRONMENT": MaxEnvironment.current.rawValue,
            "MAX_WORKSPACE_DIR": MaxMountPaths.workspace,
            "GATEWAY_SECURITY_DIR": MaxMountPaths.gatewaySecurityDir,
            "GATEWAY_PORT": String(MaxContainerPorts.gatewayHTTP),
            "ASSISTANT_HOST": "localhost",
            "RUNTIME_HTTP_PORT": String(MaxContainerPorts.assistantHTTP),
            "CES_CREDENTIAL_URL": "http://localhost:\(MaxContainerPorts.cesHTTP)",
            "GATEWAY_IPC_SOCKET_DIR": MaxMountPaths.gatewayIpcSocketDir,
            "ASSISTANT_IPC_SOCKET_DIR": MaxMountPaths.assistantIpcSocketDir,
        ]
        if let signingKey {
            env["ACTOR_TOKEN_SIGNING_KEY"] = signingKey
        }
        if let bootstrapSecret {
            env["GUARDIAN_BOOTSTRAP_SECRET"] = bootstrapSecret
        }
        if let cesServiceToken {
            env["CES_SERVICE_TOKEN"] = cesServiceToken
        }
        if let platformURL {
            env["MAX_PLATFORM_URL"] = platformURL
        }
        return env
    }

    static func credentialExecutor(cesServiceToken: String?) -> [String: String] {
        var env: [String: String] = [
            "CES_MODE": "managed",
            "MAX_WORKSPACE_DIR": MaxMountPaths.workspace,
            "CES_BOOTSTRAP_SOCKET_DIR": MaxMountPaths.cesBootstrap,
            "CREDENTIAL_SECURITY_DIR": MaxMountPaths.cesSecurityDir,
        ]
        if let cesServiceToken {
            env["CES_SERVICE_TOKEN"] = cesServiceToken
        }
        return env
    }
}

// MARK: - Service Start Order

extension MaxServiceName {
    static let startOrder: [MaxServiceName] = [
        .assistant,
        .gateway,
        .credentialExecutor,
    ]
}
