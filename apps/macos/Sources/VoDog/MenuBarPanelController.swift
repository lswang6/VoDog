import AppKit
import Combine
import OSLog
import SwiftUI

private let menuBarPanelLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "org.vodog.macos",
    category: "MenuBarPanel"
)

extension Animation {
    static let maVoPanelResizeDuration: Double = 0.18
    static let maVoPanelResize = Animation.smooth(duration: maVoPanelResizeDuration)
}

@MainActor
private final class MenuBarPanelLayout: ObservableObject {
    @Published var maximumHeight: CGFloat = 720
}

private final class MenuBarHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}

final class VoDogMenuPanel: NSPanel {
    var onCancel: (() -> Void)?
    weak var hostingView: NSView?
    var lastContentSize: NSSize?

    private var resizeLink: CADisplayLink?
    private var resizeTarget: NSSize?
    private var resizeFrom: NSSize = .zero
    private var resizeStart: CFTimeInterval = 0
    private var resizeOmega: Double = 0

    override var canBecomeKey: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }

    func applyContentSize(_ size: NSSize) {
        guard size.width > 0, size.height > 0 else { return }

        if let target = resizeTarget,
           resizeLink != nil,
           abs(target.width - size.width) < 0.5,
           abs(target.height - size.height) < 0.5 {
            return
        }

        guard abs(frame.width - size.width) > 0.5 || abs(frame.height - size.height) > 0.5 else {
            return
        }

        resizeLink?.invalidate()
        resizeLink = nil
        resizeTarget = nil

        if alphaValue == 0 || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            var newFrame = frame
            newFrame.size = size
            setFrame(newFrame, display: false)
            return
        }

        guard let displayView = contentView ?? hostingView else {
            var newFrame = frame
            newFrame.size = size
            setFrame(newFrame, display: false)
            return
        }

        resizeOmega = 2 * Double.pi / Animation.maVoPanelResizeDuration
        resizeFrom = frame.size
        resizeStart = CACurrentMediaTime()
        resizeTarget = size

        let link = displayView.displayLink(target: self, selector: #selector(resizeTick(_:)))
        link.add(to: .main, forMode: .common)
        resizeLink = link
    }

    @objc private func resizeTick(_ link: CADisplayLink) {
        guard let target = resizeTarget else {
            link.invalidate()
            resizeLink = nil
            return
        }

        let elapsed = CACurrentMediaTime() - resizeStart
        let decay = (1 + resizeOmega * elapsed) * exp(-resizeOmega * elapsed)
        var newFrame = frame

        if decay < 0.005 {
            link.invalidate()
            resizeLink = nil
            resizeTarget = nil
            newFrame.size = target
        } else {
            newFrame.size = NSSize(
                width: target.width + (resizeFrom.width - target.width) * decay,
                height: target.height + (resizeFrom.height - target.height) * decay
            )
        }

        setFrame(newFrame, display: false)
    }
}

@MainActor
final class MenuBarPanelController: NSObject, NSWindowDelegate {
    private let appState: AppState
    private let panelLayout = MenuBarPanelLayout()
    private var statusItem: NSStatusItem?
    private var panel: VoDogMenuPanel?
    private var isPanelWarmed = false
    private var isStarted = false
    private var localOutsideClickMonitor: Any?
    private var globalOutsideClickMonitor: Any?
    private var screenObserver: NSObjectProtocol?
    private var languageObserver: NSObjectProtocol?
    private var cancellables: Set<AnyCancellable> = []
    private var networkSpeedTimer: Timer?
    private var monitoredNetworkInterface: String?
    private var networkSpeedBaseline: NetworkInterfaceByteCounters?
    private var networkThroughput = NetworkThroughput.zero

    private var isPanelVisible: Bool {
        guard let panel else { return false }
        return panel.isVisible && panel.alphaValue > 0.01 && !panel.ignoresMouseEvents
    }

