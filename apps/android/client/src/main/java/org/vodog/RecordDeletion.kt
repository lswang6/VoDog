package org.vodog

import org.json.JSONObject

/**
 * S30 三端删除的 Android 纯逻辑。删除有三个入口（通话记录行、对话行、对话里选中的几条短信），每个
 * 入口都要先问一次、删完还要就地把行拿掉，所以「问什么」「选中了什么」「本地删掉哪几行」全部从
 * composable 里挪到这里，单测能一条条钉死；网络那一步留在 [ClientApi]，落地那一步留在
 * [clientStateWithoutCall] / [ClientViewModel]。
 */

// ---- 确认文案（沿用 [ContactCardConfirm] 的三段式：标题 / 后果 / 确认按钮） ----------------

/** 全部通话行的删除确认。与 Web `CALL_DELETE_PROMPT`、iOS 的 confirmationDialog 一字不差。 */
internal fun callDeleteConfirm(): ContactCardConfirm = ContactCardConfirm(
    title = "删除这条通话记录？",
    message = "录音、转写、报告条目和手机上的通话记录会一起删除，无法恢复。",
    confirmLabel = "删除",
)

/**
 * 对话行的两个动作共用一个构造器：只删对话，或者先屏蔽号码再删对话。两句后果都说明「正在发送中的
 * 短信会被保留」——服务端把 `queued`/`sending` 跳过（S30 §1.2），不提前说的话用户会以为删漏了。
 */
internal fun smsThreadDeleteConfirm(block: Boolean): ContactCardConfirm = if (block) {
    ContactCardConfirm(
        title = "删除并屏蔽此号码？",
        message = "这段对话会被删除，之后不再接收该号码的短信（来电不受影响）；正在发送中的短信会保留。",
        confirmLabel = "删除并屏蔽",
    )
} else {
    ContactCardConfirm(
        title = "删除这段对话？",
        message = "这段对话里的短信会被删除，无法恢复；正在发送中的短信会保留。",
        confirmLabel = "删除",
    )
}

/** 对话页「删除所选」的确认。 */
internal fun smsMessagesDeleteConfirm(count: Int): ContactCardConfirm = ContactCardConfirm(
    title = "删除选中的 $count 条短信？",
    message = "删除后无法恢复；正在发送中的短信会保留。",
    confirmLabel = "删除",
)

// ---- 选择模式 -------------------------------------------------------------------------------

/**
 * 对话页长按进入的选择模式。整套规则是集合运算，没有任何 Compose 依赖，所以「全选之后再点一条会
 * 取消它」这种事只需要一条单测，而不是一次装机。
 */
internal object SmsSelectionPolicy {
    const val MAX_DELETE_COUNT = 500
    fun toggle(selected: Set<String>, id: String): Set<String> = when {
        id.isBlank() -> selected
        id in selected -> selected - id
        else -> selected + id
    }

    /** 「全选」只认当前对话里真实存在的 id；空 id 不会被选进来（本地占位的消息没有服务端 id）。 */
    fun selectAll(ids: List<String>): Set<String> = ids.filter(String::isNotBlank).toSet()

    fun clear(): Set<String> = emptySet()

    /** 删除按钮的可用性：选中 0 条时禁用，避免发一次必然 400 的请求。 */
    fun canDelete(selected: Set<String>): Boolean = selected.size in 1..MAX_DELETE_COUNT

    fun deleteLimitMessage(selected: Set<String>): String =
        if (selected.size > MAX_DELETE_COUNT) "一次最多删除 $MAX_DELETE_COUNT 条短信，请减少选择" else ""

    /** 顶栏标题。 */
    fun title(selected: Set<String>): String = "已选 ${selected.size} 条"

    /** 已经全选时「全选」按钮没有意义，收起来比点了没反应好。 */
    fun allSelected(selected: Set<String>, ids: List<String>): Boolean {
        val selectable = selectAll(ids)
        return selectable.isNotEmpty() && selected.containsAll(selectable)
    }

    /** 只保留还在屏幕上的 id：刷新之后被删掉的那几条不能继续留在选中集合里。 */
    fun retain(selected: Set<String>, ids: List<String>): Set<String> = selected intersect selectAll(ids)
}

// ---- 线程删除要发什么 -----------------------------------------------------------------------

