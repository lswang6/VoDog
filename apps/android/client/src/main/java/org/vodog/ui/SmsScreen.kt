package org.vodog

import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.AnchoredDraggableState
import androidx.compose.foundation.gestures.DraggableAnchors
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.anchoredDraggable
import androidx.compose.foundation.gestures.animateTo
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.automirrored.filled.CallMade
import androidx.compose.material.icons.automirrored.filled.CallReceived
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.filled.Add
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.SimCard
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.changedToDownIgnoreConsumed
import androidx.compose.ui.input.pointer.isOutOfBounds
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

@Composable
internal fun SmsPage(
    state: ClientUiState,
    model: ClientViewModel,
    composing: Boolean,
    onComposingChange: (Boolean) -> Unit,
    onDetailVisible: (Boolean) -> Unit,
) {
    val sims = (state.sims as? RemoteList.Loaded)?.items.orEmpty().mapNotNull {
        runCatching { it.toClientSim() }.getOrNull()
    }
    val smsItems = (state.sms as? RemoteList.Loaded)?.items.orEmpty()
    var selectedId by rememberSaveable(sims.map(ClientSim::id)) {
        mutableStateOf(sims.firstOrNull()?.id.orEmpty())
    }
    var openConversation by rememberSaveable { mutableStateOf<String?>(null) }
    var composeRecipient by rememberSaveable { mutableStateOf<String?>(null) }
    var composeRequestNonce by rememberSaveable { mutableStateOf<Long?>(null) }
    val conversationListState = rememberLazyListState()
    // S30：一次只让一行停在「露出两个按钮」的展开态。不是硬要求，但两行同时敞着看上去像坏了。
    var revealedThread by remember { mutableStateOf<String?>(null) }
    val selected = sims.singleOrNull { it.id == selectedId }
    val conversations = smsConversations(smsItems, selectedId)
    val account = state.session?.username.orEmpty()
    val opened = conversations.singleOrNull { it.key.storageKey == openConversation }
    LifecycleStartEffect(Unit) {
        model.startForegroundRefresh(ClientRefreshScope.SMS)
        onStopOrDispose { model.stopForegroundRefresh(ClientRefreshScope.SMS) }
    }
    val canCompose = selected?.id?.isNotBlank() == true && account.isNotBlank()
    // The compose sheet is a ModalBottomSheet now; only the pushed conversation hides the top bar.
    LaunchedEffect(opened != null) { onDetailVisible(opened != null) }
    // S21 §F: "发送短信" on the contact card opens the composer with the recipient already filled.
    LaunchedEffect(state.navigation?.nonce, selectedId) {
        val request = state.navigation
        if (request?.target == ClientNavigationTarget.SMS && selectedId.isNotBlank()) {
            composeRecipient = request.number
            composeRequestNonce = request.nonce
            model.updateSmsDraft(newSmsNumberDraftKey(account, selectedId), request.number)
            openConversation = null
            onComposingChange(true)
            model.consumeNavigation()
        }
    }
    // S67: an open conversation marks its incoming messages read, including ones that arrive while open.
    val openedIncomingIds = opened?.messages?.filter { it.direction == "incoming" }?.map { it.id }.orEmpty()
    LaunchedEffect(openedIncomingIds) { model.markSmsRead(openedIncomingIds) }
    if (opened != null) {
        BackHandler { openConversation = null }
        SmsConversationPage(state, model, selected, opened, account) { openConversation = null }
        return
    }
    Box(Modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        ClientSimPicker(sims, selectedId, badges = state.badges?.simSms().orEmpty()) { selectedId = it; openConversation = null }
        if (state.networkAvailable && selected != null && !selected.online) {
            LineOfflineBanner(selected, sims, "收发短信暂不可用，设备恢复在线后自动同步。")
        }
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            state = conversationListState,
            // Bottom room so the last row clears the 新短信 FAB.
            contentPadding = PaddingValues(bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            if (state.sms !is RemoteList.Loaded) {
                item { Box(Modifier.padding(horizontal = ScreenPadding)) { RemoteStateText(state.sms) } }
            } else if (conversations.isEmpty()) {
                item {
                    Box(Modifier.padding(horizontal = ScreenPadding)) {
                        if (sims.isEmpty()) {
                            EmptyStateCard(Icons.Filled.SimCard, "没有可用号码", "账号尚未分配号码。")
                        } else {
                            EmptyStateCard(Icons.AutoMirrored.Filled.Message, "暂无短信", "当前号码没有短信记录。")
                        }
                    }
                }
            } else {
                items(conversations, key = { it.key.storageKey }) { conversation ->
                    ConversationRow(
                        conversation = conversation,
                        unread = conversationShowsUnreadDot(conversation.messages, state.readSmsIds),
                        revealedThread = revealedThread,
                        onRevealed = { revealedThread = conversation.key.storageKey },
                        onClick = { openConversation = conversation.key.storageKey },
                        onInfo = { model.openContactCard(smsContactCardTarget(conversation)) },
                        onDelete = { block ->
                            model.deleteSmsThread(
                                simId = conversation.key.simId,
                                conversationAddress = smsThreadDeleteAddress(conversation),
                                blockNumber = if (block) smsThreadBlockNumber(conversation) else null,
                            )
                        },
                    )
                }
            }
        }
    }
        // Signal: 新短信 is an Extended FAB (was the top-bar edit icon); same action and a11y label.
        ExtendedFloatingActionButton(
            onClick = { if (canCompose && !state.busy) onComposingChange(true) },
            icon = { Icon(Icons.Filled.EditNote, null) },
            text = { Text("新短信", maxLines = 1, softWrap = false) },
            containerColor = if (canCompose && !state.busy) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
            contentColor = if (canCompose && !state.busy) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.BottomEnd).padding(ScreenPadding).heightIn(min = 56.dp)
                .semantics {
                    contentDescription = "新短信"
                    if (!canCompose || state.busy) disabled()
                },
        )
    }
    if (composing) {
        ComposeSmsSheet(
            state = state,
            model = model,
            sims = sims,
            selectedId = selectedId,
            onSelectSim = { selectedId = it },
            account = account,
            initialRecipient = composeRecipient,
            requestNonce = composeRequestNonce,
            onDismiss = {
                composeRecipient = null
                composeRequestNonce = null
                onComposingChange(false)
            },
        )
    }
}

