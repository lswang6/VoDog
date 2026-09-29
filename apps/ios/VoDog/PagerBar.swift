import SwiftUI

/// S26. The pager for the three 记录 segments.
///
/// It is attached with `.safeAreaInset(edge: .bottom)` rather than a `.bottomBar` toolbar: 记录 is a tab of
/// `MainView`'s `TabView`, and a bottom bar there stacks on top of the tab bar; the inset is also what 通话 and
/// 短信 already use for their own pinned bars, and it gives the two-row accessibility layout room a toolbar
/// would not. The bar hides itself when the server does not page, or on a single short page at the default
/// 每页 50 条 — never at a size the user picked, which they would otherwise be unable to change back.
struct PagerBar: View {
    @Bindable var store: RecordsPagingStore
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var showingJump = false

    var body: some View {
        // The sheet is attached outside the visibility check on purpose: a request that fails while 跳转到指定页
        // is open calls `clearPaging()`, and a sheet whose host has just disappeared dismisses itself untidily.
        Group {
            if store.showsPager { bar }
        }
        .sheet(isPresented: $showingJump) {
            PageJumpSheet(current: store.page, totalPages: store.totalPages) { store.page = $0 }
        }
    }

    private var bar: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                // At accessibility sizes 第 x / y 页 + 每页 n 条 cannot share one line without truncating, so
                // the navigation keeps the first row and the two labels take the second.
                VStack(spacing: 2) {
                    HStack(spacing: 4) { previousButton; Spacer(minLength: 0); pageButton; Spacer(minLength: 0); nextButton }
                    HStack(spacing: 8) { totalLabel; Spacer(minLength: 0); pageSizeMenu }
                }
            } else {
                HStack(spacing: 4) {
                    previousButton
                    Spacer(minLength: 0)
                    VStack(spacing: 0) { pageButton; totalLabel }
                    Spacer(minLength: 0)
                    nextButton
                    pageSizeMenu
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .frame(maxWidth: 620)
        .frame(maxWidth: .infinity)
        .background(.regularMaterial)
        .accessibilityIdentifier("records.pager")
    }

    private var previousButton: some View {
        Button {
            store.page = RecordsPagingPolicy.previousPage(store.page)
        } label: {
            Image(systemName: "chevron.left").frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .disabled(!RecordsPagingPolicy.canGoPrevious(page: store.page))
        .accessibilityLabel(RecordsPagingPolicy.previousLabel)
        .accessibilityIdentifier("records.pager.previous")
    }

    private var nextButton: some View {
        Button {
            store.page = RecordsPagingPolicy.nextPage(store.page, totalPages: store.totalPages)
        } label: {
            Image(systemName: "chevron.right").frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .disabled(!RecordsPagingPolicy.canGoNext(page: store.page, totalPages: store.totalPages))
        .accessibilityLabel(RecordsPagingPolicy.nextLabel)
        .accessibilityIdentifier("records.pager.next")
    }

    private var pageButton: some View {
        Button {
            showingJump = true
        } label: {
            Text(RecordsPagingPolicy.pageLabel(page: store.page, totalPages: store.totalPages))
                .font(.subheadline.weight(.medium)).monospacedDigit()
                .frame(minHeight: 32).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.callerAccent)
        .accessibilityLabel(RecordsPagingPolicy.jumpLabel)
        .accessibilityValue(RecordsPagingPolicy.pageLabel(page: store.page, totalPages: store.totalPages))
        .accessibilityIdentifier("records.pager.page")
    }

    private var totalLabel: some View {
        Text(RecordsPagingPolicy.totalLabel(total: store.total))
            .font(.caption).foregroundStyle(.secondary).monospacedDigit()
    }

    private var pageSizeMenu: some View {
        Menu {
            Picker("每页", selection: $store.pageSizeSelection) {
                ForEach(RecordsPagingPolicy.pageSizes, id: \.self) { size in
                    Text("\(size) 条").tag(size)
                }
            }
        } label: {
            Text(RecordsPagingPolicy.pageSizeLabel(store.pageSize))
                .font(.caption).monospacedDigit()
                .frame(minHeight: 44).contentShape(Rectangle())
        }
        .accessibilityLabel(RecordsPagingPolicy.pageSizeAccessibilityLabel(store.pageSize))
        .accessibilityIdentifier("records.pager.pageSize")
    }
}

/// 跳转到指定页. A number pad rather than a slider: with 200 pages of interceptions, scrubbing to page 137 is
/// not a gesture anyone can land. Whatever is typed is clamped to a page that exists.
struct PageJumpSheet: View {
    let current: Int
    let totalPages: Int?
    let jump: (Int) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var value: Int?

    init(current: Int, totalPages: Int?, jump: @escaping (Int) -> Void) {
        self.current = current
        self.totalPages = totalPages
        self.jump = jump
        _value = State(initialValue: current)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(RecordsPagingPolicy.jumpFieldPrompt, value: $value, format: .number)
                        .keyboardType(.numberPad)
                        .monospacedDigit()
                        .frame(minHeight: 44)
                        .accessibilityLabel(RecordsPagingPolicy.jumpFieldPrompt)
                        .accessibilityIdentifier("records.pager.jumpField")
                } footer: {
                    Text("共 \(totalPages ?? current) 页")
                }
            }
            .navigationTitle(RecordsPagingPolicy.jumpLabel)
            .navigationBarTitleDisplayMode(.inline)
            // 页码 is a `.numberPad`: no return key, and the sheet is only 240 pt tall, so the keyboard covers
            // 跳转 until something puts it away.
            .keyboardDoneToolbar()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(RecordsPagingPolicy.jumpCancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(RecordsPagingPolicy.jumpConfirm) {
                        jump(RecordsPagingPolicy.clampPage(value ?? current, totalPages: totalPages))
                        dismiss()
                    }
                    .accessibilityIdentifier("records.pager.jumpConfirm")
                }
            }
        }
        .presentationDetents([.height(240)])
    }
}

#if DEBUG
private struct PagerBarPreviewHost: View {
    @State private var store = RecordsPagingStore(page: 3, pageSize: 100, total: 613, totalPages: 7)

    var body: some View {
        VStack(spacing: 0) {
            List { ForEach(0..<8, id: \.self) { Text("记录行 \($0 + 1)") } }
        }
        .safeAreaInset(edge: .bottom) { PagerBar(store: store) }
    }
}

#Preview("分页栏 3/7") {
    PagerBarPreviewHost()
}
#endif
