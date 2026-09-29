import SwiftUI

/// Main-window "VoDog" section (spec S54): the login page while signed out, otherwise a
/// secondary navigation bar over the five account pages.
struct VoDogSectionView: View {
    @ObservedObject var account: VoDogAccount
    @AppStorage("VoDogSection.page.v1") private var pageRawValue = Page.contacts.rawValue
    @State private var recordsSidebarWidth: CGFloat = 330

    enum Page: String, CaseIterable, Identifiable {
        case contacts, blocklist, records, numbers, account
        var id: String { rawValue }

        var title: String {
            switch self {
            case .contacts: return L10n.tr("通讯录")
            case .blocklist: return L10n.tr("屏蔽与拦截")
            case .records: return L10n.tr("记录与报告")
            case .numbers: return L10n.tr("号码与接听")
            case .account: return L10n.tr("账号")
            }
        }
    }

    private var page: Binding<Page> {
        Binding(get: { Page(rawValue: pageRawValue) ?? .contacts }, set: { pageRawValue = $0.rawValue })
    }

    var body: some View {
        if account.user == nil {
            VoDogLoginView(account: account)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .communicationDetailColumnStyle()
        } else {
            VStack(spacing: 0) {
                header
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            PagePicker(badges: account.badges, page: page)

            Spacer(minLength: 8)

            if let notice = account.notice {
                Label(notice, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .lineLimit(1)
                    .help(notice)
            } else if account.isVerifying {
                ProgressView().controlSize(.small)
            }

            Label(account.user?.username ?? "", systemImage: "person.crop.circle")
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 18)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background {
            AdaptiveGlassBackdrop(treatment: .regular)
                .ignoresSafeArea(.container, edges: .top)
        }
    }

    /// S67: a native segment cannot hold a red capsule, so 记录与报告 carries the pending-calls count in its title.
    private struct PagePicker: View {
        @ObservedObject var badges: VoDogBadgeStore
        let page: Binding<Page>

        var body: some View {
            Picker(L10n.tr("VoDog"), selection: page) {
                ForEach(Page.allCases) { item in
                    let count = item == .records ? VoDogBadges.text(badges.counts.calls) : nil
                    Text(count.map { "\(item.title) (\($0))" } ?? item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch page.wrappedValue {
        case .contacts: VoDogContactsView(account: account)
        case .blocklist: VoDogBlocklistView(account: account)
        case .records: VoDogRecordsView(account: account, sidebarWidth: $recordsSidebarWidth)
        case .numbers: VoDogNumbersView(account: account)
        case .account: VoDogAccountView(account: account)
        }
    }
}