/** 左滑露出的两个按钮各占多宽；两个都露出来时行最多向左走这个数的两倍。 */
private val ThreadRevealButtonWidth = 96.dp

/** 展开态只有两档：收起 / 露出按钮。中间没有别的停留位置，所以 [DraggableAnchors] 就两个锚点。 */
private enum class ThreadReveal { CLOSED, OPEN }

/**
 * S30 §4：短信会话行左滑露出「删除」（最外侧、贴边）与「删除并屏蔽」（内侧），停在展开态等着点，
 * 顺序以 iOS 的 `swipeActions(allowsFullSwipe: false)` 为准。Material3 的 `SwipeToDismissBox` 没有「停住的展开态」——它
 * 只有滑过阈值就走人 —— 所以这里用 [AnchoredDraggableState] 自己搭：两个锚点、行用 `offset` 跟着
 * 拖，按钮铺在行底下（`matchParentSize`）。点行或再滑回去就收起；长按行弹同一对动作作为次入口，
 * 因为在 LazyColumn 里横滑偶尔会被纵向滚动抢走。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationRow(
    conversation: SmsConversation,
    unread: Boolean,
    revealedThread: String?,
    onRevealed: () -> Unit,
    onClick: () -> Unit,
    onInfo: () -> Unit,
    onDelete: (Boolean) -> Unit,
) {
    val latest = conversation.latest
    val storageKey = conversation.key.storageKey
    val canBlock = canBlockSmsThread(conversation)
    val scope = rememberCoroutineScope()
    // null = 没在问；true = 删除并屏蔽；false = 只删除。
    var confirming by remember(storageKey) { mutableStateOf<Boolean?>(null) }
    var actionSheet by remember(storageKey) { mutableStateOf(false) }
    val revealPx = with(LocalDensity.current) {
        (if (canBlock) ThreadRevealButtonWidth * 2 else ThreadRevealButtonWidth).toPx()
    }
    val drag = remember(storageKey, revealPx) {
        AnchoredDraggableState(
            initialValue = ThreadReveal.CLOSED,
            anchors = DraggableAnchors {
                ThreadReveal.CLOSED at 0f
                ThreadReveal.OPEN at -revealPx
            },
        )
    }
    LaunchedEffect(drag.settledValue) { if (drag.settledValue == ThreadReveal.OPEN) onRevealed() }
    // 别的行敞开了就把自己收起来。收起不会改 `revealedThread`，所以这里不会来回打架。
    LaunchedEffect(revealedThread) {
        if (revealedThread != storageKey && drag.currentValue != ThreadReveal.CLOSED) {
            drag.animateTo(ThreadReveal.CLOSED)
        }
    }
    fun close() = scope.launch { drag.animateTo(ThreadReveal.CLOSED) }
    if (actionSheet) {
        AlertDialog(
            onDismissRequest = { actionSheet = false },
            title = { Text(conversation.title) },
            text = { Text("可以删除这段对话，或者删除的同时屏蔽这个号码。") },
            confirmButton = {
                Column {
                    // 次入口的两个按钮用自己的 tag：长按弹窗与左滑露出的按钮同时在树里时，
                    // uiautomator 不该看到两个同名的 resource-id。
                    TextButton(
                        onClick = { actionSheet = false; confirming = false },
                        enabled = LocalNetworkAvailable.current,
                        modifier = Modifier.heightIn(min = TouchTarget).testTag("threads.menu.delete"),
                        colors = destructiveTextColors(),
                    ) { Text("删除") }
                    if (canBlock) {
                        TextButton(
                            onClick = { actionSheet = false; confirming = true },
                            enabled = LocalNetworkAvailable.current,
                            modifier = Modifier.heightIn(min = TouchTarget).testTag("threads.menu.deleteAndBlock"),
                            colors = destructiveTextColors(),
                        ) { Text("删除并屏蔽") }
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { actionSheet = false }, modifier = Modifier.heightIn(min = TouchTarget)) {
                    Text("取消")
                }
            },
        )
    }
    confirming?.let { block ->
        val confirm = smsThreadDeleteConfirm(block)
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(confirm.title) },
            text = { Text(confirm.message) },
            confirmButton = {
                TextButton(
                    onClick = { confirming = null; close(); onDelete(block) },
                    enabled = LocalNetworkAvailable.current,
                    modifier = Modifier.heightIn(min = TouchTarget).testTag("threads.delete.confirm"),
                    colors = destructiveTextColors(),
                ) { Text(confirm.confirmLabel) }
            },
            dismissButton = {
                TextButton(onClick = { confirming = null }, modifier = Modifier.heightIn(min = TouchTarget)) {
                    Text("取消")
                }
            },
        )
    }
    Box(Modifier.padding(horizontal = ScreenPadding).fillMaxWidth().clip(MaterialTheme.shapes.small)) {
        Row(Modifier.matchParentSize(), horizontalArrangement = Arrangement.End) {
            // iOS 是参照：「删除」贴着屏幕边（最外侧），「删除并屏蔽」在它里面。两项都是危险操作，
            // 统一使用 error 红底和白字；Arrangement.End 下声明顺序就是从内到外。
            if (canBlock) {
                ThreadRevealAction(
                    label = "删除并屏蔽",
                    container = FilledDestructiveRed,
                    content = Color.White,
                    tag = "threads.deleteAndBlock",
                ) { confirming = true }
            }
            ThreadRevealAction(
                label = "删除",
                container = FilledDestructiveRed,
                content = Color.White,
                tag = "threads.delete",
            ) { confirming = false }
        }
        val signal = LocalSignal.current
        val code = smsVerificationCode(latest.body)
        val clipboard = LocalClipboard.current
        val stacked = isLargeFontScale(LocalDensity.current.fontScale)
        Surface(
            modifier = Modifier
                .offset { IntOffset(drag.offset.takeIf { !it.isNaN() }?.roundToInt() ?: 0, 0) }
                .fillMaxWidth()
                .anchoredDraggable(drag, Orientation.Horizontal)
                .testTag("threads.row")
                .semantics { if (unread) stateDescription = "未读" }
                .combinedClickable(
                    onClick = { if (drag.currentValue == ThreadReveal.CLOSED) onClick() else close() },
                    onLongClickLabel = "删除这段对话",
                    onLongClick = { actionSheet = true },
                ),
            color = MaterialTheme.colorScheme.background,
        ) {
            Row(Modifier.padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                // The avatar is the contact-card entry (was the trailing ⓘ button).
                Surface(
                    onClick = onInfo,
                    shape = CircleShape,
                    color = signal.surface3,
                    contentColor = signal.ink2,
                    modifier = Modifier.size(TouchTarget).semantics { contentDescription = "联系人卡片" },
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        val initial = conversation.title.trim().firstOrNull()
                        if (initial == null || initial.isDigit() || initial == '+') Icon(Icons.AutoMirrored.Filled.Message, null, Modifier.size(20.dp))
                        else Text(initial.toString(), style = MaterialTheme.typography.titleMedium)
                    }
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    val time: @Composable () -> Unit = {
                        Text(
                            compactListTime(latest.timestamp),
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (unread) signal.brand else signal.ink3,
                            maxLines = 1,
                        )
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        // §F: the blocked marker sits left of the thread title, as on the 记录 rows.
                        if (conversation.contact.blocked) {
                            Icon(Icons.Filled.Block, contentDescription = "已屏蔽", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                        }
                        Text(
                            phoneNumberTitle(conversation.title),
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal,
                            maxLines = if (stacked) 2 else 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (!stacked) time()
                    }
                    if (stacked) time()
                    Text(
                        latest.body.ifBlank { "（空短信）" },
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (unread) signal.ink else signal.ink2,
                    )
                    // S95b: no 「收到 · <own number>」 meta line; only a state that needs attention (排队中 / 失败 / 待确认).
                    if (latest.state !in setOf("sent", "delivered", "received")) {
                        Text(smsStateLabel(latest), style = MaterialTheme.typography.labelSmall, color = warningColor(), maxLines = 1)
                    }
                    if (latest.raw.optBoolean("missingParts")) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(Icons.Filled.Warning, null, Modifier.size(14.dp), tint = warningColor())
                            Text("短信缺少分段", style = MaterialTheme.typography.labelSmall, color = warningColor())
                        }
                    }
                    if (code != null) {
                        OutlinedButton(
                            onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("验证码", code))) } },
                            modifier = Modifier.heightIn(min = TouchTarget).testTag("threads.copyCode"),
                            shape = MaterialTheme.shapes.small,
                            border = BorderStroke(1.dp, signal.line),
                            contentPadding = PaddingValues(horizontal = 14.dp),
                        ) {
                            Icon(Icons.Filled.ContentCopy, null, Modifier.size(18.dp), tint = signal.brand)
                            Spacer(Modifier.width(8.dp))
                            Text("复制 ", color = signal.brand)
                            Text(code, color = signal.brand, fontFamily = FontFamily.Monospace)
                        }
                    }
                }
            }
        }
    }
}

/**
 * 露在行底下的一个按钮。整块都是点击热区（高度跟着行走，宽度固定），文字本身就是无障碍标签，所以
 * adb / uiautomator 既能按 text 找，也能按 [tag] 当成 resource-id 找。
 */
