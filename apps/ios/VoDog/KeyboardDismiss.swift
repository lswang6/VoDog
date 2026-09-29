import SwiftUI
import UIKit

/// S30 bug fix: tapping outside a text field never dismissed the software keyboard — on the login page, in the
/// dialer, in every sheet. The app had no `resignFirstResponder`, no `endEditing`, no keyboard toolbar and no
/// `scrollDismissesKeyboard` anywhere.
///
/// The rule itself is here as a pure function because the interesting part is not "dismiss the keyboard" but
/// *when not to*: a tap that lands on a text input must be left alone, otherwise moving from 用户名 straight
/// into 密码 would close the keyboard and open it again, and a tap inside the field you are already editing
/// would fight the caret.
enum KeyboardDismissPolicy {
    static let doneTitle = "完成"
    static let doneAccessibilityIdentifier = "keyboard.done"

    /// The window-level recogniser sees every tap in the app. It dismisses for anything that is not a text
    /// input, and stays out of the way for anything that is.
    static func shouldDismiss(touchOnTextInput: Bool) -> Bool { !touchOnTextInput }

    /// Whether the touched node — or any node above it — is a text input. A `UITextField` hands its touches to
    /// an inner editing view, so testing `touch.view` alone is not enough; the ancestors have to be walked.
    ///
    /// Generic over the tree so the walk is pinned by a unit test without a live view hierarchy; the app passes
    /// UIKit's `superview` chain. The step limit is a cycle guard, not a depth policy — a view tree that deep is
    /// already broken, and an infinite loop inside a gesture delegate would hang the whole UI.
    static let maximumAncestorWalk = 256

    static func touchesTextInput<Node>(
        _ node: Node?, isTextInput: (Node) -> Bool, parent: (Node) -> Node?
    ) -> Bool {
        var current = node
        var steps = 0
        while let candidate = current, steps < maximumAncestorWalk {
            if isTextInput(candidate) { return true }
            current = parent(candidate)
            steps += 1
        }
        return false
    }
}

/// The one place the app deliberately puts the keyboard *back*.
///
/// 对话回复栏 behaves like Messages.app: sending one message leaves the keyboard up for the next. Two things
/// take it away in the meantime — the window recogniser above (发送 is not a text input) and, since long before
/// it, `.disabled(isSending)` on the field, which resigns focus for the length of the request. So the reply bar
/// remembers whether it had focus when 发送 was tapped and asks for it back once the send has actually landed.
enum ReplyFocusPolicy {
    /// Only a send that both started from the keyboard and succeeded gets the keyboard back. A failed send
    /// leaves the error on screen and the focus wherever it ended up: pulling the keyboard up over a failure
    /// message the user has not read yet would hide the reason the message did not go.
    static func shouldRestoreFocus(wasFocused: Bool, sendSucceeded: Bool) -> Bool {
        wasFocused && sendSucceeded
    }
}

/// Resigning the first responder without a `@FocusState` to hand: the 完成 key above a number pad has no field
/// of its own to unfocus, and neither does anything else that wants the keyboard gone.
enum KeyboardDismisser {
    @MainActor
    static func dismiss() {
        PasskeyPresentationAnchor.keyWindow()?.endEditing(true)
    }
}

/// One tap recogniser on the key `UIWindow`, installed once from `RootView`.
///
/// It has to be the window rather than a SwiftUI modifier because sheets (`ContactEditView`,
/// `ComposeMessageView`, `PageJumpSheet`, `ContactCardView`) and `NavigationStack` destinations are separate
/// view hierarchies — a `.onTapGesture` on `RootView` would never see a tap inside any of them. They all live in
/// the same window, so one recogniser there covers the whole app including screens written later.
///
/// `cancelsTouchesInView = false` plus simultaneous recognition means it only *observes*: list rows still
/// select, `swipeActions` still swipe, bubbles still long-press, buttons still fire.
struct KeyboardDismissInstaller: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> AnchorView {
        let view = AnchorView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        view.onWindowChange = { [coordinator = context.coordinator] window in
            coordinator.install(on: window ?? PasskeyPresentationAnchor.keyWindow())
        }
        return view
    }

    func updateUIView(_ uiView: AnchorView, context: Context) {
        context.coordinator.install(on: uiView.window ?? PasskeyPresentationAnchor.keyWindow())
    }

    /// A zero-sized, non-interactive view whose only job is to say which window SwiftUI put us in.
    final class AnchorView: UIView {
        var onWindowChange: ((UIWindow?) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            onWindowChange?(window)
        }
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private weak var installedWindow: UIWindow?
        private var recognizer: UITapGestureRecognizer?

        /// Idempotent: SwiftUI calls `updateUIView` on every pass, and the app must end up with exactly one
        /// recogniser on exactly one window no matter how often that happens.
        func install(on window: UIWindow?) {
            guard let window else { return }
            if installedWindow === window, let recognizer, recognizer.view === window { return }
            if let recognizer { recognizer.view?.removeGestureRecognizer(recognizer) }
            let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
            // Observe only. Without this the tap would swallow the touch and a tap on a row or a button would
            // dismiss the keyboard instead of doing what it was for.
            tap.cancelsTouchesInView = false
            tap.delaysTouchesBegan = false
            tap.delaysTouchesEnded = false
            tap.delegate = self
            window.addGestureRecognizer(tap)
            recognizer = tap
            installedWindow = window
        }

        @objc private func handleTap(_ sender: UITapGestureRecognizer) {
            sender.view?.endEditing(true)
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch
        ) -> Bool {
            let onTextInput = KeyboardDismissPolicy.touchesTextInput(
                touch.view, isTextInput: { $0 is UITextInput }, parent: { $0.superview }
            )
            return KeyboardDismissPolicy.shouldDismiss(touchOnTextInput: onTextInput)
        }

        /// Returning true from one side is enough to guarantee simultaneous recognition, so nothing this
        /// recogniser sees can cancel a row tap, a swipe or a long press.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }
    }
}

extension View {
    /// Install the app-wide "tap anywhere else to dismiss" recogniser. Applied once, on `RootView`.
    func dismissesKeyboardOnBackgroundTap() -> some View {
        background(KeyboardDismissInstaller().frame(width: 0, height: 0).allowsHitTesting(false))
    }

    /// A 完成 key above the keyboard. A number pad has no return key at all, so without this the phone-number
    /// and page-jump fields had no escape of their own; it is applied to the whole sheet rather than to each
    /// field so a sheet with several fields still declares exactly one toolbar.
    func keyboardDoneToolbar() -> some View {
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button(KeyboardDismissPolicy.doneTitle) { KeyboardDismisser.dismiss() }
                    .accessibilityIdentifier(KeyboardDismissPolicy.doneAccessibilityIdentifier)
            }
        }
    }
}
