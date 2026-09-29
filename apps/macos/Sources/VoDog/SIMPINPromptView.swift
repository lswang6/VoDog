import SwiftUI

/// Collects a SIM PIN for one module. The PIN stays in view state only and is
/// cleared after every submission; it is never stored or logged.
struct SIMPINPromptView: View {
    @EnvironmentObject private var appState: AppState
    let moduleID: CellularModuleID
    /// Turns off the PIN lock of an unlocked SIM (CLCK only) instead of unlocking it.
    let disablingLock: Bool
    let onClose: () -> Void

    @State private var pin = ""
    @State private var disablePINLock = true
    @State private var remaining: Int?
    @State private var isPUKLocked = false
    @State private var isSubmitting = false
    @State private var errorText: String?
    @FocusState private var pinFocused: Bool

    private var isLocked: Bool {
        isPUKLocked || remaining == 0 ||
            appState.communicationModuleSnapshot(moduleID).simState == .pukRequired
    }

    private var pinIsValid: Bool {
        (4 ... 8).contains(pin.count) && pin.allSatisfy { ("0" ... "9").contains($0) }
    }

    var body: some View {
        ZStack {
            AdaptiveGlassBackdrop()
                .ignoresSafeArea()
            content
                .padding(24)
        }
        .frame(width: 360, height: 280)
        .onAppear {
            pinFocused = true
            appState.querySIMPINRemaining(moduleID: moduleID) { remaining = $0 }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n.tr(disablingLock ? "关闭 PIN 锁" : "输入 SIM PIN"))
                .font(.title3.weight(.semibold))
            if disablingLock {
                Text(L10n.tr("关闭后，SIM 卡开机时不再要求输入 PIN。"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if isLocked {
                Label(L10n.tr("SIM 已被 PUK 锁定，请联系运营商"), systemImage: "lock.fill")
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                SecureField(L10n.tr("4–8 位数字"), text: $pin)
                    .textFieldStyle(.roundedBorder)
                    .focused($pinFocused)
                    .disabled(isSubmitting)
                    .onSubmit(submit)

                if let errorText {
                    Text(verbatim: errorText)
                        .font(.caption)
                        .foregroundStyle(.red)
                } else if let remaining {
                    Text(L10n.tr("剩余 %lld 次", Int64(remaining)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if remaining == 1 {
                    Text(L10n.tr("再输错一次 PIN，SIM 将被锁定，需要 PUK 解锁。"))
                        .font(.caption)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !disablingLock {
                    Toggle(L10n.tr("解锁后关闭 PIN 锁"), isOn: $disablePINLock)
                        .disabled(isSubmitting)
                }
            }

            Spacer(minLength: 0)

            HStack {
                Spacer()
                Button(L10n.tr("取消"), action: onClose)
                    .keyboardShortcut(.cancelAction)
                if !isLocked {
                    Button(L10n.tr(disablingLock ? "关闭 PIN 锁" : "解锁"), action: submit)
                        .keyboardShortcut(.defaultAction)
                        .disabled(!pinIsValid || isSubmitting)
                }
            }
        }
    }

    private func submit() {
        guard pinIsValid, !isSubmitting, !isLocked else { return }
        let enteredPIN = pin
        pin = ""
        isSubmitting = true
        errorText = nil
        let handle: (SIMPINUnlockResult) -> Void = { result in
            isSubmitting = false
            switch result {
            case .unlocked:
                onClose()
            case .pukRequired:
                isPUKLocked = true
            case .wrongPIN(let left):
                remaining = left
                errorText = left.map { L10n.tr("PIN 错误，剩余 %lld 次", Int64($0)) } ?? L10n.tr("PIN 错误")
                pinFocused = true
            case .failure(let message):
                errorText = message
                appState.querySIMPINRemaining(moduleID: moduleID) { remaining = $0 }
            }
        }
        if disablingLock {
            appState.disableSIMPINLock(enteredPIN, moduleID: moduleID, completion: handle)
        } else {
            appState.unlockSIMPIN(enteredPIN, disablePINLock: disablePINLock, moduleID: moduleID, completion: handle)
        }
    }
}
