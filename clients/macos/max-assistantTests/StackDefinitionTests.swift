import XCTest
@testable import MaxAssistantLib

final class StackDefinitionTests: XCTestCase {

    // MARK: - MaxServiceName

    func testAllServicesPresent() {
        let names = MaxServiceName.allCases
        XCTAssertEqual(names.count, 3)
        XCTAssertTrue(names.contains(.assistant))
        XCTAssertTrue(names.contains(.gateway))
        XCTAssertTrue(names.contains(.credentialExecutor))
    }

    func testServiceRawValues() {
        XCTAssertEqual(MaxServiceName.assistant.rawValue, "max-assistant")
        XCTAssertEqual(MaxServiceName.gateway.rawValue, "max-gateway")
        XCTAssertEqual(MaxServiceName.credentialExecutor.rawValue, "max-credential-executor")
    }

    func testStartOrderContainsAllServices() {
        let ordered = Set(MaxServiceName.startOrder)
        let all = Set(MaxServiceName.allCases)
        XCTAssertEqual(ordered, all)
    }

    func testStartOrderBeginsWithAssistant() {
        XCTAssertEqual(MaxServiceName.startOrder.first, .assistant)
    }

    // MARK: - MaxImageReference

    func testFullReferenceFormat() {
        let ref = MaxImageReference(registry: "docker.io", repository: "maxai/max-assistant", tag: "1.2.3")
        XCTAssertEqual(ref.fullReference, "docker.io/maxai/max-assistant:1.2.3")
    }

    func testDefaultsContainAllServices() {
        let refs = MaxImageReference.defaults(version: "0.1.0")
        for service in MaxServiceName.allCases {
            XCTAssertNotNil(refs[service], "Missing default image ref for \(service)")
        }
    }

    func testDefaultsUseRequestedVersion() {
        let refs = MaxImageReference.defaults(version: "42.0.0")
        for (_, ref) in refs {
            XCTAssertEqual(ref.tag, "42.0.0")
        }
    }

    // MARK: - Ports

    func testPortValues() {
        XCTAssertEqual(MaxContainerPorts.assistantHTTP, 3001)
        XCTAssertEqual(MaxContainerPorts.gatewayHTTP, 7830)
        XCTAssertEqual(MaxContainerPorts.cesHTTP, 8090)
    }

    // MARK: - Environment

    func testAssistantEnvRequiredKeys() {
        let env = MaxContainerEnv.assistant(instanceName: "test", signingKey: nil, cesServiceToken: nil, platformURL: nil)
        XCTAssertEqual(env["IS_CONTAINERIZED"], "true")
        XCTAssertEqual(env["MAX_ASSISTANT_NAME"], "test")
        XCTAssertEqual(env["MAX_CLOUD"], "apple-container")
        XCTAssertEqual(env["RUNTIME_HTTP_HOST"], "0.0.0.0")
        XCTAssertEqual(env["MAX_WORKSPACE_DIR"], "/workspace")
        XCTAssertNotNil(env["CES_CREDENTIAL_URL"])
        XCTAssertNotNil(env["GATEWAY_INTERNAL_URL"])
        XCTAssertEqual(env["GATEWAY_IPC_SOCKET_DIR"], "/run/gateway-ipc")
        XCTAssertEqual(env["ASSISTANT_IPC_SOCKET_DIR"], "/run/assistant-ipc")
    }

    func testAssistantEnvOptionalKeys() {
        let env = MaxContainerEnv.assistant(instanceName: "x", signingKey: "key123", cesServiceToken: "tok456", platformURL: "https://custom.max.ai")
        XCTAssertEqual(env["ACTOR_TOKEN_SIGNING_KEY"], "key123")
        XCTAssertEqual(env["CES_SERVICE_TOKEN"], "tok456")
        XCTAssertEqual(env["MAX_PLATFORM_URL"], "https://custom.max.ai")
    }

    func testAssistantEnvOmitsNilOptionals() {
        let env = MaxContainerEnv.assistant(instanceName: "x", signingKey: nil, cesServiceToken: nil, platformURL: nil)
        XCTAssertNil(env["ACTOR_TOKEN_SIGNING_KEY"])
        XCTAssertNil(env["CES_SERVICE_TOKEN"])
        XCTAssertNil(env["MAX_PLATFORM_URL"])
    }

    func testGatewayEnvRequiredKeys() {
        let env = MaxContainerEnv.gateway(signingKey: nil, bootstrapSecret: nil, cesServiceToken: nil, platformURL: nil)
        XCTAssertEqual(env["IS_CONTAINERIZED"], "true")
        XCTAssertEqual(env["GATEWAY_PORT"], "7830")
        XCTAssertEqual(env["ASSISTANT_HOST"], "localhost")
        XCTAssertEqual(env["RUNTIME_HTTP_PORT"], "3001")
        XCTAssertNotNil(env["CES_CREDENTIAL_URL"])
        XCTAssertEqual(env["GATEWAY_IPC_SOCKET_DIR"], "/run/gateway-ipc")
        XCTAssertEqual(env["ASSISTANT_IPC_SOCKET_DIR"], "/run/assistant-ipc")
    }

    func testGatewayEnvOptionalKeys() {
        let env = MaxContainerEnv.gateway(signingKey: "sk", bootstrapSecret: "bs", cesServiceToken: "ct", platformURL: "https://custom.max.ai")
        XCTAssertEqual(env["ACTOR_TOKEN_SIGNING_KEY"], "sk")
        XCTAssertEqual(env["GUARDIAN_BOOTSTRAP_SECRET"], "bs")
        XCTAssertEqual(env["CES_SERVICE_TOKEN"], "ct")
        XCTAssertEqual(env["MAX_PLATFORM_URL"], "https://custom.max.ai")
    }

    func testCredentialExecutorEnvRequiredKeys() {
        let env = MaxContainerEnv.credentialExecutor(cesServiceToken: nil)
        XCTAssertEqual(env["CES_MODE"], "managed")
        XCTAssertEqual(env["CES_BOOTSTRAP_SOCKET_DIR"], "/run/ces-bootstrap")
        XCTAssertEqual(env["CREDENTIAL_SECURITY_DIR"], "/ces-security")
    }

    func testCredentialExecutorEnvOptionalToken() {
        let env = MaxContainerEnv.credentialExecutor(cesServiceToken: "mytoken")
        XCTAssertEqual(env["CES_SERVICE_TOKEN"], "mytoken")
    }
}
