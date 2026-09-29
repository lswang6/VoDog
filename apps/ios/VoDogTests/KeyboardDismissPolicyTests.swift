import UIKit
import XCTest
@testable import VoDog

/// The window-level tap recogniser sees every touch in the app, so the one rule that decides whether it acts is
/// pinned here rather than living inside a gesture delegate nobody can run.
final class KeyboardDismissPolicyTests: XCTestCase {
    func testATapOnAnythingButATextInputDismissesTheKeyboard() {
        XCTAssertTrue(KeyboardDismissPolicy.shouldDismiss(touchOnTextInput: false))
        // 用户名 → 密码 must not close the keyboard on the way; the field itself owns that touch.
        XCTAssertFalse(KeyboardDismissPolicy.shouldDismiss(touchOnTextInput: true))
    }

    func testTextInputIsRecognisedThroughItsAncestorsNotJustTheTouchedView() {
        // A UITextField hands touches to an inner editing view, so the touched node is usually a child.
        final class Node {
            let isField: Bool
            let parent: Node?
            init(isField: Bool, parent: Node? = nil) {
                self.isField = isField
                self.parent = parent
            }
        }
        let field = Node(isField: true)
        let editor = Node(isField: false, parent: field)
        let caret = Node(isField: false, parent: editor)
        let walk: (Node?) -> Bool = {
            KeyboardDismissPolicy.touchesTextInput($0, isTextInput: { $0.isField }, parent: { $0.parent })
        }
        XCTAssertTrue(walk(caret), "A touch two levels inside a text field is still a touch on the field")
        XCTAssertTrue(walk(field))

        let background = Node(isField: false, parent: Node(isField: false))
        XCTAssertFalse(walk(background))
        XCTAssertFalse(walk(nil), "A touch with no view is a touch on the window, which dismisses")
    }

    func testTheAncestorWalkCannotHangOnACyclicTree() {
        // A gesture delegate runs on the main thread on every touch; an unbounded walk would freeze the app.
        final class Loop {
            var parent: Loop?
        }
        let a = Loop()
        let b = Loop()
        a.parent = b
        b.parent = a
        XCTAssertFalse(
            KeyboardDismissPolicy.touchesTextInput(a, isTextInput: { _ in false }, parent: { $0.parent })
        )
        XCTAssertEqual(KeyboardDismissPolicy.maximumAncestorWalk, 256)
    }

    /// The real UIKit predicate the delegate uses, against a real view tree.
    @MainActor
    func testRealUITextFieldSubviewCountsAsATextInputAndAPlainViewDoesNot() {
        let field = UITextField(frame: .init(x: 0, y: 0, width: 100, height: 40))
        let inner = UIView()
        field.addSubview(inner)
        let plain = UIView()
        let child = UIView()
        plain.addSubview(child)

        let isTextInput: (UIView) -> Bool = { $0 is UITextInput }
        let parent: (UIView) -> UIView? = { $0.superview }
        XCTAssertTrue(KeyboardDismissPolicy.touchesTextInput(inner, isTextInput: isTextInput, parent: parent))
        XCTAssertTrue(KeyboardDismissPolicy.touchesTextInput(field, isTextInput: isTextInput, parent: parent))
        XCTAssertFalse(KeyboardDismissPolicy.touchesTextInput(child, isTextInput: isTextInput, parent: parent))
        // A UITextView is the other editor the app can show; it is a text input too.
        XCTAssertTrue(
            KeyboardDismissPolicy.touchesTextInput(UITextView(), isTextInput: isTextInput, parent: parent)
        )
    }

    /// 对话回复栏 keeps the keyboard the way Messages.app does — but only for a send that started from the
    /// keyboard and actually went out.
    func testTheReplyBarTakesTheKeyboardBackOnlyAfterASendThatStartedFocusedAndSucceeded() {
        XCTAssertTrue(ReplyFocusPolicy.shouldRestoreFocus(wasFocused: true, sendSucceeded: true))
        // A failed send leaves the error on screen; pulling the keyboard up would cover the reason it failed.
        XCTAssertFalse(ReplyFocusPolicy.shouldRestoreFocus(wasFocused: true, sendSucceeded: false))
        // 发送 tapped with the keyboard already down (a draft restored from a previous visit) stays down.
        XCTAssertFalse(ReplyFocusPolicy.shouldRestoreFocus(wasFocused: false, sendSucceeded: true))
        XCTAssertFalse(ReplyFocusPolicy.shouldRestoreFocus(wasFocused: false, sendSucceeded: false))
    }

