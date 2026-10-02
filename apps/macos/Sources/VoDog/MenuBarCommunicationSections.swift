import SwiftUI

/// Menu bar panel lists: an incoming call when ringing, then the latest 2 conversations and 2 calls.
struct MenuBarCommunicationSections: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var contacts = SystemContactStore.shared
    @ObservedObject var history: CallHistoryStore

    let onOpenMessage: (SMSMessage) -> Void
    let onOpenMissedCall: (CallHistoryRecord) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if appState.call.phase == .incoming {
                CompactCallContent()
                    .signalCard(cornerRadius: 12, padding: 10)
            }

            if !conversations.isEmpty {
                section(L10n.tr("短信")) {
                    ForEach(conversations) { conversationRow($0) }
                }
            }

            if !calls.isEmpty {
                section(L10n.tr("通话")) {
                    ForEach(calls) { callRow($0) }
                }
            }
        }
        .animation(.smooth(duration: 0.18), value: conversations.map(\.id))
    }

    private var conversations: [MessageConversation] {
        Array(MessageConversation.grouped(from: appState.messages).prefix(2))
    }

    private var calls: [CallHistoryRecord] {
        Array(history.records.prefix(2))
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: title)
                .font(.caption.weight(.bold))
                .foregroundStyle(Signal.ink3)
                .padding(.horizontal, 4)
            content()
        }
    }

    @ViewBuilder
    private func conversationRow(_ conversation: MessageConversation) -> some View {
        if let message = conversation.latestMessage {
            let name = displayName(for: conversation.address)
            let unread = conversation.unreadCount > 0
            Button {
                appState.markRead(conversation.messages.filter { !$0.isOutgoing && !$0.isRead })
                onOpenMessage(message)
            } label: {
                row(
                    leading: MessageConversationAvatar(title: name, address: conversation.address, size: 28),
                    title: name,
                    titleColor: Signal.ink,
                    detail: message.preview,
                    date: message.timestamp,
                    emphasized: unread
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel(unread
                ? L10n.tr("%lld 条未读短信，来自%@，%@", Int64(conversation.unreadCount), name, message.preview)
                : "\(name)，\(message.preview)")
        }
    }

    private func callRow(_ record: CallHistoryRecord) -> some View {
        let name = displayName(for: record.number)
        let missed = record.isMissed
        return Button {
            onOpenMissedCall(record)
        } label: {
            row(
                leading: Image(systemName: record.direction == .incoming ? "arrow.down.left" : "arrow.up.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(missed ? Signal.danger : record.direction == .incoming ? Signal.ink2 : Signal.brand)
                    .frame(width: 28, height: 28),
                title: name,
                titleColor: missed ? Signal.danger : Signal.ink,
                detail: missed ? L10n.tr("未接来电") : record.direction == .incoming ? L10n.tr("来电") : L10n.tr("去电"),
                date: record.startedAt,
                emphasized: record.isUnacknowledgedMissed
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(missed
            ? L10n.tr("未接来电，来自%@，%@", name, record.startedAt.formatted(date: .abbreviated, time: .shortened))
            : name)
    }

    private func row<Leading: View>(
        leading: Leading,
        title: String,
        titleColor: Color,
        detail: String,
        date: Date,
        emphasized: Bool
    ) -> some View {
        HStack(spacing: 10) {
            leading
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: title)
                    .font(.callout.weight(emphasized ? .bold : .semibold))
                    .foregroundStyle(titleColor)
                    .lineLimit(1)
                Text(verbatim: detail)
                    .font(.caption)
                    .foregroundStyle(Signal.ink3)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            Text(verbatim: CommunicationUI.listTimestamp(date))
                .font(.caption.monospacedDigit())
                .foregroundStyle(Signal.ink3)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
    }

    private func displayName(for number: String) -> String {
        CommunicationUI.displayText(contacts.displayName(for: number), number)
    }
}