@Composable
private fun RowScope.ThreadRevealAction(
    label: String,
    container: Color,
    content: Color,
    tag: String,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxHeight()
            .width(ThreadRevealButtonWidth)
            .background(container)
            .clickable(enabled = LocalNetworkAvailable.current, onClickLabel = label, onClick = onClick)
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = content,
            style = MaterialTheme.typography.labelLarge,
            textAlign = TextAlign.Center,
            maxLines = 2,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ComposeSmsSheet(
    state: ClientUiState,
    model: ClientViewModel,
    sims: List<ClientSim>,
    selectedId: String,
    onSelectSim: (String) -> Unit,
    account: String,
    initialRecipient: String?,
    requestNonce: Long?,
    onDismiss: () -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    val selected = sims.singleOrNull { it.id == selectedId }
    val draftKey = newSmsDraftKey(account, selectedId)
    val numberDraftKey = newSmsNumberDraftKey(account, selectedId)
    val body = state.smsDrafts[draftKey].orEmpty()
    // Recipient belongs to this composer, not to the sending SIM. An explicit record/contact
    // request wins over an older draft, including when a different SIM is chosen.
    var number by rememberSaveable(account, requestNonce) {
        mutableStateOf(SmsRecipientPolicy.initialInput(initialRecipient))
    }
    var recipients by rememberSaveable(account, requestNonce, stateSaver = listSaver<List<SmsRecipient>, String>(
        save = { list -> list.flatMap { listOf(it.number, it.name.orEmpty()) } },
        restore = { values -> values.chunked(2).map { SmsRecipient(it[0], it[1].ifBlank { null }) } },
    )) { mutableStateOf(emptyList<SmsRecipient>()) }
    var picking by rememberSaveable(account, requestNonce) { mutableStateOf(false) }
    val contacts = ((state.smsPickerContacts as? RemoteList.Loaded)?.items
        ?: (state.contacts as? RemoteList.Loaded)?.items).orEmpty()
        .mapNotNull { runCatching { it.toClientContact() }.getOrNull() }
    val targets = SmsRecipientPolicy.resolved(recipients, number, contacts)
    LaunchedEffect(account, state.networkAvailable) { model.refreshSmsPickerContacts() }
    if (picking) SmsRecipientPicker(
        contacts, recipients, number,
        onChange = { values, input -> recipients = values; number = input },
        onDismiss = { picking = false },
        status = if (!state.networkAvailable) "设备未联网，仅显示已加载联系人" else state.smsPickerError,
        onRetry = model::refreshSmsPickerContacts,
    )
    ModalBottomSheet(
        onDismissRequest = { if (!state.busy) onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(
            // S30：底部弹层也是另一个窗口，根 Box 的「点空白处收键盘」够不着，这里自己贴一次。
            Modifier.fillMaxWidth().fillMaxHeight().imePadding().dismissKeyboardOnTapOutside(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = ScreenPadding).testTag("sms.compose.header"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = onDismiss,
                    enabled = !state.busy,
                    modifier = Modifier.heightIn(min = TouchTarget).testTag("sms.compose.cancel"),
                ) { Text("取消") }
                Text("新短信", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).padding(horizontal = 8.dp))
                Button(
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                        model.sendSmsRecipients(selectedId, targets.map { it.number }, body, draftKey, numberDraftKey,
                            onAccepted = onDismiss)
                    },
                    enabled = state.networkAvailable && !state.busy && selected?.canSms == true && targets.size <= 100 && SmsRecipientPolicy.valid(targets) && body.isNotBlank(),
                    modifier = Modifier.heightIn(min = TouchTarget).testTag("sms.compose.send"),
                ) { Text("发送") }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            // Only the form scrolls; the sheet and IME bound its remaining height.
            Column(
                Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())
                    .padding(bottom = 24.dp).testTag("sms.compose.form"),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                SectionHeader("发送号码")
                ClientSimPicker(sims, selectedId, badges = state.badges?.simSms().orEmpty(), onSelect = { if (!state.busy) onSelectSim(it) })
                selected?.let { Box(Modifier.padding(horizontal = ScreenPadding)) { SimIdentityCard(it) } }
                SectionHeader("收件人")
                OutlinedTextField(
                    value = number,
                    onValueChange = { value ->
                        number = value
                    },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = ScreenPadding).testTag("sms.compose.number"),
                    label = { Text("电话号码") },
                    enabled = !state.busy,
                    trailingIcon = {
                        IconButton(onClick = { picking = true; model.refreshSmsPickerContacts() },
                            enabled = !state.busy, modifier = Modifier.size(TouchTarget).testTag("sms.recipients.add")) {
                            Icon(Icons.Filled.Add, contentDescription = "从通讯录添加收件人")
                        }
                    },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    singleLine = true,
                )
                Column(Modifier.fillMaxWidth().padding(horizontal = ScreenPadding)) {
                    SmsRecipientChips(recipients) { recipient -> if (!state.busy) recipients = recipients - recipient }
                    if (number.isNotBlank()) TextButton(
                        onClick = { recipients = targets; number = "" },
                        enabled = !state.busy && SmsRecipientPolicy.valid(targets),
                        modifier = Modifier.heightIn(min = TouchTarget).testTag("sms.recipients.addManual"),
                    ) { Text("添加此号码") }
                    if (targets.size > 100) Text("最多选择 100 个收件人", color = MaterialTheme.colorScheme.error)
                    if (state.message.isNotBlank()) Text(state.message, modifier = Modifier.testTag("sms.compose.feedback"))
                }
                SectionHeader("内容")
                OutlinedTextField(
                    value = body,
                    onValueChange = { model.updateSmsDraft(draftKey, it) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = ScreenPadding).testTag("sms.compose.body"),
                    label = { Text("短信内容") },
                    enabled = !state.busy,
                    minLines = 4,
                    maxLines = 10,
                )
                selected?.unavailableReason(forCall = false)?.let {
                    Box(Modifier.padding(horizontal = ScreenPadding)) { MessageCard(it) }
                }
            }
        }
    }
}

