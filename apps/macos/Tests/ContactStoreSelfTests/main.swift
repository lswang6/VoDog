import Contacts
import Foundation

enum ContactStoreSelfTestFailure: Error {
    case failed(String)
}

let fetchedKeys = Set(SystemContactStore.contactKeys.compactMap { $0 as? String })
let requiredKeys: Set<String> = [
    CNContactIdentifierKey,
    CNContactGivenNameKey,
    CNContactFamilyNameKey,
    CNContactNicknameKey,
    CNContactOrganizationNameKey,
    CNContactPhoneNumbersKey,
    CNContactEmailAddressesKey
]

guard requiredKeys.isSubset(of: fetchedKeys) else {
    throw ContactStoreSelfTestFailure.failed("ordinary contact fields are missing")
}
guard !fetchedKeys.contains(CNContactNoteKey) else {
    throw ContactStoreSelfTestFailure.failed(
        "restricted CNContactNoteKey must not be fetched without the Contacts Notes entitlement"
    )
}

let mainlandNumber = "13800138000"
guard SystemContactStore.normalizedPhoneNumber("+86 138-0013-8000") == mainlandNumber,
      SystemContactStore.normalizedPhoneNumber("0086 (138) 0013 8000") == mainlandNumber,
      SystemContactStore.normalizedPhoneNumber("86 138 0013 8000") == mainlandNumber,
      SystemContactStore.normalizedPhoneNumber("１２０ ２５５５ ０１２３") == "12025550123",
      SystemContactStore.normalizedPhoneNumber("138 0013 8000") == mainlandNumber else {
    throw ContactStoreSelfTestFailure.failed(
        "equivalent mainland phone numbers do not share a lookup key"
    )
}

print("Contact store self-tests passed (ordinary authorization fields only).")
