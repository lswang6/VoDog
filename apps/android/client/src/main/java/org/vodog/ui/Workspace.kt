package org.vodog

import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.Surface
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.clearAndSetSemantics
import org.json.JSONObject
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.ui.graphics.Color

/** Presentation only: media failures and refresh gaps never mean a call has ended. */
internal data class CallPresentation(
    val callId: String? = null,
    val expanded: Boolean = false,
    val presentedIds: Set<String> = emptySet(),
) {
    fun reconcile(ownedCallId: String?, finishedIds: Set<String>): CallPresentation {
        val current = if (callId in finishedIds) copy(callId = null, expanded = false) else this
        if (ownedCallId == null || ownedCallId in finishedIds) return current
        if (ownedCallId == current.callId) return current
        return current.copy(
            callId = ownedCallId,
            expanded = ownedCallId !in presentedIds,
            presentedIds = presentedIds + ownedCallId,
        )
    }

    fun minimize() = copy(expanded = false)
    fun restore() = copy(expanded = callId != null)
}

private val CallPresentationSaver = listSaver<CallPresentation, String>(
    save = { listOf(it.callId.orEmpty(), it.expanded.toString()) + it.presentedIds },
    restore = { CallPresentation(it[0].ifEmpty { null }, it[1].toBoolean(), it.drop(2).toSet()) },
)

/**
 * The five tabs, in the same order and with the same titles as the iOS TabView (S21 §F).
 *
 * 记录 comes before 通讯录, matching `MainView.swift`. S21 claimed this order in a comment but shipped
 * the two swapped, so muscle memory moved between the two apps (R4 Part B must-fix).
 */
internal enum class Destination(val tabLabel: String, val title: String, val icon: ImageVector) {
    CALL("电话", "电话", Icons.Outlined.Phone),
    SMS("短信", "短信", Icons.AutoMirrored.Outlined.Chat),
    HISTORY("记录", "记录", Icons.Outlined.History),
    CONTACTS("通讯录", "通讯录", Icons.Outlined.Person),
    SETTINGS("设置", "设置", Icons.Outlined.Tune),
}

internal enum class WorkspaceMessageKind { CONFIRMATION, ERROR }

/**
 * [ClientUiState.message] carries both errors and confirmations. The kind is recorded where the text
 * is assigned ([withInfo] sets [ClientUiState.infoMessage]); anything else — validation, transport,
 * server text containing "成功" — stays an error card.
 */
internal fun workspaceMessageKind(state: ClientUiState): WorkspaceMessageKind =
    if (state.message.isNotBlank() && state.message == state.infoMessage) WorkspaceMessageKind.CONFIRMATION
    else WorkspaceMessageKind.ERROR