/**
 * S30 §4：长按任意一条气泡进入选择模式（`selectedIds`），之后点气泡就是勾选 / 取消勾选，顶栏换成
 * 「已选 N 条」+ 全选 + 关闭 + 删除。选中集合的每一条规则都在 [SmsSelectionPolicy] 里，这里只负责
 * 把它画出来。退出选择模式走返回键，所以不会把整个会话页一起退掉。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun SmsConversationPage(
    state: ClientUiState,
    model: ClientViewModel,
    sim: ClientSim?,
    conversation: SmsConversation,
    account: String,
    onBack: () -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    // S83：「选择文字」弹窗正在展示的短信正文；null 表示没开。
    var selectingTextOf by remember { mutableStateOf<String?>(null) }
    // S87：点了正文里的链接、等待确认的规范化 URL；null 表示没开确认框。
    var pendingUrl by remember(conversation.key.storageKey) { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    val latest = conversation.latest
    val draftKey = replySmsDraftKey(account, conversation.key)
    val body = state.smsDrafts[draftKey].orEmpty()
    val canReply = sim?.canSms == true && latest.canReply && !latest.replyNumber.isNullOrBlank()
    val listState = rememberLazyListState()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val density = LocalDensity.current
    val imeBottom = WindowInsets.ime.getBottom(density)
    // 选择模式和选中集合一起活、一起死：转屏重建时两者都清掉，比「还在选择模式但一条都没选」清楚。
    var selecting by remember(conversation.key.storageKey) { mutableStateOf(false) }
    var selectedIds by remember(conversation.key.storageKey) { mutableStateOf(emptySet<String>()) }
    var confirmingDelete by remember(conversation.key.storageKey) { mutableStateOf(false) }
    val messageIds = conversation.messages.map(ClientSmsMessage::id)
    // 刷新之后消失的气泡不能继续留在选中集合里；这里是读出来的派生值，所以没有 effect 会来回打架。
    val selected = SmsSelectionPolicy.retain(selectedIds, messageIds)
    fun leaveSelection() {
        selecting = false
        selectedIds = SmsSelectionPolicy.clear()
    }
    // 选择模式下返回键先收起选择，而不是整页退出去。SmsPage 的 BackHandler 注册在前，这条在后，
    // 启用时优先级更高。
    BackHandler(enabled = selecting) { leaveSelection() }
    // 选中的气泡左边多一个复选框，气泡本身要相应窄一点，否则长消息会把复选框挤出屏幕。
    val fullBubbleWidth = (LocalConfiguration.current.screenWidthDp - 82).coerceAtLeast(160).dp
    val bubbleWidth = if (selecting) (fullBubbleWidth - 48.dp).coerceAtLeast(120.dp) else fullBubbleWidth
    var lastMessageId by remember(conversation.key.storageKey) { mutableStateOf<String?>(null) }
    val newestMessageId = conversation.messages.lastOrNull()?.id
    LaunchedEffect(conversation.key.storageKey, newestMessageId, imeBottom) {
        if (newestMessageId != null) {
            when {
                lastMessageId == null || imeBottom > 0 -> listState.scrollToItem(conversation.messages.size)
                lastMessageId != newestMessageId -> listState.animateScrollToItem(conversation.messages.size)
            }
            lastMessageId = newestMessageId
        }
    }
    if (confirmingDelete) {
        val confirm = smsMessagesDeleteConfirm(selected.size)
        AlertDialog(
            onDismissRequest = { confirmingDelete = false },
            title = { Text(confirm.title) },
            text = { Text(confirm.message) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingDelete = false
                        model.deleteSmsMessages(selected.toList())
                        leaveSelection()
                    },
                    modifier = Modifier.heightIn(min = TouchTarget).testTag("conversation.delete.confirm"),
                    enabled = state.networkAvailable && SmsSelectionPolicy.canDelete(selected),
                    colors = destructiveTextColors(),
                ) { Text(confirm.confirmLabel) }
            },
            dismissButton = {
                TextButton(onClick = { confirmingDelete = false }, modifier = Modifier.heightIn(min = TouchTarget)) {
                    Text("取消")
                }
            },
        )
    }
    selectingTextOf?.let { text ->
        AlertDialog(
            onDismissRequest = { selectingTextOf = null },
            modifier = Modifier.testTag("conversation.selectText.dialog"),
            title = { Text("选择文字") },
            text = {
                SelectionContainer(Modifier.verticalScroll(rememberScrollState())) { Text(text) }
            },
            confirmButton = {
                TextButton(onClick = { selectingTextOf = null }, modifier = Modifier.heightIn(min = TouchTarget)) {
                    Text("完成")
                }
            },
        )
    }
    pendingUrl?.let { url ->
        AlertDialog(
            onDismissRequest = { pendingUrl = null },
            modifier = Modifier.testTag("conversation.link.dialog"),
            title = { Text("打开链接？") },
            text = { Text(url) },
            confirmButton = {
                TextButton(
                    onClick = { pendingUrl = null; openSmsLink(context, url) },
                    modifier = Modifier.heightIn(min = TouchTarget).testTag("conversation.link.open"),
                ) { Text("打开") }
            },
            dismissButton = {
                TextButton(onClick = { pendingUrl = null }, modifier = Modifier.heightIn(min = TouchTarget)) {
                    Text("取消")
                }
            },
        )
    }
    Column(Modifier.fillMaxSize().imePadding().pointerInput(Unit) {
        detectTapGestures { focus.clearFocus(); keyboard?.hide() }
    }) {
        if (selecting) {
            Row(
                Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = { leaveSelection() }, modifier = Modifier.size(TouchTarget)) {
                    Icon(Icons.Filled.Close, contentDescription = "退出选择", tint = MaterialTheme.colorScheme.primary)
                }
                Text(
                    SmsSelectionPolicy.title(selected),
                    modifier = Modifier.weight(1f).padding(horizontal = 4.dp),
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                TextButton(
                    onClick = { selectedIds = SmsSelectionPolicy.selectAll(messageIds) },
                    enabled = !SmsSelectionPolicy.allSelected(selected, messageIds),
                    modifier = Modifier.heightIn(min = TouchTarget).testTag("conversation.selectAll"),
                ) { Text("全选") }
                IconButton(
                    onClick = { confirmingDelete = true },
                    enabled = state.networkAvailable && SmsSelectionPolicy.canDelete(selected),
                    modifier = Modifier.size(TouchTarget).testTag("conversation.deleteSelected"),
                ) {
                    Icon(
                        Icons.Filled.Delete,
                        contentDescription = "删除所选短信",
                        tint = if (SmsSelectionPolicy.canDelete(selected)) MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        } else {
        Box(Modifier.fillMaxWidth().height(56.dp), contentAlignment = Alignment.Center) {
            IconButton(
                onClick = onBack,
                modifier = Modifier.align(Alignment.CenterStart).padding(start = 8.dp).size(TouchTarget),
            ) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回短信", tint = MaterialTheme.colorScheme.primary)
            }
            Text(
                phoneNumberTitle(conversation.title),
                modifier = Modifier.padding(horizontal = 64.dp),
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            IconButton(
                onClick = { model.openContactCard(smsContactCardTarget(conversation)) },
                modifier = Modifier.align(Alignment.CenterEnd).padding(end = 8.dp).size(TouchTarget),
            ) {
                Icon(Icons.Outlined.Info, contentDescription = "联系人卡片", tint = MaterialTheme.colorScheme.primary)
            }
        }
        }
        SmsSelectionPolicy.deleteLimitMessage(selected).takeIf(String::isNotBlank)?.let { warning ->
            Text(
                warning,
                modifier = Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 4.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(), state = listState,
            contentPadding = PaddingValues(ScreenPadding), verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // iOS 3f9c8541 的同一处改动：会话页只留一行号码说明，不再有 SIM 横幅。
            ConversationLineCaption.text(sim)?.let { caption ->
                item {
                    Text(
                        caption,
                        modifier = Modifier.fillMaxWidth(),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            items(conversation.messages, key = ClientSmsMessage::id) { message ->
                val outgoing = message.direction == "outgoing"
                val checked = message.id in selected
                var menuOpen by remember(message.id) { mutableStateOf(false) }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    if (selecting) {
                        Checkbox(
                            checked = checked,
                            onCheckedChange = { selectedIds = SmsSelectionPolicy.toggle(selected, message.id) },
                            modifier = Modifier.testTag("conversation.select"),
                        )
                    }
                    Row(Modifier.weight(1f), horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start) {
                    Column(Modifier.widthIn(max = bubbleWidth), horizontalAlignment = if (outgoing) Alignment.End else Alignment.Start) {
                        Box {
                        Surface(
                            // S83：长按弹出「复制 / 选择文字 / 多选」（同 iOS），「多选」才进选择模式；选择模式下
                            // 点或长按气泡都是勾选 / 取消勾选。不在选择模式时点一下仍旧要收键盘 ——
                            // 外层 detectTapGestures 已经被这个 clickable 挡住了。不能直接套 SelectionContainer，它会吃掉长按。
                            modifier = Modifier.clip(MaterialTheme.shapes.large).combinedClickable(
                                onClick = {
                                    if (selecting) selectedIds = SmsSelectionPolicy.toggle(selected, message.id)
                                    else { focus.clearFocus(); keyboard?.hide() }
                                },
                                onLongClickLabel = "短信操作",
                                onLongClick = {
                                    if (selecting) selectedIds = SmsSelectionPolicy.toggle(selected, message.id)
                                    else if (message.body.isNotBlank() || message.id.isNotBlank()) menuOpen = true
                                },
                            ).testTag("conversation.bubble"),
                            color = if (outgoing) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                            contentColor = if (outgoing) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                            shape = MaterialTheme.shapes.large,
                        ) {
                            SmsBubbleBody(
                                message.body.ifBlank { "（空短信）" },
                                linkable = !selecting,
                                onOpenLink = { pendingUrl = it },
                                onLongPressLink = { menuOpen = true },
                            )
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            if (message.body.isNotBlank()) {
                                DropdownMenuItem(
                                    text = { Text("复制") },
                                    onClick = {
                                        menuOpen = false
                                        scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("短信", message.body))) }
                                    },
                                    modifier = Modifier.heightIn(min = TouchTarget).testTag("conversation.bubble.menu.copy"),
                                )
                                DropdownMenuItem(
                                    text = { Text("选择文字") },
                                    onClick = { menuOpen = false; selectingTextOf = message.body },
                                    modifier = Modifier.heightIn(min = TouchTarget).testTag("conversation.bubble.menu.selectText"),
                                )
                            }
                            if (message.id.isNotBlank()) {
                                DropdownMenuItem(
                                    text = { Text("多选") },
                                    onClick = {
                                        menuOpen = false
                                        selecting = true
                                        selectedIds = SmsSelectionPolicy.toggle(selected, message.id)
                                    },
                                    modifier = Modifier.heightIn(min = TouchTarget).testTag("conversation.bubble.menu.multiSelect"),
                                )
                            }
                        }
                        }
                        Text(
                            smsRowCaption(message, sim?.displayLabel ?: "号码已移除"),
                            modifier = Modifier.padding(top = 4.dp),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            displayDateTime(message.timestamp),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        smsFailureDetail(message.raw)?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                        }
                    }
                    }
                }
            }
        }
        // 选择模式下没有「回复」这回事：输入框收起来，顶栏的删除就是唯一的动作。
        if (!selecting) Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = ScreenPadding, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                val reason = if (canReply) "短信" else sim?.unavailableReason(forCall = false)
                    ?: if (!latest.canReply) "此发件人不支持直接回复" else "回复号码不可用"
                OutlinedTextField(
                    value = body,
                    onValueChange = { model.updateSmsDraft(draftKey, it) },
                    modifier = Modifier.weight(1f).heightIn(min = TouchTarget).testTag("sms.reply.body"),
                    enabled = canReply && !state.busy,
                    minLines = 1,
                    maxLines = 5,
                    shape = MaterialTheme.shapes.extraLarge,
                    placeholder = {
                        Text(reason, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                    },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
                val sendEnabled = state.networkAvailable && !state.busy && canReply && body.isNotBlank()
                IconButton(
                    onClick = { haptic.performHapticFeedback(HapticFeedbackType.Confirm); model.sendSms(conversation.key.simId, latest.replyNumber.orEmpty(), body, draftKey) },
                    enabled = sendEnabled,
                    modifier = Modifier.size(TouchTarget).testTag("sms.reply.send"),
                ) {
                    Icon(
                        Icons.Filled.ArrowUpward,
                        contentDescription = "发送回复",
                        tint = if (sendEnabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/**
 * S87：气泡正文。选择模式或没有链接时与原来的纯文本完全一致；有链接时链接段加下划线（颜色继承气泡
 * 正文色），点按只把 URL 交给确认框，绝不直接打开。
 *
 * 每个链接段在 BasicText 里自带一个没有长按的 combinedClickable，它会在 Main pass 吃掉按下事件，外层
 * 气泡的长按就收不到了，按住再松手反而触发链接。所以这里在 Initial pass 先看一眼：按在链接上且按满
 * 长按时长，就自己弹 S83 菜单，并吃掉后续事件，让链接的点按随之取消。
 */
