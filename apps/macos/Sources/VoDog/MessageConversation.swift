import Foundation

struct MessageConversation: Identifiable, Equatable {
    let id: String
    let address: String
    let moduleID: CellularModuleID?
    let messages: [SMSMessage]

    var latestMessage: SMSMessage? {
        messages.last
    }

    var unreadCount: Int {
        messages.lazy.filter { !$0.isOutgoing && !$0.isRead }.count
    }

    var hasUnread: Bool {
        unreadCount > 0
    }

    static func conversationID(
        for address: String,
        moduleID: CellularModuleID? = nil
    ) -> String {
        let addressID = PhoneNumberNormalizer.conversationID(for: address)
        return moduleID.map { "\($0.rawValue)|\(addressID)" } ?? addressID
    }

    static func grouped(from messages: [SMSMessage]) -> [MessageConversation] {
        Dictionary(grouping: messages) { message in
            conversationID(for: message.peerAddress, moduleID: message.moduleID)
        }
        .compactMap { id, groupedMessages in
            let sortedMessages = groupedMessages.sorted { lhs, rhs in
                if lhs.timestamp != rhs.timestamp {
                    return lhs.timestamp < rhs.timestamp
                }
                return lhs.id < rhs.id
            }
            guard let latestMessage = sortedMessages.last else { return nil }
            return MessageConversation(
                id: id,
                address: latestMessage.peerAddress,
                moduleID: latestMessage.moduleID,
                messages: sortedMessages
            )
        }
        .sorted { lhs, rhs in
            let lhsDate = lhs.latestMessage?.timestamp ?? .distantPast
            let rhsDate = rhs.latestMessage?.timestamp ?? .distantPast
            if lhsDate != rhsDate {
                return lhsDate > rhsDate
            }
            return lhs.id < rhs.id
        }
    }
}
