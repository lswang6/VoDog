package org.vodog

/**
 * S21 §F — the contact card is opened from a history row, from the dialer's recent list and from an
 * interception, so what it may offer depends on data that arrives in three different shapes. The
 * decision is pulled out of the composable and made here, once, on plain data.
 */
data class ContactCardTarget(
    val number: String,
    val sourceCallId: String? = null,
    val annotation: ContactAnnotation = ContactAnnotation.Empty,
) {
    val title: String get() = numberWithContactName(number, annotation.contactName)
}

data class ContactCardUiState(
    val target: ContactCardTarget,
    val contact: RemoteResource<ClientContact?> = RemoteResource.NotLoaded,
    val blocked: Boolean = target.annotation.blocked,
    val blockedEntryId: String? = target.annotation.blockedEntryId,
    val busy: Boolean = false,
    val message: String = "",
    val status: String = "",
) {
    val resolvedContact: ClientContact? get() = (contact as? RemoteResource.Loaded)?.value
    val displayName: String?
        get() = resolvedContact?.displayName ?: target.annotation.contactName?.takeIf(String::isNotBlank)
}

/**
 * `112`/`911` are the two keys the control service refuses to block (`isEmergencyServiceNumber`).
 * Checking locally keeps the confirm dialog from ending in a 400 the user cannot act on; the server
 * stays authoritative either way.
 */
internal fun isEmergencyServiceNumber(number: String): Boolean =
    number.filter(Char::isDigit).let { it == "112" || it == "911" }

internal fun dialableNumber(number: String): Boolean =
    number.isNotBlank() && number != "null" && number.any(Char::isDigit)

/** Which of the six card actions are offered, and why a missing one is missing. */
internal data class ContactCardActions(
    val canCall: Boolean,
    val canSms: Boolean,
    val canCreateContact: Boolean,
    val canAttachToContact: Boolean,
    val canBlock: Boolean,
    val canUnblock: Boolean,
    val blockLabel: String,
    val disabledReason: String?,
)

internal fun contactCardActions(state: ContactCardUiState): ContactCardActions {
    val dialable = dialableNumber(state.target.number)
    val emergency = dialable && isEmergencyServiceNumber(state.target.number)
    // Until the lookup answers we do not yet know whether this number already belongs to somebody,
    // so the two "create / attach" actions stay hidden rather than offering to duplicate a contact.
    val resolved = state.contact is RemoteResource.Loaded
    val known = state.resolvedContact != null
    return ContactCardActions(
        canCall = dialable && !state.busy,
        canSms = dialable && !state.busy,
        canCreateContact = dialable && resolved && !known && !state.busy,
        canAttachToContact = dialable && resolved && !known && !state.busy,
        canBlock = dialable && !emergency && !state.blocked && !state.busy,
        canUnblock = state.blocked && dialable && !state.busy,
        blockLabel = if (state.blocked) "解除屏蔽" else "屏蔽此号码",
        disabledReason = when {
            !dialable -> "这条记录没有可用号码"
            emergency -> "紧急号码不能被屏蔽"
            else -> null
        },
    )
}

internal data class ContactCardConfirm(val title: String, val message: String, val confirmLabel: String)

internal fun contactBlockConfirm(target: ContactCardTarget, blocked: Boolean): ContactCardConfirm =
    if (blocked) {
        ContactCardConfirm(
            title = "解除屏蔽",
            message = "${target.title} 的来电将不再被挂断。",
            confirmLabel = "解除屏蔽",
        )
    } else {
        // One confirmation for every 屏蔽 entry point on Android — contact card and 报告 card both
        // call this (S22 决策 10 / R3 §6: one verb, one sentence, no second wording to drift).
        // The question mark matches iOS `ContactCardActionPolicy.blockConfirmTitle`.
        ContactCardConfirm(
            title = "屏蔽此号码？",
            message = "${target.title} 的来电将被直接挂断（短信不受影响）；拦截记录仍可在记录页查看。",
            confirmLabel = "屏蔽",
        )
    }

/** Progress of "导入本机通讯录" (§F). */
sealed interface ContactImportUiState {
    data object Idle : ContactImportUiState
    data object Reading : ContactImportUiState
    data class Uploading(val uploaded: Int, val total: Int) : ContactImportUiState
    data class Done(val result: ContactImportResult) : ContactImportUiState
    data class Failed(val message: String) : ContactImportUiState

    val running: Boolean get() = this is Reading || this is Uploading
}

/** The dialer's name hint under the typed number (`GET /contacts/lookup`). */
data class DialerLookupState(
    val number: String = "",
    val contactId: String? = null,
    val contactName: String? = null,
) {
    fun hintFor(current: String): String? =
        contactName?.takeIf { it.isNotBlank() && current.trim() == number && number.isNotBlank() }
}

/** Debounce before the dialer asks the server who a half-typed number belongs to. */
internal const val CONTACT_LOOKUP_DEBOUNCE_MS = 350L

/** The shortest input worth a lookup; below this every number matches something. */
internal const val CONTACT_LOOKUP_MIN_DIGITS = 3

internal fun shouldLookupNumber(number: String): Boolean =
    number.count(Char::isDigit) >= CONTACT_LOOKUP_MIN_DIGITS

enum class ClientNavigationTarget { DIAL, SMS }

/**
 * "拨打电话 / 发送短信" from the contact card have to leave the card, switch tab and pre-fill a
 * field owned by another screen. The request travels through the view model as data with a nonce so
 * the same number twice in a row still navigates.
 */
data class ClientNavigationRequest(
    val target: ClientNavigationTarget,
    val number: String,
    val nonce: Long,
    /** S36 C5-b: the SIM the source screen already knows about (a record's SIM), if any. */
    val simId: String? = null,
    /** S36 C5-b: 拨打 from a record/contact confirms and dials; the plain dialer prefill does not. */
    val confirm: Boolean = false,
)

/**
 * S36 C5-b: which SIM a 确认后拨打 uses. The request's SIM wins when it is still one of ours, then
 * the dialer's current selection, then the first SIM that can actually place a call. `null` means
 * nothing is dialable, and the caller falls back to the old prefill-only path.
 */
internal fun resolveDialSim(requested: String?, selected: String, sims: List<ClientSim>): ClientSim? =
    sims.firstOrNull { it.id == requested }
        ?: sims.firstOrNull { it.id == selected }
        ?: sims.firstOrNull { it.canCall }