    init(appState: AppState) {
        self.appState = appState
        super.init()
    }

    func start() {
        guard !isStarted else { return }
        isStarted = true

        appState.$isMenuBarStatusItemVisible
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] isVisible in
                self?.setStatusItemVisible(isVisible)
            }
            .store(in: &cancellables)

        appState.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                DispatchQueue.main.async {
                    self?.refreshStatusItem()
                }
            }
            .store(in: &cancellables)

        appState.callHistory.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                DispatchQueue.main.async {
                    self?.refreshStatusItem()
                }
            }
            .store(in: &cancellables)

        localOutsideClickMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] event in
            guard let self, self.isPanelVisible else { return event }
            if self.eventBelongsToPanel(event) || self.eventTargetsStatusItem(event) {
                return event
            }
            self.closePanel()
            return event
        }

        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isPanelVisible, let panel = self.panel else { return }
                self.positionPanel(panel)
            }
        }

        languageObserver = NotificationCenter.default.addObserver(
            forName: .cellDockAppLanguageDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshStatusItem() }
        }
    }

    func stop() {
        if let localOutsideClickMonitor {
            NSEvent.removeMonitor(localOutsideClickMonitor)
        }
        if let globalOutsideClickMonitor {
            NSEvent.removeMonitor(globalOutsideClickMonitor)
        }
        if let screenObserver {
            NotificationCenter.default.removeObserver(screenObserver)
        }
        if let languageObserver {
            NotificationCenter.default.removeObserver(languageObserver)
        }
        localOutsideClickMonitor = nil
        globalOutsideClickMonitor = nil
        screenObserver = nil
        languageObserver = nil
        cancellables.removeAll()
        stopNetworkSpeedMonitoring()
        panel?.orderOut(nil)
        if let statusItem {
            NSStatusBar.system.removeStatusItem(statusItem)
        }
        statusItem = nil
    }

    private func setStatusItemVisible(_ isVisible: Bool) {
        if isVisible {
            if statusItem == nil {
                makeStatusItem()
            }
            refreshStatusItem()
            warmPanel()
        } else {
            stopNetworkSpeedMonitoring()
            closePanel()
            if let statusItem {
                NSStatusBar.system.removeStatusItem(statusItem)
                self.statusItem = nil
            }
        }
    }

    private func makeStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.target = self
        item.button?.action = #selector(togglePanel)
        item.button?.imagePosition = .imageOnly
        item.button?.imageScaling = .scaleProportionallyDown
        statusItem = item
        refreshStatusItem()
    }

    private func refreshStatusItem() {
        guard let button = statusItem?.button else { return }
        reconcileNetworkSpeedMonitoring()
        let statusModule = appState.menuBarStatusModule
        let statusModem = statusModule?.modem ?? ModemSnapshot()
        let displaysCellularData = appState.presentedCellularNetworkingEnabled &&
            statusModule?.id == appState.primaryDataModuleID
        let displaysNetworkSpeed = shouldDisplayNetworkSpeed
        statusItem?.length = displaysNetworkSpeed ? 68 : NSStatusItem.variableLength
        button.image = VoDogStatusItemRenderer.image(
            bars: statusModem.signalBars,
            modemState: statusModem.state,
            dataEnabled: displaysCellularData,
            callPhase: appState.call.phase,
            unreadMessageCount: appState.unreadCount,
            missedCallCount: appState.callHistory.unacknowledgedMissedCallCount,
            networkThroughput: displaysNetworkSpeed ? networkThroughput : nil
        )
        button.title = ""
        var description = statusDescription
        if displaysNetworkSpeed {
            description += "\n" + NetworkSpeedFormatter.detailedText(networkThroughput)
        }
        button.toolTip = description
        button.setAccessibilityLabel(description)
    }

    private var shouldDisplayNetworkSpeed: Bool {
        appState.showsMenuBarNetworkSpeed &&
            appState.presentedCellularNetworkingEnabled &&
            appState.menuBarStatusModule?.id == appState.primaryDataModuleID &&
            menuBarNetworkInterfaceName != nil
    }

    /// Read counters from the same module represented by the status item.
    /// `appState.network` is a compatibility/global snapshot and can briefly
    /// refer to the previous module while a multi-module selection changes.
    private var menuBarNetworkInterfaceName: String? {
        appState.menuBarStatusModule?.network.bsdName
    }

    private func reconcileNetworkSpeedMonitoring() {
        guard shouldDisplayNetworkSpeed,
              let interfaceName = menuBarNetworkInterfaceName else {
            stopNetworkSpeedMonitoring()
            return
        }
        guard networkSpeedTimer == nil ||
                monitoredNetworkInterface != interfaceName else {
            return
        }

        stopNetworkSpeedMonitoring()
        monitoredNetworkInterface = interfaceName
        networkSpeedBaseline = NetworkInterfaceCounterReader.read(
            interfaceName: interfaceName
        )
        networkThroughput = .zero

        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sampleNetworkSpeed() }
        }
        RunLoop.main.add(timer, forMode: .common)
        networkSpeedTimer = timer
    }

    private func sampleNetworkSpeed() {
        guard shouldDisplayNetworkSpeed,
              let interfaceName = monitoredNetworkInterface,
              interfaceName == menuBarNetworkInterfaceName else {
            stopNetworkSpeedMonitoring()
            refreshStatusItem()
            return
        }
        guard let current = NetworkInterfaceCounterReader.read(
            interfaceName: interfaceName
        ) else {
            networkSpeedBaseline = nil
            networkThroughput = .zero
            refreshStatusItem()
            return
        }

        if let previous = networkSpeedBaseline,
           let throughput = NetworkThroughputCalculator.rates(
               previous: previous,
               current: current
           ) {
            networkThroughput = throughput
        } else {
            networkThroughput = .zero
        }
        networkSpeedBaseline = current
        refreshStatusItem()
    }

    private func stopNetworkSpeedMonitoring() {
        networkSpeedTimer?.invalidate()
        networkSpeedTimer = nil
        monitoredNetworkInterface = nil
        networkSpeedBaseline = nil
        networkThroughput = .zero
    }

    private var statusDescription: String {
        if appState.call.phase == .incoming {
            return L10n.tr("来电：%@", presentedCallIdentity)
        }
        if appState.showsLocalCallUI {
            return L10n.tr("蜂窝通话：%@", presentedCallIdentity)
        }
        let missedCallCount = appState.callHistory.unacknowledgedMissedCallCount
        let unreadMessageCount = appState.unreadCount
        if missedCallCount > 0, unreadMessageCount > 0 {
            return L10n.tr(
                "%lld 个未接来电，%lld 条未读短信",
                Int64(missedCallCount),
                Int64(unreadMessageCount)
            )
        }
        if missedCallCount > 0 {
            return L10n.tr("%lld 个未接来电", Int64(missedCallCount))
        }
        if unreadMessageCount > 0 {
            return L10n.tr("%lld 条未读短信", Int64(unreadMessageCount))
        }
        let statusModem = appState.menuBarStatusModule?.modem ?? ModemSnapshot()
        switch statusModem.operationalState {
        case .absent:
            return L10n.tr("VoDog：模组未连接")
        case .enumerating:
            return L10n.tr("VoDog：USB 枚举中")
        case .initializing:
            return L10n.tr("VoDog：模组初始化中")
        case .configurationRequired:
            return L10n.tr("VoDog：模组需要配置")
        case .restarting:
            return L10n.tr("VoDog：模组正在重启")
        case .reconnecting:
            return L10n.tr("VoDog：模组正在重新连接")
        case .failed:
            return L10n.tr("VoDog：模组异常")
        case .ready:
            break
        }
        let dataStatus: String
        switch appState.cellularDataConnectionState {
        case .disabled: dataStatus = L10n.tr("蜂窝数据已关闭")
        case .waitingForModem: dataStatus = L10n.tr("蜂窝数据等待模组")
        case .starting: dataStatus = L10n.tr("蜂窝数据连接中")
        case .linkDown: dataStatus = L10n.tr("ECM 链路中断")
        case .interfaceReady: dataStatus = L10n.tr("ECM 接口已连接")
        case .available: dataStatus = L10n.tr("蜂窝数据可用")
        case .recovering: dataStatus = L10n.tr("蜂窝数据恢复中")
        case .failed: dataStatus = L10n.tr("蜂窝数据异常")
        }
        if let signal = statusModem.signalDBm {
            return "\(statusModem.operatorName ?? L10n.tr("蜂窝网络")) · \(signal) dBm · \(dataStatus)"
        }
        return L10n.tr("VoDog：模块已连接 · %@", dataStatus)
    }

    private var presentedCallIdentity: String {
        let number = appState.call.number
        return CommunicationUI.displayText(number.flatMap {
                SystemContactStore.shared.displayName(for: $0)
            }, number)
    }

    private func warmPanel() {
        let panel = self.panel ?? makePanel()
        self.panel = panel
        guard !isPanelWarmed else { return }
        isPanelWarmed = true

        let rootView = MenuBarPanelRootView(
            appState: appState,
            layout: panelLayout,
            onDismiss: { [weak self] in self?.closePanel() },
            onSizeChange: { [weak self, weak panel] size in
                guard let self, let panel else { return }
                self.applyContentSize(size, to: panel)
            }
        )
        .cellDockLanguageEnvironment()
        let hostingView = MenuBarHostingView(rootView: rootView)
        hostingView.layoutSubtreeIfNeeded()
        let size = hostingView.fittingSize
        let container = NSView(frame: NSRect(origin: .zero, size: size))
        container.wantsLayer = true
        container.layer?.cornerRadius = 16
        container.layer?.cornerCurve = .continuous
        container.layer?.masksToBounds = true

        let backdrop: NSView
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView(frame: container.bounds)
            glass.cornerRadius = 16
            backdrop = glass
        } else {
            let material = NSVisualEffectView(frame: container.bounds)
            material.material = .popover
            material.state = .active
            material.wantsLayer = true
            material.layer?.cornerRadius = 16
            material.layer?.cornerCurve = .continuous
            material.layer?.masksToBounds = true
            backdrop = material
        }
        backdrop.autoresizingMask = [.width, .height]
        container.addSubview(backdrop)

        hostingView.frame = container.bounds
        hostingView.autoresizingMask = [.width, .height]
        container.addSubview(hostingView)

        panel.hostingView = hostingView
        panel.lastContentSize = size
        panel.setFrame(
            NSRect(origin: NSPoint(x: 0, y: -4_000), size: size),
            display: false
        )
        panel.contentView = container
        panel.layoutIfNeeded()
        panel.alphaValue = 0
        panel.ignoresMouseEvents = true
    }

    @objc private func togglePanel() {
        isPanelVisible ? closePanel() : showPanel()
    }

    private func showPanel() {
        warmPanel()
        guard let panel else { return }
        positionPanel(panel)
        panel.alphaValue = 1
        panel.ignoresMouseEvents = false
        panel.orderFrontRegardless()
        panel.makeFirstResponder(nil)
        statusItem?.button?.highlight(true)
        menuBarPanelLogger.info("Menu bar panel shown")

        DispatchQueue.main.async { [weak self, weak panel] in
            guard let self, let panel, self.isPanelVisible else { return }
            NSApplication.shared.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
            panel.makeFirstResponder(nil)

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak panel] in
                guard let self, let panel, self.isPanelVisible else { return }
                if !NSApplication.shared.isActive || !panel.isKeyWindow {
                    NSApplication.shared.activate(ignoringOtherApps: true)
                    panel.makeKeyAndOrderFront(nil)
                    panel.makeFirstResponder(nil)
                }
                menuBarPanelLogger.info(
                    "Menu bar panel focus settled: active=\(NSApplication.shared.isActive), key=\(panel.isKeyWindow)"
                )
            }
        }

        if globalOutsideClickMonitor == nil {
            globalOutsideClickMonitor = NSEvent.addGlobalMonitorForEvents(
                matching: [.leftMouseDown, .rightMouseDown]
            ) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.isPanelVisible, let panel = self.panel else { return }
                    if panel.frame.contains(NSEvent.mouseLocation) { return }
                    self.closePanel()
                }
            }
        }
    }

    private func closePanel() {
        guard let panel else { return }
        let wasVisible = isPanelVisible
        statusItem?.button?.highlight(false)
        panel.ignoresMouseEvents = true
        panel.alphaValue = 0
        panel.orderOut(nil)
        if wasVisible {
            menuBarPanelLogger.info("Menu bar panel hidden")
        }
        if let globalOutsideClickMonitor {
            NSEvent.removeMonitor(globalOutsideClickMonitor)
            self.globalOutsideClickMonitor = nil
        }
    }

    private func eventTargetsStatusItem(_ event: NSEvent) -> Bool {
        guard let button = statusItem?.button,
              event.window === button.window else {
            return false
        }
        let location = button.convert(event.locationInWindow, from: nil)
        return button.bounds.contains(location)
    }

    private func eventBelongsToPanel(_ event: NSEvent) -> Bool {
        guard let panel, let eventWindow = event.window else { return false }
        if eventWindow === panel || eventWindow.sheetParent === panel {
            return true
        }
        if panel.attachedSheet === eventWindow {
            return true
        }
        return panel.childWindows?.contains { $0 === eventWindow } == true
    }

    private func positionPanel(_ panel: VoDogMenuPanel) {
        let requestedSize = panel.lastContentSize ?? panel.frame.size
        guard let placement = panelPlacement(for: requestedSize) else { return }
        panel.setFrame(
            NSRect(
                x: placement.anchorX - placement.size.width / 2,
                y: placement.topY - placement.size.height,
                width: placement.size.width,
                height: placement.size.height
            ),
            display: false
        )
    }

    private func applyContentSize(_ size: NSSize, to panel: VoDogMenuPanel) {
        guard size.width > 0, size.height > 0 else { return }
        let targetSize = limitedPanelSize(size, on: panel)
        panel.lastContentSize = targetSize
        if panel.isVisible {
            var frame = panel.frame
            frame.origin.x += (frame.width - targetSize.width) / 2
            frame.origin.y += frame.height - targetSize.height
            frame.size = targetSize
            panel.setFrame(frame, display: false)
        }
        panel.applyContentSize(targetSize)
    }

    private func limitedPanelSize(_ requestedSize: NSSize, on panel: NSWindow) -> NSSize {
        guard let screen = panel.screen ?? NSScreen.main else { return requestedSize }
        let visibleFrame = screen.visibleFrame
        return NSSize(
            width: min(max(requestedSize.width, 1), max(1, visibleFrame.width - 16)),
            height: min(max(requestedSize.height, 1), max(1, panelLayout.maximumHeight))
        )
    }

    private func panelPlacement(for requestedSize: NSSize) -> MenuBarPanelPlacement? {
        guard let button = statusItem?.button,
              let buttonWindow = button.window else { return nil }

        let buttonRectInWindow = button.convert(button.bounds, to: nil)
        let convertedButtonFrame = buttonWindow.convertToScreen(buttonRectInWindow)
        let buttonFrame = convertedButtonFrame.width > 0 && convertedButtonFrame.height > 0
            ? convertedButtonFrame
            : buttonWindow.frame
        let buttonCenter = NSPoint(x: buttonFrame.midX, y: buttonFrame.midY)
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(buttonCenter) })
                ?? buttonWindow.screen
                ?? NSScreen.main else { return nil }

        let visibleFrame = screen.visibleFrame
        let topY = max(
            visibleFrame.minY + 9,
            min(buttonFrame.minY - 4, visibleFrame.maxY - 4)
        )
        let availableHeight = max(1, topY - visibleFrame.minY - 8)
        let maximumHeight = min(720, availableHeight)
        if abs(panelLayout.maximumHeight - maximumHeight) > 0.5 {
            panelLayout.maximumHeight = maximumHeight
        }

        let maximumWidth = max(1, visibleFrame.width - 16)
        let size = NSSize(
            width: min(max(requestedSize.width, 1), maximumWidth),
            height: min(max(requestedSize.height, 1), maximumHeight)
        )
        return MenuBarPanelPlacement(
            anchorX: buttonFrame.midX,
            topY: topY,
            visibleFrame: visibleFrame,
            size: size
        )
    }

    private func makePanel() -> VoDogMenuPanel {
        let panel = VoDogMenuPanel(
            contentRect: .zero,
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.level = .popUpMenu
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isMovable = true
        panel.isMovableByWindowBackground = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.animationBehavior = .none
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.transient, .ignoresCycle]
        panel.delegate = self
        panel.onCancel = { [weak self] in self?.closePanel() }
        return panel
    }
}

