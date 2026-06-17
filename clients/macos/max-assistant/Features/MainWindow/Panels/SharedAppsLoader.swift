import Foundation
import MaxAssistantShared

@MainActor
enum SharedAppsLoader {

    static func load() async -> [SharedAppItem] {
        let response = await AppsClient().fetchSharedAppsList()
        return response?.apps ?? []
    }
}
