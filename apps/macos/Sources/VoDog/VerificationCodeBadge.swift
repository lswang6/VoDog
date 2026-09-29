import AppKit
import SwiftUI

struct VerificationCodeBadge: View {
    let code: String
    var onCopy: (() -> Void)?

    @State private var copied = false
    @State private var resetTask: Task<Void, Never>?

    var body: some View {
        Button {
            copyCode()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: copied ? "checkmark" : "key.fill")
                    .font(.system(size: 9, weight: .bold))
                Text(code)
                    .font(.caption.monospaced().weight(.semibold))
            }
            .foregroundStyle(copied ? Color.green : Color.accentColor)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                (copied ? Color.green : Color.accentColor).opacity(0.12),
                in: Capsule()
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(
            copied
                ? L10n.tr("验证码已复制")
                : L10n.tr("点击复制验证码 %@", code)
        )
        .accessibilityLabel(L10n.tr("验证码 %@，点击复制", code))
        .onDisappear {
            resetTask?.cancel()
            resetTask = nil
        }
    }

    private func copyCode() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        onCopy?()
        resetTask?.cancel()
        copied = true
        resetTask = Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            copied = false
        }
    }
}