@Composable
internal fun StateMessage(state: ClientUiState) = when (workspaceMessageKind(state)) {
    WorkspaceMessageKind.CONFIRMATION -> StatusLine(state.message)
    WorkspaceMessageKind.ERROR -> MessageCard(state.message)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun Workspace(
    state: ClientUiState,
    model: ClientViewModel,
    passkeys: PasskeyCredentialProvider,
) {
    // The coordinator epoch is stable across token refresh and changes for a new login.
    var presentation by rememberSaveable(state.sessionEpoch, state.session?.username, stateSaver = CallPresentationSaver) {
        mutableStateOf(CallPresentation())
    }
    val calls = (state.calls as? RemoteList.Loaded)?.items.orEmpty()
    val ownedCall = primaryOwnedCall(calls, state.media.callId)
    val finishedIds = calls.filter {
        it.optString("state") in setOf("ended", "failed") || !it.optBoolean("claimedByCurrentSession")
    }.map { it.optString("id") }.toSet()
    var presentedCall by remember(state.sessionEpoch, state.session?.username) { mutableStateOf<JSONObject?>(null) }
    LaunchedEffect(state.sessionEpoch, calls, ownedCall?.optString("id")) {
        presentation = presentation.reconcile(ownedCall?.optString("id"), finishedIds)
        presentedCall = calls.firstOrNull { it.optString("id") == presentation.callId }
            ?: presentedCall?.takeIf { it.optString("id") == presentation.callId }
    }
    var destination by rememberSaveable { mutableStateOf(Destination.CALL) }
    // S69: ui.error_shown 的 screen 跟随当前页签。
    SideEffect { ClientDiag.screen = destination.name.lowercase() }
    var detailVisible by remember(destination) { mutableStateOf(false) }
    // Hoisted out of SmsPage so a tab switch closes the composer.
    var smsComposing by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(destination) { if (destination != Destination.SMS) smsComposing = false }
    // S21 §F: 拨打电话 / 发送短信 on the contact card switch tab here; the target page pre-fills the
    // number and clears the request, so the same number twice in a row still navigates.
    LaunchedEffect(state.navigation?.nonce) {
        when (state.navigation?.target) {
            ClientNavigationTarget.DIAL -> destination = Destination.CALL
            ClientNavigationTarget.SMS -> destination = Destination.SMS
            null -> Unit
        }
    }
    // Shared presentation timestamp survives full-screen/minimized transitions. Failure clears
    // endingCallIds, discards the freeze and resumes from the authoritative answeredAt.
    val durationCallId = presentedCall?.optString("id")
    val durationEnding = durationCallId in state.endingCallIds ||
        presentedCall?.optString("state") in setOf("ending", "ended", "failed")
    val durationFrozenAt by rememberSaveable(state.sessionEpoch, durationCallId, durationEnding) {
        mutableStateOf(if (durationEnding) System.currentTimeMillis() else null)
    }
    CompositionLocalProvider(
        LocalNetworkAvailable provides state.networkAvailable,
        LocalCallDurationFrozenAt provides durationFrozenAt,
    ) {
        Scaffold(
            modifier = Modifier.testTag("workspace").then(
                if (presentation.expanded) Modifier.clearAndSetSemantics {} else Modifier,
            ),
            topBar = {
                Column(Modifier.statusBarsPadding()) {
                    if (!state.networkAvailable) {
                        val live = state.media.callId != null && state.media.phase in setOf(CallMediaPhase.CONNECTING, CallMediaPhase.CONNECTED)
                        StatusBanner(
                            StatusBannerKind.DEVICE_OFFLINE,
                            if (live) offlineBannerText(state.media) else "显示的是上次加载的内容；草稿可以继续编辑，联网后自动刷新。",
                            Modifier.padding(horizontal = ScreenPadding, vertical = 8.dp).testTag("workspace.offline"),
                        )
                    }
                    presentedCall?.takeIf { !presentation.expanded }?.let { call -> CollapsedCallBar(call, state) { presentation = presentation.restore() } }
                    // S68: one row per tab page — big title on the left, that page's action on the right.
                    if (!detailVisible) TopAppBar(
                        windowInsets = WindowInsets(0, 0, 0, 0),
                        title = {
                            Text(
                                destination.title,
                                style = MaterialTheme.typography.titleLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        colors = TopAppBarDefaults.topAppBarColors(
                            containerColor = MaterialTheme.colorScheme.background,
                            scrolledContainerColor = MaterialTheme.colorScheme.background,
                        ),
                        actions = {
                            when (destination) {
                                Destination.CALL -> IconButton(
                                    onClick = model::refreshAll,
                                    enabled = state.networkAvailable && !state.busy,
                                    modifier = Modifier.padding(end = 4.dp).size(TouchTarget),
                                ) {
                                    Icon(Icons.Filled.Refresh, contentDescription = "刷新通话", tint = MaterialTheme.colorScheme.primary)
                                }
                                else -> Unit
                            }
                        },
                    )
                }
            },
            bottomBar = {
                val haptic = LocalHapticFeedback.current
                NavigationBar(containerColor = LocalSignal.current.chrome, modifier = Modifier.heightIn(min = 80.dp)) {
                    Destination.entries.forEach { item ->
                        NavigationBarItem(
                            selected = destination == item,
                            onClick = { haptic.performHapticFeedback(HapticFeedbackType.VirtualKey); destination = item },
                            modifier = Modifier.testTag("tab.${item.name.lowercase()}"),
                            icon = {
                                val count = when (item) {
                                    Destination.CALL -> state.badges?.calls ?: 0
                                    Destination.SMS -> state.badges?.sms ?: 0
                                    else -> 0
                                }
                                BadgedBox(badge = { CountBadge(count) }) { Icon(item.icon, contentDescription = item.tabLabel) }
                            },
                            label = {
                                Text(
                                    item.tabLabel,
                                    fontWeight = if (destination == item) FontWeight.Bold else FontWeight.Normal,
                                    maxLines = 1,
                                    softWrap = false,
                                )
                            },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = MaterialTheme.colorScheme.primary,
                                selectedTextColor = MaterialTheme.colorScheme.onSurface,
                                indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                                unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            ),
                        )
                    }
                }
            },
            containerColor = MaterialTheme.colorScheme.background,
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                val showDialingAcknowledgement = ownedCall?.optString("state") in setOf("outgoing_pending", "connecting") &&
                    ownedCall?.optString("id") !in state.endingCallIds
                if (state.message.isNotBlank() && state.message != "结束请求已提交" &&
                    (state.message != DIALING_ACKNOWLEDGEMENT || showDialingAcknowledgement)
                ) {
                    Box(Modifier.padding(horizontal = ScreenPadding, vertical = 8.dp)) { StateMessage(state) }
                }
                if (state.refreshMessage.isNotBlank()) {
                    StatusBanner(
                        StatusBannerKind.SERVICE_UNAVAILABLE,
                        "正在自动重试。${state.refreshMessage}",
                        Modifier.padding(horizontal = ScreenPadding, vertical = 8.dp),
                    )
                }
                when (destination) {
                    Destination.CALL -> CallPage(state, model, onShowCall = { presentation = presentation.restore() }, onDetailVisible = { detailVisible = it })
                    Destination.SMS -> SmsPage(
                        state = state,
                        model = model,
                        composing = smsComposing,
                        onComposingChange = { smsComposing = it },
                        onDetailVisible = { detailVisible = it },
                    )
                    Destination.CONTACTS -> ContactsPage(state, model) { detailVisible = it }
                    Destination.HISTORY -> HistoryPage(state, model) { detailVisible = it }
                    Destination.SETTINGS -> SettingsPage(state, model, passkeys) { detailVisible = it }
                }
            }
        }
        // One host for the whole workspace: the card is opened from 通话, 记录, 记录详情, 拦截记录 and
        // 通讯录, and a per-screen copy would stack two sheets when a tab switches underneath it.
        if (state.contactCard != null) ContactCardSheet(state, model)
        presentedCall?.takeIf { presentation.expanded }?.let { call ->
            FullscreenCall(call, state, model, onMinimize = { presentation = presentation.minimize() })
        }
    }
}

/**
 * S46 collapsed call: one full-width 44 dp callFill row under the status bar — ● name timer … 返回通话 ›.
 * Tapping restores the full-screen call; it never ends the call.
 */
@Composable
private fun CollapsedCallBar(call: JSONObject, state: ClientUiState, onRestore: () -> Unit) {
    val ending = call.optString("id") in state.endingCallIds || call.optString("state") == "ending"
    val signal = LocalSignal.current
    Surface(
        onClick = onRestore,
        color = if (ending) signal.surface3 else signal.callFill,
        contentColor = if (ending) signal.ink2 else Color.White,
        modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("call.restore"),
    ) {
        Row(
            Modifier.padding(horizontal = ScreenPadding, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (ending) CircularProgressIndicator(Modifier.size(14.dp).clearAndSetSemantics {}, color = LocalContentColor.current, strokeWidth = 2.dp)
            else Box(Modifier.size(8.dp).background(Color.White, CircleShape))
            Text(
                when {
                    ending -> "正在结束… · "
                    call.optString("state") != "active" -> "${callStateLabel(call.optString("state"))} · "
                    else -> ""
                } + callTitle(call),
                Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            CallDurationText(call, compact = true)
            // S95b §A: the line's own answer mode (per-SIM settings), compact badge.
            (state.sims as? RemoteList.Loaded)?.items.orEmpty().firstOrNull { it.optString("id") == call.optString("simId") }
                ?.let { runCatching { it.toClientSim() }.getOrNull() }?.let { AiBadge(it.answerMode) }
            Spacer(Modifier.weight(1f))
            Text("返回通话 ›", style = MaterialTheme.typography.titleSmall, maxLines = 1, softWrap = false)
        }
    }
}