    func testDoneKeyCopyAndIdentifier() {
        XCTAssertEqual(KeyboardDismissPolicy.doneTitle, "完成")
        XCTAssertEqual(KeyboardDismissPolicy.doneAccessibilityIdentifier, "keyboard.done")
    }

    /// The recogniser must end up installed exactly once, however many times SwiftUI re-runs `updateUIView`.
    @MainActor
    func testInstallingTheRecogniserIsIdempotentAndFollowsTheWindow() {
        let coordinator = KeyboardDismissInstaller.Coordinator()
        let window = UIWindow(frame: .init(x: 0, y: 0, width: 390, height: 844))
        coordinator.install(on: window)
        coordinator.install(on: window)
        coordinator.install(on: window)
        // A real UIWindow already carries UIKit's own recognisers, so only the ones this coordinator owns count.
        XCTAssertEqual(
            Self.installed(on: window, by: coordinator).count, 1,
            "SwiftUI calls updateUIView constantly; one window must keep one recogniser"
        )
        let tap = Self.installed(on: window, by: coordinator).first
        XCTAssertEqual(tap?.cancelsTouchesInView, false, "The recogniser observes; it must not swallow the touch")

        // A new window (a scene change) moves the recogniser rather than leaving one behind on the old one.
        let replacement = UIWindow(frame: window.frame)
        coordinator.install(on: replacement)
        XCTAssertEqual(Self.installed(on: window, by: coordinator).count, 0)
        XCTAssertEqual(Self.installed(on: replacement, by: coordinator).count, 1)

        // A nil window (nothing on screen yet) is a no-op, never a crash and never a second recogniser.
        coordinator.install(on: nil)
        XCTAssertEqual(Self.installed(on: replacement, by: coordinator).count, 1)
    }

    @MainActor
    private static func installed(
        on window: UIWindow, by coordinator: KeyboardDismissInstaller.Coordinator
    ) -> [UIGestureRecognizer] {
        (window.gestureRecognizers ?? []).filter { $0.delegate === coordinator }
    }

    /// The delegate that keeps 用户名 → 密码 from flickering, exercised against real views.
    @MainActor
    func testGestureDelegateIgnoresTouchesThatLandOnATextField() {
        let coordinator = KeyboardDismissInstaller.Coordinator()
        let window = UIWindow(frame: .init(x: 0, y: 0, width: 390, height: 844))
        coordinator.install(on: window)
        let recognizer = Self.installed(on: window, by: coordinator).first
        let field = UITextField(frame: .init(x: 0, y: 0, width: 200, height: 40))
        let inner = UIView()
        field.addSubview(inner)
        window.addSubview(field)
        let background = UIView(frame: window.bounds)
        window.addSubview(background)

        guard let recognizer else { return XCTFail("No recogniser was installed") }
        XCTAssertFalse(coordinator.gestureRecognizer(recognizer, shouldReceive: StubTouch(view: field)))
        XCTAssertFalse(coordinator.gestureRecognizer(recognizer, shouldReceive: StubTouch(view: inner)))
        XCTAssertTrue(coordinator.gestureRecognizer(recognizer, shouldReceive: StubTouch(view: background)))
        XCTAssertTrue(
            coordinator.gestureRecognizer(
                recognizer, shouldRecognizeSimultaneouslyWith: UILongPressGestureRecognizer()
            ),
            "Nothing this recogniser sees may cancel a row tap, a swipe action or a bubble long press"
        )
    }
}

/// `UITouch.view` is read-only, so the delegate is exercised through a stub that answers the one question it asks.
private final class StubTouch: UITouch {
    private let stubbedView: UIView?

    init(view: UIView?) {
        stubbedView = view
        super.init()
    }

    override var view: UIView? { stubbedView }
}
