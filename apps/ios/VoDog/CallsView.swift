import SwiftUI

struct CallsView<Content: View>: View {
    /// One host owns the original state, actions and poll, above the tab content.
    @ViewBuilder let content: (AnyView) -> Content
    @Environment(UIAvailabilityState.self) private var availability
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var presentation = CallUIPresentationPolicy()
    @State private var badges = BadgeStore.shared
    @State private var endRequests: [CallUIPayload.ID: Date] = [:]
    @State private var endingObservedAt: [CallUIPayload.ID: Date] = [:]
    @State private var presentationSessionID: UUID?
    @State private var callsSnapshotSessionID: UUID?
    @Environment(SessionStore.self) private var session
    @Environment(AppNavigation.self) private var navigation
    @State private var sims: [SIMChannel] = []
    @State private var calls: [CallRecord] = []
    @State private var selectedSIM: String?
    @State private var number = ""
    @State private var error: String?
    @State private var loading = false
    @State private var loaded = false
    @State private var showingKeypad = true
    /// S36 C5-b / C2: the confirm-then-dial sheet, and the in-call DTMF keypad on the active-call card.
    @State private var confirmingDial = false
    @State private var showingDTMFKeypad = false
    @State private var dtmfError: String?
    @State private var media = CallMediaSession.shared
    @State private var answerFeedback = 0
    @State private var endFeedback = 0
    @State private var dialFeedback = 0
    /// §F: the dialer echoes the matched name. `lookupNumber` records which number the answer belongs to, so a
    /// late response for an older prefix can never label the number now on screen.
    @State private var lookupContact: Contact?
    @State private var lookupNumber = ""

    private var activeCalls: [CallRecord] { CallAvailabilityPolicy.activeCalls(calls) }
    private var secondaryActiveCalls: [CallRecord] {
        activeCalls.filter { $0.id != primaryOwnedCall?.id }
    }
    private var recentCalls: [CallRecord] {
        calls.filter { call in
            ["ended", "failed"].contains(call.state ?? "") && (selectedSIM == nil || call.simId == selectedSIM)
        }
    }
    private var selectedSIMValue: SIMChannel? { sims.first { $0.id == selectedSIM } }
    /// S20 decision 6: the call that holds the selected SIM's gateway, if any.
    private var occupyingCall: CallRecord? {
        SIMOccupancyDisplayPolicy.occupyingCall(simID: selectedSIM, sims: sims, calls: calls)
    }
    private var selectedTimeZone: TimeZone {
        GatewayTimeDisplay.resolvedTimeZone(
            callZone: occupyingCall?.gatewayTimeZone, simZone: selectedSIMValue?.timeZone
        )
    }
    private var primaryOwnedCall: CallRecord? {
        CallAvailabilityPolicy.primaryOwnedCall(calls, currentMediaCallID: media.callID)
    }
    private var canDial: Bool {
        availability.canDial(on: selectedSIM)
            && SIMSelectionPolicy.canDial(on: selectedSIM, sims: sims)
            && !CallAvailabilityPolicy.gatewayIsBusy(simID: selectedSIM, sims: sims, calls: calls)
            && CallAvailabilityPolicy.canStartOutbound(currentMediaCallID: media.callID)
            && PhoneNumberText.isDialable(PhoneNumberText.normalized(number))
            && !loading
    }