@Composable
private fun SmsBubbleBody(text: String, linkable: Boolean, onOpenLink: (String) -> Unit, onLongPressLink: () -> Unit) {
    val modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp)
    val style = MaterialTheme.typography.bodyLarge
    val links = remember(text) { SmsLinkPolicy.detect(text) }
    if (!linkable || links.isEmpty()) {
        Text(text, modifier = modifier, style = style)
        return
    }
    val haptic = LocalHapticFeedback.current
    val longPress by rememberUpdatedState(onLongPressLink)
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val linkStyles = TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline))
    val annotated = buildAnnotatedString {
        append(text)
        links.forEach { link ->
            addLink(LinkAnnotation.Clickable(link.url, linkStyles) { onOpenLink(link.url) }, link.start, link.end)
        }
    }
    Text(
        annotated,
        modifier = modifier.pointerInput(links) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                // ponytail: 按字符偏移判定，链接自身的点按区按字形裁剪，边缘一条细缝两者可能不一致（最坏是
                // 双重震动或退回原生行为）；要更准就改用 layout.getPathForRange 做命中。
                val offset = layout?.getOffsetForPosition(down.position) ?: return@awaitEachGesture
                if (links.none { offset >= it.start && offset < it.end }) return@awaitEachGesture
                // true = 松手（交给链接当点按），false = 滑动 / 取消，null = 按满长按时长。在 Final pass 看，
                // 这样列表滚动已经消费过事件：文字跟着手指走、位置不出界，只能靠「被消费」认出滚动。
                // 第一次拿到的是同一个按下事件的 Final pass，链接的 clickable 已经消费了它，不能算取消。
                val released = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                    var result: Boolean? = null
                    while (result == null) {
                        val event = awaitPointerEvent(PointerEventPass.Final)
                        result = when {
                            event.changes.all { !it.pressed } -> true
                            event.changes.any {
                                (it.isConsumed && !it.changedToDownIgnoreConsumed()) || it.isOutOfBounds(size, extendedTouchPadding) ||
                                    (it.position - down.position).getDistance() > viewConfiguration.touchSlop
                            } -> false
                            else -> null
                        }
                    }
                    result
                }
                if (released != null) return@awaitEachGesture
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                longPress()
                do {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    event.changes.forEach { it.consume() }
                } while (event.changes.any { it.pressed })
            }
        },
        style = style,
        onTextLayout = { layout = it },
    )
}

/** S87：确认后才走到这里；短信正文不可信，解析后再校验一次 scheme。 */
private fun openSmsLink(context: Context, url: String) {
    // 意图过滤器按小写比对 scheme，`HTTP://…` 不规范化会找不到浏览器。
    val uri = Uri.parse(url).normalizeScheme()
    if (!SmsLinkPolicy.isOpenable(url) || uri.scheme?.lowercase() !in setOf("http", "https")) return
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "没有可打开链接的应用", Toast.LENGTH_SHORT).show()
    }
}

/** Signal 「号码设备离线」 banner for the selected line (existing `online` signal only). */
@Composable
internal fun LineOfflineBanner(sim: ClientSim, sims: List<ClientSim>, detail: String) {
    StatusBanner(StatusBannerKind.LINE_OFFLINE, detail, Modifier.padding(horizontal = ScreenPadding, vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LineBlock(simColor(sim, sims), 8.dp)
            Text(simPickerTitle(sim), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