/**
 * 服务端按 `smsAddress(remote_number, sims.country_iso)` 逐行算线程键，请求侧同样归一化，所以客户端
 * 照发自己手上的 `conversationAddress` 即可（S30 §1.3）。唯一的例外是这个地址本身是客户端造出来的
 * 占位（服务端没给 `conversationAddress` 时 [toClientSmsMessage] 会填 `unresolved:<id>` / `号码未知`）
 * ——那种写法服务端一行都匹配不上，退回原始的 `remoteNumber`，正好是合同里的 `conversationAddress ??
 * remoteNumber`。
 */
internal fun smsThreadDeleteAddress(conversation: SmsConversation): String {
    val address = conversation.key.address
    if (address.isNotBlank() && !smsAddressPlaceholder(address)) return address
    return conversation.latest.remoteNumber.takeIf(String::isNotBlank) ?: address
}

/**
 * 「删除并屏蔽」屏蔽的是线程的**原始号码**（三端一律如此），不是 `replyNumber` —— 回复号码可能是
 * 运营商的网关短号，屏蔽它会连带挡掉别人的短信。
 */
internal fun smsThreadBlockNumber(conversation: SmsConversation): String =
    conversation.latest.remoteNumber.takeIf(String::isNotBlank) ?: conversation.contactNumber

internal fun smsAddressPlaceholder(address: String): Boolean =
    address.startsWith("unresolved:") || address == "号码未知"

/** 紧急号码服务端拒绝入黑名单（400），所以「删除并屏蔽」在这种行上不提供。 */
internal fun canBlockSmsThread(conversation: SmsConversation): Boolean =
    smsThreadBlockNumber(conversation).let { dialableNumber(it) && !isEmergencyServiceNumber(it) }

// ---- 删除之后本地怎么收拾 -------------------------------------------------------------------

/** 按 id 就地移除几条短信；刷新回来之前屏幕上不会留着已经删掉的气泡。 */
internal fun smsRowsWithoutIds(items: List<JSONObject>, ids: Set<String>): List<JSONObject> =
    if (ids.isEmpty()) items else items.filterNot { it.optString("id") in ids }

internal fun smsSkippedIds(response: JSONObject): Set<String> {
    val skipped = response.optJSONArray("skipped")
    return (0 until (skipped?.length() ?: 0)).mapNotNullTo(linkedSetOf()) { index ->
        skipped?.optJSONObject(index)?.optString("id")?.takeIf(String::isNotBlank)
    }
}

internal fun smsAcceptedDeletedIds(requested: Set<String>, response: JSONObject): Set<String> =
    requested - smsSkippedIds(response)

/**
 * 按线程键就地移除一整段对话。这里只做「一模一样的写法」的比较：归一化是服务端的活，客户端多做一次
 * 只会和服务端的判定漂移；漏掉的行会在紧接着的 [ClientViewModel.refreshAll] 里消失。
 */
internal fun smsRowsWithoutThread(
    items: List<JSONObject>,
    simId: String,
    conversationAddress: String,
): List<JSONObject> = items.filterNot { row ->
    val message = runCatching { row.toClientSmsMessage() }.getOrNull() ?: return@filterNot false
    message.simId == simId &&
        (message.conversationAddress == conversationAddress || message.remoteNumber == conversationAddress)
}

internal fun smsRowsAfterThreadDelete(
    items: List<JSONObject>,
    simId: String,
    conversationAddress: String,
    response: JSONObject,
): List<JSONObject> {
    val skipped = smsSkippedIds(response)
    return items.filterNot { row ->
        val message = runCatching { row.toClientSmsMessage() }.getOrNull() ?: return@filterNot false
        message.id !in skipped && message.simId == simId &&
            (message.conversationAddress == conversationAddress || message.remoteNumber == conversationAddress)
    }
}

/**
 * 删除成功不说话 —— 行当场消失就是回执，Web 与 iOS 也一样静默。唯一要出声的是「有几条没删掉」：
 * `skipped` 里 `in_flight` 的那些是真的还在发，用户看见气泡还在必须知道为什么。另一种理由
 * `not_found` 是别处已经删掉了，对用户来说和删掉没区别，所以不数进来（S30 §1.2）。
 *
 * 返回空串表示「没什么可说的」，调用方原样写进 [ClientUiState.message]，空串不会显示横幅。
 */
internal fun smsDeleteSkippedMessage(response: JSONObject): String {
    val skipped = response.optJSONArray("skipped")
    val inFlight = (0 until (skipped?.length() ?: 0))
        .count { skipped?.optJSONObject(it)?.optString("reason") == "in_flight" }
    return if (inFlight == 0) "" else "$inFlight 条短信正在发送中，暂时不能删除"
}
