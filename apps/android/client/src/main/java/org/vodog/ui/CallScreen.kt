package org.vodog

import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.automirrored.filled.CallMade
import androidx.compose.material.icons.automirrored.filled.CallReceived
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import kotlinx.coroutines.delay
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleStartEffect
import org.json.JSONObject

@Composable
internal fun CallPage(state: ClientUiState, model: ClientViewModel, onShowCall: () -> Unit = {}) {
    val haptic = LocalHapticFeedback.current
    val sims = (state.sims as? RemoteList.Loaded)?.items.orEmpty().mapNotNull {
        runCatching { it.toClientSim() }.getOrNull()
    }
    val simJsonById = (state.sims as? RemoteList.Loaded)?.items.orEmpty().associateBy { it.optString("id") }
    val calls = (state.calls as? RemoteList.Loaded)?.items.orEmpty()
    var selectedId by rememberSaveable(sims.map(ClientSim::id)) {
        mutableStateOf(sims.firstOrNull()?.id.orEmpty())
    }
    var number by rememberSaveable { mutableStateOf("") }
    var showingKeypad by rememberSaveable { mutableStateOf(true) }
    var phoneDetailId by rememberSaveable { mutableStateOf<String?>(null) }
    val listState = rememberLazyListState()
    val phoneDetail = state.callDetail?.takeIf { it.item.callId == phoneDetailId }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    // S20 D5: poll only while this tab is on screen and the app is at least STARTED. Leaving the
    // tab or backgrounding the app stops every periodic request; it never ends a call.
    LifecycleStartEffect(Unit) {
        model.startForegroundRefresh(ClientRefreshScope.CALLS)
        onStopOrDispose { model.stopForegroundRefresh(ClientRefreshScope.CALLS) }
    }
    // S21 §F: "拨打电话" on the contact card lands here with the number already typed.
    // S36 C5-b: a 拨打 from a record/contact also resolves the SIM and asks for one confirmation
    // before dialing; when no SIM can place the call it degrades to the old prefill-only path.
    var dialConfirm by remember { mutableStateOf<Pair<ClientSim, String>?>(null) }
    LaunchedEffect(state.navigation) {
        val request = state.navigation
        if (request?.target == ClientNavigationTarget.DIAL) {
            number = request.number
            showingKeypad = true
            listState.scrollToItem(0)
            if (request.confirm) resolveDialSim(request.simId, selectedId, sims)?.let { sim ->
                selectedId = sim.id
                dialConfirm = sim to request.number
            }
            model.consumeNavigation()
        }
    }
    // Debounced `GET /contacts/lookup`; the view model drops anything shorter than three digits.
    LaunchedEffect(number, state.networkAvailable) { if (state.networkAvailable) model.lookupDialNumber(number) }
    val selected = sims.singleOrNull { it.id == selectedId }
    val occupied = selected?.let { gatewayBusyForSim(it, calls, sims) }
    val activeCalls = calls.filter { it.optString("state") !in setOf("ended", "failed") }
    val controlledCall = primaryOwnedCall(calls, state.media.callId)
    val otherActiveCalls = activeCalls.filter { it.optString("id") != controlledCall?.optString("id") }
    val recentCalls = hideMergedInternalLegs(calls).filter {
        it.optString("state") in setOf("ended", "failed") && (selectedId.isBlank() || it.optString("simId") == selectedId)
    }.take(20)
    Column(Modifier.fillMaxSize()) {
        ClientSimPicker(sims, selectedId, badges = state.badges?.simCalls().orEmpty()) { selectedId = it }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth().testTag("calls.list").pointerInput(showingKeypad) {
                detectTapGestures { focus.clearFocus(); keyboard?.hide(); showingKeypad = false }
            },
            contentPadding = PaddingValues(bottom = 18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            state = listState,
        ) {
            item {
                Card(
                    Modifier.padding(horizontal = ScreenPadding).fillMaxWidth().pointerInput(Unit) {
                        detectTapGestures(onTap = { /* consume outer keypad-dismiss gesture */ })
                    },
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                ) {
                    Column(
                        Modifier.fillMaxWidth().padding(ScreenPadding),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        if (controlledCall != null) {
                            Text(callTitle(controlledCall), style = MaterialTheme.typography.titleLarge)
                            Button(onClick = onShowCall, modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget)) {
                                Text("返回通话")
                            }
                        } else {
                            Surface(onClick = { showingKeypad = true }, color = androidx.compose.ui.graphics.Color.Transparent, modifier = Modifier.fillMaxWidth()) {
                                Box(Modifier.height(42.dp), contentAlignment = Alignment.Center) {
                                    Text(
                                        number.ifBlank { "输入电话号码" },
                                        style = MaterialTheme.typography.headlineSmall,
                                        color = if (number.isBlank()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                                        fontFamily = FontFamily.Monospace,
                                    )
                                }
                            }
                            val matchingName = state.dialerLookup.hintFor(number)
                            val hintStyle = MaterialTheme.typography.titleSmall
                            val hintHeight = with(LocalDensity.current) { hintStyle.lineHeight.toDp() }
                            Box(
                                Modifier.fillMaxWidth().height(hintHeight),
                                contentAlignment = Alignment.Center,
                            ) {
                                if (matchingName != null) Text(
                                    matchingName,
                                    style = hintStyle,
                                    color = MaterialTheme.colorScheme.primary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            // Exactly one footnote, in the same precedence the dial preflight uses.
                            val occupancyNotice = occupied?.let { callOccupancyNotice(it, selected?.timeZone) }
                            val unavailable = when {
                                !state.networkAvailable -> "设备未联网"
                                selected == null -> "请选择已分配的号码"
                                selected.unavailableReason(forCall = true) != null -> selected.unavailableReason(forCall = true)
                                occupancyNotice != null -> occupancyNotice
                                localMediaBlocks(null, state.media) -> "本机音频正在用于另一通话，请先结束该通话"
                                else -> null
                            }
                            if (showingKeypad) PhoneKeypad(
                                onDigit = { digit -> number += digit },
                                onPlus = { number += "+" },
                            )
                            val canDial = state.networkAvailable && !state.busy && selected?.canCall == true && occupied == null &&
                                !localMediaBlocks(null, state.media) && number.isNotBlank()
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(34.dp, Alignment.CenterHorizontally),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                IconButton(
                                    onClick = { if (number.isNotEmpty()) number = number.dropLast(1) },
                                    enabled = number.isNotEmpty(),
                                    modifier = Modifier.size(52.dp),
                                ) { Icon(Icons.AutoMirrored.Filled.Backspace, contentDescription = "删除一位") }
                                Surface(
                                    onClick = { haptic.performHapticFeedback(HapticFeedbackType.Confirm); model.startCall(selectedId, number.trim()) },
                                    enabled = canDial,
                                    modifier = Modifier.size(62.dp),
                                    shape = CircleShape,
                                    color = if (canDial) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.tertiaryContainer,
                                    contentColor = if (canDial) MaterialTheme.colorScheme.onTertiary else MaterialTheme.colorScheme.onTertiaryContainer,
                                ) {
                                    Box(contentAlignment = Alignment.Center) {
                                        Icon(
                                            Icons.Filled.Call,
                                            contentDescription = selected?.let { "使用${it.displayLabel}拨打" } ?: "拨号",
                                        )
                                    }
                                }
                                IconButton(
                                    onClick = { number = "" },
                                    enabled = number.isNotEmpty(),
                                    modifier = Modifier.size(52.dp),
                                ) { Icon(Icons.Filled.Close, contentDescription = "清除号码") }
                            }
                            unavailable?.let {
                                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            // The occupancy line is printed even when a more urgent reason won the single
                            // footnote slot, because the release button below has to have a visible
                            // reason. Before S22 the SIM-offline text outranked it and the button vanished
                            // with it — exactly when the user most needs to free the line (R4 Part B).
                            if (occupancyNotice != null && unavailable != occupancyNotice) {
                                Text(
                                    occupancyNotice,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (occupied != null) {
                                OccupancyReleaseAction(occupied, state, model)
                            }
                        }
                    }
                }
            }
            // The owned call is rendered by the primary controls above, so the section only appears when
            // there is no owned call or there are other active calls to show.
            if (controlledCall == null || otherActiveCalls.isNotEmpty()) {
                item { SectionHeader("当前通话") }
                if (state.calls !is RemoteList.Loaded) item { Box(Modifier.padding(horizontal = ScreenPadding)) { RemoteStateText(state.calls) } }
                else if (otherActiveCalls.isEmpty()) item { EmptyCard("暂无当前通话") }
                else items(otherActiveCalls, key = { it.optString("id") }) { call ->
                    Box(Modifier.padding(horizontal = ScreenPadding)) { ActiveCallCard(call, state, model) }
                }
            }
            item { SectionHeader("最近通话") }
            if (recentCalls.isEmpty()) item { EmptyCard("当前号码暂无通话记录") }
            else items(recentCalls, key = { it.optString("id") }) { call ->
                RecentCallRow(
                    call = call,
                    unseen = callShowsUnseenDot(call, state.seenCallIds),
                    simLabel = callLineLabel(simJsonById[call.optString("simId")]),
                    timeZone = selected?.timeZone,
                    onInfo = { model.openContactCard(callContactCardTarget(call)) },
                    onTranscript = {
                        phoneDetailId = call.optString("id")
                        model.openCallDetail(call, HistoryViewerKind.TRANSCRIPT)
                    },
                    onRecording = {
                        phoneDetailId = call.optString("id")
                        model.openCallDetail(call, HistoryViewerKind.RECORDING)
                    },
                )
            }
        }
    }
    if (phoneDetail?.viewer == HistoryViewerKind.TRANSCRIPT) {
        TranscriptSheet(phoneDetail, model) { phoneDetailId = null; model.closeReportCall() }
    }
    if (phoneDetail?.viewer == HistoryViewerKind.RECORDING) {
        RecordingSheet(phoneDetail, model) { phoneDetailId = null; model.closeReportCall() }
    }
    dialConfirm?.let { (sim, target) ->
        AlertDialog(
            onDismissRequest = { dialConfirm = null },
            title = { Text("确认拨打") },
            text = { Text("用 ${sim.displayLabel} 拨打 $target？") },
            confirmButton = {
                TextButton(
                    onClick = { haptic.performHapticFeedback(HapticFeedbackType.Confirm); dialConfirm = null; model.startCall(sim.id, target) },
                    enabled = state.networkAvailable && !state.busy && sims.firstOrNull { it.id == sim.id }?.canCall == true,
                ) { Text("拨打") }
            },
            dismissButton = { TextButton(onClick = { dialConfirm = null }) { Text("取消") } },
        )
    }
}

/**
 * S20 D6 "结束该通话": ends the call that currently occupies this Pixel on another device of the same
 * account. It renders only when the server says this session may release it and does not already
 * hold it, and always asks first — the wording for a ringing call is a decline, not a hang-up.
 */
@Composable
private fun OccupancyReleaseAction(call: JSONObject, state: ClientUiState, model: ClientViewModel) {
    if (!canReleaseOccupiedCall(call)) return
    val callId = call.optString("id")
    val callState = call.optString("state")
    val ending = callId in state.endingCallIds || callState == "ending"
    val prompt = occupancyReleasePrompt(callState)
    var confirming by remember(callId) { mutableStateOf(false) }
    TextButton(
        onClick = { confirming = true },
        enabled = !ending && callId.isNotBlank(),
        modifier = Modifier.heightIn(min = TouchTarget),
        colors = destructiveTextColors(),
    ) { Text(if (ending) "正在结束" else "结束该通话") }
    if (confirming) AlertDialog(
        onDismissRequest = { confirming = false },
        title = { Text(prompt.title) },
        text = { Text(prompt.message) },
        confirmButton = {
            TextButton(
                onClick = {
                    confirming = false
                    model.releaseOccupiedCall(callId, callState)
                },
                colors = destructiveTextColors(),
            ) { Text(prompt.confirmLabel) }
        },
        dismissButton = { TextButton(onClick = { confirming = false }) { Text("取消") } },
    )
}

@Composable
private fun RecentCallRow(
    call: JSONObject,
    unseen: Boolean,
    simLabel: String?,
    timeZone: String?,
    onInfo: () -> Unit,
    onTranscript: () -> Unit,
    onRecording: () -> Unit,
) {
    val failed = call.optString("state") == "failed"
    Card(
        Modifier.padding(horizontal = ScreenPadding).fillMaxWidth()
            .testTag("calls.recent.${call.optString("id")}"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                UnreadDot(unseen, "未查看")
                if (call.toContactAnnotation().blocked) {
                    Icon(
                        Icons.Filled.Block,
                        contentDescription = "已屏蔽",
                        Modifier.size(18.dp),
                        tint = MaterialTheme.colorScheme.error,
                    )
                }
                Icon(
                    if (call.optString("direction") == "incoming") Icons.AutoMirrored.Filled.CallReceived else Icons.AutoMirrored.Filled.CallMade,
                    contentDescription = directionLabel(call.optString("direction")),
                    tint = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                )
                Column(Modifier.weight(1f)) {
                    // S36 C5-a: 有联系人时姓名单独一行，号码整行不截断。
                    val (rowName, rowNumber) = callRowLines(call)
                    rowName?.let {
                        Text(it, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    PhoneNumberText(
                        rowNumber,
                        color = if (rowName == null) androidx.compose.ui.graphics.Color.Unspecified
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    val missedLabel = missedCallLabel(call)
                    val missed = missedLabel != null
                    Text(
                        listOfNotNull(simLabel, missedLabel ?: callStateLabel(call.optString("state"))).joinToString(" · "),
                        style = MaterialTheme.typography.labelSmall,
                        color = if (missed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        formatGatewayDateTime(call.optString("startedAt"), jsonDisplayTimeZone(call, timeZone)),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    talkDurationLabel(
                        call.optString("answeredAt").takeUnless { it.isBlank() || it == "null" },
                        call.optString("endedAt").takeUnless { it.isBlank() || it == "null" },
                    )?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                IconButton(onClick = onInfo, modifier = Modifier.size(TouchTarget)) {
                    Icon(Icons.Outlined.Info, contentDescription = "联系人卡片", tint = MaterialTheme.colorScheme.primary)
                }
            }
            HistoryCallActions(onTranscript = onTranscript, onRecording = onRecording)
        }
    }
}

/**
 * Runs a media action only once RECORD_AUDIO is granted, reporting a denial back to the view model
 * so the call still shows why audio is missing. Both the primary controls and [ActiveCallCard] need
 * this gate, including the retry path — otherwise a permission-denied failure can never recover.
 */
@Composable
private fun rememberMicPermissionGate(
    callId: String,
    model: ClientViewModel,
): (CallMediaTransport, () -> Unit) -> Unit {
    val context = LocalContext.current
    var pending by remember { mutableStateOf<Pair<CallMediaTransport, () -> Unit>?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        pending?.let { (transport, action) ->
            if (granted) action() else model.mediaPermissionDenied(callId, transport)
        }
        pending = null
    }
    return { transport, action ->
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            action()
        } else {
            pending = transport to action
            permission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}

internal const val DIALING_ACKNOWLEDGEMENT = "拨号已提交，正在等待网关设备的线路接通"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun FullscreenCall(call: JSONObject, state: ClientUiState, model: ClientViewModel, onMinimize: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    val callId = call.optString("id")
    val ending = callId in state.endingCallIds || call.optString("state") == "ending"
    val sims = (state.sims as? RemoteList.Loaded)?.items.orEmpty().mapNotNull {
        runCatching { it.toClientSim() }.getOrNull()
    }
    // A separate presentation window leaves the selected tab, drafts and scroll positions composed.
    // Android Back dismisses this window into the ongoing-call strip; it never ends a call.
    Dialog(onDismissRequest = onMinimize, properties = DialogProperties(
        usePlatformDefaultWidth = false, dismissOnClickOutside = false, decorFitsSystemWindows = false,
    )) {
        Scaffold(
            modifier = Modifier.fillMaxSize().testTag("call.fullscreen"),
            topBar = {
                TopAppBar(title = { Text("当前通话") }, navigationIcon = {
                    IconButton(onClick = onMinimize, modifier = Modifier.size(TouchTarget)) {
                        Icon(Icons.Filled.ExpandMore, "最小化通话")
                    }
                })
            },
            bottomBar = {
                Surface {
                    Button(
                        onClick = { haptic.performHapticFeedback(HapticFeedbackType.Reject); model.endCall(callId) },
                        enabled = !ending,
                        modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(ScreenPadding).heightIn(min = 52.dp).testTag("call.end"),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = FilledDestructiveRed,
                            contentColor = androidx.compose.ui.graphics.Color.White,
                            disabledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                            disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        ),
                    ) {
                        if (ending) CircularProgressIndicator(Modifier.size(20.dp).clearAndSetSemantics {}, color = MaterialTheme.colorScheme.onSurfaceVariant, strokeWidth = 2.dp)
                        else Icon(Icons.Filled.CallEnd, contentDescription = if (state.media.callId == callId && state.media.phase == CallMediaPhase.FAILED) "结束这通通话" else null)
                        Spacer(Modifier.width(6.dp))
                        Text(if (ending) "正在结束" else "结束通话")
                    }
                }
            },
        ) { padding ->
            Column(
                Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(ScreenPadding),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                if (!state.networkAvailable) MessageCard("设备未联网 · 仍可尝试结束通话")
                if (state.message == DIALING_ACKNOWLEDGEMENT) {
                    if (!ending && call.optString("state") in setOf("outgoing_pending", "connecting")) {
                        Text(state.message, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                } else if (state.message == "结束请求已提交") {
                    Text(state.message, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else if (state.message.isNotBlank()) StateMessage(state)
                PrimaryOwnedCallControls(call, state, model, sims)
            }
        }
    }
}

/** The retry surface of a held call whose media handshake failed (media already scoped to this call). */
internal fun mediaRecoveryVisible(media: CallMediaUiState?): Boolean = media?.phase == CallMediaPhase.FAILED

internal fun callDtmfEnabled(callState: String, networkAvailable: Boolean, ending: Boolean): Boolean =
    callState == "active" && networkAvailable && !ending

@Composable
internal fun PrimaryOwnedCallControls(
    call: JSONObject,
    state: ClientUiState,
    model: ClientViewModel,
    sims: List<ClientSim>,
) {
    val callId = call.optString("id")
    val sim = sims.firstOrNull { it.id == call.optString("simId") }
    val media = state.media.takeIf { it.callId == callId }
    val ending = callId in state.endingCallIds || call.optString("state") == "ending"
    val liveAudio = media?.phase == CallMediaPhase.CONNECTED
    val withMic = rememberMicPermissionGate(callId, model)
    var showDtmf by rememberSaveable(callId) { mutableStateOf(false) }
    val statusColor = if (ending) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.tertiary
    Icon(Icons.Filled.PhoneInTalk, contentDescription = null, tint = statusColor)
    Text(
        callTitle(call),
        style = MaterialTheme.typography.headlineSmall,
        fontFamily = FontFamily.Monospace,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
    Text(
        "${sim?.displayLabel ?: "SIM"} · 当前登录会话",
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text(if (ending) "正在结束" else callStateLabel(call.optString("state")), style = MaterialTheme.typography.titleMedium, color = statusColor)
    CallDurationText(call)
    val haptic = LocalHapticFeedback.current
    val muted = media?.microphoneMuted == true
    val speakerOn = media?.speakerEnabled == true
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedButton(
            onClick = {
                haptic.performHapticFeedback(if (muted) HapticFeedbackType.ToggleOff else HapticFeedbackType.ToggleOn)
                model.setMuted(!muted)
            },
            enabled = liveAudio && !ending,
            modifier = Modifier.weight(1f).heightIn(min = 52.dp),
            colors = callToggleColors(muted),
        ) {
            Icon(if (media?.microphoneMuted == true) Icons.Filled.Mic else Icons.Filled.MicOff, contentDescription = null)
            Spacer(Modifier.width(6.dp))
            Text(if (media?.microphoneMuted == true) "取消静音" else "静音")
        }
        OutlinedButton(
            onClick = {
                haptic.performHapticFeedback(if (speakerOn) HapticFeedbackType.ToggleOff else HapticFeedbackType.ToggleOn)
                model.setSpeaker(!speakerOn)
            },
            enabled = liveAudio && !ending,
            modifier = Modifier.weight(1f).heightIn(min = 52.dp),
            colors = callToggleColors(speakerOn),
        ) {
            Icon(if (media?.speakerEnabled == true) Icons.AutoMirrored.Filled.VolumeOff else Icons.AutoMirrored.Filled.VolumeUp, contentDescription = null)
            Spacer(Modifier.width(6.dp))
            Text(if (media?.speakerEnabled == true) "关闭扬声器" else "打开扬声器")
        }
    }
    // S36 C2: 通话中拨号盘。只在 active 时出现（服务端也只在 active 收 DTMF），每按一位立刻发一位，
    // 本地提示音由 [PhoneKeypad] 自带；长按 0 的 "+" 在这里是空操作，因为 "+" 不是 DTMF 字符。
    if (call.optString("state") == "active") {
        var dtmfError by remember(callId) { mutableStateOf("") }
        OutlinedButton(
            onClick = { haptic.performHapticFeedback(HapticFeedbackType.VirtualKey); showDtmf = !showDtmf },
            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).testTag("call.keypad.toggle"),
            colors = callToggleColors(showDtmf),
        ) { Text(if (showDtmf) "收起键盘" else "键盘") }
        if (showDtmf) {
            PhoneKeypad(
                enabled = callDtmfEnabled(call.optString("state"), state.networkAvailable, ending),
                onDigit = { digit ->
                    dtmfError = ""
                    model.sendDtmf(callId, digit) { dtmfError = it }
                },
                onPlus = {},
            )
            if (dtmfError.isNotBlank()) Text(
                dtmfError,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
    if (mediaRecoveryVisible(media)) {
        MediaRecoveryControls(
            message = media?.message.orEmpty(),
            ending = ending,
            failedAtMillis = media?.failedAtMillis,
            onRetry = { withMic(CallMediaTransport.UDP) { model.retryCallMedia(callId) } },
            onEnd = { model.endCall(callId) },
            onTls = { withMic(CallMediaTransport.TLS) { model.connectMedia(callId, CallMediaTransport.TLS) } },
            showEndAction = false,
        )
    }
    Text(
        when {
            media?.phase == CallMediaPhase.FAILED -> "通话声音暂不可用，仍可结束通话。"
            media?.rejoining == true -> CallMediaRejoinPolicy.MESSAGE
            !liveAudio -> "通话声音尚未就绪。"
            media?.microphoneMuted == true -> "麦克风已静音，对方听不到你的声音。"
            else -> "通话声音已连接。"
        },
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    )
}

/** In-call toggles (mute, speaker, keypad): a filled primary pill while on, so the state reads at a glance. */
@Composable
private fun callToggleColors(on: Boolean) =
    if (on) ButtonDefaults.outlinedButtonColors(
        containerColor = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
    ) else ButtonDefaults.outlinedButtonColors(containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.35f))

/**
 * S19 media recovery (iOS `mediaRecoveryControls`): the failed handshake message, a retry, an
 * explicit end, and the grace footnote. Manual TLS stays reachable for the "UDP is blocked here"
 * case that the automatic retry cannot fix.
 */
@Composable
private fun MediaRecoveryControls(
    message: String,
    ending: Boolean,
    failedAtMillis: Long?,
    onRetry: () -> Unit,
    onEnd: () -> Unit,
    onTls: () -> Unit,
    showEndAction: Boolean = true,
) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Filled.Warning, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.error)
        Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Button(onClick = onRetry, enabled = LocalNetworkAvailable.current && !ending, modifier = Modifier.weight(1f).heightIn(min = 52.dp)) {
            Icon(Icons.Filled.Refresh, contentDescription = "重试通话音频")
            Spacer(Modifier.width(6.dp))
            Text("重试音频")
        }
        if (showEndAction) OutlinedButton(
            onClick = onEnd,
            enabled = !ending,
            modifier = Modifier.weight(1f).heightIn(min = 52.dp),
            colors = destructiveOutlinedColors(),
            border = destructiveBorder(),
        ) {
            Icon(Icons.Filled.CallEnd, contentDescription = "结束这通通话")
            Spacer(Modifier.width(6.dp))
            Text("结束通话")
        }
    }
    TextButton(onClick = onTls, enabled = LocalNetworkAvailable.current && !ending, modifier = Modifier.heightIn(min = TouchTarget)) { Text("改用 TLS") }
    // iOS runs a live countdown here (TimelineView + Text(timerInterval:)); a static "30 秒内…" read
    // as a warning that never moved, so the Android card ticks too (R4 Part B must-fix).
    var remaining by remember(failedAtMillis) {
        mutableStateOf(mediaGraceRemainingSeconds(failedAtMillis, System.currentTimeMillis()))
    }
    LaunchedEffect(failedAtMillis) {
        while (true) {
            remaining = mediaGraceRemainingSeconds(failedAtMillis, System.currentTimeMillis())
            if (remaining <= 0) break
            delay(1_000)
        }
    }
    Text(
        if (remaining > 0) mediaGraceCountdownFootnote(remaining) else CallMediaGracePolicy.FOOTNOTE,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun PhoneKeypad(onDigit: (String) -> Unit, onPlus: () -> Unit, enabled: Boolean = true) {
    val keyColor = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
    val dialTone = remember { DialTonePlayer() }
    val haptic = LocalHapticFeedback.current
    DisposableEffect(dialTone) { onDispose { dialTone.release() } }
    val rows = listOf(
        listOf("1" to "", "2" to "ABC", "3" to "DEF"),
        listOf("4" to "GHI", "5" to "JKL", "6" to "MNO"),
        listOf("7" to "PQRS", "8" to "TUV", "9" to "WXYZ"),
        listOf("*" to "", "0" to "+", "#" to ""),
    )
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp)) {
                row.forEach { (digit, letters) ->
                    Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                        Box(
                            Modifier.size(68.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape)
                                .combinedClickable(
                                    enabled = enabled,
                                    role = Role.Button,
                                    onClick = { dialTone.play(digit); haptic.performHapticFeedback(HapticFeedbackType.KeyboardTap); onDigit(digit) },
                                    onLongClick = { if (digit == "0") { haptic.performHapticFeedback(HapticFeedbackType.KeyboardTap); onPlus() } },
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(digit, style = MaterialTheme.typography.headlineSmall, fontFamily = FontFamily.Monospace, color = keyColor)
                                Text(letters, style = MaterialTheme.typography.labelSmall, modifier = Modifier.height(12.dp), color = keyColor)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun ActiveCallCard(call: JSONObject, state: ClientUiState, model: ClientViewModel) {
    val haptic = LocalHapticFeedback.current
    val callId = call.optString("id")
    val callState = call.optString("state")
    val ending = callId in state.endingCallIds || callState == "ending"
    val sim = (state.sims as? RemoteList.Loaded)?.items.orEmpty()
        .firstOrNull { it.optString("id") == call.optString("simId") }
        ?.let { runCatching { it.toClientSim() }.getOrNull() }
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Filled.PhoneInTalk, null, tint = MaterialTheme.colorScheme.tertiary)
                Text("当前通话", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.tertiary)
            }
            Text(callTitle(call), style = MaterialTheme.typography.headlineSmall, fontFamily = FontFamily.Monospace)
            Row(Modifier.fillMaxWidth()) {
                Text(callStateLabel(callState), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                Column(horizontalAlignment = Alignment.End) {
                    Text(sim?.displayLabel ?: calledSimLabel(call) ?: "SIM", style = MaterialTheme.typography.labelMedium)
                    Text(sim?.gatewayShortLabel ?: "设备待确认", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            val ownership = if (call.optBoolean("claimedByCurrentSession")) "当前登录会话" else callOwnerLabel(call)
            ownership?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            // S22 决策 4: a call the server says AI is answering must not offer 接听/拒接 on any
            // device — accepting it here would race the AI that already owns the audio.
            val aiAnswering = aiAnswerSuppressed(call)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (callState == "incoming_ringing" && aiAnswering) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Icon(
                            Icons.Filled.AutoAwesome,
                            contentDescription = null,
                            Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.tertiary,
                        )
                        Text("AI 接听中", color = MaterialTheme.colorScheme.tertiary)
                    }
                } else if (callState == "incoming_ringing") {
                    Button(
                        onClick = { haptic.performHapticFeedback(HapticFeedbackType.Confirm); model.claimCall(callId) },
                        enabled = state.networkAvailable && !state.busy && !localMediaBlocks(callId, state.media),
                        modifier = Modifier.weight(1f).heightIn(min = TouchTarget),
                    ) { Text("接听") }
                    OutlinedButton(
                        onClick = { haptic.performHapticFeedback(HapticFeedbackType.Reject); model.declineCall(callId) },
                        enabled = state.networkAvailable && !ending && !state.busy,
                        modifier = Modifier.weight(1f).heightIn(min = TouchTarget),
                        colors = destructiveOutlinedColors(),
                        border = destructiveBorder(),
                    ) { Text(if (ending) "正在结束" else "拒接") }
                } else if (call.optBoolean("claimedByCurrentSession")) {
                    OutlinedButton(
                        onClick = { haptic.performHapticFeedback(HapticFeedbackType.Reject); model.endCall(callId) },
                        enabled = !ending,
                        modifier = Modifier.weight(1f).heightIn(min = TouchTarget),
                        colors = destructiveOutlinedColors(),
                        border = destructiveBorder(),
                    ) {
                        Icon(Icons.Filled.CallEnd, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text(if (ending) "正在结束" else "结束通话")
                    }
                }
            }
            if (callState in setOf("outgoing_pending", "connecting", "active")) {
                Text(
                    if (call.optBoolean("claimedByCurrentSession")) "请在通话面板查看通话状态。"
                    else "此通话由${callOwnerLabel(call) ?: "其他登录会话"}处理",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
