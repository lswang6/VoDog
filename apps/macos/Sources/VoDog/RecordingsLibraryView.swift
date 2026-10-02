import AppKit
import SwiftUI

struct RecordingsLibraryView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var recordings: CallRecordingStore
    @ObservedObject var contacts: SystemContactStore
    @Binding var selectedRecordingID: CallRecordingRecord.ID?
    @Binding var sidebarWidth: CGFloat
    var focusFirstItemRequest = false
    var didHandleFocusFirstItemRequest: () -> Void = {}

    @State private var searchText = ""
    @State private var directionFilter = 0
    @State private var deletingRecording: CallRecordingRecord?
    @State private var isRenaming = false
    @State private var renameText = ""
    @State private var waveform: CallRecordingWaveformData?
    @State private var waveformError: String?
    @State private var loadingWaveformID: CallRecordingRecord.ID?
    @FocusState private var listFocused: Bool

    var body: some View {
        ResizableCommunicationSplit(sidebarWidth: $sidebarWidth) {
            recordingList
        } detail: {
            detail
                .frame(minWidth: 390, maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear {
            selectFirstRecordingIfNeeded()
            loadSelectedWaveform()
            handleFocusFirstItemRequest()
        }
        .onChange(of: focusFirstItemRequest) { _, requested in
            if requested { handleFocusFirstItemRequest() }
        }
        .onChange(of: recordings.records.map(\.id)) { _, _ in
            selectFirstRecordingIfNeeded()
        }
        .onChange(of: selectedRecordingID) { _, _ in
            renameText = selectedRecording?.title ?? ""
            loadSelectedWaveform()
        }
        .confirmationDialog(
            "删除这段通话录音？",
            isPresented: Binding(
                get: { deletingRecording != nil },
                set: { if !$0 { deletingRecording = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("删除录音", role: .destructive) { deleteSelectedRecording() }
            Button("取消", role: .cancel) { deletingRecording = nil }
        } message: {
            Text("音频文件将从这台 Mac 永久删除；最近通话记录仍会保留。")
        }
        .alert("重命名录音", isPresented: $isRenaming) {
            TextField("录音名称", text: $renameText)
            Button("取消", role: .cancel) {}
            Button("保存") { saveRename() }
        } message: {
            Text("留空将恢复显示联系人或电话号码。")
        }
    }

    private var recordingList: some View {
        VStack(spacing: 0) {
            TextField("搜索录音、联系人或号码", text: $searchText)
                .communicationSearchField()
                .padding(.horizontal, 14)
                .padding(.bottom, 10)

            CommunicationGlassTabs(
                items: [(0, "全部"), (1, "呼入"), (2, "呼出")],
                selection: $directionFilter
            )
            .padding(.horizontal, 14)
            .padding(.bottom, 10)

            List(filteredRecordingRecords) { record in
                recordingRow(record)
                    .communicationSelectionHighlight(selectedRecordingID == record.id)
                    .contentShape(Rectangle())
                    .onTapGesture { selectedRecordingID = record.id }
                    .accessibilityAddTraits(selectedRecordingID == record.id ? .isSelected : [])
                    .tag(record.id)
                    .contextMenu {
                        Button("播放或暂停", systemImage: "playpause") {
                            recordings.play(record)
                        }
                        Button("导出…", systemImage: "square.and.arrow.up") {
                            recordings.export(record)
                        }
                        Button("在访达中显示", systemImage: "folder") {
                            recordings.reveal(record)
                        }
                        Divider()
                        Button("删除", systemImage: "trash", role: .destructive) {
                            deletingRecording = record
                        }
                    }
            }
            .listStyle(.sidebar)
            .communicationEmphasizedSelection()
            .communicationInitialListFocus($listFocused)
            .scrollContentBackground(.hidden)
            .communicationSidebarScrollEdgeEffect()
        }
        .communicationSidebarColumnStyle()
    }

    private func recordingRow(_ record: CallRecordingRecord) -> some View {
        HStack(spacing: 11) {
            RecordingDirectionBadge(
                direction: record.direction,
                size: 38,
                iconSize: 16
            )

            VStack(alignment: .leading, spacing: 3) {
                Text(displayName(for: record))
                    .font(.callout.weight(.medium))
                    .lineLimit(1)

                HStack(spacing: 5) {
                    if recordings.playingRecordingID == record.id {
                        Image(systemName: recordings.isPlaybackPlaying ? "waveform" : "play.fill")
                            .font(.caption2.weight(.semibold))
                            .selectionTint(Signal.brand)
                    }

                    Text(recordingDuration(record.duration))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 6)

            VStack(alignment: .trailing, spacing: 4) {
                Text(CommunicationUI.listTimestamp(record.startedAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: true, vertical: false)
                if record.isIncomplete {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .selectionTint(Signal.warn)
                        .help(L10n.tr("录音过程中部分音频未能写入"))
                }
            }
        }
        .padding(.vertical, 5)
    }

    @ViewBuilder
    private var detail: some View {
        if let record = selectedRecording {
            RecordingDetailPane(
                record: record,
                displayName: displayName(for: record),
                waveform: waveform,
                waveformError: waveformError,
                recordings: recordings,
                onCall: { appState.showPhoneWindow(number: record.number) },
                onMessage: { appState.showMessagesWindow(destination: record.number) },
                onRename: beginRename,
                onExport: { recordings.export(record) },
                onReveal: { recordings.reveal(record) },
                onDelete: { deletingRecording = record }
            )
        } else {
            PhoneEmptyState(
                title: recordings.records.isEmpty ? L10n.tr("暂无通话录音") : L10n.tr("选择一段录音"),
                detail: recordings.records.isEmpty
                    ? L10n.tr("在通话中手动开始录音，结束后会保存在此 Mac。")
                    : L10n.tr("可播放、定位、重命名、导出或删除通话录音。"),
                systemImage: "waveform"
            )
        }
    }

    private var filteredRecordingRecords: [CallRecordingRecord] {
        let directional = recordings.records.filter { record in
            directionFilter == 0 ||
                (directionFilter == 1 && record.direction == .incoming) ||
                (directionFilter == 2 && record.direction == .outgoing)
        }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return directional }
        return directional.filter { record in
            record.number.localizedCaseInsensitiveContains(query) ||
                (record.title ?? "").localizedCaseInsensitiveContains(query) ||
                (contacts.displayName(for: record.number) ?? "")
                    .localizedCaseInsensitiveContains(query)
        }
    }

    private var selectedRecording: CallRecordingRecord? {
        guard let selectedRecordingID else { return nil }
        return recordings.records.first { $0.id == selectedRecordingID }
    }

    private func selectFirstRecordingIfNeeded() {
        if let selectedRecordingID,
           recordings.records.contains(where: { $0.id == selectedRecordingID }) {
            return
        }
        selectedRecordingID = recordings.records.first?.id
    }

    private func handleFocusFirstItemRequest() {
        guard focusFirstItemRequest else { return }
        selectedRecordingID = filteredRecordingRecords.first?.id
        didHandleFocusFirstItemRequest()
        listFocused = false
        DispatchQueue.main.async {
            listFocused = true
        }
    }

    private func loadSelectedWaveform() {
        guard let record = selectedRecording else {
            waveform = nil
            waveformError = nil
            loadingWaveformID = nil
            return
        }
        waveform = nil
        waveformError = nil
        loadingWaveformID = record.id
        CallRecordingWaveformLoader.shared.load(url: recordings.fileURL(for: record)) { result in
            guard selectedRecordingID == record.id else { return }
            loadingWaveformID = nil
            switch result {
            case let .success(loaded):
                waveform = loaded
            case let .failure(error):
                waveformError = error.localizedDescription
            }
        }
    }

    private func beginRename() {
        renameText = selectedRecording?.title ?? ""
        isRenaming = true
    }

    private func saveRename() {
        guard let selectedRecording else { return }
        recordings.rename(selectedRecording, title: renameText)
    }

    private func deleteSelectedRecording() {
        guard let deletingRecording else { return }
        recordings.delete(deletingRecording)
        self.deletingRecording = nil
        selectFirstRecordingIfNeeded()
        loadSelectedWaveform()
    }

    private func displayName(for record: CallRecordingRecord) -> String {
        CommunicationUI.displayText(record.title, contacts.displayName(for: record.number), record.number)
    }

}

private struct RecordingDirectionBadge: View {
    let direction: CallDirection
    let size: CGFloat
    let iconSize: CGFloat

    var body: some View {
        ZStack {
            Color.clear
                .selectionBackground(directionColor, opacity: 0.14, in: Circle())

            Image(systemName: directionIcon)
                .font(.system(size: iconSize, weight: .semibold))
                .selectionTint(directionColor)
        }
        .frame(width: size, height: size)
        .accessibilityLabel(
            direction == .incoming ? L10n.tr("呼入录音") : L10n.tr("呼出录音")
        )
    }

    private var directionIcon: String {
        direction == .incoming ? "phone.arrow.down.left" : "phone.arrow.up.right"
    }

    private var directionColor: Color {
        direction == .incoming ? .blue : .green
    }
}

private struct RecordingDetailPane: View {
    @EnvironmentObject private var appState: AppState
    let record: CallRecordingRecord
    let displayName: String
    let waveform: CallRecordingWaveformData?
    let waveformError: String?
    @ObservedObject var recordings: CallRecordingStore
    let onCall: () -> Void
    let onMessage: () -> Void
    let onRename: () -> Void
    let onExport: () -> Void
    let onReveal: () -> Void
    let onDelete: () -> Void

    var body: some View {
        ScrollView {
            AdaptiveGlassContainer(spacing: 16) {
                VStack(alignment: .leading, spacing: 16) {
                    identityHeader

                    RecordingPlayerCard(
                        record: record,
                        waveform: waveform,
                        waveformError: waveformError,
                        recordings: recordings
                    )

                    RecordingInformationCard(
                        record: record,
                        fileURL: recordings.fileURL(for: record)
                    )

                    actionBar

                    if let error = recordings.lastError {
                        Label(L10n.tr(error), systemImage: "exclamationmark.triangle.fill")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
                .padding(24)
                .frame(maxWidth: 940, alignment: .leading)
            }
            .frame(maxWidth: .infinity)
        }
        .scrollContentBackground(.hidden)
        .communicationDetailColumnStyle()
    }

    private var identityHeader: some View {
        HStack(spacing: 16) {
            identity
                .layoutPriority(1)

            Spacer(minLength: 12)

            headerActions
        }
        .adaptiveGlassSurface(
            cornerRadius: 20,
            padding: 16,
            treatment: .regular
        )
    }

    private var identity: some View {
        HStack(spacing: 13) {
            RecordingDirectionBadge(
                direction: record.direction,
                size: 54,
                iconSize: 22
            )

            VStack(alignment: .leading, spacing: 3) {
                Text(displayName)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                Text(CommunicationUI.displayText(record.number))
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Text(headerMetadata)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private var headerActions: some View {
        VStack(spacing: 8) {
            Button(action: onCall) {
                Label("回拨", systemImage: "phone")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .adaptiveGlassButton()
            .controlSize(.small)
            .frame(width: 92)

            Button(action: onMessage) {
                Label("发短信", systemImage: "message")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .adaptiveGlassButton()
            .controlSize(.small)
            .frame(width: 92)
        }
    }

    private var actionBar: some View {
        HStack(spacing: 8) {
            Button(action: onRename) {
                Label("重新命名", systemImage: "pencil")
            }
            .adaptiveGlassButton()
            .help(L10n.tr("重新命名录音"))

            Button(action: onExport) {
                Label("导出", systemImage: "square.and.arrow.up")
            }
            .adaptiveGlassButton()
            .help(L10n.tr("导出录音"))

            Button(action: onReveal) {
                Label("在访达中显示", systemImage: "folder")
            }
            .adaptiveGlassButton()
            .help(L10n.tr("在访达中显示"))

            Spacer(minLength: 12)

            Button(role: .destructive, action: onDelete) {
                Label("删除录音", systemImage: "trash")
            }
            .adaptiveGlassButton()
            .tint(.red)
        }
        .controlSize(.small)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headerMetadata: String {
        let formatter = DateFormatter()
        formatter.locale = AppLanguage.storedPreference.locale
        formatter.setLocalizedDateFormatFromTemplate("yMMMdjmm")
        let direction = record.direction == .incoming ? L10n.tr("呼入") : L10n.tr("呼出")
        return L10n.tr("%@ · %@ · %@", formatter.string(from: record.startedAt), direction, spokenDuration(record.duration))
    }
}

private struct RecordingPlayerCard: View {
    @EnvironmentObject private var appState: AppState
    let record: CallRecordingRecord
    let waveform: CallRecordingWaveformData?
    let waveformError: String?
    @ObservedObject var recordings: CallRecordingStore

    @State private var showsVolume = false

    private let playbackControlSize: CGFloat = 38

    var body: some View {
        VStack(spacing: 14) {
            waveformArea

            HStack(spacing: 10) {
                Text(recordingDuration(position))
                    .frame(width: 50, alignment: .leading)

                Slider(value: progressBinding, in: 0 ... max(duration, 0.1))
                    .accessibilityLabel(L10n.tr("播放进度"))
                    .accessibilityValue(L10n.tr(
                        "播放进度：%@，共 %@",
                        recordingDuration(position),
                        recordingDuration(duration)
                    ))

                Text(recordingDuration(duration))
                    .frame(width: 50, alignment: .trailing)
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)

            playbackControls
        }
        .adaptiveGlassSurface(
            cornerRadius: 22,
            padding: 18,
            treatment: .regular
        )
    }

    @ViewBuilder
    private var waveformArea: some View {
        if let waveform {
            RecordingWaveformView(
                waveform: waveform,
                progress: duration > 0 ? position / duration : 0,
                currentTime: position,
                duration: duration,
                onSeek: { progress in
                    recordings.seekPlayback(record, to: duration * progress)
                }
            )
            .frame(height: 184)
        } else if let waveformError {
            VStack(spacing: 8) {
                Image(systemName: "waveform.slash")
                    .font(.title2)
                Text(waveformError)
                    .font(.caption)
            }
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 184)
        } else {
            VStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("正在生成声纹…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 184)
        }
    }

    private var playbackControls: some View {
        HStack(spacing: 12) {
            Button {
                ensurePrepared()
                recordings.skipPlayback(by: -15)
            } label: {
                Image(systemName: "gobackward.15")
                    .font(.system(size: 16, weight: .medium))
                    .frame(width: playbackControlSize, height: playbackControlSize)
            }
            .adaptiveGlassButton()
            .buttonBorderShape(.circle)
            .help(L10n.tr("后退 15 秒"))

            Button {
                recordings.play(record)
            } label: {
                Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: playbackControlSize, height: playbackControlSize)
            }
            .adaptiveGlassButton(.accented)
            .buttonBorderShape(.circle)
            .help(isPlaying ? L10n.tr("暂停") : L10n.tr("播放"))

            Button {
                ensurePrepared()
                recordings.skipPlayback(by: 15)
            } label: {
                Image(systemName: "goforward.15")
                    .font(.system(size: 16, weight: .medium))
                    .frame(width: playbackControlSize, height: playbackControlSize)
            }
            .adaptiveGlassButton()
            .buttonBorderShape(.circle)
            .help(L10n.tr("前进 15 秒"))

            Button {
                recordings.setPlaybackRate(nextPlaybackRate)
            } label: {
                Text(playbackRateLabel)
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .frame(width: playbackControlSize, height: playbackControlSize)
            }
            .adaptiveGlassButton()
            .buttonBorderShape(.circle)
            .help(L10n.tr("切换播放速度"))

            Button {
                showsVolume.toggle()
            } label: {
                Image(systemName: volumeIcon)
                    .font(.system(size: 16, weight: .medium))
                    .frame(width: playbackControlSize, height: playbackControlSize)
            }
            .adaptiveGlassButton()
            .buttonBorderShape(.circle)
            .help(L10n.tr("调整音量"))
            .popover(isPresented: $showsVolume, arrowEdge: .bottom) {
                HStack(spacing: 10) {
                    Image(systemName: "speaker.fill")
                    Slider(value: volumeBinding, in: 0 ... 1)
                    Image(systemName: "speaker.wave.3.fill")
                }
                .padding(14)
                .frame(width: 230)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var isActiveRecording: Bool {
        recordings.playingRecordingID == record.id
    }

    private var isPlaying: Bool {
        isActiveRecording && recordings.isPlaybackPlaying
    }

    private var position: TimeInterval {
        isActiveRecording ? recordings.playbackPosition : 0
    }

    private var duration: TimeInterval {
        isActiveRecording && recordings.playbackDuration > 0
            ? recordings.playbackDuration
            : record.duration
    }

    private var progressBinding: Binding<Double> {
        Binding(
            get: { position },
            set: { recordings.seekPlayback(record, to: $0) }
        )
    }

    private var volumeBinding: Binding<Double> {
        Binding(
            get: { Double(recordings.playbackVolume) },
            set: { recordings.setPlaybackVolume(Float($0)) }
        )
    }

    private var playbackRateLabel: String {
        let rate = recordings.playbackRate
        return rate.rounded() == rate ? "\(Int(rate))×" : "\(rate.formatted())×"
    }

    private var nextPlaybackRate: Float {
        let rates: [Float] = [0.75, 1, 1.25, 1.5, 2]
        guard let index = rates.firstIndex(of: recordings.playbackRate) else { return 1 }
        return rates[(index + 1) % rates.count]
    }

    private var volumeIcon: String {
        switch recordings.playbackVolume {
        case ...0: return "speaker.slash.fill"
        case ..<0.34: return "speaker.wave.1.fill"
        case ..<0.67: return "speaker.wave.2.fill"
        default: return "speaker.wave.3.fill"
        }
    }

    private func ensurePrepared() {
        if !isActiveRecording {
            recordings.seekPlayback(record, to: 0)
        }
    }
}

private struct RecordingWaveformView: View {
    let waveform: CallRecordingWaveformData
    let progress: Double
    let currentTime: TimeInterval
    let duration: TimeInterval
    let onSeek: (Double) -> Void

    @State private var isHovering = false

    private let labelWidth: CGFloat = 44

    var body: some View {
        GeometryReader { proxy in
            Canvas { context, size in
                let topInset: CGFloat = 24
                let rightInset: CGFloat = 4
                let availableWidth = max(size.width - labelWidth - rightInset, 1)
                let remoteY = topInset + (size.height - topInset) * 0.28
                let localY = topInset + (size.height - topInset) * 0.72
                let laneHeight = (size.height - topInset) * 0.32

                context.draw(
                    Text("对方").font(.caption).foregroundStyle(.secondary),
                    at: CGPoint(x: 0, y: remoteY),
                    anchor: .leading
                )
                context.draw(
                    Text("本机").font(.caption).foregroundStyle(.secondary),
                    at: CGPoint(x: 0, y: localY),
                    anchor: .leading
                )

                drawLane(
                    context: &context,
                    values: waveform.remote,
                    centerY: remoteY,
                    height: laneHeight,
                    color: .blue,
                    labelWidth: labelWidth,
                    availableWidth: availableWidth
                )
                drawLane(
                    context: &context,
                    values: waveform.local,
                    centerY: localY,
                    height: laneHeight,
                    color: .indigo,
                    labelWidth: labelWidth,
                    availableWidth: availableWidth
                )

                let resolvedProgress = min(max(progress, 0), 1)
                let playheadX = labelWidth + availableWidth * resolvedProgress
                var playhead = Path()
                playhead.move(to: CGPoint(x: playheadX, y: topInset - 3))
                playhead.addLine(to: CGPoint(x: playheadX, y: size.height - 4))
                context.stroke(playhead, with: .color(.blue), lineWidth: 1.5)
                context.fill(
                    Path(ellipseIn: CGRect(x: playheadX - 4, y: topInset - 7, width: 8, height: 8)),
                    with: .color(.blue)
                )

                let timestamp = context.resolve(
                    Text(recordingDuration(currentTime))
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.blue)
                )
                let textSize = timestamp.measure(in: CGSize(width: 80, height: 18))
                let bubbleWidth = textSize.width + 12
                let bubbleRect = CGRect(
                    x: min(max(labelWidth, playheadX - bubbleWidth / 2), size.width - bubbleWidth),
                    y: 0,
                    width: bubbleWidth,
                    height: 19
                )
                context.fill(
                    Path(roundedRect: bubbleRect, cornerRadius: 9),
                    with: .color(Color.blue.opacity(0.10))
                )
                context.stroke(
                    Path(roundedRect: bubbleRect, cornerRadius: 9),
                    with: .color(Color.blue.opacity(0.45)),
                    lineWidth: 0.7
                )
                context.draw(timestamp, at: CGPoint(x: bubbleRect.midX, y: bubbleRect.midY))
            }
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovering = hovering
                (hovering ? NSCursor.resizeLeftRight : NSCursor.arrow).set()
            }
            .gesture(
                DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .onChanged { value in
                        onSeek(progress(at: value.location.x, width: proxy.size.width))
                    }
            )
        }
        .onDisappear {
            if isHovering { NSCursor.arrow.set() }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L10n.tr("双声道录音声纹"))
        .accessibilityValue(L10n.tr(
            "对方为左声道，本机为右声道，当前 %@",
            recordingDuration(currentTime)
        ))
        .accessibilityAdjustableAction { direction in
            let step = duration > 0 ? min(5 / duration, 0.1) : 0.05
            switch direction {
            case .increment: onSeek(min(progress + step, 1))
            case .decrement: onSeek(max(progress - step, 0))
            @unknown default: break
            }
        }
    }

    private func drawLane(
        context: inout GraphicsContext,
        values: [Float],
        centerY: CGFloat,
        height: CGFloat,
        color: Color,
        labelWidth: CGFloat,
        availableWidth: CGFloat
    ) {
        guard !values.isEmpty else { return }
        let targetCount = max(1, min(values.count, Int(availableWidth / 2.2)))
        let step = Double(values.count) / Double(targetCount)
        let lineWidth = max(1.2, min(2.2, availableWidth / CGFloat(targetCount) * 0.62))
        let resolvedProgress = min(max(progress, 0), 1)

        for index in 0 ..< targetCount {
            let sourceIndex = min(values.count - 1, Int(Double(index) * step))
            let amplitude = max(CGFloat(values[sourceIndex]), 0.035)
            let x = labelWidth + (CGFloat(index) + 0.5) / CGFloat(targetCount) * availableWidth
            let barHeight = max(2, height * amplitude)
            var bar = Path()
            bar.move(to: CGPoint(x: x, y: centerY - barHeight / 2))
            bar.addLine(to: CGPoint(x: x, y: centerY + barHeight / 2))
            let sampleProgress = Double(index) / Double(max(targetCount - 1, 1))
            let barColor = sampleProgress <= resolvedProgress
                ? color
                : Color.secondary.opacity(0.28)
            context.stroke(
                bar,
                with: .color(barColor),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
            )
        }
    }

    private func progress(at x: CGFloat, width: CGFloat) -> Double {
        let availableWidth = max(width - labelWidth - 4, 1)
        return min(max(Double((x - labelWidth) / availableWidth), 0), 1)
    }
}

private struct RecordingInformationCard: View {
    let record: CallRecordingRecord
    let fileURL: URL

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 22) {
                recordingInformation
                    .frame(maxWidth: .infinity, alignment: .leading)
                Divider()
                channelInformation
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            VStack(alignment: .leading, spacing: 18) {
                recordingInformation
                Divider()
                channelInformation
            }
        }
        .adaptiveGlassSurface(
            cornerRadius: 20,
            padding: 16,
            treatment: .regular
        )
    }

    private var recordingInformation: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("录音信息")
                .font(.headline)
            informationRow("录制时间", value: formattedDate)
            informationRow(
                "通话方向",
                value: record.direction == .incoming ? L10n.tr("呼入") : L10n.tr("呼出")
            )
            informationRow("文件大小", value: fileSize)
        }
    }

    private var channelInformation: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("声道")
                .font(.headline)
            channelRow(color: .blue, title: "对方", value: L10n.tr("左声道"))
            channelRow(color: .indigo, title: "本机", value: L10n.tr("右声道"))
            Label(CallRecordingStore.storageText, systemImage: "internaldrive")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func informationRow(_ title: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(L10n.tr(title))
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
        }
        .font(.caption)
    }

    private func channelRow(color: Color, title: String, value: String) -> some View {
        HStack(spacing: 8) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(L10n.tr(title))
            Spacer()
            Text(value).foregroundStyle(.secondary)
        }
        .font(.caption)
    }

    private var formattedDate: String {
        let formatter = DateFormatter()
        formatter.locale = AppLanguage.storedPreference.locale
        formatter.setLocalizedDateFormatFromTemplate("yMMMdjmm")
        return formatter.string(from: record.startedAt)
    }

    private var fileSize: String {
        let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        let byteCount = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
        return byteCount > 0
            ? ByteCountFormatter.string(fromByteCount: byteCount, countStyle: .file)
            : L10n.tr("尚未读取")
    }
}

private func recordingDuration(_ duration: TimeInterval) -> String {
    let total = max(0, Int(duration.rounded()))
    if total >= 3_600 {
        return String(format: "%d:%02d:%02d", total / 3_600, (total / 60) % 60, total % 60)
    }
    return String(format: "%d:%02d", total / 60, total % 60)
}

private func spokenDuration(_ duration: TimeInterval) -> String {
    let total = max(0, Int(duration.rounded()))
    let hours = total / 3_600
    let minutes = (total / 60) % 60
    let seconds = total % 60
    if hours > 0 {
        return L10n.tr(
            "%lld小时%lld分%lld秒",
            Int64(hours),
            Int64(minutes),
            Int64(seconds)
        )
    }
    return L10n.tr("%lld分%lld秒", Int64(minutes), Int64(seconds))
}
