import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    if !condition() {
        FileHandle.standardError.write(Data("VoDogContactsSelfTests failed (line \(line)): \(message)\n".utf8))
        exit(1)
    }
}

typealias Logic = VoDogContactsLogic

// Tolerant decode: missing version / child arrays, nulls.
do {
    let contact = try Logic.decode(VoDogContact.self, from: [
        "id": "c1", "displayName": "张三", "organization": NSNull(),
        "phones": [["id": "p1", "rawNumber": "202 555 0123", "e164": "+12025550123",
                    "blocked": true, "blockedEntryId": "b1"]],
    ] as [String: Any])
    check(contact.version == 1, "missing version defaults to 1")
    check(contact.emails.isEmpty && contact.addresses.isEmpty, "missing arrays default to []")
    check(contact.organization == nil, "null decodes as nil")
    check(contact.isBlocked, "phone-level blocked marks the contact")
    check(contact.primaryPhone?.displayNumber == "+12025550123", "display number prefers e164")
} catch { check(false, "decode threw \(error)") }

// Paged envelope with and without paging keys.
do {
    let paged = try Logic.decode(VoDogPage<VoDogInterception>.self, from: [
        "items": [["id": "i1", "kind": "sms", "bodyPreview": "hi", "source": "phone", "blockedEntryId": NSNull()]],
        "page": 1, "pageSize": 50, "total": 1, "totalPages": 1,
    ] as [String: Any])
    check(paged.items.first?.isSMS == true && paged.totalPages == 1, "interception page decodes")
    check(paged.items.first?.blockedEntryId == nil, "null blockedEntryId")
    let bare = try Logic.decode(VoDogPage<VoDogBlockedNumber>.self, from: [
        "items": [["id": "b1", "remoteNumber": "+12025550123", "createdAt": "2026-09-23T01:02:03.456Z"]],
    ] as [String: Any])
    check(bare.totalPages == nil && bare.items.count == 1, "bare {items} decodes")
} catch { check(false, "page decode threw \(error)") }

// Draft validation and write body.
do {
    var draft = VoDogContactDraft()
    draft.displayName = "  "
    draft.phones = [.init(label: "", value: "13800000000")]
    check(!draft.isValid, "blank displayName rejected")
    draft.displayName = "李四"
    draft.phones = [.init(label: "", value: "abc")]
    check(!draft.isValid, "displayName only (no digit phone) rejected")
    draft.emails = [.init(label: "work", value: "a@b.c")]
    check(draft.isValid, "displayName + email accepted")
    draft.emails = []
    draft.phones = [.init(label: " mobile ", value: " 138 0000  0000 ")]
    check(draft.isValid, "displayName + phone accepted")
    let body = draft.body(expectedVersion: nil)
    check(body["expectedVersion"] == nil, "create omits expectedVersion")
    check(body["givenName"] == nil, "empty optionals omitted")
    let phones = body["phones"] as? [[String: Any]]
    check(phones?.first?["rawNumber"] as? String == "138 0000 0000", "whitespace collapsed, formatting kept")
    check(phones?.first?["label"] as? String == "mobile", "label trimmed")
}

// Edit keeps addresses verbatim (PUT replaces them).
do {
    let contact = try Logic.decode(VoDogContact.self, from: [
        "id": "c2", "version": 7, "displayName": "王五",
        "phones": [["id": "p", "rawNumber": "10086"]],
        "addresses": [["id": "a", "city": "深圳", "street": "深南大道", "label": "work"]],
    ] as [String: Any])
    let body = VoDogContactDraft(contact).body(expectedVersion: contact.version)
    check(body["expectedVersion"] as? Int == 7, "edit sends expectedVersion")
    let addresses = body["addresses"] as? [[String: Any]]
    check(addresses?.count == 1, "address round-trips")
    check(addresses?.first?["city"] as? String == "深圳" && addresses?.first?["street"] as? String == "深南大道",
          "address fields unchanged")
    check(addresses?.first?["formatted"] == nil && addresses?.first?["id"] == nil, "no nulls or ids sent")
    check(JSONSerialization.isValidJSONObject(body), "body is valid JSON")
} catch { check(false, "address decode threw \(error)") }

// Conflict predicate.
check(Logic.isVersionConflict(status: 409, code: "CONTACT_VERSION_CONFLICT"), "409 conflict")
check(Logic.isVersionConflict(status: 428, code: "CONTACT_VERSION_REQUIRED"), "428 required")
check(!Logic.isVersionConflict(status: 409, code: "IDEMPOTENCY_CONFLICT"), "idempotency conflict is not a version conflict")
check(!Logic.isVersionConflict(status: 404, code: "NOT_FOUND"), "404 is not a conflict")

// Emergency / canBlock.
check(Logic.isEmergency("112") && Logic.isEmergency("9-1-1") && Logic.isEmergency(" 911 "), "emergency numbers")
check(!Logic.isEmergency("110") && !Logic.isEmergency("1120"), "non-emergency")
check(!Logic.canBlock("911") && !Logic.canBlock("") && !Logic.canBlock("abc") && !Logic.canBlock(nil), "cannot block")
check(Logic.canBlock("+86 202 555 0123"), "can block normal number")

// Source labels.
check(Logic.sourceTitleKey("phone") == "手机自动拦截", "phone source")
check(Logic.sourceTitleKey("gateway") == "网关拦截", "gateway source")
check(Logic.sourceTitleKey("control") == "服务器拦截", "control source")
check(Logic.sourceTitleKey("x") == nil && Logic.sourceTitleKey(nil) == nil, "unknown source prints nothing")

// Blocklist fallback lookup.
do {
    let items = try Logic.decode(VoDogPage<VoDogBlockedNumber>.self, from: [
        "items": [["id": "x", "remoteNumber": "10086"], ["id": "y", "remoteNumber": "+12025550123"]],
    ] as [String: Any]).items
    check(Logic.blockedEntryID(for: "202 555 0123", in: items) == "y", "e164 vs national matches")
    check(Logic.blockedEntryID(for: "10086", in: items) == "x", "exact short match")
    check(Logic.blockedEntryID(for: "086", in: items) == nil, "short fragment never suffix-matches")
} catch { check(false, "lookup decode threw \(error)") }

// Gateway time zone formatting.
check(Logic.gatewayTime("2026-09-23T01:02:03.456Z", timeZone: "Asia/Shanghai") == "2026-09-23 09:02", "fractional ISO in +08")
check(Logic.gatewayTime("2026-09-23T01:02:03Z", timeZone: "Europe/Paris") == "2026-09-23 03:02", "plain ISO in Paris")
check(Logic.gatewayTime("2026-09-23T01:02:03Z", timeZone: "Bad/Zone") == "2026-09-23 09:02", "fallback Asia/Shanghai")
check(Logic.gatewayTime(nil, timeZone: nil) == "—", "missing time")

// Queries.
check(Logic.interceptionsQuery(page: 0, kind: "sms") == ["page": "1", "pageSize": "50", "kind": "sms"], "interceptions query")
check(Logic.contactsQuery(search: "  ", offset: 200) == ["limit": "200", "offset": "200"], "blank search omitted")
check(Logic.contactsQuery(search: " 张 ", offset: 0)["query"] == "张", "search trimmed")

print("VoDogContactsSelfTests passed")
