import AppKit
import Foundation
import UserNotifications

enum AppNotificationAuthorizationStatus: Equatable {
    case unknown
    case notDetermined
    case denied
    case authorized
}

final class NotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationService()

    private let center = UNUserNotificationCenter.current()
    private var onAnswerCall: (() -> Void)?
    private var onRejectCall: (() -> Void)?
    private var onOpenCallWindow: (() -> Void)?
    private var onOpenMissedCall: ((UUID) -> Void)?
    private var onOpenMessage: ((String) -> Void)?

    private override init() {
        super.init()
        center.delegate = self
        registerCategories()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(registerCategories),
            name: .cellDockAppLanguageDidChange,
            object: nil
        )
    }

    func configure(
        onAnswerCall: @escaping () -> Void,
        onRejectCall: @escaping () -> Void,
        onOpenCallWindow: @escaping () -> Void,
        onOpenMissedCall: @escaping (UUID) -> Void,
        onOpenMessage: @escaping (String) -> Void
    ) {
        self.onAnswerCall = onAnswerCall
        self.onRejectCall = onRejectCall
        self.onOpenCallWindow = onOpenCallWindow
        self.onOpenMissedCall = onOpenMissedCall
        self.onOpenMessage = onOpenMessage
    }

    func authorizationStatus(
        completion: @escaping (AppNotificationAuthorizationStatus) -> Void
    ) {
        center.getNotificationSettings { settings in
            let status = Self.authorizationStatus(from: settings.authorizationStatus)
            DispatchQueue.main.async { completion(status) }
        }
    }

    func requestAuthorization(
        completion: @escaping (AppNotificationAuthorizationStatus, String?) -> Void
    ) {
        center.requestAuthorization(options: [.alert, .badge, .sound]) { [weak self] _, error in
            guard let self else { return }
            self.center.getNotificationSettings { settings in
                let status = Self.authorizationStatus(from: settings.authorizationStatus)
                DispatchQueue.main.async {
                    completion(status, error?.localizedDescription)
                }
            }
        }
    }

    func openSystemSettings() {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=org.vodog.macos"
        ) else { return }
        NSWorkspace.shared.open(url)
    }

    private static func authorizationStatus(
        from status: UNAuthorizationStatus
    ) -> AppNotificationAuthorizationStatus {
        switch status {
        case .notDetermined:
            return .notDetermined
        case .denied:
            return .denied
        case .authorized, .provisional, .ephemeral:
            return .authorized
        @unknown default:
            return .unknown
        }
    }

    func postNewMessage(
        _ message: SMSMessage,
        displayName: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = displayName ?? message.sender
        content.subtitle = L10n.tr("收到新短信")
        content.body = message.preview
        // VoDog plays the selected alert itself so MP3 and user-imported
        // audio work consistently without duplicating the notification sound.
        content.sound = nil
        content.userInfo = ["messageID": message.id]
        content.categoryIdentifier = AppNotificationIdentifier.messageCategory
        content.threadIdentifier = "org.vodog.messages"
        content.interruptionLevel = .active

        let request = UNNotificationRequest(
            identifier: "sms-\(message.id)",
            content: content,
            trigger: nil
        )
        center.add(request)
    }

    func postIncomingCall(
        number: String?,
        displayName: String? = nil,
        subtitle: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = displayName ?? number ?? L10n.tr("未知号码")
        content.subtitle = subtitle ?? L10n.tr("蜂窝来电")
        content.body = L10n.tr("可直接接听或拒接，也可以打开 VoDog 查看。")
        // The looping ringtone is owned by AlertSoundService and is stopped as
        // soon as the call leaves the incoming state.
        content.sound = nil
        content.categoryIdentifier = AppNotificationIdentifier.incomingCallCategory
        content.threadIdentifier = "org.vodog.calls"
        content.interruptionLevel = .timeSensitive
        center.add(UNNotificationRequest(
            identifier: "call-incoming",
            content: content,
            trigger: nil
        ))
    }

    func clearIncomingCall() {
        center.removeDeliveredNotifications(withIdentifiers: ["call-incoming"])
        center.removePendingNotificationRequests(withIdentifiers: ["call-incoming"])
    }

    func postMissedCall(
        _ record: CallHistoryRecord,
        displayName: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = displayName ?? record.number
        content.subtitle = L10n.tr("未接来电")
        content.body = L10n.tr("点击查看最近通话。")
        content.sound = .default
        content.categoryIdentifier = AppNotificationIdentifier.missedCallCategory
        content.threadIdentifier = "org.vodog.calls"
        content.interruptionLevel = .active
        content.userInfo = ["callRecordID": record.id.uuidString]
        center.add(UNNotificationRequest(
            identifier: "call-missed-\(record.id.uuidString)",
            content: content,
            trigger: nil
        ))
    }

    @objc private func registerCategories() {
        let answer = UNNotificationAction(
            identifier: AppNotificationIdentifier.answerCallAction,
            title: L10n.tr("接听"),
            options: [.foreground]
        )
        let reject = UNNotificationAction(
            identifier: AppNotificationIdentifier.rejectCallAction,
            title: L10n.tr("拒接"),
            options: [.destructive]
        )
        let incomingCall = UNNotificationCategory(
            identifier: AppNotificationIdentifier.incomingCallCategory,
            actions: [answer, reject],
            intentIdentifiers: [],
            options: []
        )
        let openMissedCall = UNNotificationAction(
            identifier: AppNotificationIdentifier.openCallWindowAction,
            title: L10n.tr("查看未接来电"),
            options: [.foreground]
        )
        let missedCall = UNNotificationCategory(
            identifier: AppNotificationIdentifier.missedCallCategory,
            actions: [openMissedCall],
            intentIdentifiers: [],
            options: []
        )
        let openMessage = UNNotificationAction(
            identifier: AppNotificationIdentifier.openMessageAction,
            title: L10n.tr("查看短信"),
            options: [.foreground]
        )
        let message = UNNotificationCategory(
            identifier: AppNotificationIdentifier.messageCategory,
            actions: [openMessage],
            intentIdentifiers: [],
            options: []
        )
        center.setNotificationCategories([incomingCall, missedCall, message])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let content = response.notification.request.content
        let route = AppNotificationRouter.route(
            actionIdentifier: response.actionIdentifier,
            categoryIdentifier: content.categoryIdentifier,
            messageID: content.userInfo["messageID"] as? String,
            callRecordID: content.userInfo["callRecordID"] as? String,
            defaultActionIdentifier: UNNotificationDefaultActionIdentifier,
            dismissActionIdentifier: UNNotificationDismissActionIdentifier
        )
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            switch route {
            case .answerCall:
                self.onAnswerCall?()
            case .rejectCall:
                self.onRejectCall?()
            case .openCallWindow:
                self.onOpenCallWindow?()
            case let .openMissedCall(callRecordID):
                if let id = UUID(uuidString: callRecordID) {
                    self.onOpenMissedCall?(id)
                } else {
                    self.onOpenCallWindow?()
                }
            case let .openMessage(messageID):
                self.onOpenMessage?(messageID)
            case .ignore:
                break
            }
        }
        completionHandler()
    }
}
