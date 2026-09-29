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
    CALL("通话", "电话", Icons.Filled.Phone),
    SMS("短信", "短信", Icons.AutoMirrored.Filled.Message),
    HISTORY("记录", "记录", Icons.Filled.History),
    CONTACTS("通讯录", "通讯录", Icons.Filled.Contacts),
    SETTINGS("设置", "设置", Icons.Filled.Settings),
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
    // Hoisted out of SmsPage because the "新短信" affordance lives in the top app bar.
    var smsComposing by rememberSaveable { mutableStateOf(false) }
    var smsCanCompose by remember { mutableStateOf(false) }
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
                        Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.testTag("workspace.offline")) {
                            Row(Modifier.fillMaxWidth().padding(ScreenPadding), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Icon(Icons.Filled.WifiOff, null)
                                Text(offlineBannerText(state.media), style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                    presentedCall?.takeIf { !presentation.expanded }?.let { call ->
                        Surface(
                            onClick = { presentation = presentation.restore() },
                            color = MaterialTheme.colorScheme.secondaryContainer,
                            modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("call.restore"),
                        ) {
                            Row(Modifier.padding(horizontal = ScreenPadding, vertical = 12.dp),
                                horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                val ending = call.optString("id") in state.endingCallIds || call.optString("state") == "ending"
                                if (ending) CircularProgressIndicator(Modifier.size(24.dp).clearAndSetSemantics {}, strokeWidth = 2.dp)
                                else Icon(Icons.Filled.Phone, null)
                                val callStatus = if (ending) "正在结束" else callStateLabel(call.optString("state"))
                                val callSim = (state.sims as? RemoteList.Loaded)?.items
                                    ?.firstOrNull { it.optString("id") == call.optString("simId") }
                                    ?.let { runCatching { it.toClientSim() }.getOrNull() }
                                Column(Modifier.weight(1f)) {
                                    Text("$callStatus · ${callTitle(call)}",
                                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(callSim?.let { simPickerTitle(it) } ?: "SIM",
                                        style = MaterialTheme.typography.labelSmall,
                                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                                CallDurationText(call, compact = true)
                                Text("返回通话", style = MaterialTheme.typography.labelLarge)
                            }
                        }
                    }
                    // S68: one row per tab page — big title on the left, that page's action on the right.
                    if (!detailVisible) TopAppBar(
                        windowInsets = WindowInsets(0, 0, 0, 0),
                        title = {
                            Text(
                                destination.title,
                                style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold),
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
                                Destination.SMS -> IconButton(
                                    onClick = { smsComposing = true },
                                    enabled = smsCanCompose && !state.busy,
                                    modifier = Modifier.padding(end = 4.dp).size(TouchTarget),
                                ) {
                                    Icon(Icons.Filled.Edit, contentDescription = "新短信", tint = MaterialTheme.colorScheme.primary)
                                }
                                else -> Unit
                            }
                        },
                    )
                }
            },
            bottomBar = {
                val haptic = LocalHapticFeedback.current
                NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
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
                            label = { Text(item.tabLabel) },
                            colors = NavigationBarItemDefaults.colors(
                                selectedIconColor = MaterialTheme.colorScheme.onSecondaryContainer,
                                selectedTextColor = MaterialTheme.colorScheme.primary,
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
                    Box(Modifier.padding(horizontal = ScreenPadding, vertical = 8.dp)) { MessageCard(state.refreshMessage) }
                }
                when (destination) {
                    Destination.CALL -> CallPage(state, model, onShowCall = { presentation = presentation.restore() })
                    Destination.SMS -> SmsPage(
                        state = state,
                        model = model,
                        composing = smsComposing,
                        onComposingChange = { smsComposing = it },
                        onCanComposeChange = { smsCanCompose = it },
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