private struct MenuBarPanelPlacement {
    let anchorX: CGFloat
    let topY: CGFloat
    let visibleFrame: NSRect
    let size: NSSize
}

private struct MenuBarPanelRootView: View {
    let appState: AppState
    @ObservedObject var layout: MenuBarPanelLayout
    let onDismiss: () -> Void
    let onSizeChange: (CGSize) -> Void

    var body: some View {
        VStack(spacing: 0) {
            MenuBarHubView(
                maximumHeight: layout.maximumHeight,
                onDismiss: onDismiss
            )
                .environmentObject(appState)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .onGeometryChange(for: CGSize.self) { proxy in
                    proxy.size
                } action: { size in
                    onSizeChange(size)
                }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

private enum VoDogStatusItemRenderer {
    static func image(
        bars: Int,
        modemState: ModemConnectionState,
        dataEnabled: Bool,
        callPhase: CallPhase,
        unreadMessageCount: Int,
        missedCallCount: Int,
        networkThroughput: NetworkThroughput?
    ) -> NSImage {
        let statusImage: NSImage
        if let callIconName = callIconName(for: callPhase),
           let callImage = configuredSymbol(
               named: callIconName,
               fallback: callPhase == .dialing || callPhase == .alerting
                   ? "phone.arrow.up.right.fill"
                   : nil,
               accessibilityDescription: L10n.tr("蜂窝通话")
           ) {
            callImage.isTemplate = true
            statusImage = callImage
        } else if let notificationImage = notificationImage(
            unreadMessageCount: unreadMessageCount,
            missedCallCount: missedCallCount
        ) {
            statusImage = notificationImage
        } else {
            statusImage = signalImage(
                bars: bars,
                state: modemState,
                dataEnabled: dataEnabled
            )
        }

        guard let networkThroughput else { return statusImage }
        return networkSpeedImage(
            statusImage: statusImage,
            throughput: networkThroughput
        )
    }

    private static func networkSpeedImage(
        statusImage: NSImage,
        throughput: NetworkThroughput
    ) -> NSImage {
        // Keep only the native status-button inset. The previous 80 pt canvas
        // plus 86 pt item left visibly oversized gutters around 65 pt of actual
        // content.
        let image = NSImage(size: NSSize(width: 64, height: 20), flipped: false) { _ in
            let iconBounds = NSRect(x: 0, y: 1, width: 20, height: 18)
            statusImage.draw(
                in: aspectFitRect(for: statusImage.size, in: iconBounds),
                from: .zero,
                operation: .sourceOver,
                fraction: 1
            )

            let lines = NetworkSpeedFormatter.menuBarLines(throughput)
            let paragraph = NSMutableParagraphStyle()
            // A fixed-width item avoids the neighboring menu icons jumping as
            // the number of digits changes. Right alignment puts that reserved
            // width between the icon and short values instead of exposing it as
            // an oversized trailing gutter.
            paragraph.alignment = .right
            paragraph.lineBreakMode = .byClipping
            let attributes: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(
                    ofSize: 8,
                    weight: .medium
                ),
                .foregroundColor: NSColor.black,
                .paragraphStyle: paragraph
            ]
            (lines.download as NSString).draw(
                in: NSRect(x: 23, y: 10, width: 41, height: 10),
                withAttributes: attributes
            )
            (lines.upload as NSString).draw(
                in: NSRect(x: 23, y: 0, width: 41, height: 10),
                withAttributes: attributes
            )
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func callIconName(for phase: CallPhase) -> String? {
        switch phase {
        case .incoming:
            return "phone.arrow.down.left.fill"
        case .dialing, .alerting:
            return "phone.down.waves.left.and.right"
        case .active, .ending, .recovering:
            return "phone.fill"
        case .unavailable, .idle, .error:
            return nil
        }
    }

    private static func notificationImage(
        unreadMessageCount: Int,
        missedCallCount: Int
    ) -> NSImage? {
        var symbols: [(name: String, fallback: String?, description: String)] = []
        if missedCallCount > 0 {
            symbols.append((
                "phone.arrow.down.left.fill",
                nil,
                L10n.tr("未接来电")
            ))
        }
        if unreadMessageCount > 0 {
            symbols.append((
                "message.badge.fill",
                "message.fill",
                L10n.tr("未读短信")
            ))
        }
        guard !symbols.isEmpty else { return nil }

        if symbols.count == 1,
           let symbol = configuredSymbol(
               named: symbols[0].name,
               fallback: symbols[0].fallback,
               accessibilityDescription: symbols[0].description
           ) {
            symbol.isTemplate = true
            return symbol
        }

        let image = NSImage(size: NSSize(width: 36, height: 18), flipped: false) { _ in
            for (index, symbol) in symbols.prefix(2).enumerated() {
                guard let source = configuredSymbol(
                    named: symbol.name,
                    fallback: symbol.fallback,
                    accessibilityDescription: symbol.description
                ) else { continue }
                let bounds = NSRect(
                    x: CGFloat(index) * 19,
                    y: 1,
                    width: 17,
                    height: 16
                )
                source.draw(
                    in: aspectFitRect(for: source.size, in: bounds),
                    from: .zero,
                    operation: .sourceOver,
                    fraction: 1
                )
            }
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func configuredSymbol(
        named name: String,
        fallback: String?,
        accessibilityDescription: String
    ) -> NSImage? {
        let configuration = NSImage.SymbolConfiguration(pointSize: 14, weight: .medium)
        let source = NSImage(
            systemSymbolName: name,
            accessibilityDescription: accessibilityDescription
        ) ?? fallback.flatMap {
            NSImage(
                systemSymbolName: $0,
                accessibilityDescription: accessibilityDescription
            )
        }
        return source?.withSymbolConfiguration(configuration)
    }

    private static func signalImage(
        bars: Int,
        state: ModemConnectionState,
        dataEnabled: Bool
    ) -> NSImage {
        let image = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
            if state == .disconnected {
                drawDisconnectedIcon()
            } else {
                drawSignalBars(bars: bars, state: state)
                switch state {
                case .connected where dataEnabled:
                    drawDataIndicator()
                case .connecting:
                    drawConnectingIndicator()
                case .error:
                    drawErrorIndicator()
                case .connected, .disconnected:
                    break
                }
            }
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func drawSignalBars(
        bars: Int,
        state: ModemConnectionState
    ) {
        let activeBars = min(max(bars, 0), 4)
        let connectingOpacities: [CGFloat] = [0.22, 0.38, 0.60, 0.88]
        let heights: [CGFloat] = [4, 7, 10, 13]
        let barWidth: CGFloat = 2.6
        let spacing: CGFloat = 1.45

        for index in 0 ..< 4 {
            let opacity: CGFloat
            switch state {
            case .connected:
                opacity = index < activeBars ? 1 : 0.18
            case .connecting:
                opacity = connectingOpacities[index]
            case .error, .disconnected:
                opacity = 0.18
            }

            NSColor(calibratedWhite: 0, alpha: opacity).setFill()
            NSBezierPath(
                roundedRect: NSRect(
                    x: 1.2 + CGFloat(index) * (barWidth + spacing),
                    y: 2.25,
                    width: barWidth,
                    height: heights[index]
                ),
                xRadius: barWidth / 2,
                yRadius: barWidth / 2
            ).fill()
        }
    }

    private static func drawDisconnectedIcon() {
        NSGraphicsContext.saveGraphicsState()
        let transform = NSAffineTransform()
        transform.translateX(by: 2, yBy: 1)
        transform.concat()

        let port = NSBezierPath()
        port.windingRule = .evenOdd
        port.appendRoundedRect(
            NSRect(x: 0, y: 5, width: 16, height: 6),
            xRadius: 3,
            yRadius: 3
        )
        port.appendRoundedRect(
            NSRect(x: 1, y: 6, width: 14, height: 4),
            xRadius: 2,
            yRadius: 2
        )
        NSColor.black.setFill()
        port.fill()

        NSBezierPath(
            roundedRect: NSRect(x: 3.5, y: 7.5, width: 9, height: 1),
            xRadius: 0.5,
            yRadius: 0.5
        ).fill()

        let slash = NSBezierPath()
        slash.lineCapStyle = .round
        slash.move(to: NSPoint(x: 2.2, y: 13.8))
        slash.line(to: NSPoint(x: 13.8, y: 2.2))

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current?.compositingOperation = .clear
        slash.lineWidth = 2.1
        slash.stroke()
        NSGraphicsContext.restoreGraphicsState()

        NSColor.black.setStroke()
        slash.lineWidth = 1.15
        slash.stroke()
        NSGraphicsContext.restoreGraphicsState()
    }

    private static func aspectFitRect(for sourceSize: NSSize, in bounds: NSRect) -> NSRect {
        guard sourceSize.width > 0, sourceSize.height > 0 else { return bounds }
        let scale = min(bounds.width / sourceSize.width, bounds.height / sourceSize.height)
        let size = NSSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
        return NSRect(
            x: bounds.midX - size.width / 2,
            y: bounds.midY - size.height / 2,
            width: size.width,
            height: size.height
        )
    }

    private static func drawDataIndicator() {
        NSColor.black.setFill()
        NSBezierPath(
            ovalIn: NSRect(x: 17.1, y: 13.2, width: 2.35, height: 2.35)
        ).fill()
    }

    private static func drawConnectingIndicator() {
        NSColor(calibratedWhite: 0, alpha: 0.70).setFill()
        NSBezierPath(
            ovalIn: NSRect(x: 17.15, y: 2.4, width: 1.8, height: 1.8)
        ).fill()
    }

    private static func drawErrorIndicator() {
        NSColor.black.setFill()
        NSBezierPath(
            roundedRect: NSRect(x: 17.25, y: 8.4, width: 1.8, height: 6),
            xRadius: 0.9,
            yRadius: 0.9
        ).fill()
        NSBezierPath(
            ovalIn: NSRect(x: 17.25, y: 5.4, width: 1.8, height: 1.8)
        ).fill()
    }
}