    var body: some View {
        content(AnyView(callTab))
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    NetworkAvailabilityNotice().padding(.horizontal)
                    if let payload = presentation.current { ongoingCallBanner(payload) }
                }
                .background(.bar)
            }
            .fullScreenCover(item: Binding(
                get: { presentation.presented },
                set: { if $0 == nil { presentation.minimize() } }
            )) { payload in
                // Read the live snapshot for this ID, with the payload as a nonempty dismissal fallback.
                let live = presentation.current.flatMap { $0.id == payload.id ? $0 : nil } ?? payload
                fullScreenCall(live.call)
            }
            .sensoryFeedback(.success, trigger: answerFeedback)
            .sensoryFeedback(.impact(weight: .heavy), trigger: endFeedback)
            .sensoryFeedback(.impact(weight: .medium), trigger: dialFeedback)
            .task(id: session.sessionIdentity) {
                syncPresentation()
                await poll()
            }
            .onChange(of: media.callID) { _, _ in syncPresentation() }
            .task(id: number) { await lookupContactName() }
            .onAppear { Task { await CallMediaSession.shared.preflightMicrophonePermission() } }
            // S36 C2: the keypad and its error belong to one call, never to the next one.
            .onChange(of: primaryOwnedCall?.id) { _, _ in showingDTMFKeypad = false; dtmfError = nil }
            .onChange(of: navigation.pendingRedial) { _, pending in
                guard let pending else { return }
                navigation.pendingRedial = nil
                selectedSIM = pending.simID
                number = pending.remoteNumber
                showingKeypad = true
                Task { await dial() }
            }
            // S36 C5-b: 拨打 from a contact or a record lands here. The SIM is resolved against the list this
            // screen owns and confirmed; a request that cannot be dialled (no usable SIM, media busy, …) keeps
            // the older prefill-only behaviour, with the dialer already stating why.
            .onChange(of: navigation.pendingDialPrefill) { _, pending in
                guard let pending else { return }
                navigation.pendingDialPrefill = nil
                if let resolved = SIMSelectionPolicy.dialSIM(requested: pending.simID, current: selectedSIM, sims: sims) {
                    selectedSIM = resolved
                }
                number = pending.remoteNumber
                showingKeypad = true
                confirmingDial = pending.confirm && canDial
            }
            .confirmationDialog(
                "用 \(selectedSIMValue.map(simDisplayName) ?? "所选号码") 拨打 \(number)？",
                isPresented: $confirmingDial, titleVisibility: .visible
            ) {
                Button("拨打") { Task { await dial() } }.disabled(!canDial)
                Button("取消", role: .cancel) { }
            } message: {
                if let reason = availability.reason { Text(reason) }
            }
    }

    private var callTab: some View {
        NavigationStack {
            VStack(spacing: 0) {
                SIMStrip(sims: sims, selectedID: $selectedSIM, loaded: loaded, badges: badges.counts.callsBySIM)
                if let occupyingCall {
                    SIMOccupancyBar(call: occupyingCall, timeZone: selectedTimeZone, simLabel: simTitle(occupyingCall.simId, in: sims)) {
                        guard availability.canMutate else { return }
                        await release(occupyingCall)
                    }
                    .disabled(!availability.canMutate)
                }
                ScrollView {
                    VStack(spacing: 18) {
                        if primaryOwnedCall == nil { dialer }
                        ForEach(secondaryActiveCalls) { call in activeCallCard(call) }
                        recentCallList
                        if let error {
                            ErrorBanner(screen: "calls", message: error) {
                                Task { await load(requiredIdentity: session.sessionIdentity) }
                            }
                        }
                    }
                    .padding()
                    .frame(maxWidth: 620)
                    .frame(maxWidth: .infinity)
                }
                .background(Color(uiColor: .systemGroupedBackground))
                .contentShape(Rectangle())
                .onTapGesture { showingKeypad = false }
                .refreshable { await load(requiredIdentity: session.sessionIdentity) }
            }
            .navigationTitle("电话")
            .toolbarTitleDisplayMode(.inlineLarge)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await load(requiredIdentity: session.sessionIdentity) } } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("刷新通话")
                }
            }
        }
    }

    private func syncPresentation() {
        if presentationSessionID != session.sessionIdentity {
            presentationSessionID = session.sessionIdentity
            endRequests.removeAll()
            endingObservedAt.removeAll()
            availability.resetSessionSnapshot()
        }
        for call in calls where ["ended", "failed"].contains(call.state ?? "") || call.claimedByCurrentSession != true {
            if let identity = session.sessionIdentity { endRequests.removeValue(forKey: .init(session: identity, call: call.id)) }
        }
        if let identity = session.sessionIdentity {
            for call in calls {
                let key = CallUIPayload.ID(session: identity, call: call.id)
                if call.state == "ending" {
                    if endingObservedAt[key] == nil { endingObservedAt[key] = .now }
                } else {
                    endingObservedAt.removeValue(forKey: key)
                }
            }
        }
        presentation.update(
            sessionID: session.sessionIdentity,
            calls: callsSnapshotSessionID == session.sessionIdentity ? calls : [],
            mediaCallID: media.callID
        )
    }

    private func ongoingCallBanner(_ payload: CallUIPayload) -> some View {
        Button { presentation.restore() } label: {
            HStack(spacing: 12) {
                Image(systemName: "phone.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Text(ContactDisplay.numberWithName(number: payload.call.shownNumber(in: sims), contactName: payload.call.shownContactName))
                        .font(.subheadline.weight(.semibold)).lineLimit(2)
                    Text(simTitle(payload.call.simId, in: sims)).font(.caption)
                    CallUIStatusLabel(call: payload.call, requestedAt: endRequests[payload.id]).font(.caption)
                }
                Spacer(minLength: 8)
                CallElapsedTime(call: payload.call, requestedAt: endRequests[payload.id], endingObservedAt: endingObservedAt[payload.id]).font(.subheadline)
                Image(systemName: "chevron.up")
            }
            .frame(maxWidth: 620, minHeight: 44, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal).padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.callerAccent)
        .accessibilityHint("展开当前通话")
        .accessibilityIdentifier("calls.ongoingBanner")
    }

    private func fullScreenCall(_ call: CallRecord) -> some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    if availability.reason != nil { NetworkAvailabilityNotice() }
                    primaryCallControls(call)
                }
                .padding(24)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .safeAreaInset(edge: .bottom) {
                hangupButton(call).padding().background(.bar)
            }
            .navigationTitle("当前通话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { presentation.minimize() } label: {
                        Label("收起", systemImage: "chevron.down")
                    }
                    .accessibilityIdentifier("calls.minimize")
                }
            }
        }
        .interactiveDismissDisabled()
    }

    /// Only shown while the answer still belongs to the digits on screen.
    private var dialerContactName: String? {
        guard let contact = lookupContact, lookupNumber == PhoneNumberText.normalized(number) else { return nil }
        let name = contact.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    private var dialer: some View {
        VStack(spacing: 14) {
            Button { showingKeypad = true } label: {
                Text(number.isEmpty ? "输入电话号码" : number)
                    .font(.system(.title2, design: .rounded).weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(number.isEmpty ? Color.secondary : Color.primary)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("拨号号码")
            .accessibilityHint("打开数字键盘")

            // A real, font-scaled line stays in layout when the asynchronous match is absent.
            Text(dialerContactName ?? " ")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.callerAccent)
                .lineLimit(1)
                .accessibilityHidden(dialerContactName == nil)
                .accessibilityLabel("通讯录匹配到 \(dialerContactName ?? "")")
                .accessibilityIdentifier("calls.dialerContactName")

            if showingKeypad {
                DialPad(number: $number)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            HStack(spacing: 34) {
                Button { number = PhoneNumberText.deletingLast(from: number) } label: {
                    Image(systemName: "delete.left").font(.title2).frame(width: 52, height: 52)
                }
                .disabled(number.isEmpty)
                .accessibilityLabel("删除一位")

                Button { Task { await dial() } } label: {
                    Image(systemName: "phone.fill")
                        .font(.title2).foregroundStyle(.white)
                        .frame(width: 62, height: 62).background(.green, in: Circle())
                }
                .disabled(!canDial)
                .opacity(canDial ? 1 : 0.4)
                .accessibilityLabel("使用\(selectedSIMValue.map(simDisplayName) ?? "所选号码")拨打")

                Button { number = "" } label: {
                    Image(systemName: "xmark").font(.title3).frame(width: 52, height: 52)
                }
                .disabled(number.isEmpty)
                .accessibilityLabel("清除号码")
            }

            if let reason = availability.reason {
                Text(reason).font(.footnote).foregroundStyle(.secondary)
            } else if !availability.hasCurrentSIMSnapshot {
                Text("号码状态待刷新，暂时无法拨号").font(.footnote).foregroundStyle(.secondary)
            } else if selectedSIMValue?.online != true {
                Text(selectedSIMValue == nil ? "请选择已分配的号码" : "号码设备离线，暂时无法拨号")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if selectedSIMValue?.telephonyReady != true || selectedSIMValue?.mediaReady != true {
                Text("当前设备的电话或媒体能力尚未就绪")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if CallAvailabilityPolicy.gatewayIsBusy(simID: selectedSIM, sims: sims, calls: calls) {
                Text("当前号码所在设备已有通话，请在通话结束后拨号")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if !CallAvailabilityPolicy.canStartOutbound(currentMediaCallID: media.callID) {
                Text("本机音频正在用于另一通话，请先结束该通话")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(.background, in: RoundedRectangle(cornerRadius: 20))
        .onTapGesture { /* Consume the outer blank-area dismissal gesture. */ }
    }

    @ViewBuilder private func primaryCallControls(_ call: CallRecord) -> some View {
        let requestedAt = session.sessionIdentity.flatMap { endRequests[.init(session: $0, call: call.id)] }
        let ending = CallUIEndPolicy.isPending(requestedAt: requestedAt, state: call.state, now: Date())
        VStack(spacing: 8) {
            // §F: 号码 · 姓名 while the call is up.
            Text(ContactDisplay.numberWithName(number: call.shownNumber(in: sims), contactName: call.shownContactName))
                .font(.system(.title, design: .rounded).weight(.semibold)).monospacedDigit().lineLimit(2)
                .minimumScaleFactor(0.7)
            Text("\(simTitle(call.simId, in: sims)) · 当前登录会话")
                .font(.caption).foregroundStyle(.secondary)
            CallUIStatusLabel(call: call, requestedAt: requestedAt)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(requestedAt != nil || call.state == "ending" ? Color.secondary : Color.green)
            CallElapsedTime(call: call, requestedAt: requestedAt, endingObservedAt: session.sessionIdentity.flatMap { endingObservedAt[.init(session: $0, call: call.id)] }).font(.title2)
        }
        .frame(maxWidth: .infinity)
        let audioReady: Bool = {
            guard media.callID == call.id else { return false }
            if case .connected = media.state { return true }
            return false
        }()
        HStack(spacing: 12) {
            Button {
                guard media.callID == call.id else { return }
                CallCoordinator.shared.setMuted(!media.isMuted, media: media)
            } label: {
                Label((media.callID == call.id && media.isMuted) ? "取消静音" : "静音", systemImage: (media.callID == call.id && media.isMuted) ? "mic.fill" : "mic.slash.fill")
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .disabled(ending || !audioReady || !media.microphoneAvailable)

            Button {
                guard speakerControlsEnabled(for: call) else { return }
                _ = media.setSpeaker(!media.isSpeakerEnabled)
            } label: {
                Label(
                    (media.callID == call.id && media.isSpeakerEnabled) ? "关闭扬声器" : "打开扬声器",
                    systemImage: (media.callID == call.id && media.isSpeakerEnabled) ? "speaker.slash.fill" : "speaker.wave.2.fill"
                )
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.bordered)
            .disabled(ending || !audioReady || !speakerControlsEnabled(for: call))

        }
        // S36 C2: IVR menus need digits on the live cellular call; the gateway plays them, this only sends.
        Button {
            showingDTMFKeypad.toggle()
            dtmfError = nil
        } label: {
            Label("键盘", systemImage: "circle.grid.3x3.fill")
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .disabled(ending || call.state != "active")
        .accessibilityIdentifier("calls.dtmfToggle")
        if showingDTMFKeypad, call.state == "active" {
            InCallKeypad { key in Task { guard !ending, availability.canMutate else { return }; await sendDTMF(key, on: call) } }
                .disabled(ending || !availability.canMutate)
            if let dtmfError {
                Text(dtmfError)
                    .font(.footnote).foregroundStyle(Color.callerDanger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .reportsError(dtmfError, screen: "calls", site: "dtmf")
            }
        }
        Text(mediaFailureMessage(for: call) != nil
             ? "通话声音暂不可用，仍可结束通话。"
             : (!audioReady ? "通话声音尚未就绪。"
                : (media.isMuted ? "麦克风已静音，对方听不到你的声音。" : "通话声音已连接。")))
            .font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func hangupButton(_ call: CallRecord) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let key = session.sessionIdentity.map { CallUIPayload.ID(session: $0, call: call.id) }
            let requestedAt = key.flatMap { endRequests[$0] }
            let pending = CallUIEndPolicy.isPending(requestedAt: requestedAt, state: call.state, now: context.date)
            VStack(spacing: 6) {
                Button(role: .destructive) { requestEnd(call) } label: {
                    HStack(spacing: 8) {
                        if pending { ProgressView().tint(Color.primary).accessibilityHidden(true) }
                        Label(pending ? "正在结束…" : (requestedAt == nil ? "结束通话" : "重试结束"), systemImage: "phone.down.fill")
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.vertical, 6)
                    .foregroundStyle(pending ? Color.primary : Color.white)
                    .background(
                        pending ? Color(uiColor: .secondarySystemBackground) : Color.callerDanger,
                        in: Capsule()
                    )
                }
                .buttonStyle(.plain)
                .disabled(pending)
                .accessibilityIdentifier("calls.hangup")
                if requestedAt != nil {
                    Text(pending ? "结束请求已提交，等待确认。" : "尚未确认通话结束，可重试；不会重新拨号。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func requestEnd(_ call: CallRecord) {
        guard let identity = session.sessionIdentity else { return }
        let key = CallUIPayload.ID(session: identity, call: call.id)
        guard !CallUIEndPolicy.isPending(requestedAt: endRequests[key], state: call.state, now: .now) else { return }
        endRequests[key] = .now
        endFeedback += 1
        Task { await end(call) }
    }

    /// S18 decision 6: a media failure keeps the call for 30 s and offers a choice instead of hanging up. The audio
    /// controls are replaced — not supplemented — so there is exactly one way to end the call.
    @ViewBuilder private func mediaRecoveryControls(_ call: CallRecord, showsEndButton: Bool = true) -> some View {
        if let message = mediaFailureMessage(for: call) {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote).foregroundStyle(Color.callerDanger)
                .frame(maxWidth: .infinity, alignment: .leading)
                .reportsError(message, screen: "calls", site: "media_failure")
            HStack(spacing: 12) {
                Button { Task { guard availability.canMutate else { return }; await media.retry(session: session) } } label: {
                    Label("重试音频", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel("重试通话音频")
                .disabled(!availability.canMutate)

                if showsEndButton { hangupButton(call) }
            }
            graceFootnote
        }
    }

    /// S20 decision 8: the 30 s grace is shown as a live countdown. `Text(timerInterval:)` ticks on its own, and the
    /// surrounding `TimelineView` keeps the VoiceOver value in step with it.
    @ViewBuilder private var graceFootnote: some View {
        if let deadline = media.graceDeadline {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = MediaGracePolicy.remainingDescription(deadline: deadline, now: context.date)
                HStack(spacing: 4) {
                    if deadline > context.date {
                        Text("未恢复音频将在")
                        Text(timerInterval: context.date...deadline, countsDown: true, showsHours: false)
                            .monospacedDigit()
                        Text("后自动结束通话")
                    } else {
                        Text(MediaGracePolicy.footnote)
                    }
                }
                .font(.footnote).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(MediaGracePolicy.footnote)
                .accessibilityValue(remaining)
            }
        } else {
            Text(MediaGracePolicy.footnote)
                .font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The mapped failure text, but only while this call still owns the audio session.
    private func mediaFailureMessage(for call: CallRecord) -> String? {
        guard media.callID == call.id, case let .failed(_, message) = media.state else { return nil }
        return message
    }

    private func speakerControlsEnabled(for call: CallRecord) -> Bool {
        guard media.callID == call.id else { return false }
        switch media.state {
        case .connecting, .connected: return true
        default: return false
        }
    }

    private func activeCallCard(_ call: CallRecord) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("当前通话", systemImage: "phone.connection.fill").font(.headline).foregroundStyle(.tint)
            Text(ContactDisplay.numberWithName(number: call.shownNumber(in: sims), contactName: call.shownContactName))
                .font(.title2).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
            HStack {
                Text(callStateTitle(call.state)).foregroundStyle(.secondary)
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(simTitle(call.simId, in: sims))
                    if let sim = sims.first(where: { $0.id == call.simId }) {
                        Text(simGatewayIdentity(sim, shortened: true))
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            if call.claimedByCurrentSession == true {
                Label("当前登录会话", systemImage: "person.crop.circle.badge.checkmark")
                    .font(.footnote).foregroundStyle(.secondary)
            } else if let owner = callOwnerTitle(call) {
                Label(owner, systemImage: "person.crop.circle")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            // S22 decision 4: an `ai` call an AI run already owns is not offered to a human — the push was
            // suppressed server-side, so 接听/拒接 here would be the one way left to race the AI. `timeout_ai`
            // is deliberately untouched: it rings, and grabbing it before the timer fires is the point.
            HStack {
                if call.suppressesRinging {
                    Label("AI 接听中", systemImage: "sparkles")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.callerAccent)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("calls.aiAnswering")
                    Spacer()
                } else if call.state == "incoming_ringing" {
                    Button("接听") { answerFeedback += 1; Task { guard availability.canMutate else { return }; await claim(call) } }
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                        .disabled(!availability.canMutate || (media.callID != nil && media.callID != call.id))
                    Spacer()
                    Button("拒接", role: .destructive) { endFeedback += 1; Task { await decline(call) } }
                        .buttonStyle(.bordered)
                        .tint(Color.callerDanger)
                } else {
                    Spacer()
                    if call.claimedByCurrentSession == true {
                        hangupButton(call)
                    }
                }
            }
            // The recovery block states the failure itself, so the status line would repeat it.
            if mediaFailureMessage(for: call) == nil, media.callID == nil || media.callID == call.id {
                Label(media.statusText, systemImage: mediaIcon).font(.footnote).foregroundStyle(.secondary)
            }
            mediaControls(for: call)
        }
        .padding()
        .background(.background, in: RoundedRectangle(cornerRadius: 18))
        .onTapGesture { showingKeypad = false }
    }

    @ViewBuilder private var recentCallList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("最近通话").font(.headline).padding(.horizontal, 4)
            if !loaded {
                // S20 decision 8: an empty list before the first response is unknown, not empty.
                HStack(spacing: 8) { ProgressView(); Text("正在读取通话记录…") }
                    .font(.subheadline).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding()
                    .background(.background, in: RoundedRectangle(cornerRadius: 14))
            } else if recentCalls.isEmpty {
                Text("当前号码暂无通话记录").font(.subheadline).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding()
                    .background(.background, in: RoundedRectangle(cornerRadius: 14))
            } else {
                ForEach(recentCalls.prefix(20)) { call in
                    NavigationLink { RecordDetailView(call: call) } label: {
                        HStack(spacing: 12) {
                            UnreadDot(
                                visible: UnreadDotPolicy.callUnseen(call, locallySeen: badges.seenCallIDs),
                                label: "未查看"
                            )
                            Image(systemName: call.direction == "incoming" ? "phone.arrow.down.left" : "phone.arrow.up.right")
                                .foregroundStyle(call.state == "failed" ? Color.callerDanger : Color.accentColor)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 3) {
                                // S36 C5-a: a matched name gets its own line so the number below it is never
                                // truncated by the "号码 · 姓名" one-liner.
                                RecentCallTitle(number: call.shownNumber(in: sims), contactName: call.shownContactName)
                                Text(callLineTitle(call.simId, in: sims) ?? simTitle(call.simId, in: sims))
                                    .font(.caption).foregroundStyle(.secondary)
                                // Accessibility sizes: the right column moves under the text instead of squeezing it.
                                if dynamicTypeSize.isAccessibilitySize {
                                    recentCallFacts(call, alignment: .leading).font(.caption)
                                }
                            }
                            Spacer()
                            if !dynamicTypeSize.isAccessibilitySize {
                                // S82: duration (when answered), date, status stacked right-aligned so 未接来电 never wraps.
                                recentCallFacts(call, alignment: .trailing)
                                    .font(.caption).lineLimit(1).fixedSize()
                            }
                        }
                    }
                    .padding()
                    .background(.background, in: RoundedRectangle(cornerRadius: 14))
                }
            }
        }
        .onTapGesture { showingKeypad = false }
    }

    private func recentCallFacts(_ call: CallRecord, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 3) {
            if let duration = CallDurationLabel.text(answeredAt: call.answeredAt, endedAt: call.endedAt) {
                Text(duration).foregroundStyle(.secondary)
                    .accessibilityLabel("通话时长 \(duration)")
            }
            Text(GatewayTimeDisplay.compact(
                call.endedAt ?? call.startedAt,
                timeZone: GatewayTimeDisplay.resolvedTimeZone(
                    callZone: call.gatewayTimeZone,
                    simZone: sims.first { $0.id == call.simId }?.timeZone
                )
            )).foregroundStyle(.secondary)
            Text(call.rowStateTitle).foregroundStyle(call.isMissedIncoming ? .red : .secondary)
        }
    }

    /// S20 decision 5: 2 s while one of this session's own calls is still moving, 5 s otherwise.
    private func poll() async {
        guard let identity = session.sessionIdentity else { return }
        while !Task.isCancelled, session.isCurrentSession(identity) {
            await load(requiredIdentity: identity)
            let interval = CallRefreshCadencePolicy.interval(
                calls: calls,
                currentMediaCallID: media.callID,
                mediaIsConnecting: OccupancyReleasePolicy.mediaLiveness(media.state) == .connecting
            )
            do { try await Task.sleep(for: interval) } catch { return }
        }
    }

    /// Debounced `GET /contacts/lookup`. A number too short to match anything never leaves the device.
    private func lookupContactName() async {
        let normalized = PhoneNumberText.normalized(number)
        guard let identity = session.sessionIdentity else {
            lookupContact = nil
            lookupNumber = ""
            return
        }
        guard ContactLookupPolicy.shouldLookup(normalized) else {
            lookupContact = nil
            lookupNumber = ""
            return
        }
        do { try await Task.sleep(for: ContactLookupPolicy.debounce) } catch { return }
        guard session.isCurrentSession(identity), PhoneNumberText.normalized(number) == normalized else { return }
        do {
            let response: ContactLookupEnvelope = try await session.request(
                "contacts/lookup", requiredSessionIdentity: identity,
                queryItems: [URLQueryItem(name: "number", value: normalized)]
            )
            guard !Task.isCancelled, session.isCurrentSession(identity),
                  PhoneNumberText.normalized(number) == normalized else { return }
            lookupContact = response.item
            lookupNumber = normalized
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, session.isCurrentSession(identity),
                  PhoneNumberText.normalized(number) == normalized else { return }
            // Never surface this: an unmatched number is the normal case and a failed lookup must not block dialling.
            lookupContact = nil
            lookupNumber = normalized
        }
    }

    private func load(requiredIdentity identity: UUID?) async {
        guard let identity, session.isCurrentSession(identity) else { return }
        do {
            async let simResult: ItemEnvelope<SIMChannel> = session.request("sims", requiredSessionIdentity: identity)
            async let callResult: ItemEnvelope<CallRecord> = session.request("calls", requiredSessionIdentity: identity)
            let (newSims, newCalls) = try await (simResult, callResult)
            guard session.isCurrentSession(identity) else { return }
            sims = newSims.items
            calls = newCalls.items
            callsSnapshotSessionID = identity
            availability.didRefreshSIMs(newSims.items)
            syncPresentation()
            // S41 decision 3: the remote party's hangup reaches the device as a list state, and until S41
            // nothing here took the system call down — only `media.stop()` below.
            IncomingCallManager.shared.endRemotelyEndedCalls(
                CallKitRemoteEndPolicy.idsToEnd(
                    activeCallKitIDs: CallCoordinator.shared.activeCallIDs,
                    calls: newCalls.items.map { ($0.id, $0.state) }
                ),
                reason: "poll"
            )
            selectedSIM = SIMSelectionPolicy.preferredID(in: sims, current: selectedSIM)
            if media.callID != nil, !newCalls.items.contains(where: { $0.id == media.callID && !["ended", "failed"].contains($0.state ?? "") }) {
                media.stop()
            }
            error = nil
            loaded = true
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard !Task.isCancelled, session.isCurrentSession(identity) else { return }
            availability.didFailRefresh(error)
            self.error = error.localizedDescription
            loaded = true
        }
    }

    private func dial() async {
        guard canDial, CallAvailabilityPolicy.canStartOutbound(currentMediaCallID: media.callID),
              let simId = selectedSIM, let accountID = session.user?.id,
              let identity = session.sessionIdentity else { return }
        let payload = OutboundCallPayload(simId: simId, remoteNumber: PhoneNumberText.normalized(number))
        let key = OutboundCallIdempotencyStore.shared.key(accountID: accountID, payload: payload)
        loading = true
        defer { loading = false }
        // S36 C3: the dial tap is where "拨打失败" starts; the number itself is never logged, only its length.
        let startedAt = ContinuousClock.now
        let dialFields: [String: Any] = [
            "simId": simId, "numberLength": payload.remoteNumber.count, "transport": "api"
        ]
        do {
            let response: OutboundCallResponse = try await session.request(
                "calls/outbound", method: "POST", body: payload, idempotencyKey: key,
                requiredSessionIdentity: identity
            )
            Diag.shared.log(
                "dial.request", dialFields.merging(["ms": Diag.ms(since: startedAt), "code": 200]) { _, new in new },
                callId: response.call.id
            )
            // S20 decision 6: own the call id the instant the server hands it over. `load()` and `startMedia()`
            // both await afterwards, and being killed in between used to leave the gateway locked.
            IncomingCallManager.shared.registerOwnedCall(id: response.call.id, sessionIdentity: identity)
            dialFeedback += 1
            guard session.isCurrentSession(identity) else { return }
            OutboundCallIdempotencyStore.shared.markSucceeded(accountID: accountID, payload: payload, idempotencyKey: key)
            number = ""
            await load(requiredIdentity: identity)
            guard session.isCurrentSession(identity) else { return }
            await startMedia(callID: response.call.id, sessionIdentity: identity)
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            Diag.shared.log(
                "dial.request",
                dialFields.merging([
                    "ms": Diag.ms(since: startedAt), "code": (error as? APIError)?.diagCode ?? -1,
                    "message": error.localizedDescription
                ]) { _, new in new }
            )
            guard session.isCurrentSession(identity) else { return }
            self.error = APIError.dialMessage(for: error)
        }
    }

    /// S36 C2: one digit per tap, fire-and-forget. Control turns it into a single `dtmf` command with a 20 s
    /// expiry, so there is nothing to retry here — a failure is stated under the keypad and the user taps again.
    private func sendDTMF(_ digit: String, on call: CallRecord) async {
        guard let identity = session.sessionIdentity, session.isCurrentSession(identity) else { return }
        let startedAt = ContinuousClock.now
        do {
            let _: EmptyResponse = try await session.request(
                "calls/\(call.id)/dtmf", method: "POST", body: ["digits": digit],
                timeoutInterval: 4, requiredSessionIdentity: identity
            )
            Diag.shared.log("dtmf.send", ["ms": Diag.ms(since: startedAt), "code": 200], callId: call.id)
            guard session.isCurrentSession(identity) else { return }
            dtmfError = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            Diag.shared.log(
                "dtmf.send",
                ["ms": Diag.ms(since: startedAt), "code": (error as? APIError)?.diagCode ?? -1],
                callId: call.id
            )
            guard session.isCurrentSession(identity) else { return }
            dtmfError = error.localizedDescription
        }
    }

    private func claim(_ call: CallRecord) async {
        guard let identity = session.sessionIdentity,
              media.callID == nil || media.callID == call.id else { return }
        let startedAt = ContinuousClock.now
        do {
            let response: CallEnvelope = try await session.request(
                "calls/\(call.id)/claim", method: "POST",
                body: ClaimBody(platform: "ios", deviceName: UIDevice.current.name),
                requiredSessionIdentity: identity
            )
            Diag.shared.log("call.claim", ["ms": Diag.ms(since: startedAt), "code": 200], callId: call.id)
            guard session.isCurrentSession(identity) else { return }
            _ = response.call // Claiming enters connecting; Telecom ACTIVE remains authoritative.
            await load(requiredIdentity: identity)
            guard session.isCurrentSession(identity) else { return }
            await startMedia(callID: response.call.id, sessionIdentity: identity)
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            Diag.shared.log(
                "call.claim",
                ["ms": Diag.ms(since: startedAt), "code": (error as? APIError)?.diagCode ?? -1],
                callId: call.id
            )
            guard session.isCurrentSession(identity) else { return }
            self.error = error.localizedDescription
        }
    }

    private func end(_ call: CallRecord) async {
        guard let identity = session.sessionIdentity, session.isCurrentSession(identity) else { return }
        Diag.shared.log("call.end", ["state": call.state ?? "unknown", "hasMedia": media.callID == call.id], callId: call.id)
        if media.callID == call.id { media.stop() }
        CallCoordinator.shared.endCall(id: call.id)
        ReliableCallEndQueue.shared.enqueue(callID: call.id, session: session, sessionIdentity: identity)
        try? await Task.sleep(for: .milliseconds(250))
        await load(requiredIdentity: identity)
    }

    /// S20 decision 6: hand the gateway back from a call this account owns but this session does not.
    ///
    /// Deliberately a single `POST /calls/{id}/end`, not a `ReliableCallEndQueue` entry. The queue retries for about
    /// 90 s, and the body this action sends carries no session guard — a retry issued after another device answered
    /// would hang that call up. A failure is reported and the list refreshed instead; the user can press again.
    private func release(_ call: CallRecord) async {
        guard let identity = session.sessionIdentity, session.isCurrentSession(identity) else { return }
        endFeedback += 1
        do {
            let _: CallEnvelope = try await session.request(
                "calls/\(call.id)/end", method: "POST",
                body: OccupancyReleaseActionPolicy.body(for: call),
                timeoutInterval: 8, requiredSessionIdentity: identity
            )
            guard session.isCurrentSession(identity) else { return }
            error = nil
        } catch SessionLifecycleError.staleSession {
            return
        } catch {
            guard session.isCurrentSession(identity) else { return }
            // 409 CALL_NOT_RINGING / CALL_NOT_SESSION_OWNER land here too: the state moved on, so the refresh
            // below shows what is actually true rather than this request being repeated against it.
            self.error = error.localizedDescription
        }
        await load(requiredIdentity: identity)
    }

    private func decline(_ call: CallRecord) async {
        // The button is already hidden for a suppressed call; the guard is what makes that a rule rather than a
        // layout detail, so a queued tap from the previous render can never decline the AI's call.
        guard call.state == "incoming_ringing", !call.suppressesRinging, let identity = session.sessionIdentity,
              session.isCurrentSession(identity) else { return }
        ReliableCallEndQueue.shared.enqueue(
            callID: call.id, session: session, sessionIdentity: identity, constraint: .ringingUnclaimed
        )
        try? await Task.sleep(for: .milliseconds(250))
        await load(requiredIdentity: identity)
    }

    @ViewBuilder private func mediaControls(for call: CallRecord) -> some View {
        if media.callID != nil, media.callID != call.id {
            Label("另一通话正在使用本机音频", systemImage: "waveform.slash")
                .font(.footnote).foregroundStyle(.secondary)
        } else if call.claimedByCurrentSession != true, ["connecting", "active"].contains(call.state ?? "") {
            Label("此通话由其他登录会话接听", systemImage: "person.crop.circle.badge.checkmark")
                .font(.footnote).foregroundStyle(.secondary)
        } else if CallAvailabilityPolicy.canUseMedia(for: call, currentMediaCallID: media.callID) {
            switch media.state {
            case .idle:
                Button("连接通话音频") { Task { await startMedia(callID: call.id, sessionIdentity: session.sessionIdentity) } }
            case .connecting:
                Button("取消音频连接", role: .cancel) { media.stop() }
            case .connected:
                Button("断开通话音频", role: .destructive) { media.stop() }
            case .failed:
                // "重试音频" re-runs UDP with the automatic TLS fallback, so a separate TLS button adds nothing.
                mediaRecoveryControls(call)
            }
        }
    }

    private func startMedia(callID: String, sessionIdentity identity: UUID?) async {
        guard let identity, session.isCurrentSession(identity),
              media.callID == nil || media.callID == callID else { return }
        await media.start(callID: callID, session: session, automaticallyRetryTLS: true) { [weak session] failedCallID in
            guard let session, session.isCurrentSession(identity) else { return }
            ReliableCallEndQueue.shared.enqueue(callID: failedCallID, session: session, sessionIdentity: identity)
        }
    }

    private var mediaIcon: String {
        switch media.state {
        case .connected: "waveform"
        case .connecting: "antenna.radiowaves.left.and.right"
        case .failed: "exclamationmark.triangle"
        case .idle: "speaker.slash"
        }
    }

    private struct ClaimBody: Encodable { let platform, deviceName: String }
    private struct CallEnvelope: Decodable { let call: CallRecord }
    private struct OutboundCallResponse: Decodable { let call: CallRecord }
}

// `callStateTitle` and `callOwnerTitle` moved to Components.swift so the records list can render the same
// Chinese state wording instead of the raw server string (S20 decision 8).
