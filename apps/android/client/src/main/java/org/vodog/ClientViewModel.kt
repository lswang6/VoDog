package org.vodog

import android.Manifest
import android.app.Application
import android.os.SystemClock
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.Closeable

sealed interface RemoteList {
    data object NotLoaded : RemoteList
    data object Loading : RemoteList
    data class Loaded(val items: List<JSONObject>) : RemoteList
    data class Failed(val message: String) : RemoteList
}

internal fun remoteListDuringRefresh(current: RemoteList): RemoteList =
    if (current is RemoteList.Loaded) current else RemoteList.Loading

internal fun remoteListAfterRefresh(previous: RemoteList, updated: RemoteList): RemoteList =
    if (previous is RemoteList.Loaded && updated is RemoteList.Failed) previous else updated

internal data class VisibleRemoteListRefresh(val value: RemoteList, val error: String)

/** Retains a usable snapshot while keeping the refresh failure visible beside that Settings section. */
internal fun visibleRemoteListAfterRefresh(previous: RemoteList, updated: RemoteList): VisibleRemoteListRefresh =
    VisibleRemoteListRefresh(
        value = remoteListAfterRefresh(previous, updated),
        error = (updated as? RemoteList.Failed)?.message.orEmpty(),
    )

/** A superseded read is control flow, not a user-visible network failure. */
internal suspend fun loadRemoteList(block: () -> List<JSONObject>): RemoteList = try {
    RemoteList.Loaded(withContext(Dispatchers.IO) { block() })
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (error: Throwable) {
    RemoteList.Failed(error.userMessage())
}

/** Applies the POST-accepted gateway row before any independent reconciliation GET can finish. */
internal fun gatewayPowerAfterAcceptedItem(previous: RemoteList, item: JSONObject): RemoteList {
    val id = item.optString("gatewayId")
    if (id.isBlank()) return previous
    val rows = (previous as? RemoteList.Loaded)?.items.orEmpty()
    val replaced = rows.map { if (it.optString("gatewayId") == id) item else it }
    return RemoteList.Loaded(if (replaced.any { it.optString("gatewayId") == id }) replaced else replaced + item)
}

internal fun gatewayPowerHasPendingIntent(current: RemoteList, gatewayId: String): Boolean =
    (current as? RemoteList.Loaded)?.items.orEmpty().any {
        it.optString("gatewayId") == gatewayId && it.optString("desiredPower") in setOf("on", "off")
    }

internal sealed interface AcceptedPasskeyMutation {
    data class Renamed(val item: PasskeyItem) : AcceptedPasskeyMutation
    data class Deleted(val id: String) : AcceptedPasskeyMutation
}

/** Keeps an accepted rename/delete visible even when the following list reconciliation fails. */
internal fun passkeysAfterAcceptedMutation(
    previous: List<PasskeyItem>,
    mutation: AcceptedPasskeyMutation,
): List<PasskeyItem> = when (mutation) {
    // PATCH changes only `label`; retain rendered metadata if an older server returns a minimal
    // echo. The accepted label still wins immediately.
    is AcceptedPasskeyMutation.Renamed -> previous.map {
        if (it.id == mutation.item.id) it.copy(label = mutation.item.label) else it
    }
    is AcceptedPasskeyMutation.Deleted -> previous.filterNot { it.id == mutation.id }
}

internal fun passkeyRegistrationAllowed(state: ClientUiState): Boolean =
    !state.busy && state.passkeyPending.isEmpty() && !state.passkeyRegistrationRefreshPending

/** [remoteListDuringRefresh] 的 [RemoteResource] 版：重新请求当前页时列表先留着，不闪一下空白。 */
internal fun <T> remoteResourceDuringRefresh(current: RemoteResource<T>): RemoteResource<T> =
    if (current is RemoteResource.Loaded) current else RemoteResource.Loading

internal fun <T> remoteResourceAfterRefresh(
    previous: RemoteResource<T>,
    updated: RemoteResource<T>,
): RemoteResource<T> = if (previous is RemoteResource.Loaded && updated is RemoteResource.Failed) previous else updated

/**
 * 翻页 / 换搜索词（[sameRequest] 为 false）要给一个明确的「正在读」；只是重读当前这一页时保留旧结果。
 */
internal fun <T> pageStateDuringLoad(current: RemoteResource<T>, sameRequest: Boolean): RemoteResource<T> =
    if (sameRequest) remoteResourceDuringRefresh(current) else RemoteResource.Loading

/** 服务端回来的页码为准（越界时夹回最后一页），失败时页码不动。 */
internal fun pageNumberAfterLoad(current: Int, loaded: Page<*>?): Int =
    loaded?.let { RecordsPagingPolicy.clampPage(it.page, it.totalPages) } ?: current

/**
 * 分页结果落地。整个函数只碰 `callsPage`/`callsPageNum` —— [ClientUiState.calls]（拨号页轮询的那份）
 * 是刻意不在 copy 里的，这条约束有单测盯着。
 */
internal fun clientStateWithCallsPage(
    current: ClientUiState,
    result: RemoteResource<Page<JSONObject>>,
): ClientUiState = current.copy(
    callsPage = remoteResourceAfterRefresh(current.callsPage, result),
    // 失败时 `callsPage` 会原样留着上一份 Loaded，所以转圈必须由这一位收尾，否则下拉刷新会一直转。
    callsPageRefreshing = false,
    callsPageNum = pageNumberAfterLoad(current.callsPageNum, (result as? RemoteResource.Loaded)?.value),
)

/**
 * S30 删掉一条通话记录之后的就地落地。**刻意不经过 [clientStateWithCallsPage]**：那条路只写
 * `callsPage`（S28 钉死它一行都不许碰 [ClientUiState.calls]，因为分页结果不是「当前全部通话」），而
 * 删除恰恰要三处一起改 —— 拨号页轮询的 `calls`、记录页当前这一页 `callsPage`、以及报告页 `reports`
 * 里的同一通。服务端一条 `DELETE /calls/:id` 就把录音、转写和报告行级联删了，客户端只是在紧接着的
 * 重读回来之前不让这一行留在屏幕上。
 *
 * `total` 减一、`totalPages` 按 [RecordsPagingPolicy.totalPagesFor] 重算；删掉的正好是本页最后一行
 * 时页码退一页，否则随后的 [ClientViewModel.loadCallsPage] 会去请求一页空结果。旧 Control 的
 * `supported=false` 信封没有页数可言，`totalPages` 保持 1、也不退页。
 */
internal fun clientStateWithoutCall(current: ClientUiState, callId: String): ClientUiState {
    if (callId.isBlank()) return current
    val calls = (current.calls as? RemoteList.Loaded)
        ?.let { loaded -> RemoteList.Loaded(loaded.items.filterNot { it.optString("id") == callId }) }
        ?: current.calls
    val trimmedPage = (current.callsPage as? RemoteResource.Loaded)?.value?.let { page ->
        val items = page.items.filterNot { it.optString("id") == callId }
        val total = (if (items.size != page.items.size) page.total - 1 else page.total)
            .coerceAtLeast(items.size)
        val totalPages =
            if (!page.supported) page.totalPages else RecordsPagingPolicy.totalPagesFor(total, page.pageSize)
        val wanted = if (items.isEmpty() && page.page > 1) page.page - 1 else page.page
        page.copy(
            items = items,
            total = total,
            totalPages = totalPages,
            page = RecordsPagingPolicy.clampPage(wanted, totalPages),
        )
    }
    val reports = (current.reports as? RemoteResource.Loaded)?.value?.let { report ->
        val items = report.items.filterNot { it.callId == callId }
        val total = (if (items.size != report.items.size) report.paging.total - 1 else report.paging.total)
            .coerceAtLeast(items.size)
        RemoteResource.Loaded(
            report.copy(
                paging = report.paging.copy(
                    items = items,
                    total = total,
                    totalPages = if (!report.paging.supported) report.paging.totalPages
                    else RecordsPagingPolicy.totalPagesFor(total, report.paging.pageSize),
                ),
            ),
        )
    } ?: current.reports
    return current.copy(
        calls = calls,
        callsPage = trimmedPage?.let { RemoteResource.Loaded(it) } ?: current.callsPage,
        callsPageNum = trimmedPage?.page ?: current.callsPageNum,
        reports = reports,
        // 打开着的转录 / 录音页指的就是这一通的话，它已经没有内容可读了。
        callDetail = current.callDetail?.takeIf { it.item.callId != callId },
        openedHistoryCall = current.openedHistoryCall?.takeIf { it.optString("id") != callId },
        aiTranscriptCallId = current.aiTranscriptCallId?.takeIf { it != callId },
    )
}

/** 三个「另一端删了这通」的落点（详情页、录音/转写浮层、AI 对话浮层）说同一句话。 */
internal const val CALL_DELETED_ELSEWHERE_MESSAGE = "这条通话记录已在另一端删除"

/**
 * S39 §E：AI 对话浮层不走 [ClientUiState.callDetail]，所以 [ClientViewModel.validateOpenCallDetail]
 * 看不见它 —— 另一端删掉这通之后它会一直开着，读的还是缓存下来的几段对话。这里是它的收口：按 ID
 * 校验拿到 404 时关掉浮层、丢掉缓存（同一个 id 再也拿不到内容了），并说那句共用的话。
 *
 * 纯函数：`callId` 不是当前打开的那一通就原样返回（迟到的 404 不许关掉用户后开的另一个浮层）。
 */
internal fun clientStateWithoutAiTranscript(current: ClientUiState, callId: String): ClientUiState =
    if (callId.isBlank() || current.aiTranscriptCallId != callId) current
    else current.copy(
        aiTranscriptCallId = null,
        aiTranscripts = current.aiTranscripts - callId,
    ).withInfo(CALL_DELETED_ELSEWHERE_MESSAGE)

/** 成功/进度/同步类提示：在赋值处标明「不是错误」，界面据此选确认样式，而不是按文案猜。 */
internal fun ClientUiState.withInfo(text: String): ClientUiState = copy(message = text, infoMessage = text)

/** How long a confirmation stays on screen before it clears itself. */
internal const val INFO_MESSAGE_VISIBLE_MS = 5_000L

/**
 * The confirmation that should clear itself, or null. Errors stay until the next action; the dialing
 * acknowledgement follows the call state instead, and a 「正在…」 progress line is replaced by its outcome.
 */
internal fun ClientUiState.autoDismissInfo(): String? = message.takeIf {
    it.isNotBlank() && (
        (it == infoMessage && it != DIALING_ACKNOWLEDGEMENT && !it.startsWith("正在")) || it == transientMessage
    )
}

/**
 * An error that describes a passing state (the gateway is busy right now), not a failed action: it keeps
 * the error style but clears itself on the same 5 s timer as a confirmation instead of staying forever.
 */
internal fun ClientUiState.withTransientError(text: String): ClientUiState = copy(message = text, transientMessage = text)

/**
 * The outbound call this session placed whose media should start now, or null. Mirrors iOS, which starts
 * media right after dialing: `connecting` already carries early media (S56 ringback). [attempted] makes it
 * once per call — a FAILED handshake is retried by the user, never re-fired by the next refresh — and any
 * existing local media session (this call's or another's) blocks without consuming the attempt.
 */
internal fun outboundMediaAutoStartId(
    calls: List<JSONObject>,
    media: CallMediaUiState,
    attempted: Set<String>,
): String? = calls.firstOrNull { call ->
    val id = call.optString("id")
    id.isNotBlank() && id !in attempted &&
        call.optString("direction") == "outgoing" &&
        call.optBoolean("claimedByCurrentSession") &&
        call.optString("state") in setOf("connecting", "active") &&
        media.callId == null
}?.optString("id")

internal fun clientStateWithInterceptionsPage(
    current: ClientUiState,
    result: RemoteResource<Page<JSONObject>>,
): ClientUiState = current.copy(
    interceptionsPage = remoteResourceAfterRefresh(current.interceptionsPage, result),
    interceptionsPageNum = pageNumberAfterLoad(current.interceptionsPageNum, (result as? RemoteResource.Loaded)?.value),
)

internal fun clientStateWithReportsPage(
    current: ClientUiState,
    result: RemoteResource<CallReportPage>,
): ClientUiState = current.copy(
    reports = remoteResourceAfterRefresh(current.reports, result),
    reportsPageNum = pageNumberAfterLoad(current.reportsPageNum, (result as? RemoteResource.Loaded)?.value?.paging),
)

/** S67c: only a successful list read may clear optimistic ids. */
internal fun prunedLocalIds(local: Set<String>, result: RemoteList, flag: String): Set<String> =
    if (result is RemoteList.Loaded) pruneLocallyCleared(local, result.items, flag) else local

internal fun refreshFailureMessage(vararg results: Pair<String, RemoteList>): String = results
    .mapNotNull { (label, result) -> label.takeIf { result is RemoteList.Failed } }
    .takeIf(List<String>::isNotEmpty)
    ?.joinToString(prefix = "部分数据刷新失败，请稍后重试（", postfix = "）", separator = "、")
    .orEmpty()

internal fun stateAfterSessionChange(
    current: ClientUiState,
    session: Session?,
    sameLoginGeneration: Boolean,
): ClientUiState = if (session != null && sameLoginGeneration) {
    current.copy(session = session)
} else {
    ClientUiState(checkingSession = false, session = session, networkAvailable = current.networkAvailable)
}

/** Opening an offline card is local navigation, not evidence that a contact lookup returned empty. */
internal fun contactCardForOpen(current: ClientUiState, target: ContactCardTarget): ContactCardUiState {
    if (current.networkAvailable) return ContactCardUiState(target, contact = RemoteResource.Loading)
    val previous = current.contactCard?.takeIf { it.target.number == target.number }
    if (previous?.contact is RemoteResource.Loaded) return previous.copy(target = target)
    val cached = target.annotation.contactId?.let { id ->
        current.contactDetail?.takeIf { it.id == id }
            ?: (current.contacts as? RemoteList.Loaded)?.items?.firstOrNull { it.optString("id") == id }
                ?.let { runCatching { it.toClientContact() }.getOrNull() }
    }
    return ContactCardUiState(target, contact = cached?.let { RemoteResource.Loaded(it) } ?: RemoteResource.NotLoaded)
}

data class SimNotesSubmission(
    val targetVersion: Long,
    val label: String,
    val phoneLabel: String?,
)

data class SimSettingsSubmission(
    val targetVersion: Long,
    val mode: String,
    val timeoutSeconds: Int,
)

data class ClientUiState(
    val checkingSession: Boolean = true,
    val session: Session? = null,
    val busy: Boolean = false,
    val message: String = "",
    /** 最近一次非错误提示的原文；`message` 只有等于它时才按确认样式显示，其余一律是错误卡片。 */
    val infoMessage: String = "",
    /** 表示一时状态的错误（网关正忙）：仍按错误样式显示，但和确认一样 5 秒后自行清除。 */
    val transientMessage: String = "",
    val refreshMessage: String = "",
    val sims: RemoteList = RemoteList.NotLoaded,
    val simsRefreshError: String = "",
    val calls: RemoteList = RemoteList.NotLoaded,
    val sms: RemoteList = RemoteList.NotLoaded,
    val media: CallMediaUiState = CallMediaUiState(),
    val endingCallIds: Set<String> = emptySet(),
    // S22 决策 10 记录页: 全部通话 carries a server-side search, 报告 carries a date window plus its own
    // search.
    // S28: 记录页的三条列表都翻页了，而且每一条都有自己的一份 state —— `callsPage` 与上面的 `calls`
    // 是两份数据。`calls` 仍旧是拨号页每 2–5 秒轮的那一份（运行时对账、占用释放都读它），分页请求
    // 一行都不许写进去，否则第 3 页的 50 条会被当成「当前全部通话」去对账。
    val callQuery: String = "",
    val callsPage: RemoteResource<Page<JSONObject>> = RemoteResource.NotLoaded,
    // 重读当前页时列表要留在屏幕上（不然每次屏蔽 / 挂断都闪一下），所以「正在请求」是独立的一位，
    // 而不是把 `callsPage` 打回 Loading —— 下拉刷新的转圈只认它，失败也会落下来。
    val callsPageRefreshing: Boolean = false,
    val callsPageNum: Int = 1,
    val callsPageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE,
    val callsSimId: String = "",
    val reportPreset: ReportRangePreset = ReportRangePreset.DAYS_7,
    val reportRange: ReportDateRange? = null,
    val reportQuery: String = "",
    val reportSimId: String = "",
    val reportTimeZone: String = DEFAULT_GATEWAY_TIME_ZONE,
    val reports: RemoteResource<CallReportPage> = RemoteResource.NotLoaded,
    val reportsPageNum: Int = 1,
    val reportsPageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE,
    val reportBlocking: Set<String> = emptySet(),
    val reportMessage: String = "",
    val callDetail: CallDetailUiState? = null,
    val openedHistoryCall: JSONObject? = null,
    // S39 §E: AI 对话浮层的 callId 原来是 HistoryScreen 自己的 rememberSaveable，ViewModel 看不见就
    // 没法在轮询里校验它。提上来之后 composable 只读这一位。
    val aiTranscriptCallId: String? = null,
    val smsDrafts: Map<String, String> = emptyMap(),
    val pushRegistration: PushRegistrationState = PushRegistrationState.Unavailable,
    val turnstile: TurnstileUiState = TurnstileUiState(),
    val passkeys: List<PasskeyItem> = emptyList(),
    val passkeysLoading: Boolean = false,
    val passkeysLoaded: Boolean = false,
    val passkeyPending: Set<String> = emptySet(),
    val passkeyRegistrationRefreshPending: Boolean = false,
    val passkeyStatus: String = "",
    val passkeyError: String = "",
    // S21 §A/§B/§D/§F. Contacts, blocklist and gateway power are all new surfaces; each keeps its
    // own busy/message pair so a failed contact edit never disables the dialer.
    val contacts: RemoteList = RemoteList.NotLoaded,
    val smsPickerContacts: RemoteList = RemoteList.NotLoaded,
    val smsPickerError: String = "",
    val contactQuery: String = "",
    val contactBusy: Boolean = false,
    val contactMessage: String = "",
    val contactDetail: ClientContact? = null,
    val contactConflicts: Map<String, Long> = emptyMap(),
    val contactImport: ContactImportUiState = ContactImportUiState.Idle,
    val contactCard: ContactCardUiState? = null,
    val dialerLookup: DialerLookupState = DialerLookupState(),
    val interceptionsPage: RemoteResource<Page<JSONObject>> = RemoteResource.NotLoaded,
    val interceptionsPageNum: Int = 1,
    val interceptionsPageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE,
    /** S66 来电黑名单 (`scope=call`). */
    val blocklist: RemoteList = RemoteList.NotLoaded,
    /** S66 短信黑名单 (`scope=sms`), filled only by 短信「删除并屏蔽」. */
    val smsBlocklist: RemoteList = RemoteList.NotLoaded,
    val blocklistMessage: String = "",
    val blocklistPending: Set<String> = emptySet(),
    val gatewayPower: RemoteList = RemoteList.NotLoaded,
    val gatewayPowerMessage: String = "",
    val gatewayPowerRefreshError: String = "",
    val gatewayPowerPending: Set<String> = emptySet(),
    val aiTranscripts: Map<String, RemoteResource<List<ClientAiTranscriptSegment>>> = emptyMap(),
    // S24 决策 3「AI 语音服务」. `voiceProviderUnavailable` is the 404 of a Control that predates S24:
    // the whole section hides rather than reporting a failure the user cannot act on.
    val voiceProviders: RemoteResource<ClientVoiceProviderList> = RemoteResource.NotLoaded,
    val voiceProviderUnavailable: Boolean = false,
    val voiceProviderMessage: String = "",
    val voiceProviderPending: String = "",
    val voiceProviderReview: String? = null,
    val voiceProviderConflict: Boolean = false,
    val voiceProviderConflictVersion: Long? = null,
    val simNotesSubmissions: Map<String, SimNotesSubmission> = emptyMap(),
    val simNotesConflicts: Map<String, Long> = emptyMap(),
    val simSettingsSubmissions: Map<String, SimSettingsSubmission> = emptyMap(),
    val simSettingsConflicts: Map<String, Long> = emptyMap(),
    // 设置 → SIM 与接听模式：保存后每个 SIM 自己的「应用状态」，键是 simId。只有正在等网关 ack 的
    // SIM 会在表里留下 Applying，其余读快照即可，所以退出登录整份 state 被替换时它自然清空。
    val settingsApply: Map<String, SettingsApplyState> = emptyMap(),
    val navigation: ClientNavigationRequest? = null,
    val networkAvailable: Boolean = true,
    /** Stable across token renewal, different for a new login; UI presentation identity only. */
    val sessionEpoch: Long = 0L,
    /** S67 `/badges`; null until the first successful read, a failed read keeps the last value. */
    val badges: ClientBadges? = null,
    /** S67c optimistic dot removal: call / SMS ids opened here, until a refresh reports them cleared. */
    val seenCallIds: Set<String> = emptySet(),
    val readSmsIds: Set<String> = emptySet(),
)

/** §D: the gateway power card re-reads `/gateways/power` every 5 s while 设置 is on screen. */
internal const val GATEWAY_POWER_INTERVAL_MS = 5_000L

/** Typing in the contacts search box waits this long before it costs a request. */
internal const val CONTACT_SEARCH_DEBOUNCE_MS = 300L

/** Same debounce for the two 记录 search boxes (S22 决策 10), so all three feel identical. */
internal const val CALL_SEARCH_DEBOUNCE_MS = CONTACT_SEARCH_DEBOUNCE_MS

/** `GET /auth/config` attempts before the login form gives up and says so (R4 A3 #2). */
internal const val AUTH_CONFIG_ATTEMPTS = 3

/** Backoff between those attempts. */
internal fun authConfigRetryDelayMs(attempt: Int): Long = 500L * (1L shl (attempt - 1).coerceIn(0, 4))

class ClientViewModel(application: Application) : AndroidViewModel(application) {
    private val sessions = ClientSessionProcess.coordinator(application)
    private val initialSessionSnapshot = sessions.snapshot()
    private val restoredSession = initialSessionSnapshot.session
    private var visibleSessionEpoch = initialSessionSnapshot.epoch
    private val smsRetries = SmsIdempotencyCoordinator(SharedPreferencesSmsRetryPersistence(application)).also {
        if (restoredSession == null) it.clearSession() else it.resumeSession(restoredSession.username)
    }
    private val callRetries = CallIdempotencyCoordinator(application).also {
        if (restoredSession == null) it.clearSession() else it.resumeSession(restoredSession.username)
    }
    private val connectivity = application.getSystemService(ConnectivityManager::class.java)
    private fun systemNetworkAvailable(): Boolean = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    private val _state = MutableStateFlow(ClientUiState(
        session = restoredSession,
        networkAvailable = systemNetworkAvailable(),
        sessionEpoch = initialSessionSnapshot.epoch,
    ))
    val state: StateFlow<ClientUiState> = _state.asStateFlow()
    // This describes the handset's default network, not reachability of Control or a SIM gateway.
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        private var defaultNetwork = connectivity.activeNetwork
        override fun onAvailable(network: Network) { defaultNetwork = network }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            if (network == defaultNetwork) _state.update {
                it.copy(networkAvailable = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
            }
        }
        override fun onLost(network: Network) {
            if (network == defaultNetwork) {
                defaultNetwork = null
                _state.update { it.copy(networkAvailable = false) }
            }
        }
    }
    private val push = AndroidPushRegistrationCoordinator(application, sessions, ClientApi(sessions))

    /** The active screen owns this one ticker. It fires immediately, then every 2–5 seconds. */
    private val foregroundRefresh = ClientRefreshLoop(
        scope = viewModelScope,
        intervalMs = {
            ClientRefreshCadence.intervalMs(
                currentCalls(), _state.value.media, ReconcilingCalls.snapshot(),
                dialBurst, SystemClock.elapsedRealtime(),
            )
        },
        refresh = { activeRefreshScope?.let(::refreshVisibleScope) },
    )
    /** S52: publish comes from service threads; hop onto the view model scope before touching state. */
    private val livenessListener: Closeable = ClientCallLiveness.listen { _, phase ->
        viewModelScope.launch {
            if (livenessTriggersRefresh(phase, activeRefreshScope != null) && _state.value.networkAvailable) {
                refreshCallsAndSims()
            }
        }
    }
    /**
     * 保存接听模式之后的有界轮询（[SettingsApplyPolicy]）：每 2 秒安静地重读一次 `/sims`，
     * 直到网关确认或 30 秒超时。它复用 [refreshCallsAndSims]，所以不会多出一条新的请求路径。
     */
    private val settingsApplyWatch = SettingsApplyWatch(
        scope = viewModelScope,
        refresh = ::awaitCallsAndSimsRefresh,
        evaluate = ::advanceSettingsApply,
    )
    private val pendingBlockedSmsDeletes = mutableSetOf<String>()
    private val sessionListener: Closeable = ClientSessionProcess.listen { event ->
        when (event) {
            is ProcessSessionEvent.Changed -> {
                val session = event.session
                if (session == null) {
                    dialBurst = null
                    smsRetries.clearSession()
                    callRetries.clearSession()
                    OutboundCallReleaseService.clear(application)
                }
                ClientCallRuntime.invalidateProbe()
                val changedEpoch = sessions.snapshot().epoch
                if (changedEpoch != visibleSessionEpoch) pendingBlockedSmsDeletes.clear()
                _state.update { current ->
                    stateAfterSessionChange(
                        current,
                        session,
                        sameLoginGeneration = session != null && current.session != null && changedEpoch == visibleSessionEpoch,
                    ).copy(sessionEpoch = changedEpoch)
                }
                visibleSessionEpoch = changedEpoch
                if (session == null) {
                    OngoingCallService.stopAll(application)
                    BadgeNotifier.cancel(application)
                } else ensurePushRegistration()
            }
            ProcessSessionEvent.Invalidated -> {
                OngoingCallService.stopAll(application)
                BadgeNotifier.cancel(application)
                OutboundCallReleaseService.clear(application)
                foregroundRefresh.stop()
                dialBurst = null
                activeRefreshScope = null
                settingsApplyWatch.stop()
                settingsApplyEpoch = null
                pendingBlockedSmsDeletes.clear()
                _state.value = ClientUiState(checkingSession = false, message = "登录已失效，请重新登录".asUiError("session.expired"), networkAvailable = systemNetworkAvailable())
            }
        }
    }
    private val clientApi = ClientApi(sessions)
    private var refreshJob: Job? = null
    /** S70e: set by a successful dial; read by [foregroundRefresh]'s cadence, no loop of its own. */
    private var dialBurst: ClientRefreshCadence.DialBurst? = null
    private var simsRefreshJob: Job? = null
    private var smsRefreshJob: Job? = null
    private var contactsJob: Job? = null
    private var smsPickerJob: Job? = null
    private var contactDetailJob: Job? = null
    private var blocklistJob: Job? = null
    private var lookupJob: Job? = null
    private var gatewayPowerJob: Job? = null
    private var passkeyReadJob: Job? = null
    private var voiceProviderJob: Job? = null
    private var authConfigJob: Job? = null
    private var callsPageJob: Job? = null
    private var interceptionsJob: Job? = null
    private var reportsJob: Job? = null
    private var activeRefreshScope: ClientRefreshScope? = null
    private var badgesJob: Job? = null
    /** S67: SMS ids already POSTed to `/sms/read` in this process, so a 5 s refresh does not re-send them. */
    private val smsReadSent = mutableSetOf<String>()
    private val badgePrefsStore = BadgePrefsStore(application)
    private val _badgePrefs = MutableStateFlow(badgePrefsStore.read())
    internal val badgePrefs: StateFlow<BadgePrefs> = _badgePrefs.asStateFlow()
    private var simsRefreshGeneration = 0L
    private var smsRefreshGeneration = 0L
    private var blocklistGeneration = 0L
    private var voiceProviderGeneration = 0L
    /** 发起「保存设置」时的会话世代；换号登录后旧的轮询结果不准再写进新会话的 state。 */
    private var settingsApplyEpoch: Long? = null
    /**
     * S30 删除的在途闸门。刻意不进 [ClientUiState]：确认对话框在点「删除」的当下就收起了，这两位只是
     * 挡住「同一行连点两次发两条请求」，屏幕上没有任何东西读它们。
     */
    private val deletingCallIds = mutableSetOf<String>()
    private var smsDeleting = false
    /**
     * Deliberately *not* part of [ClientUiState]: `logout()`, `stateAfterSessionChange` and the
     * session-invalidated branch all replace the whole state object, and this entry has to survive
     * exactly those three (S22 决策 11). The login screen reads it through [lastLogin].
     */
    private val lastLoginStore = LastLoginStore.create(application)
    private val _lastLogin = MutableStateFlow(runCatching { lastLoginStore.read() }.getOrNull())
    val lastLogin: StateFlow<LastLogin?> = _lastLogin.asStateFlow()
    private val reportRequests = AsyncRequestGuard()
    private val callsPageRequests = AsyncRequestGuard()
    private val interceptionsRequests = AsyncRequestGuard()
    private val detailRequests = AsyncRequestGuard()
    private val historyRecordRequests = AsyncRequestGuard()
    private val viewerValidityRequests = AsyncRequestGuard()
    // 自己一个闸：[AsyncRequestGuard] 只有一条 serial，和 `viewerValidityRequests` 共用的话同一轮
    // 刷新里后发的那条会把先发的那条作废（两个浮层可以同时开着）。
    private val aiTranscriptValidityRequests = AsyncRequestGuard()
    private val contactDetailRequests = AsyncRequestGuard()
    private val contactCardRequests = AsyncRequestGuard()
    private val gatewayPowerRequests = AsyncRequestGuard()
    private val passkeyRequests = AsyncRequestGuard()

    init {
        connectivity.registerDefaultNetworkCallback(networkCallback)
        // A confirmation such as 「短信已提交，正在等待发送」 used to stay until the next action.
        viewModelScope.launch {
            _state.map { it.autoDismissInfo() }.distinctUntilChanged().collectLatest { text ->
                if (text == null) return@collectLatest
                delay(INFO_MESSAGE_VISIBLE_MS)
                _state.update { if (it.message == text) it.copy(message = "") else it }
            }
        }
        viewModelScope.launch {
            ClientCallRuntime.state.collect { media ->
                // Connected media means the call was answered here, so it is no longer an
                // abandonable dial attempt (S20 D5).
                if (media.phase == CallMediaPhase.CONNECTED) {
                    media.callId?.let { OutboundCallReleaseService.forget(getApplication(), it) }
                }
                _state.update { it.copy(media = media) }
            }
        }
        restoreSession()
        loadAuthConfig()
    }

    /**
     * Reads the public pre-login configuration.
     *
     * S22 决策 11 / R4 A3: this used to be a single silent attempt, and the login form treated "not
     * answered yet" exactly like "Turnstile is off" — so a restored form could send a password login
     * with no token and get a 400 the user could not explain. Now every outcome sets `configLoaded`,
     * a failure is retried [AUTH_CONFIG_ATTEMPTS] times with backoff and then surfaces
     * [TURNSTILE_CONFIG_FAILED_MESSAGE], and the button stays disabled until this finishes.
     */
    private fun loadAuthConfig() {
        authConfigJob?.cancel()
        _state.update { it.copy(turnstile = it.turnstile.copy(configLoaded = false, configError = null)) }
        authConfigJob = viewModelScope.launch {
            repeat(AUTH_CONFIG_ATTEMPTS) { index ->
                val attempt = index + 1
                val result = runCatching { withContext(Dispatchers.IO) { ClientApi().authConfig() } }
                result.onSuccess { config ->
                    _state.update { current ->
                        // copy(), not a fresh state: a reload triggered by a 400 must not reset
                        // `generation` (that would churn the WebView a second time) nor drop a token
                        // the user solved while the request was in flight. A rotated site key does
                        // invalidate both, so that case starts a new challenge.
                        val rotated = current.turnstile.siteKey != config.siteKey
                        current.copy(
                            turnstile = current.turnstile.copy(
                                enabled = config.enabled,
                                siteKey = config.siteKey,
                                token = if (rotated) null else current.turnstile.token,
                                error = if (rotated) null else current.turnstile.error,
                                generation = current.turnstile.generation + if (rotated) 1 else 0,
                                configLoaded = true,
                                configError = null,
                            ),
                        )
                    }
                    return@launch
                }
                if (attempt < AUTH_CONFIG_ATTEMPTS) delay(authConfigRetryDelayMs(attempt))
            }
            // Every attempt failed. `required` stays false so nothing pretends to know the server's
            // policy, but `configLoaded` is true with an error: the form explains itself instead of
            // offering a button that can only 400.
            _state.update {
                it.copy(
                    turnstile = it.turnstile.copy(
                        configLoaded = true,
                        configError = TURNSTILE_CONFIG_FAILED_MESSAGE.asUiError("login.turnstile.config"),
                    ),
                )
            }
        }
    }

    /**
     * The server just told us Turnstile is on after all (or the token was stale). Re-read the config
     * so the challenge card actually appears — `resetTurnstile()` alone only bumps the generation,
     * and a widget whose `required` is still false renders nothing (R4 A3 #3).
     */
    private fun recoverTurnstileAfter(error: Throwable) {
        val code = (error as? ApiError)?.code ?: return
        if (code != "TURNSTILE_REQUIRED" && code != "TURNSTILE_FAILED") return
        loadAuthConfig()
    }

    fun acceptTurnstile(event: TurnstileEvent) {
        _state.update { current ->
            when (event) {
                is TurnstileEvent.Token -> current.copy(turnstile = current.turnstile.copy(token = event.value, error = null))
                is TurnstileEvent.Failed -> current.copy(turnstile = current.turnstile.copy(token = null, error = event.message.asUiError("login.turnstile")))
                TurnstileEvent.Expired -> current.copy(turnstile = current.turnstile.copy(token = null))
            }
        }
    }

    /** A Turnstile token is single use, so every failed attempt starts a fresh challenge. */
    fun resetTurnstile() {
        _state.update {
            it.copy(turnstile = it.turnstile.copy(token = null, error = null, generation = it.turnstile.generation + 1))
        }
    }

    /** Token for one request; a missing token is reported as a request failure instead of being sent empty. */
    private fun turnstileToken(): String? {
        val turnstile = _state.value.turnstile
        if (!turnstile.required) return null
        return turnstile.token?.takeIf { it.isNotBlank() }
    }

    fun login(username: String, password: String) {
        if (username.isBlank() || password.isBlank()) {
            _state.update { it.copy(message = "请输入账号和密码".asUiError("login.validate")) }
            return
        }
        val token = turnstileToken()
        if (_state.value.turnstile.required && token == null) {
            _state.update { it.copy(message = "请先完成人机验证".asUiError("login.turnstile")) }
            return
        }
        val attemptEpoch = sessions.snapshot().epoch
        _state.update { it.copy(busy = true, message = "") }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { ClientApi().login(username.trim(), password, token) } }
                .onSuccess { session ->
                    if (ClientSessionProcess.installNew(getApplication(), attemptEpoch, session)) {
                        rememberLastLogin(username, password)
                        smsRetries.startSession(session.username)
                        callRetries.startSession(session.username)
                        refreshJob?.cancel()
                        refreshJob = null
                        _state.update { it.copy(busy = false) }
                        refreshAll()
                        loadPasskeys()
                    } else {
                        revokeDiscardedSession(session)
                    }
                }
                .onFailure { error ->
                    if (sessions.isCurrent(attemptEpoch)) {
                        _state.update { it.copy(busy = false, message = error.userMessage("login.password")) }
                        // A Turnstile token is single use, so the widget always restarts here; if the
                        // server rejected us *because* of Turnstile, re-read the config as well so the
                        // widget can appear at all (R4 A3 #3).
                        resetTurnstile()
                        recoverTurnstileAfter(error)
                    }
                }
        }
    }

    /**
     * S22 决策 11 / R4 A2: Passkey needs neither the password nor a solved challenge. The token is
     * sent when one happens to be in hand and omitted otherwise — `POST /passkeys/authenticate/options`
     * no longer requires it, and sending a spare token is harmless.
     */
    internal fun loginWithPasskey(username: String, credentials: PasskeyCredentialProvider) {
        if (username.isBlank()) {
            _state.update { it.copy(message = "请输入账号后使用 Passkey".asUiError("login.passkey")) }
            return
        }
        if (_state.value.busy) return
        val token = turnstileToken()
        val attemptEpoch = sessions.snapshot().epoch
        _state.update { it.copy(busy = true).withInfo("正在准备 Passkey…") }
        viewModelScope.launch {
            runCatching {
                val api = ClientApi()
                val challenge = withContext(Dispatchers.IO) {
                    api.passkeyAuthenticationOptions(username.trim(), token)
                }
                if (!sessions.isCurrent(attemptEpoch)) throw SessionChangedException()
                val credentialJson = credentials.get(challenge.requestJson)
                if (!sessions.isCurrent(attemptEpoch)) throw SessionChangedException()
                withContext(Dispatchers.IO) {
                    api.verifyPasskeyAuthentication(challenge.challengeId, credentialJson)
                }
            }.onSuccess { session ->
                if (ClientSessionProcess.installNew(getApplication(), attemptEpoch, session)) {
                    rememberLastLoginUsername(session.username.ifBlank { username })
                    smsRetries.startSession(session.username)
                    callRetries.startSession(session.username)
                    refreshJob?.cancel()
                    refreshJob = null
                    _state.update { it.copy(busy = false, message = "") }
                    refreshAll()
                    loadPasskeys()
                } else {
                    revokeDiscardedSession(session)
                }
            }.onFailure { error ->
                if (sessions.isCurrent(attemptEpoch)) {
                    _state.update { it.copy(busy = false, message = error.userMessage("login.passkey")) }
                    resetTurnstile()
                    recoverTurnstileAfter(error)
                }
            }
        }
    }

    internal fun registerPasskey(credentials: PasskeyCredentialProvider) {
        val current = _state.value
        if (!passkeyRegistrationAllowed(current)) return
        val expectedEpoch = sessions.snapshot().also { if (it.session == null) return }.epoch
        _state.update {
            it.copy(busy = true, passkeyError = "", passkeyStatus = "").withInfo("正在准备创建通行密钥…")
        }
        viewModelScope.launch {
            runCatching {
                val challenge = withContext(Dispatchers.IO) { clientApi.passkeyRegistrationOptions() }
                if (!sessions.isCurrent(expectedEpoch)) throw SessionChangedException()
                val credentialJson = credentials.create(challenge.requestJson)
                if (!sessions.isCurrent(expectedEpoch)) throw SessionChangedException()
                withContext(Dispatchers.IO) {
                    check(clientApi.verifyPasskeyRegistration(challenge.challengeId, credentialJson))
                }
            }.onSuccess {
                if (sessions.isCurrent(expectedEpoch)) {
                    invalidatePasskeyRead()
                    _state.update {
                        it.copy(
                            busy = false,
                            message = "通行密钥已保存到系统凭据服务",
                            infoMessage = "通行密钥已保存到系统凭据服务",
                            passkeyStatus = "通行密钥已保存到系统凭据服务",
                            passkeyError = "",
                            passkeyRegistrationRefreshPending = true,
                        )
                    }
                    loadPasskeys()
                }
            }.onFailure { error ->
                if (sessions.isCurrent(expectedEpoch)) {
                    val message = error.userMessage("passkey.create")
                    _state.update { it.copy(busy = false, message = message, passkeyError = message) }
                }
            }
        }
    }

    fun loadPasskeys() {
        // A mutation owns the visible row until its accepted result is applied. A manual Settings
        // refresh during that window is dropped; the mutation starts one fresh reconciliation.
        if (_state.value.passkeyPending.isNotEmpty()) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val token = passkeyRequests.next(expected.epoch, "list")
        passkeyReadJob?.cancel()
        _state.update { it.copy(passkeysLoading = true, passkeyError = "") }
        passkeyReadJob = viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { clientApi.passkeys() } }
                .onSuccess { items ->
                    val currentEpoch = sessions.snapshot().epoch
                    if (passkeyRequests.accepts(token, currentEpoch, "list")) {
                        _state.update {
                            it.copy(
                                passkeys = items,
                                passkeysLoading = false,
                                passkeysLoaded = true,
                                passkeyRegistrationRefreshPending = false,
                            )
                        }
                    }
                }
                .onFailure { error ->
                    val currentEpoch = sessions.snapshot().epoch
                    if (passkeyRequests.accepts(token, currentEpoch, "list")) {
                        _state.update {
                            it.copy(passkeysLoading = false, passkeysLoaded = true, passkeyError = error.userMessage("passkey.list"))
                        }
                    }
                }
        }
    }

    /** Invalid input is rejected locally, matching the server's own `trim().min(1).max(64)`. */
    fun renamePasskey(id: String, label: String) {
        val normalized = PasskeyDisplayPolicy.normalizedLabel(label)
        if (normalized == null) {
            _state.update {
                it.copy(passkeyError = PasskeyDisplayPolicy.LABEL_VALIDATION_MESSAGE, passkeyStatus = "")
            }
            return
        }
        mutatePasskey(id, "通行密钥已重命名") {
            AcceptedPasskeyMutation.Renamed(clientApi.renamePasskey(id, normalized))
        }
    }

    fun deletePasskey(id: String) = mutatePasskey(id, "通行密钥已删除") {
        clientApi.deletePasskey(id)
        AcceptedPasskeyMutation.Deleted(id)
    }

    private fun mutatePasskey(
        id: String,
        successMessage: String,
        operation: () -> AcceptedPasskeyMutation,
    ) {
        if (id.isBlank() || _state.value.passkeyPending.isNotEmpty()) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        invalidatePasskeyRead()
        _state.update {
            it.copy(
                passkeysLoading = false,
                passkeyPending = it.passkeyPending + id,
                passkeyError = "",
                passkeyStatus = "",
            )
        }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { operation() } }
                .onSuccess { accepted ->
                    if (sessions.isCurrent(expected.epoch)) {
                        // Close the tiny race where a read passed its pending check just before the
                        // mutation became visible. Its response must not replace this accepted row.
                        invalidatePasskeyRead()
                        _state.update {
                            it.copy(
                                passkeys = passkeysAfterAcceptedMutation(it.passkeys, accepted),
                                passkeyPending = it.passkeyPending - id,
                                passkeyStatus = successMessage,
                                passkeyError = "",
                            )
                        }
                        loadPasskeys()
                    }
                }
                .onFailure { error ->
                    if (sessions.isCurrent(expected.epoch)) {
                        invalidatePasskeyRead()
                        _state.update {
                            it.copy(passkeyPending = it.passkeyPending - id, passkeyError = error.userMessage())
                        }
                    }
                }
        }
    }

    private fun invalidatePasskeyRead() {
        passkeyRequests.invalidate()
        passkeyReadJob?.cancel()
        passkeyReadJob = null
    }

    /** Re-runs the media handshake for a held call after a failure (UDP first, TLS fallback). */
    fun retryCallMedia(callId: String) = connectMedia(callId, CallMediaTransport.UDP)

    fun logout() {
        val installationId = AndroidPushStore(getApplication()).installationId
        reportRequests.invalidate()
        callsPageRequests.invalidate()
        interceptionsRequests.invalidate()
        detailRequests.invalidate()
        historyRecordRequests.invalidate()
        viewerValidityRequests.invalidate()
        aiTranscriptValidityRequests.invalidate()
        contactDetailRequests.invalidate()
        contactCardRequests.invalidate()
        val session = sessions.clear()
        attemptedOutboundMedia.clear()
        AndroidPushStore(getApplication()).clearBinding()
        OngoingCallService.stopAll(getApplication())
        OutboundCallReleaseService.clear(getApplication())
        foregroundRefresh.stop()
        activeRefreshScope = null
        settingsApplyWatch.stop()
        settingsApplyEpoch = null
        pendingBlockedSmsDeletes.clear()
        refreshJob?.cancel()
        refreshJob = null
        simsRefreshJob?.cancel()
        simsRefreshJob = null
        smsRefreshJob?.cancel()
        smsRefreshJob = null
        contactsJob?.cancel()
        contactsJob = null
        smsPickerJob?.cancel()
        smsPickerJob = null
        contactDetailJob?.cancel()
        contactDetailJob = null
        blocklistJob?.cancel()
        blocklistJob = null
        lookupJob?.cancel()
        lookupJob = null
        callsPageJob?.cancel()
        callsPageJob = null
        interceptionsJob?.cancel()
        interceptionsJob = null
        reportsJob?.cancel()
        reportsJob = null
        voiceProviderJob?.cancel()
        voiceProviderJob = null
        // The saved username/password is not part of this state and is not cleared here (S22 决策 11):
        // 退出登录 means "end the session", not "forget the account".
        _state.value = ClientUiState(checkingSession = false, networkAvailable = systemNetworkAvailable())
        // The reset above drops the Turnstile site key; reload it so the next login shows the challenge.
        loadAuthConfig()
        viewModelScope.launch {
            if (session != null) withContext(Dispatchers.IO) {
                runCatching { ClientApi().deletePushRegistration(session, installationId) }
                runCatching { ClientApi().revoke(session) }
            }
        }
    }

    /** After a password login. [logout] never clears this — that is the whole point (S22 决策 11). */
    private fun rememberLastLogin(username: String, password: String) {
        runCatching { lastLoginStore.save(username, password) }
        _lastLogin.value = runCatching { lastLoginStore.read() }.getOrNull()
    }

    /** After a Passkey login: the username is refreshed, a stored password for it is left alone. */
    private fun rememberLastLoginUsername(username: String) {
        runCatching { lastLoginStore.saveUsername(username) }
        _lastLogin.value = runCatching { lastLoginStore.read() }.getOrNull()
    }

    /** "忘记已保存的账号" from the login screen; the only way this entry is removed. */
    fun forgetLastLogin() {
        runCatching { lastLoginStore.clear() }
        _lastLogin.value = null
    }

    private fun revokeDiscardedSession(session: Session) {
        viewModelScope.launch(Dispatchers.IO) {
            runCatching { ClientApi().revoke(session) }
        }
    }

    /** Started by the calls tab while it is STARTED; a stopped loop issues no requests at all. */
    internal fun startForegroundRefresh(scope: ClientRefreshScope = ClientRefreshScope.CALLS) {
        if (activeRefreshScope == scope && foregroundRefresh.running) return
        foregroundRefresh.stop()
        activeRefreshScope = scope
        foregroundRefresh.start()
    }

    internal fun stopForegroundRefresh(scope: ClientRefreshScope = ClientRefreshScope.CALLS) {
        if (activeRefreshScope != scope) return
        activeRefreshScope = null
        foregroundRefresh.stop()
    }

    private fun refreshVisibleScope(scope: ClientRefreshScope) {
        if (!_state.value.networkAvailable) return
        val refreshOngoingCalls = scope != ClientRefreshScope.CALLS &&
            (currentCalls().any { it.optBoolean("claimedByCurrentSession") && it.optString("state") !in setOf("ended", "failed") } ||
                _state.value.media.callId != null)
        if (refreshOngoingCalls) refreshCallsAndSims()
        when (scope) {
            ClientRefreshScope.CALLS -> refreshCallsAndSims()
            ClientRefreshScope.SMS -> refreshSms()
            ClientRefreshScope.CONTACTS -> {
                refreshContacts()
                refreshContactDetail()
            }
            ClientRefreshScope.HISTORY_CALLS -> {
                loadCallsPage()
                refreshOpenedHistoryCall()
                validateOpenCallDetail()
                validateOpenAiTranscript()
            }
            ClientRefreshScope.HISTORY_REPORTS -> {
                loadReports()
                refreshOpenedHistoryCall()
                validateOpenCallDetail()
                validateOpenAiTranscript()
            }
            ClientRefreshScope.HISTORY_INTERCEPTIONS -> {
                loadInterceptionsPage()
                loadBlocklist()
            }
            ClientRefreshScope.SETTINGS -> {
                if (!refreshOngoingCalls) refreshSimsOnly()
                refreshGatewayPower()
                loadVoiceProviders()
                loadBlocklist()
            }
        }
        refreshOpenContactCard()
        refreshBadges()
    }

    /** S67: rides every foreground tick; a failure (or a pre-S67 404) keeps the last value. */
    private fun refreshBadges() {
        val expected = sessions.snapshot().also { if (it.session == null) return }
        if (badgesJob?.isActive == true) return
        badgesJob = viewModelScope.launch {
            val badges = runCatching { withContext(Dispatchers.IO) { clientApi.badges() } }.getOrNull() ?: return@launch
            if (!sessions.isCurrent(expected.epoch)) return@launch
            _state.update { it.copy(badges = badges) }
            updateIconBadge(badges)
        }
    }

    private fun updateIconBadge(badges: ClientBadges) {
        val (calls, sms) = iconBadgeCounts(badges.calls, badges.sms, _badgePrefs.value)
        BadgeNotifier.show(getApplication(), calls, sms)
    }

    fun setBadgePrefs(value: BadgePrefs) {
        badgePrefsStore.write(value)
        _badgePrefs.value = value
        val badges = _state.value.badges
        if (badges != null) updateIconBadge(badges) else if (!value.enabled) BadgeNotifier.cancel(getApplication())
        ensurePushRegistration()
    }

    /** S67: opening a call's record or contact card marks it seen on every device. */
    private fun markCallSeen(callId: String) {
        if (sessions.snapshot().session == null) return
        _state.update { it.copy(seenCallIds = it.seenCallIds + callId) }
        viewModelScope.launch {
            val done = runCatching { withContext(Dispatchers.IO) { clientApi.markCallSeen(callId) } }.isSuccess
            if (done) { badgesJob?.cancel(); refreshBadges() } else _state.update { it.copy(seenCallIds = it.seenCallIds - callId) }
        }
    }

    /** S67: opening an SMS conversation marks its incoming messages read. */
    fun markSmsRead(ids: List<String>) {
        if (sessions.snapshot().session == null) return
        val fresh = ids.filter { it.isNotBlank() && it !in smsReadSent }
        if (fresh.isEmpty()) return
        smsReadSent += fresh
        _state.update { it.copy(readSmsIds = it.readSmsIds + fresh) }
        viewModelScope.launch {
            val done = runCatching { withContext(Dispatchers.IO) { clientApi.markSmsRead(fresh) } }.isSuccess
            if (done) {
                badgesJob?.cancel(); refreshBadges()
            } else {
                smsReadSent -= fresh.toSet()
                _state.update { it.copy(readSmsIds = it.readSmsIds - fresh.toSet()) }
            }
        }
    }

    private fun refreshSimsOnly() {
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val generation = ++simsRefreshGeneration
        simsRefreshJob?.cancel()
        simsRefreshJob = viewModelScope.launch {
            val result = load { clientApi.sims() }
            if (!sessions.isCurrent(expected.epoch) || generation != simsRefreshGeneration) return@launch
            _state.update {
                val visible = visibleRemoteListAfterRefresh(it.sims, result)
                it.copy(
                    sims = visible.value,
                    simsRefreshError = visible.error,
                )
            }
            advanceSettingsApply()
        }
    }

    private fun refreshSms() {
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val generation = ++smsRefreshGeneration
        smsRefreshJob?.cancel()
        smsRefreshJob = viewModelScope.launch {
            val result = load { clientApi.sms() }
            if (!sessions.isCurrent(expected.epoch) || generation != smsRefreshGeneration) return@launch
            _state.update {
                it.copy(
                    sms = remoteListAfterRefresh(it.sms, result),
                    readSmsIds = prunedLocalIds(it.readSmsIds, result, "unread"),
                    refreshMessage = refreshFailureMessage("短信" to result),
                )
            }
        }
    }

    /**
     * The periodic half of [refreshAll]: calls and SIMs only, no `Loading` flicker, and it shares
     * [refreshJob] so a tick that arrives while a refresh is still in flight is dropped instead of
     * stacking a second round of requests.
     */
    private fun refreshCallsAndSims() {
        val expectedEpoch = sessions.snapshot().also { if (it.session == null) return }.epoch
        if (refreshJob?.isActive == true) return
        val simsGeneration = ++simsRefreshGeneration
        simsRefreshJob?.cancel()
        refreshJob = viewModelScope.launch {
            val sims = load { clientApi.sims() }
            val calls = load { clientApi.calls() }
            if (sessions.isCurrent(expectedEpoch)) {
                if (calls is RemoteList.Loaded) applyLoadedCalls(calls.items)
                _state.update {
                    val visibleSims = visibleRemoteListAfterRefresh(it.sims, sims)
                    it.copy(
                        sims = if (simsGeneration == simsRefreshGeneration) {
                            visibleSims.value
                        } else {
                            it.sims
                        },
                        calls = remoteListAfterRefresh(it.calls, calls),
                        endingCallIds = endingCallIdsAfterRefresh(it.endingCallIds, calls),
                        seenCallIds = prunedLocalIds(it.seenCallIds, calls, "unseen"),
                        refreshMessage = if (simsGeneration == simsRefreshGeneration) {
                            refreshFailureMessage("SIM" to sims, "通话" to calls)
                        } else {
                            refreshFailureMessage("通话" to calls)
                        },
                        simsRefreshError = if (simsGeneration == simsRefreshGeneration) {
                            visibleSims.error
                        } else {
                            it.simsRefreshError
                        },
                    )
                }
            }
        }
    }

    /**
     * One place where a freshly loaded call list is handed to the media session and to the S20 D5
     * release registry, so an outbound call that got answered (or ended) stops being releasable.
     */
    private fun applyLoadedCalls(items: List<JSONObject>) {
        ClientCallRuntime.reconcile(items)
        autoStartOutboundMedia(items)
        val media = _state.value.media
        OutboundCallReleaseService.retain(
            getApplication(),
            OccupancyReleasePolicy.retainedIds(
                SelfManagedOutboundCalls.snapshot(),
                items,
                media.callId.takeIf { media.phase == CallMediaPhase.CONNECTED },
            ),
        )
    }

    fun refreshAll() {
        val expectedEpoch = sessions.snapshot().also { if (it.session == null) return }.epoch
        // S28: 记录页的当前页跟着一起重读 —— 屏蔽 / 解除屏蔽之后第 3 页该变的行要当场变。没打开过
        // 记录页就一个请求都不发（`NotLoaded`），拨号页的刷新不会白白多付一次 COUNT。
        if (_state.value.callsPage !is RemoteResource.NotLoaded) loadCallsPage()
        refreshBadges()
        if (refreshJob?.isActive == true) return
        val simsGeneration = ++simsRefreshGeneration
        val smsGeneration = ++smsRefreshGeneration
        simsRefreshJob?.cancel()
        smsRefreshJob?.cancel()
        _state.update {
            it.copy(
                sims = remoteListDuringRefresh(it.sims),
                calls = remoteListDuringRefresh(it.calls),
                sms = remoteListDuringRefresh(it.sms),
                refreshMessage = "",
            )
        }
        refreshJob = viewModelScope.launch {
            val sims = load { clientApi.sims() }
            val calls = load { clientApi.calls() }
            val sms = load { clientApi.sms() }
            if (sessions.isCurrent(expectedEpoch)) {
                if (calls is RemoteList.Loaded) applyLoadedCalls(calls.items)
                val simsIsCurrent = simsGeneration == simsRefreshGeneration
                val smsIsCurrent = smsGeneration == smsRefreshGeneration
                _state.update {
                    val visibleSims = visibleRemoteListAfterRefresh(it.sims, sims)
                    it.copy(
                        sims = if (simsIsCurrent) visibleSims.value else it.sims,
                        calls = remoteListAfterRefresh(it.calls, calls),
                        endingCallIds = endingCallIdsAfterRefresh(it.endingCallIds, calls),
                        seenCallIds = prunedLocalIds(it.seenCallIds, calls, "unseen"),
                        sms = if (smsIsCurrent) remoteListAfterRefresh(it.sms, sms) else it.sms,
                        readSmsIds = prunedLocalIds(it.readSmsIds, sms, "unread"),
                        refreshMessage = refreshFailureMessage(
                            *buildList {
                                if (simsIsCurrent) add("SIM" to sims)
                                add("通话" to calls)
                                if (smsIsCurrent) add("短信" to sms)
                            }.toTypedArray(),
                        ),
                        simsRefreshError = if (simsIsCurrent) {
                            visibleSims.error
                        } else {
                            it.simsRefreshError
                        },
                    )
                }
            }
        }
    }

    fun startCall(simId: String, number: String) {
        if (_state.value.busy) return
        val normalizedNumber = number.trim()
        if (normalizedNumber.isEmpty()) {
            _state.update { it.copy(message = "请输入对方号码".asUiError("call.validate")) }
            return
        }
        val sim = currentSims().singleOrNull { it.id == simId }
        val unavailable = sim?.unavailableReason(forCall = true) ?: "所选号码已不可用，请重新选择"
        if (sim == null || !sim.canCall) {
            _state.update { it.copy(message = unavailable.asUiError("sim.unavailable")) }
            return
        }
        val gatewayCall = gatewayBusyForSim(sim, currentCalls(), currentSims())
        if (gatewayCall != null) {
            _state.update { it.withTransientError(gatewayBusyMessage(gatewayCall).asUiError("call.gatewayBusy")) }
            return
        }
        if (localMediaBlocks(null, _state.value.media)) {
            _state.update { it.copy(message = "当前设备已有通话音频，结束后才能拨打另一通电话".asUiError("call.localBusy")) }
            return
        }
        val expected = sessions.snapshot()
        expected.session ?: return
        val attempt = runCatching { callRetries.attempt(simId, normalizedNumber) }.getOrElse {
            _state.update { state -> state.copy(message = "待确认的拨号请求过多，请稍后再试".asUiError("call.pendingLimit")) }
            return
        }
        _state.update { it.copy(busy = true, message = "") }
        val dialStartedAt = System.nanoTime()
        viewModelScope.launch {
            runCatching {
                callPreflightRejection(simId)?.let { throw it }
                withContext(Dispatchers.IO) {
                    callPreflightRejection(simId)?.let { throw it }
                    clientApi.startCall(simId, normalizedNumber, attempt.idempotencyKey)
                }
            }
                .onSuccess { response ->
                    ClientDiag.log(
                        "dial.request",
                        mapOf("ms" to diagElapsedMs(dialStartedAt), "code" to 200, "simId" to simId),
                        callId = response.optJSONObject("call")?.optString("id"),
                    )
                    if (sessions.isCurrent(expected.epoch)) {
                        callRetries.confirmed(attempt)
                        // S20 D5: registered the moment the server hands back the id, not after the
                        // list reload, so a swipe-away inside that window still releases the lock.
                        OccupancyReleasePolicy.registrableOutboundId(response)?.let {
                            OutboundCallReleaseService.track(getApplication(), it)
                        }
                        _state.update { it.copy(busy = false).withInfo(DIALING_ACKNOWLEDGEMENT) }
                        dialBurst = ClientRefreshCadence.DialBurst(
                            response.optJSONObject("call")?.optString("id")?.takeIf { it.isNotBlank() },
                            SystemClock.elapsedRealtime() + ClientRefreshCadence.DIAL_BURST_WINDOW_MS,
                        )
                        refreshAll()
                        foregroundRefresh.kick()
                    }
                }
                .onFailure { error ->
                    ClientDiag.log(
                        "dial.request",
                        mapOf("ms" to diagElapsedMs(dialStartedAt), "code" to (error as? ApiError)?.status, "simId" to simId, "error" to error.diagReason()),
                        level = "warn",
                    )
                    if (sessions.isCurrent(expected.epoch)) {
                        if (error is LocalActionRejected) callRetries.confirmed(attempt)
                        else callRetries.failed(attempt, error)
                        val text = error.userMessage()
                        val transient = (error is ApiError && error.code == "GATEWAY_BUSY") ||
                            (error as? LocalActionRejected)?.transient == true
                        _state.update {
                            if (transient) it.copy(busy = false).withTransientError(text) else it.copy(busy = false, message = text)
                        }
                        if (error is ApiError && error.status == 409) refreshAll()
                    }
                }
        }
    }

    fun claimCall(callId: String) {
        if (localMediaBlocks(callId, _state.value.media)) {
            _state.update { it.copy(message = "当前设备已有通话音频，不能接听另一通电话".asUiError("call.localBusy")) }
            return
        }
        if (_state.value.busy) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        _state.update { it.copy(busy = true, message = "") }
        val claimStartedAt = System.nanoTime()
        viewModelScope.launch {
            runCatching {
                if (localMediaBlocks(callId, _state.value.media)) {
                    throw LocalActionRejected("当前设备已有通话音频，不能接听另一通电话")
                }
                withContext(Dispatchers.IO) {
                    if (localMediaBlocks(callId, _state.value.media)) {
                        throw LocalActionRejected("当前设备已有通话音频，不能接听另一通电话")
                    }
                    clientApi.claimCall(callId, requiredSession = expected)
                }
            }.onSuccess {
                ClientDiag.log("call.claim", mapOf("ms" to diagElapsedMs(claimStartedAt), "ok" to true), callId = callId)
                if (sessions.isCurrent(expected.epoch)) {
                    _state.update { it.copy(busy = false).withInfo("已接听，正在等待网关设备的线路接通") }
                    refreshAll()
                }
            }.onFailure { error ->
                ClientDiag.log(
                    "call.claim",
                    mapOf("ms" to diagElapsedMs(claimStartedAt), "ok" to false, "code" to (error as? ApiError)?.status, "error" to error.diagReason()),
                    callId = callId,
                    level = "warn",
                )
                if (sessions.isCurrent(expected.epoch)) {
                    _state.update { it.copy(busy = false, message = error.userMessage()) }
                    if (error is ApiError && error.status == 409) refreshAll()
                }
            }
        }
    }

    /**
     * S36 C2: 通话中按一位就发一位，不排队、不改 `busy`、不刷新列表 —— 失败只回一句话给调用方的
     * 行内提示，因为 DTMF 的结果用户是用耳朵确认的。
     */
    fun sendDtmf(callId: String, digit: String, onError: (String) -> Unit) {
        if (callId.isBlank() || !Regex("^[0-9*#]$").matches(digit)) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        viewModelScope.launch {
            val startedAt = System.nanoTime()
            runCatching {
                withContext(Dispatchers.IO) { clientApi.sendDtmf(callId, digit, requiredSession = expected) }
            }.onSuccess {
                ClientDiag.log("dtmf.send", mapOf("ms" to diagElapsedMs(startedAt), "ok" to true), callId = callId)
            }.onFailure { error ->
                ClientDiag.log(
                    "dtmf.send",
                    mapOf("ms" to diagElapsedMs(startedAt), "ok" to false, "error" to error.diagReason()),
                    callId = callId,
                    level = "warn",
                )
                if (sessions.isCurrent(expected.epoch)) onError(error.userMessage())
            }
        }
    }

    fun endCall(callId: String) {
        if (callId.isBlank()) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        if (callId in _state.value.endingCallIds) return
        _state.update { it.copy(endingCallIds = it.endingCallIds + callId, message = "") }
        OutboundCallReleaseService.forget(getApplication(), callId)
        if (_state.value.media.callId == callId) {
            OngoingCallService.stopMedia(getApplication(), callId)
        }
        val endStartedAt = System.nanoTime()
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    clientApi.endCall(
                        callId,
                        onlyIfCurrentSessionOwner = true,
                        requiredSession = expected,
                    )
                }
            }
                .onSuccess {
                    ClientDiag.log("call.end", mapOf("ms" to diagElapsedMs(endStartedAt), "ok" to true), callId = callId)
                    if (sessions.isCurrent(expected.epoch)) {
                        _state.update { it.withInfo("结束请求已提交") }
                        refreshAll()
                    }
                }
                .onFailure { error ->
                    ClientDiag.log(
                        "call.end",
                        mapOf("ms" to diagElapsedMs(endStartedAt), "ok" to false, "error" to error.diagReason()),
                        callId = callId,
                        level = "warn",
                    )
                    if (sessions.isCurrent(expected.epoch)) {
                        _state.update { it.copy(
                            endingCallIds = it.endingCallIds - callId,
                            message = error.userMessage(),
                        ) }
                        if (error is ApiError && error.status == 409) refreshAll()
                    }
                }
        }
    }

    fun declineCall(callId: String) {
        if (callId.isBlank()) return
        mutate("已拒绝来电") { expected ->
            clientApi.endCall(callId, onlyIfRinging = true, requiredSession = expected)
        }
    }

    /**
     * S20 D6 "结束该通话": ends a call this account holds on another device. [endCall] cannot serve
     * here because it sends `onlyIfCurrentSessionOwner`, which is exactly the guard this action has
     * to step past; the server still authorises by snapshot owner, so nobody else's gateway is
     * reachable. The guards come from [occupancyEndGuard] so a decline stays a decline even if the
     * call is answered elsewhere between the tap and the request. The confirmation dialog is the
     * UI's job.
     */
    fun releaseOccupiedCall(callId: String, state: String) {
        if (callId.isBlank()) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        if (callId in _state.value.endingCallIds) return
        val guard = occupancyEndGuard(state)
        _state.update { it.copy(endingCallIds = it.endingCallIds + callId, message = "") }
        viewModelScope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    clientApi.endCall(
                        callId,
                        onlyIfCurrentSessionOwner = guard.onlyIfCurrentSessionOwner,
                        onlyIfRinging = guard.onlyIfRinging,
                        requiredSession = expected,
                    )
                }
            }
                .onSuccess {
                    if (sessions.isCurrent(expected.epoch)) {
                        _state.update { it.withInfo("结束请求已提交") }
                        refreshAll()
                    }
                }
                .onFailure { error ->
                    if (sessions.isCurrent(expected.epoch)) {
                        _state.update {
                            it.copy(endingCallIds = it.endingCallIds - callId, message = error.userMessage())
                        }
                        if (error is ApiError && error.status == 409) refreshAll()
                    }
                }
        }
    }

    /** Call ids whose outbound media was already started automatically; see [outboundMediaAutoStartId]. */
    private val attemptedOutboundMedia = mutableSetOf<String>()

    private fun autoStartOutboundMedia(items: List<JSONObject>) {
        // The runtime flow, not `_state.media`: the view model copy lags one collector hop behind.
        val callId = outboundMediaAutoStartId(items, ClientCallRuntime.state.value, attemptedOutboundMedia) ?: return
        attemptedOutboundMedia += callId
        ClientDiag.log("media.auto_start", mapOf("direction" to "outgoing"), callId = callId)
        // Same rule as `connectAfterClaim`: a denied microphone is a FAILED media with a retry, not a silent call.
        if (ContextCompat.checkSelfPermission(getApplication(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            mediaPermissionDenied(callId, CallMediaTransport.UDP)
        } else {
            connectMedia(callId, CallMediaTransport.UDP)
        }
    }

    fun connectMedia(callId: String, transport: CallMediaTransport) {
        if (localMediaBlocks(callId, _state.value.media)) {
            _state.update { it.copy(message = "当前设备已有通话音频，不能切换到另一通电话".asUiError("call.localBusy")) }
            return
        }
        if (!canShowCallNotification(getApplication())) {
            _state.update { it.copy(message = "请先允许通知，才能保持通话在后台运行".asUiError("call.notificationPermission")) }
            return
        }
        OngoingCallService.connect(getApplication(), callId, transport)
    }

    fun mediaPermissionDenied(callId: String, transport: CallMediaTransport) {
        ClientCallRuntime.permissionDenied(getApplication(), callId, transport)
    }

    fun stopMedia() {
        _state.value.media.callId?.let { OngoingCallService.stopMedia(getApplication(), it) }
    }

    fun setSpeaker(enabled: Boolean) {
        _state.value.media.callId?.let { OngoingCallService.speaker(getApplication(), it, enabled) }
    }

    fun setMuted(muted: Boolean) {
        _state.value.media.callId?.let { OngoingCallService.mute(getApplication(), it, muted) }
    }

    fun refreshBackgroundCalling() = ensurePushRegistration()

    private fun ensurePushRegistration() {
        if (BuildConfig.S33_UI_TEST) {
            _state.update { it.copy(pushRegistration = PushRegistrationState.Unavailable) }
            return
        }
        val expected = sessions.snapshot()
        if (expected.session == null) return
        _state.update { it.copy(pushRegistration = PushRegistrationState.Registering) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { push.ensureCurrent() }
            if (sessions.isCurrent(expected.epoch)) _state.update { it.copy(pushRegistration = result) }
        }
    }

    fun sendSms(
        simId: String,
        number: String,
        body: String,
        draftKey: String? = null,
        additionalDraftKey: String? = null,
    ) {
        if (_state.value.busy) return
        sendSmsRecipients(simId, listOf(number.trim()), body, draftKey, additionalDraftKey)
    }

    fun sendSmsRecipients(
        simId: String, recipients: List<String>, body: String,
        draftKey: String? = null, additionalDraftKey: String? = null,
        onAccepted: () -> Unit = {},
    ) {
        if (_state.value.busy) return
        val numbers = recipients.map(String::trim)
        if (numbers.size !in 1..100 || !SmsRecipientPolicy.valid(numbers.map { SmsRecipient(it) }) || body.isBlank()) {
            _state.update { it.copy(message = "请输入收件号码和短信内容".asUiError("sms.validate")) }
            return
        }
        val sim = currentSims().singleOrNull { it.id == simId }
        val unavailable = sim?.unavailableReason(forCall = false) ?: "所选号码已不可用，请重新选择"
        if (sim == null || !sim.canSms) {
            _state.update { it.copy(message = unavailable.asUiError("sim.unavailable")) }
            return
        }
        val expected = sessions.snapshot()
        expected.session ?: return
        val attempt = runCatching { if (numbers.size == 1) smsRetries.attempt(simId, numbers.single(), body)
            else smsRetries.batchAttempt(simId, numbers, body) }.getOrElse {
            _state.update { state -> state.copy(message = "待确认的短信请求过多，请稍后再试".asUiError("sms.pendingLimit")) }
            return
        }
        _state.update { it.copy(busy = true, message = "") }
        viewModelScope.launch {
            runCatching {
                smsPreflightReason(simId)?.let { throw LocalActionRejected(it) }
                withContext(Dispatchers.IO) {
                    smsPreflightReason(simId)?.let { throw LocalActionRejected(it) }
                    if (numbers.size == 1) clientApi.sendSms(simId, numbers.single(), body, attempt.idempotencyKey)
                    else clientApi.sendSmsBatch(simId, numbers, body, attempt.idempotencyKey)
                }
            }.onSuccess {
                if (sessions.isCurrent(expected.epoch)) {
                    smsRetries.confirmed(attempt)
                    _state.update { current -> current.copy(
                        busy = false,
                        message = "短信已提交，正在等待发送",
                        infoMessage = "短信已提交，正在等待发送",
                        smsDrafts = current.smsDrafts - listOfNotNull(
                            draftKey?.takeIf { current.smsDrafts[it] == body }, additionalDraftKey,
                        ).toSet(),
                    ) }
                    onAccepted()
                    refreshAll()
                }
            }.onFailure { error ->
                if (sessions.isCurrent(expected.epoch)) {
                    if (error is LocalActionRejected) smsRetries.confirmed(attempt)
                    else smsRetries.failed(attempt, error)
                    _state.update { it.copy(busy = false, message = error.userMessage()) }
                    if (error is ApiError && error.status == 409) refreshAll()
                }
            }
        }
    }

    fun updateSmsDraft(key: String, value: String) {
        _state.update { current ->
            current.copy(smsDrafts = current.smsDrafts.toMutableMap().apply {
                if (value.isEmpty()) remove(key) else put(key, value)
            })
        }
    }

    fun clearSmsDraft(key: String) = updateSmsDraft(key, "")

    fun setMode(simId: String, mode: String, timeoutSeconds: Int, expectedVersion: Long) {
        if (mode !in setOf("normal", "ai", "timeout_ai") || timeoutSeconds !in 10..120) {
            _state.update { it.copy(message = "超时秒数必须在 10–120 之间".asUiError("settings.validate")) }
            return
        }
        mutate(
            "接听模式已保存，正在等待网关确认",
            // PUT 的回包按设计仍带旧的 appliedVersion，所以这里不是“已应用”，而是开始等网关 ack。
            afterSuccess = { response ->
                beginSettingsApply(simId, mode, timeoutSeconds, response, expectedVersion)
            },
            afterFailure = { error ->
                if (error.isSimVersionConflict()) {
                    _state.update {
                        it.copy(
                            simSettingsConflicts = it.simSettingsConflicts +
                                (simId to error.simConflictVersion(expectedVersion)),
                        )
                    }
                }
            },
        ) { _ ->
            clientApi.setMode(simId, mode, timeoutSeconds, expectedVersion)
        }
    }

    /**
     * 保存成功后进入 [SettingsApplyState.Applying] 并启动有界轮询。目标版本取 PUT 回包里的
     * `settings.version`（[SettingsApplyPolicy.targetVersion]），所以「已应用」的判据不依赖任何
     * 保存前的旧快照。
     */
    private fun beginSettingsApply(
        simId: String,
        submittedMode: String,
        submittedTimeoutSeconds: Int,
        response: JSONObject,
        expectedVersion: Long,
    ) {
        if (simId.isBlank()) return
        val applying = SettingsApplyPolicy.applying(
            simId = simId,
            targetVersion = SettingsApplyPolicy.targetVersion(response, expectedVersion),
            nowMs = System.currentTimeMillis(),
        )
        settingsApplyEpoch = sessions.snapshot().epoch
        _state.update {
            it.copy(
                settingsApply = it.settingsApply + (simId to applying),
                simSettingsSubmissions = it.simSettingsSubmissions + (
                    simId to SimSettingsSubmission(
                        targetVersion = applying.targetVersion,
                        mode = submittedMode,
                        timeoutSeconds = submittedTimeoutSeconds,
                    )
                ),
                simSettingsConflicts = it.simSettingsConflicts - simId,
            )
        }
        settingsApplyWatch.start()
    }

    /** 轮询的一拍：安静地重读 `/sims`（[refreshCallsAndSims]），并等这一轮真的落地。 */
    private suspend fun awaitCallsAndSimsRefresh() {
        refreshCallsAndSims()
        refreshJob?.join()
    }

    /**
     * 用最新的 `/sims` 快照推进每一个在等的 SIM；返回「还有没有人在等」，[SettingsApplyWatch] 据此收工。
     */
    private fun advanceSettingsApply(): Boolean {
        val expectedEpoch = settingsApplyEpoch ?: return false
        if (!sessions.isCurrent(expectedEpoch)) {
            settingsApplyEpoch = null
            return false
        }
        val sims = (_state.value.sims as? RemoteList.Loaded)?.items.orEmpty()
        val now = System.currentTimeMillis()
        // 推进写在 CAS 里重算：这一拍进行中用户又按了一次「保存设置」时，不能用读到一半的旧表把
        // 新的 Applying 覆盖掉（那会让新的一次保存既没有轮询也停在等待）。
        _state.update { current ->
            current.copy(
                settingsApply = current.settingsApply.mapValues { (simId, state) ->
                    // SIM 从名下消失也不能永远转圈，按「没有版本可读」继续走超时。
                    val versions = sims.firstOrNull { it.optString("id") == simId }?.simSettingsVersions()
                        ?: SimSettingsVersions(version = 0, appliedVersion = null)
                    SettingsApplyPolicy.next(state, now, versions.appliedVersion, versions.version)
                },
            )
        }
        return _state.value.settingsApply.values.any { it is SettingsApplyState.Applying }
    }

    fun setSimNotes(simId: String, label: String, phoneLabel: String?, expectedVersion: Long) {
        val trimmed = label.trim()
        if (trimmed.isEmpty()) {
            _state.update { it.copy(message = "名称不能为空".asUiError("settings.validate")) }
            return
        }
        val submittedPhoneLabel = phoneLabel?.trim()?.takeIf(String::isNotEmpty)
        mutate(
            "号码备注已保存",
            afterSuccess = { response ->
                val targetVersion = response.optJSONObject("sim")
                    ?.optLong("version", expectedVersion + 1)
                    ?.takeIf { it > expectedVersion }
                    ?: (expectedVersion + 1)
                _state.update {
                    it.copy(
                        simNotesSubmissions = it.simNotesSubmissions + (
                            simId to SimNotesSubmission(targetVersion, trimmed, submittedPhoneLabel)
                        ),
                        simNotesConflicts = it.simNotesConflicts - simId,
                    )
                }
            },
            afterFailure = { error ->
                if (error.isSimVersionConflict()) {
                    _state.update {
                        it.copy(
                            simNotesConflicts = it.simNotesConflicts +
                                (simId to error.simConflictVersion(expectedVersion)),
                        )
                    }
                }
            },
        ) { _ ->
            clientApi.setSimNotes(
                simId,
                expectedVersion,
                trimmed,
                submittedPhoneLabel,
            )
        }
    }

    fun acceptLatestSimNotes(simId: String, observedVersion: Long): Boolean {
        val required = _state.value.simNotesConflicts[simId] ?: return true
        if (observedVersion < required) return false
        _state.update { it.copy(simNotesConflicts = it.simNotesConflicts - simId) }
        return true
    }

    fun acceptLatestSimSettings(simId: String, observedVersion: Long): Boolean {
        val required = _state.value.simSettingsConflicts[simId] ?: return true
        if (observedVersion < required) return false
        _state.update { it.copy(simSettingsConflicts = it.simSettingsConflicts - simId) }
        return true
    }

    // ---- S22 决策 10 记录页 -------------------------------------------------------------------

    /**
     * Loads 报告 for an explicit calendar-day window. A preset is re-resolved against today in the
     * gateway's zone on every load, so "7 天" stays 7 days as the day rolls over; 自定义 keeps the
     * range the date picker produced.
     */
    fun loadReports(
        preset: ReportRangePreset = _state.value.reportPreset,
        range: ReportDateRange? = _state.value.reportRange,
        query: String = _state.value.reportQuery,
        timeZone: String = _state.value.reportTimeZone,
        simId: String = _state.value.reportSimId,
        page: Int = _state.value.reportsPageNum,
        pageSize: Int = _state.value.reportsPageSize,
        debounceMs: Long = 0,
    ) {
        if (!_state.value.networkAvailable) return
        val expected = sessions.snapshot()
        expected.session ?: return
        val zone = gatewayDisplayTimeZone(timeZone)
        val today = reportToday(zone)
        val resolved = (if (preset == ReportRangePreset.CUSTOM) range else reportRangeFor(preset, today))
            ?: range
            ?: checkNotNull(reportRangeFor(ReportRangePreset.DAYS_7, today))
        val size = RecordsPagingPolicy.clampPageSize(pageSize)
        val previousKey = reportContentKey()
        val key = reportContentKey(resolved, query, zone, simId)
        // 窗口 / 搜索词 / SIM 一变就回第 1 页：旧的第 7 页在新的条件下多半是空的。
        val wanted = if (RecordsPagingPolicy.resetsPage(previousKey, key)) 1 else page.coerceAtLeast(1)
        val token = reportRequests.next(expected.epoch, reportRequestKey(key, size, wanted))
        reportsJob?.cancel()
        _state.update {
            it.copy(
                reportPreset = preset,
                reportRange = resolved,
                reportQuery = query,
                reportSimId = simId,
                reportTimeZone = zone,
                reportsPageNum = wanted,
                reportsPageSize = size,
                // 轮询当前页时保留最后一次成功快照；换条件或翻页才显示整页加载态。
                reports = pageStateDuringLoad(
                    it.reports,
                    sameRequest = key == previousKey && wanted == it.reportsPageNum && size == it.reportsPageSize,
                ),
                // 翻页不是换内容：只有窗口/搜索/SIM 变了才关掉已经打开的转录页。
                callDetail = if (key != previousKey) null else it.callDetail,
            )
        }
        reportsJob = viewModelScope.launch {
            if (debounceMs > 0) delay(debounceMs)
            val result: RemoteResource<CallReportPage> = runCatching {
                withContext(Dispatchers.IO) { clientApi.reportsPage(resolved, zone, query, simId, wanted, size) }
            }.fold(
                onSuccess = { RemoteResource.Loaded(it) },
                onFailure = { RemoteResource.Failed(it.reportUserMessage()) },
            )
            val current = _state.value
            val currentKey = reportRequestKey(reportContentKey(), current.reportsPageSize, current.reportsPageNum)
            if (!reportRequests.accepts(token, sessions.snapshot().epoch, currentKey)) return@launch
            _state.update { clientStateWithReportsPage(it, result) }
            (result as? RemoteResource.Loaded)?.value?.paging?.let(RecordsPagingPolicy::rewindPage)
                ?.let { last -> loadReports(page = last) }
        }
    }

    /** 决定「这是不是同一份内容」：翻页不算，换窗口 / 搜索词 / SIM 才算。 */
    private fun reportContentKey(
        range: ReportDateRange? = _state.value.reportRange,
        query: String = _state.value.reportQuery,
        timeZone: String = _state.value.reportTimeZone,
        simId: String = _state.value.reportSimId,
    ): String = "${range?.fromWire}|${range?.toWire}|${query.trim()}|$timeZone|$simId"

    /** 异步守卫用的键：内容 + 页长 + 页码，晚到的上一页结果不会覆盖当前页。 */
    private fun reportRequestKey(contentKey: String, pageSize: Int, page: Int): String = "$contentKey|$pageSize|$page"

    /** Typing in the 报告 search box; the request is debounced the same way contacts search is. */
    fun setReportQuery(query: String) {
        if (_state.value.reportQuery == query) return
        loadReports(query = query, page = 1, debounceMs = CALL_SEARCH_DEBOUNCE_MS)
    }

    fun setReportsPage(page: Int) = loadReports(page = page)

    fun setReportsPageSize(pageSize: Int) = loadReports(page = 1, pageSize = pageSize)

    /**
     * S28 全部通话：这一页现在是服务端切的，搜索词和 SIM 都进了 WHERE，所以「清空搜索框」也是一次
     * 请求（回到第 1 页的完整列表），而不是回读轮询列表。轮询列表 [ClientUiState.calls] 只服务拨号页。
     */
    fun loadCallsPage(
        query: String = _state.value.callQuery,
        simId: String = _state.value.callsSimId,
        page: Int = _state.value.callsPageNum,
        pageSize: Int = _state.value.callsPageSize,
        debounceMs: Long = 0,
    ) {
        if (!_state.value.networkAvailable) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val size = RecordsPagingPolicy.clampPageSize(pageSize)
        val previous = _state.value
        val previousKey = callsContentKey()
        val key = callsContentKey(query, simId)
        val wanted = if (RecordsPagingPolicy.resetsPage(previousKey, key)) 1 else page.coerceAtLeast(1)
        val sameRequest = key == previousKey && wanted == previous.callsPageNum && size == previous.callsPageSize
        val token = callsPageRequests.next(expected.epoch, callsRequestKey(key, size, wanted))
        callsPageJob?.cancel()
        _state.update {
            it.copy(
                callQuery = query,
                callsSimId = simId,
                callsPageNum = wanted,
                callsPageSize = size,
                callsPage = pageStateDuringLoad(it.callsPage, sameRequest),
                callsPageRefreshing = true,
            )
        }
        callsPageJob = viewModelScope.launch {
            if (debounceMs > 0) delay(debounceMs)
            val result: RemoteResource<Page<JSONObject>> = runCatching {
                withContext(Dispatchers.IO) { clientApi.callsPage(query, simId, wanted, size) }
            }.fold(
                onSuccess = { RemoteResource.Loaded(it) },
                onFailure = { RemoteResource.Failed(it.userMessage()) },
            )
            val current = _state.value
            val currentKey = callsRequestKey(callsContentKey(), current.callsPageSize, current.callsPageNum)
            if (!callsPageRequests.accepts(token, sessions.snapshot().epoch, currentKey)) return@launch
            // 只写 callsPage：state.calls 属于拨号页的轮询与运行时对账，分页结果碰不得。
            _state.update { clientStateWithCallsPage(it, result) }
            (result as? RemoteResource.Loaded)?.value?.let(RecordsPagingPolicy::rewindPage)
                ?.let { last -> loadCallsPage(page = last) }
        }
    }

    private fun callsContentKey(
        query: String = _state.value.callQuery,
        simId: String = _state.value.callsSimId,
    ): String = "${query.trim()}|$simId"

    private fun callsRequestKey(contentKey: String, pageSize: Int, page: Int): String = "$contentKey|$pageSize|$page"

    fun setCallsPage(page: Int) = loadCallsPage(page = page)

    fun setCallsPageSize(pageSize: Int) = loadCallsPage(page = 1, pageSize = pageSize)

    /** The 全部通话 search box; the request is debounced exactly like 报告 and 通讯录. */
    fun setCallQuery(query: String) {
        if (_state.value.callQuery == query) return
        loadCallsPage(query = query, page = 1, debounceMs = CALL_SEARCH_DEBOUNCE_MS)
    }

    /**
     * S30：删掉一条通话记录。服务端一条 `DELETE /calls/:id` 就把这通的录音、转写和报告条目级联删了
     * （S29 把外键改成级联/置空），客户端先用 [clientStateWithoutCall] 就地把这一行从三处拿掉，再按
     * 当前的搜索词 / SIM / 页码重读，让分页条的总数和页码回到服务端的口径；报告页已经读过才跟着重读，
     * 没打开过就一个请求都不发。
     *
     * 失败落在 [ClientUiState.message]，[Workspace] 把它顶在 tab 内容上方，所以 409
     * 「通话仍在进行或处理中，稍后再删」在记录页上看得见。
     */
    fun deleteCall(callId: String) {
        if (callId.isBlank() || !deletingCallIds.add(callId)) return
        val expected = sessions.snapshot().also { if (it.session == null) { deletingCallIds.remove(callId); return } }
        _state.update { it.copy(message = "") }
        viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.deleteCall(callId) } }
            deletingCallIds.remove(callId)
            if (!sessions.isCurrent(expected.epoch)) return@launch
            result.fold(
                onSuccess = {
                    // 成功不出声：行当场消失就是回执（Web / iOS 同样静默）。
                    _state.update { clientStateWithoutCall(it, callId) }
                    loadCallsPage()
                    if (_state.value.reports is RemoteResource.Loaded) loadReports()
                },
                onFailure = { error -> _state.update { it.copy(message = error.userMessage()) } },
            )
        }
    }

    /**
     * 对话页「删除所选」。选中的 id 先本地过滤掉再 [refreshAll]，所以气泡当场消失，而不是等下一轮
     * 刷新；在途的短信被服务端跳过，回执里会说清楚有几条没删掉。
     */
    fun deleteSmsMessages(ids: List<String>) {
        val wanted = ids.filter(String::isNotBlank).toSet()
        if (!SmsSelectionPolicy.canDelete(wanted) || smsDeleting) {
            SmsSelectionPolicy.deleteLimitMessage(wanted).takeIf(String::isNotBlank)?.let { warning ->
                _state.update { it.copy(message = warning.asUiError("sms.deleteLimit")) }
            }
            return
        }
        val expected = sessions.snapshot().also { if (it.session == null) return }
        ++smsRefreshGeneration
        smsRefreshJob?.cancel()
        smsDeleting = true
        _state.update { it.copy(message = "") }
        viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.deleteSms(wanted.toList()) } }
            smsDeleting = false
            if (!sessions.isCurrent(expected.epoch)) return@launch
            result.fold(
                onSuccess = { response ->
                    val accepted = smsAcceptedDeletedIds(wanted, response)
                    _state.update { state ->
                        state.copy(
                            sms = (state.sms as? RemoteList.Loaded)
                                ?.let { RemoteList.Loaded(smsRowsWithoutIds(it.items, accepted)) } ?: state.sms,
                            // 成功静默；只有「有几条还在发、没删成」才需要说一句。
                            message = smsDeleteSkippedMessage(response).asUiError("sms.deleteSkipped"),
                        )
                    }
                    refreshSms()
                },
                onFailure = { error -> _state.update { it.copy(message = error.userMessage()) } },
            )
        }
    }

    /**
     * 短信列表左滑出来的两个动作。「删除并屏蔽」= 先 `POST /blocklist {remoteNumber}`（新建 201、
     * 已存在 200 都算成功，见 S30 §1.3），再删这段对话；屏蔽失败就不再往下删，否则号码没挡住、对话
     * 却已经没了。
     */
    fun deleteSmsThread(simId: String, conversationAddress: String, blockNumber: String? = null) {
        if (simId.isBlank() || conversationAddress.isBlank() || smsDeleting) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val block = blockNumber?.takeIf(String::isNotBlank)
        val deleteKey = "$simId\u0000$conversationAddress"
        val blockAlreadySucceeded = deleteKey in pendingBlockedSmsDeletes
        val shouldBlock = block != null && !blockAlreadySucceeded
        if (shouldBlock || blockAlreadySucceeded) {
            ++blocklistGeneration
            blocklistJob?.cancel()
        }
        ++smsRefreshGeneration
        smsRefreshJob?.cancel()
        smsDeleting = true
        _state.update { it.copy(message = "") }
        viewModelScope.launch {
            var blockSucceeded = false
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    if (shouldBlock) {
                        clientApi.block(checkNotNull(block), null, ClientApiRoutes.BLOCK_SCOPE_SMS)
                        blockSucceeded = true
                    }
                    clientApi.deleteSmsThread(simId, conversationAddress)
                }
            }
            smsDeleting = false
            if (!sessions.isCurrent(expected.epoch)) return@launch
            result.fold(
                onSuccess = { response ->
                    pendingBlockedSmsDeletes.remove(deleteKey)
                    _state.update { state ->
                        state.copy(
                            sms = (state.sms as? RemoteList.Loaded)?.let {
                                RemoteList.Loaded(smsRowsAfterThreadDelete(it.items, simId, conversationAddress, response))
                            } ?: state.sms,
                            // 屏蔽成功也不出声：会话消失 + 拦截记录里出现那一条就是回执。
                            message = smsDeleteSkippedMessage(response).asUiError("sms.deleteSkipped"),
                        )
                    }
                    refreshSms()
                    loadBlocklist()
                },
                onFailure = { error ->
                    if (blockSucceeded) pendingBlockedSmsDeletes += deleteKey
                    _state.update {
                        it.copy(
                            message = if (blockSucceeded || blockAlreadySucceeded) {
                                "号码已屏蔽，但对话删除失败，请重试".asUiError("sms.deleteThread")
                            } else {
                                error.userMessage()
                            },
                        )
                    }
                    if (blockSucceeded || blockAlreadySucceeded) loadBlocklist()
                },
            )
        }
    }

    /**
     * "立即屏蔽" on a report card: the same `POST /blocklist {remoteNumber, sourceCallId}` the contact
     * card uses. Every row for that number is marked blocked from the response, so the list does not
     * have to be refetched before the button turns into the 已屏蔽 pill.
     */
    fun blockReportNumber(callId: String, remoteNumber: String) {
        if (callId.isBlank() || !dialableNumber(remoteNumber)) return
        if (callId in _state.value.reportBlocking) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        _state.update { it.copy(reportBlocking = it.reportBlocking + callId, reportMessage = "") }
        viewModelScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) { clientApi.block(remoteNumber, callId, ClientApiRoutes.BLOCK_SCOPE_CALL).optString("id") }
            }
            if (!sessions.isCurrent(expected.epoch)) return@launch
            _state.update { state ->
                val cleared = state.copy(reportBlocking = state.reportBlocking - callId)
                result.fold(
                    onSuccess = { entryId ->
                        val page = (cleared.reports as? RemoteResource.Loaded)?.value
                        cleared.copy(
                            reportMessage = "",
                            reports = if (page == null) cleared.reports else RemoteResource.Loaded(
                                page.copy(paging = page.paging.copy(items = page.items.map { item ->
                                    if (item.remoteNumber != remoteNumber) item
                                    else item.copy(blocked = true, blockedEntryId = entryId.takeIf(String::isNotBlank))
                                })),
                            ),
                        )
                    },
                    onFailure = { error -> cleared.copy(reportMessage = error.userMessage()) },
                )
            }
            if (result.isSuccess) {
                refreshAll()
                refreshInterceptions()
            }
        }
    }

    fun clearReportMessage() = _state.update { it.copy(reportMessage = "") }

    fun openHistoryViewer(
        item: CallReportItem,
        viewer: HistoryViewerKind,
        source: RecordingSource = item.defaultRecordingSource,
    ) {
        if (!_state.value.networkAvailable) return
        val expected = sessions.snapshot()
        expected.session ?: return
        markCallSeen(item.callId)
        val key = historyDetailKey(viewer, item.callId)
        val token = detailRequests.next(expected.epoch, key)
        _state.update {
            it.copy(
                callDetail = CallDetailUiState(
                    item = item,
                    viewer = viewer,
                    selectedRecordingSource = source,
                    transcript = if (viewer == HistoryViewerKind.TRANSCRIPT) RemoteResource.Loading else RemoteResource.NotLoaded,
                    recordings = RecordingSource.entries.associateWith { entry ->
                        if (viewer == HistoryViewerKind.RECORDING && entry == source) RemoteResource.Loading
                        else RemoteResource.NotLoaded
                    },
                ),
            )
        }
        when (viewer) {
            HistoryViewerKind.TRANSCRIPT -> viewModelScope.launch {
                val result = runCatching { withContext(Dispatchers.IO) { clientApi.transcript(item.callId) } }
                applyDetailResult(token, item.callId, viewer) { detail ->
                    detail.copy(transcript = result.fold(
                        onSuccess = { RemoteResource.Loaded(it) },
                        onFailure = { RemoteResource.Failed(it.reportUserMessage()) },
                    ))
                }
                if (result.isSuccess) pollTranscriptWhileInFlight(token, item.callId, viewer)
            }
            HistoryViewerKind.RECORDING -> viewModelScope.launch {
                val result = runCatching { withContext(Dispatchers.IO) { clientApi.recording(item.callId, source) } }
                applyDetailResult(token, item.callId, viewer) { detail ->
                    detail.copy(
                        recordings = detail.recordings + (source to result.fold(
                            onSuccess = { RemoteResource.Loaded(it) },
                            onFailure = { RemoteResource.Failed(it.reportUserMessage()) },
                        )),
                    )
                }
            }
        }
    }

    fun selectRecordingSource(source: RecordingSource) {
        val detail = _state.value.callDetail ?: return
        if (detail.viewer != HistoryViewerKind.RECORDING) return
        val current = detail.recordings[source]
        if (!_state.value.networkAvailable && current !is RemoteResource.Loaded) return
        _state.update { it.copy(callDetail = it.callDetail?.copy(selectedRecordingSource = source)) }
        if (current is RemoteResource.Loaded || current is RemoteResource.Loading) return
        val expected = sessions.snapshot()
        expected.session ?: return
        val callId = detail.item.callId
        val epoch = expected.epoch
        _state.update { state ->
            val latest = state.callDetail ?: return@update state
            if (latest.item.callId != callId || latest.viewer != HistoryViewerKind.RECORDING) state
            else state.copy(
                callDetail = latest.copy(recordings = latest.recordings + (source to RemoteResource.Loading)),
            )
        }
        viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.recording(callId, source) } }
            if (sessions.snapshot().epoch != epoch) return@launch
            _state.update { state ->
                val latest = state.callDetail
                if (latest?.item?.callId != callId || latest.viewer != HistoryViewerKind.RECORDING) state
                else state.copy(
                    callDetail = latest.copy(
                        recordings = latest.recordings + (source to result.fold(
                            onSuccess = { RemoteResource.Loaded(it) },
                            onFailure = { RemoteResource.Failed(it.reportUserMessage()) },
                        )),
                    ),
                )
            }
        }
    }

    fun retryHistoryViewer() {
        val detail = _state.value.callDetail ?: return
        openHistoryViewer(detail.item, detail.viewer, detail.selectedRecordingSource)
    }

    fun openCallDetail(call: JSONObject, viewer: HistoryViewerKind = HistoryViewerKind.RECORDING) {
        val simId = call.optString("simId")
        val sim = (_state.value.sims as? RemoteList.Loaded)?.items.orEmpty()
            .firstOrNull { it.optString("id") == simId }
        openHistoryViewer(parseCallHistoryItem(call, sim), viewer)
    }

    fun openHistoryRecord(call: JSONObject) {
        val callId = call.optString("id")
        if (callId.isBlank()) return
        markCallSeen(callId)
        _state.update { it.copy(openedHistoryCall = call, message = "") }
        refreshOpenedHistoryCall()
    }

    fun closeHistoryRecord() {
        historyRecordRequests.invalidate()
        _state.update { it.copy(openedHistoryCall = null, callDetail = null) }
    }

    private fun refreshOpenedHistoryCall() {
        if (!_state.value.networkAvailable) return
        val current = _state.value.openedHistoryCall ?: return
        val callId = current.optString("id")
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val key = "record|$callId"
        val token = historyRecordRequests.next(expected.epoch, key)
        viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.call(callId) } }
            val latestId = _state.value.openedHistoryCall?.optString("id").orEmpty()
            if (!historyRecordRequests.accepts(token, sessions.snapshot().epoch, "record|$latestId")) return@launch
            result.fold(
                onSuccess = { fresh -> _state.update { state ->
                    if (state.openedHistoryCall?.optString("id") == callId) state.copy(openedHistoryCall = fresh) else state
                } },
                onFailure = { error ->
                    if ((error as? ApiError)?.status == 404) {
                        _state.update {
                            it.copy(
                                openedHistoryCall = null,
                                callDetail = null,
                                message = CALL_DELETED_ELSEWHERE_MESSAGE,
                                infoMessage = CALL_DELETED_ELSEWHERE_MESSAGE,
                            )
                        }
                    } else {
                        _state.update { it.copy(refreshMessage = "通话详情刷新失败，请稍后重试".asUiError("history.detail")) }
                    }
                },
            )
        }
    }

    private fun validateOpenCallDetail() {
        val detail = _state.value.callDetail ?: return
        val callId = detail.item.callId
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val token = viewerValidityRequests.next(expected.epoch, callId)
        viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.call(callId) } }
            val latestId = _state.value.callDetail?.item?.callId.orEmpty()
            if (!viewerValidityRequests.accepts(token, sessions.snapshot().epoch, latestId)) return@launch
            result.fold(
                onSuccess = { fresh ->
                    val sim = (_state.value.sims as? RemoteList.Loaded)?.items.orEmpty()
                        .firstOrNull { it.optString("id") == fresh.optString("simId") }
                    _state.update { state ->
                        val current = state.callDetail
                        if (current?.item?.callId != callId) state
                        else state.copy(callDetail = current.copy(item = parseCallHistoryItem(fresh, sim)))
                    }
                },
                onFailure = { error ->
                    if ((error as? ApiError)?.status == 404) {
                        detailRequests.invalidate()
                        _state.update {
                            it.copy(
                                callDetail = null,
                                openedHistoryCall = it.openedHistoryCall
                                    ?.takeIf { row -> row.optString("id") != callId },
                                message = CALL_DELETED_ELSEWHERE_MESSAGE,
                                infoMessage = CALL_DELETED_ELSEWHERE_MESSAGE,
                            )
                        }
                    }
                },
            )
        }
    }

    fun closeReportCall() {
        detailRequests.invalidate()
        viewerValidityRequests.invalidate()
        _state.update { it.copy(callDetail = null) }
    }

    // ---- S39 §E AI 对话浮层的按 ID 校验 --------------------------------------------------------

    fun openAiTranscript(callId: String) {
        if (callId.isBlank()) return
        markCallSeen(callId)
        // 内容由 [AiTranscriptSheet] 自己的 LaunchedEffect 去 [loadAiTranscript]，这里只管开。
        _state.update { it.copy(aiTranscriptCallId = callId, message = "") }
    }

    fun closeAiTranscript() {
        aiTranscriptValidityRequests.invalidate()
        _state.update { it.copy(aiTranscriptCallId = null) }
    }

    /**
     * 与 [validateOpenCallDetail] 同一条规矩，只是盯着 [ClientUiState.aiTranscriptCallId]：浮层开着
     * 的时候每一轮前台刷新都 `GET calls/<id>`，404 就关掉。成功没有副作用 —— 浮层里显示的几段对话
     * 由 [loadAiTranscript] 一次读完，不随通话行变。
     */
    private fun validateOpenAiTranscript() {
        val callId = _state.value.aiTranscriptCallId ?: return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val token = aiTranscriptValidityRequests.next(expected.epoch, callId)
        viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.call(callId) } }
            val latestId = _state.value.aiTranscriptCallId.orEmpty()
            if (!aiTranscriptValidityRequests.accepts(token, sessions.snapshot().epoch, latestId)) return@launch
            if ((result.exceptionOrNull() as? ApiError)?.status == 404) {
                _state.update { clientStateWithoutAiTranscript(it, callId) }
            }
        }
    }

    private suspend fun pollTranscriptWhileInFlight(
        token: AsyncRequestToken,
        callId: String,
        viewer: HistoryViewerKind,
    ) {
        while (true) {
            val status = (_state.value.callDetail?.transcript as? RemoteResource.Loaded)?.value?.status
            if (!transcriptStatusIsInFlight(status)) return
            delay(5_000)
            val currentKey = historyDetailKey(viewer, callId)
            if (!detailRequests.accepts(token, sessions.snapshot().epoch, currentKey)) return
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.transcript(callId) } }
            applyDetailResult(token, callId, viewer) { detail ->
                detail.copy(transcript = result.fold(
                    onSuccess = { RemoteResource.Loaded(it) },
                    onFailure = { RemoteResource.Failed(it.reportUserMessage()) },
                ))
            }
            if (result.isFailure) return
        }
    }

    private fun applyDetailResult(
        token: AsyncRequestToken,
        callId: String,
        viewer: HistoryViewerKind,
        transform: (CallDetailUiState) -> CallDetailUiState,
    ) {
        val currentEpoch = sessions.snapshot().epoch
        val currentKey = _state.value.callDetail?.let { historyDetailKey(it.viewer, it.item.callId) }.orEmpty()
        if (!detailRequests.accepts(token, currentEpoch, currentKey)) return
        _state.update { state ->
            val detail = state.callDetail
            if (detail?.item?.callId != callId || detail.viewer != viewer) state
            else state.copy(callDetail = transform(detail))
        }
    }

    fun clearMessage() = _state.update { it.copy(message = "") }

    private fun restoreSession() {
        val session = restoredSession
        if (session == null) {
            _state.update { it.copy(checkingSession = false) }
            return
        }
        _state.update { it.copy(session = session) }
        viewModelScope.launch {
            val expected = sessions.snapshot()
            runCatching {
                val profile = withContext(Dispatchers.IO) { clientApi.meProfile(expected) }
                sessions.updateProfile(expected, profile.username, profile.role)
            }
                .onSuccess { latest ->
                    if (sessions.isCurrent(expected.epoch)) _state.update { current ->
                        current.copy(checkingSession = false, session = latest.session)
                    }
                    ensurePushRegistration()
                    refreshAll()
                    loadPasskeys()
                }
                .onFailure { error ->
                    if (sessions.isCurrent(expected.epoch)) _state.update { current ->
                        if (current.session == null) current.copy(checkingSession = false)
                        else current.copy(
                            checkingSession = false,
                            message = "暂时无法验证登录：${error.userMessage()}。凭据已保留，可稍后刷新。",
                        )
                    }
                }
        }
    }

    private fun mutate(
        successMessage: String,
        afterSuccess: (JSONObject) -> Unit = {},
        afterFailure: (Throwable) -> Unit = {},
        operation: (SessionSnapshot) -> JSONObject,
    ) {
        if (_state.value.busy) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        _state.update { it.copy(busy = true, message = "") }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { operation(expected) } }
                .onSuccess { response ->
                    if (sessions.isCurrent(expected.epoch)) {
                        _state.update { it.copy(busy = false).withInfo(successMessage) }
                        afterSuccess(response)
                        refreshAll()
                    }
                }
                .onFailure { error ->
                    if (sessions.isCurrent(expected.epoch)) {
                        _state.update { it.copy(busy = false, message = error.userMessage()) }
                        afterFailure(error)
                        if (error is ApiError && error.status == 409) refreshAll()
                    }
                }
        }
    }

    private suspend fun load(block: () -> List<JSONObject>): RemoteList = loadRemoteList(block)

    private fun currentSims(): List<ClientSim> = (_state.value.sims as? RemoteList.Loaded)?.items.orEmpty()
        .mapNotNull { runCatching { it.toClientSim() }.getOrNull() }

    private fun currentCalls(): List<JSONObject> = (_state.value.calls as? RemoteList.Loaded)?.items.orEmpty()

    private fun callPreflightRejection(simId: String): LocalActionRejected? {
        val sims = currentSims()
        val sim = sims.singleOrNull { it.id == simId } ?: return LocalActionRejected("所选号码已不可用，请重新选择")
        sim.unavailableReason(forCall = true)?.let { return LocalActionRejected(it) }
        gatewayBusyForSim(sim, currentCalls(), sims)?.let {
            return LocalActionRejected(gatewayBusyMessage(it), transient = true)
        }
        if (localMediaBlocks(null, _state.value.media)) return LocalActionRejected("当前设备已有通话音频，结束后才能拨打另一通电话")
        return null
    }

    private fun smsPreflightReason(simId: String): String? {
        val sim = currentSims().singleOrNull { it.id == simId } ?: return "所选号码已不可用，请重新选择"
        return sim.unavailableReason(forCall = false)
    }

    // ---- S21 §A 通讯录 ----------------------------------------------------------------------

    fun setContactQuery(query: String) {
        if (!_state.value.networkAvailable) return
        if (_state.value.contactQuery == query) return
        _state.update { it.copy(contactQuery = query) }
        refreshContacts(query, debounceMs = CONTACT_SEARCH_DEBOUNCE_MS, preserveSnapshot = false)
    }

    /** Independent from the address book search; epoch guards prevent cross-account results. */
    fun refreshSmsPickerContacts() {
        if (!_state.value.networkAvailable || smsPickerJob?.isActive == true) return
        val expected = sessions.snapshot()
        if (expected.session == null) return
        _state.update { it.copy(smsPickerError = "") }
        smsPickerJob = viewModelScope.launch {
            val result = load {
                val all = mutableListOf<JSONObject>()
                var page: List<JSONObject>
                do {
                    page = clientApi.contacts(limit = ClientApiRoutes.CONTACTS_PAGE_LIMIT, offset = all.size)
                    all.addAll(page)
                } while (page.size == ClientApiRoutes.CONTACTS_PAGE_LIMIT)
                all.distinctBy { it.optString("id") }
            }
            if (sessions.isCurrent(expected.epoch)) {
                _state.update { it.copy(
                    smsPickerContacts = remoteListAfterRefresh(it.smsPickerContacts, result),
                    smsPickerError = if (result is RemoteList.Failed) "联系人刷新失败，可重试或手动输入号码" else "",
                ) }
            }
        }
    }

    fun refreshContacts(
        query: String = _state.value.contactQuery,
        debounceMs: Long = 0,
        preserveSnapshot: Boolean = true,
    ) {
        if (!_state.value.networkAvailable) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        contactsJob?.cancel()
        _state.update {
            it.copy(contacts = if (preserveSnapshot) remoteListDuringRefresh(it.contacts) else RemoteList.Loading)
        }
        contactsJob = viewModelScope.launch {
            if (debounceMs > 0) delay(debounceMs)
            val result = load { clientApi.contacts(query) }
            // A query that changed while the request was in flight has its own job; drop this one.
            if (sessions.isCurrent(expected.epoch) && _state.value.contactQuery == query) {
                _state.update {
                    it.copy(
                        contacts = if (preserveSnapshot) remoteListAfterRefresh(it.contacts, result) else result,
                        contactMessage = if (result is RemoteList.Failed) "联系人刷新失败：${result.message}" else it.contactMessage,
                    )
                }
            }
        }
    }

    fun createContact(
        draft: ContactDraft,
        afterSuccess: () -> Unit = {},
        afterFailure: () -> Unit = {},
    ) {
        if (!draft.valid) {
            _state.update { it.copy(contactMessage = "请填写姓名，并至少留下一个电话或邮箱".asUiError("contact.validate")) }
            afterFailure()
            return
        }
        mutateContact(
            successMessage = "联系人已创建",
            afterSuccess = afterSuccess,
            afterFailure = afterFailure,
        ) { clientApi.createContact(draft) }
    }

    fun openContactDetail(contact: ClientContact) {
        contactDetailRequests.invalidate()
        _state.update { it.copy(contactDetail = contact, contactMessage = "") }
        refreshContactDetail()
    }

    fun closeContactDetail() {
        contactDetailRequests.invalidate()
        contactDetailJob?.cancel()
        contactDetailJob = null
        _state.update { it.copy(contactDetail = null) }
    }

    private fun refreshContactDetail() {
        if (!_state.value.networkAvailable) return
        val current = _state.value.contactDetail ?: return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val token = contactDetailRequests.next(expected.epoch, current.id)
        contactDetailJob?.cancel()
        contactDetailJob = viewModelScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) { clientApi.contact(current.id) }.let { it to it.toClientContact() }
            }
            if (!contactDetailRequests.accepts(token, sessions.snapshot().epoch, _state.value.contactDetail?.id.orEmpty())) {
                return@launch
            }
            result.fold(
                onSuccess = { (freshJson, fresh) ->
                    _state.update { state ->
                        if (state.contactDetail?.id != fresh.id) state
                        else state.copy(
                            contactDetail = fresh,
                            contacts = (state.contacts as? RemoteList.Loaded)?.let { loaded ->
                                RemoteList.Loaded(loaded.items.map { row ->
                                    if (row.optString("id") == fresh.id) freshJson else row
                                })
                            } ?: state.contacts,
                        )
                    }
                },
                onFailure = { error ->
                    if ((error as? ApiError)?.status == 404) {
                        _state.update {
                            it.copy(contactDetail = null, contactMessage = "联系人已在另一端删除")
                        }
                    } else {
                        _state.update { it.copy(contactMessage = "联系人刷新失败：${error.userMessage()}") }
                    }
                },
            )
        }
    }

    fun updateContact(contact: ClientContact, draft: ContactDraft) {
        if (!draft.valid) {
            _state.update { it.copy(contactMessage = "请填写姓名，并至少留下一个电话或邮箱".asUiError("contact.validate")) }
            return
        }
        if (contact.id in _state.value.contactConflicts) {
            _state.update { it.copy(contactMessage = "请先载入最新内容并核对，再保存".asUiError("contact.conflict")) }
            return
        }
        mutateContact("联系人已更新", conflictContactId = contact.id) {
            clientApi.updateContact(contact.id, draft, contact.version)
        }
    }

    fun deleteContact(contact: ClientContact) {
        if (contact.id in _state.value.contactConflicts) {
            _state.update { it.copy(contactMessage = "请先载入最新内容并核对，再删除".asUiError("contact.conflict")) }
            return
        }
        mutateContact(
            successMessage = "联系人已删除",
            conflictContactId = contact.id,
            afterSuccess = ::closeContactDetail,
        ) { clientApi.deleteContact(contact.id, contact.version) }
    }

    fun acceptLatestContactConflict(contactId: String): Boolean {
        val requiredVersion = _state.value.contactConflicts[contactId] ?: return true
        val fresh = _state.value.contactDetail
        if (fresh?.id != contactId || fresh.version < requiredVersion) {
            if (!_state.value.networkAvailable) {
                _state.update { it.copy(contactMessage = "设备未联网，最新联系人尚未加载".asUiError("contact.offline")) }
                return false
            }
            refreshContactDetail()
            _state.update { it.copy(contactMessage = "正在载入最新联系人，请稍候") }
            return false
        }
        _state.update {
            it.copy(
                contactConflicts = it.contactConflicts - contactId,
                contactMessage = "已载入最新内容，请核对后保存",
            )
        }
        return true
    }

    /**
     * "添加到现有联系人" from the contact card. The busy guard is checked here as well as inside
     * [mutateContact], so a tap that sent nothing does not close the card as if it had succeeded.
     */
    fun addNumberToContact(
        contactId: String,
        rawNumber: String,
        afterSuccess: () -> Unit = {},
        afterFailure: () -> Unit = {},
    ) {
        if (_state.value.contactBusy) return
        mutateContact(
            successMessage = "号码已添加到联系人",
            afterSuccess = afterSuccess,
            afterFailure = afterFailure,
        ) { clientApi.addContactPhone(contactId, rawNumber) }
    }

    private fun mutateContact(
        successMessage: String,
        conflictContactId: String? = null,
        afterSuccess: () -> Unit = {},
        afterFailure: () -> Unit = {},
        operation: () -> Unit,
    ) {
        if (_state.value.contactBusy) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        contactsJob?.cancel()
        _state.update { it.copy(contactBusy = true, contactMessage = "") }
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { operation() } }
                .onSuccess {
                    if (sessions.isCurrent(expected.epoch)) {
                        _state.update { it.copy(contactBusy = false, contactMessage = successMessage) }
                        afterSuccess()
                        refreshContacts()
                        if (conflictContactId != null) refreshContactDetail()
                        // Call and SMS rows carry contactName, so they are stale the moment a
                        // contact changes (架构决策 3: the server owns the match, not the client).
                        refreshAll()
                    }
                }
                .onFailure { error ->
                    if (sessions.isCurrent(expected.epoch)) {
                        _state.update {
                            it.copy(
                                contactBusy = false,
                                contactMessage = error.contactMutationUserMessage(),
                                contactConflicts = if (conflictContactId != null && error.isContactVersionConflict()) {
                                    it.contactConflicts + (conflictContactId to error.contactConflictVersion())
                                } else {
                                    it.contactConflicts
                                },
                            )
                        }
                        if (conflictContactId != null && error.isContactVersionConflict()) refreshContactDetail()
                        afterFailure()
                    }
                }
        }
    }

    fun clearContactMessage() = _state.update { it.copy(contactMessage = "") }

    fun dismissContactImport() = _state.update { it.copy(contactImport = ContactImportUiState.Idle) }

    /**
     * Reads the device address book once, then uploads it in ≤ [ContactImport.MAX_BATCH] chunks and
     * adds up the server's counters. READ_CONTACTS is the caller's job; a denial never reaches here.
     */
    fun importDeviceContacts() {
        if (_state.value.contactImport.running) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        _state.update { it.copy(contactImport = ContactImportUiState.Reading, contactMessage = "") }
        viewModelScope.launch {
            val outcome = runCatching {
                val device = withContext(Dispatchers.IO) { ContactsContractReader(getApplication()).read() }
                val entries = ContactImport.entries(device)
                val deviceId = contactSourceDeviceId(getApplication())
                var total = ContactImportResult()
                var uploaded = 0
                _state.update { it.copy(contactImport = ContactImportUiState.Uploading(0, entries.size)) }
                ContactImport.batches(entries).forEach { batch ->
                    if (!sessions.isCurrent(expected.epoch)) throw SessionChangedException()
                    val result = withContext(Dispatchers.IO) {
                        clientApi.importContacts(ContactImport.payload(batch, deviceId))
                    }
                    uploaded += batch.size
                    total += result
                    _state.update {
                        it.copy(contactImport = ContactImportUiState.Uploading(uploaded, entries.size))
                    }
                }
                total
            }
            if (!sessions.isCurrent(expected.epoch)) return@launch
            _state.update { state ->
                state.copy(
                    contactImport = outcome.fold(
                        onSuccess = { ContactImportUiState.Done(it) },
                        onFailure = { ContactImportUiState.Failed(it.userMessage()) },
                    ),
                )
            }
            if (outcome.isSuccess) {
                refreshContacts()
                refreshAll()
            }
        }
    }

    /**
     * The dialer's name hint. Debounced, cancellable, and deliberately silent on failure: a control
     * service without §A answers 404 and the dialer simply shows no name.
     */
    fun lookupDialNumber(number: String) {
        if (!_state.value.networkAvailable) return
        val trimmed = number.trim()
        lookupJob?.cancel()
        if (!shouldLookupNumber(trimmed)) {
            if (_state.value.dialerLookup != DialerLookupState()) {
                _state.update { it.copy(dialerLookup = DialerLookupState()) }
            }
            return
        }
        if (_state.value.dialerLookup.number == trimmed) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        lookupJob = viewModelScope.launch {
            delay(CONTACT_LOOKUP_DEBOUNCE_MS)
            if (!_state.value.networkAvailable) return@launch
            val item = runCatching { withContext(Dispatchers.IO) { clientApi.lookupContact(trimmed) } }.getOrNull()
            if (!sessions.isCurrent(expected.epoch)) return@launch
            val contact = item?.let { json -> runCatching { json.toClientContact() }.getOrNull() }
            _state.update {
                it.copy(dialerLookup = DialerLookupState(trimmed, contact?.id, contact?.displayName))
            }
        }
    }

    // ---- S21 §F 联系人卡片 / §B 黑名单 -------------------------------------------------------

    fun openContactCard(target: ContactCardTarget) {
        target.sourceCallId?.let(::markCallSeen)
        _state.update { it.copy(contactCard = contactCardForOpen(it, target)) }
        refreshOpenContactCard()
    }

    private fun refreshOpenContactCard() {
        if (!_state.value.networkAvailable) return
        val target = _state.value.contactCard?.target ?: return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val token = contactCardRequests.next(expected.epoch, target.number)
        viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.lookupContact(target.number) } }
            val latestNumber = _state.value.contactCard?.target?.number.orEmpty()
            if (!contactCardRequests.accepts(token, sessions.snapshot().epoch, latestNumber)) return@launch
            _state.update { state ->
                val card = state.contactCard
                if (card == null || card.target != target) return@update state
                val loaded: RemoteResource<ClientContact?> = result.fold(
                    onSuccess = { item ->
                        RemoteResource.Loaded(item?.let { runCatching { it.toClientContact() }.getOrNull() })
                    },
                    // Unknown, not "no contact": 新建/添加 stay hidden so an old server cannot be
                    // asked to create a contact it has no table for.
                    onFailure = {
                        if (card.contact is RemoteResource.Loaded) card.contact else RemoteResource.Failed(it.userMessage())
                    },
                )
                val resolved = (loaded as? RemoteResource.Loaded)?.value
                state.copy(
                    contactCard = card.copy(
                        contact = loaded,
                        blocked = resolved?.blocked ?: card.blocked,
                        message = result.exceptionOrNull()?.let { "联系人刷新失败：${it.userMessage()}" }.orEmpty(),
                    ),
                )
            }
        }
    }

    fun closeContactCard() {
        contactCardRequests.invalidate()
        _state.update { it.copy(contactCard = null) }
    }

    /** POST /blocklist or DELETE /blocklist/:id; the card keeps the result so no reload is needed. */
    fun setContactCardBlocked(blocked: Boolean) {
        val card = _state.value.contactCard ?: return
        if (card.busy) return
        if (blocked && !dialableNumber(card.target.number)) return
        val entryId = card.blockedEntryId
        val expected = sessions.snapshot().also { if (it.session == null) return }
        contactCardRequests.invalidate()
        ++blocklistGeneration
        blocklistJob?.cancel()
        _state.update { it.copy(contactCard = it.contactCard?.copy(busy = true, message = "", status = "")) }
        viewModelScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    if (blocked) {
                        clientApi.block(card.target.number, card.target.sourceCallId, ClientApiRoutes.BLOCK_SCOPE_CALL)
                            .optString("id")
                    } else {
                        val resolvedEntryId = entryId
                            ?: blocklistEntryIdForNumber(clientApi.blocklist(ClientApiRoutes.BLOCK_SCOPE_CALL), card.target.number)
                            ?: throw LocalActionRejected("这个号码已在另一端解除屏蔽")
                        clientApi.unblock(resolvedEntryId)
                        ""
                    }
                }
            }
            if (!sessions.isCurrent(expected.epoch)) return@launch
            _state.update { state ->
                val latest = state.contactCard ?: return@update state
                state.copy(
                    contactCard = result.fold(
                        onSuccess = { id ->
                            latest.copy(
                                busy = false,
                                blocked = blocked,
                                blockedEntryId = if (blocked) id.takeIf(String::isNotBlank) else null,
                                status = if (blocked) "已屏蔽该号码" else "已解除屏蔽",
                            )
                        },
                        onFailure = { error -> latest.copy(busy = false, message = error.userMessage()) },
                    ),
                )
            }
            if (result.isSuccess) {
                refreshAll()
                refreshInterceptions()
                loadBlocklist()
            }
        }
    }

    fun loadBlocklist() {
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val generation = ++blocklistGeneration
        blocklistJob?.cancel()
        _state.update {
            it.copy(
                blocklist = if (it.blocklist is RemoteList.Loaded) it.blocklist else RemoteList.Loading,
                smsBlocklist = if (it.smsBlocklist is RemoteList.Loaded) it.smsBlocklist else RemoteList.Loading,
            )
        }
        blocklistJob = viewModelScope.launch {
            // S66: both lists in one pass — Settings shows both counts, the page switches between them.
            val result = load { clientApi.blocklist(ClientApiRoutes.BLOCK_SCOPE_CALL) }
            val smsResult = load { clientApi.blocklist(ClientApiRoutes.BLOCK_SCOPE_SMS) }
            if (!sessions.isCurrent(expected.epoch) || generation != blocklistGeneration) return@launch
            val failure = (result as? RemoteList.Failed) ?: (smsResult as? RemoteList.Failed)
            _state.update {
                it.copy(
                    blocklist = remoteListAfterRefresh(it.blocklist, result),
                    smsBlocklist = remoteListAfterRefresh(it.smsBlocklist, smsResult),
                    blocklistMessage = if (failure != null) {
                        "屏蔽号码刷新失败：${failure.message}"
                    } else if (it.blocklistMessage.startsWith("屏蔽号码刷新失败：")) {
                        ""
                    } else {
                        it.blocklistMessage
                    },
                )
            }
        }
    }

    fun unblockBlocklistEntry(entryId: String) {
        if (entryId.isBlank() || entryId in _state.value.blocklistPending) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        ++blocklistGeneration
        blocklistJob?.cancel()
        _state.update { it.copy(blocklistPending = it.blocklistPending + entryId, blocklistMessage = "") }
        viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.unblock(entryId) } }
            if (!sessions.isCurrent(expected.epoch)) return@launch
            _state.update { state ->
                val cleared = state.copy(blocklistPending = state.blocklistPending - entryId)
                result.fold(
                    onSuccess = { cleared.copy(blocklistMessage = "已解除屏蔽") },
                    onFailure = { cleared.copy(blocklistMessage = it.userMessage()) },
                )
            }
            if (result.isSuccess) {
                loadBlocklist()
                refreshInterceptions()
                refreshContacts()
            }
        }
    }

    fun clearBlocklistMessage() = _state.update { it.copy(blocklistMessage = "") }

    /** 屏蔽 / 解除屏蔽之后重读拦截记录：停在用户当前那一页，不会被拉回第 1 页。 */
    fun refreshInterceptions() = loadInterceptionsPage()

    fun setInterceptionsPage(page: Int) = loadInterceptionsPage(page = page)

    fun setInterceptionsPageSize(pageSize: Int) = loadInterceptionsPage(page = 1, pageSize = pageSize)

    fun loadInterceptionsPage(
        page: Int = _state.value.interceptionsPageNum,
        pageSize: Int = _state.value.interceptionsPageSize,
    ) {
        if (!_state.value.networkAvailable) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val size = RecordsPagingPolicy.clampPageSize(pageSize)
        val previous = _state.value
        val wanted = page.coerceAtLeast(1)
        val sameRequest = wanted == previous.interceptionsPageNum && size == previous.interceptionsPageSize
        val token = interceptionsRequests.next(expected.epoch, interceptionsRequestKey(size, wanted))
        interceptionsJob?.cancel()
        _state.update {
            it.copy(
                interceptionsPageNum = wanted,
                interceptionsPageSize = size,
                interceptionsPage = pageStateDuringLoad(it.interceptionsPage, sameRequest),
            )
        }
        interceptionsJob = viewModelScope.launch {
            val result: RemoteResource<Page<JSONObject>> = runCatching {
                withContext(Dispatchers.IO) { clientApi.interceptionsPage(wanted, size) }
            }.fold(
                onSuccess = { RemoteResource.Loaded(it) },
                onFailure = { RemoteResource.Failed(it.userMessage()) },
            )
            val current = _state.value
            val currentKey = interceptionsRequestKey(current.interceptionsPageSize, current.interceptionsPageNum)
            if (!interceptionsRequests.accepts(token, sessions.snapshot().epoch, currentKey)) return@launch
            _state.update { clientStateWithInterceptionsPage(it, result) }
            (result as? RemoteResource.Loaded)?.value?.let(RecordsPagingPolicy::rewindPage)
                ?.let { last -> loadInterceptionsPage(page = last) }
        }
    }

    private fun interceptionsRequestKey(pageSize: Int, page: Int): String = "$pageSize|$page"

    // ---- S21 §E AI 对话 ---------------------------------------------------------------------

    fun loadAiTranscript(callId: String) {
        if (callId.isBlank() || !_state.value.networkAvailable) return
        val current = _state.value.aiTranscripts[callId]
        if (current is RemoteResource.Loading || current is RemoteResource.Loaded) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        _state.update { it.copy(aiTranscripts = it.aiTranscripts + (callId to RemoteResource.Loading)) }
        viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.aiTranscript(callId) } }
            if (!sessions.isCurrent(expected.epoch)) return@launch
            _state.update { state ->
                state.copy(
                    aiTranscripts = state.aiTranscripts + (callId to result.fold(
                        onSuccess = { items ->
                            RemoteResource.Loaded(
                                items.map { it.toAiTranscriptSegment() }.filter { it.text.isNotBlank() },
                            )
                        },
                        // 404 from a control service without §E reads as "this call had no AI leg".
                        onFailure = { RemoteResource.Loaded(emptyList()) },
                    )),
                )
            }
        }
    }

    // ---- S21 §D 远程开关 --------------------------------------------------------------------

    fun startGatewayPowerRefresh() {
        // 页面回到前台时，还没确认的 SIM 接着等（startedAt 不变，30 秒上限也不变），
        // 否则离开过一次的卡片会永远停在「正在应用中…」。
        if (settingsApplyEpoch != null && _state.value.settingsApply.values.any { it is SettingsApplyState.Applying }) {
            settingsApplyWatch.resume()
        }
    }

    fun stopGatewayPowerRefresh() {
        settingsApplyWatch.stop()
    }

    private fun refreshGatewayPower() {
        // While a POST is unresolved, its eventual accepted item owns this section. The POST starts
        // the next GET after applying that item.
        if (_state.value.gatewayPowerPending.isNotEmpty()) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        if (gatewayPowerJob?.isActive == true) return
        val token = gatewayPowerRequests.next(expected.epoch, "list")
        gatewayPowerJob = viewModelScope.launch {
            val result = load { clientApi.gatewayPowers() }
            val currentEpoch = sessions.snapshot().epoch
            if (gatewayPowerRequests.accepts(token, currentEpoch, "list")) {
                _state.update {
                    val visible = visibleRemoteListAfterRefresh(it.gatewayPower, result)
                    it.copy(
                        gatewayPower = visible.value,
                        gatewayPowerRefreshError = visible.error,
                    )
                }
            }
        }
    }

    fun retrySettingsSims() = refreshSimsOnly()

    fun retryGatewayPower() = refreshGatewayPower()

    /** Refreshes every remote Settings section without cancelling a request already in flight. */
    fun refreshSettings() {
        refreshAll()
        refreshGatewayPower()
        loadVoiceProviders()
        loadBlocklist()
        loadPasskeys()
        refreshBackgroundCalling()
    }

    fun setGatewayPower(gatewayId: String, on: Boolean) {
        val current = _state.value
        if (
            gatewayId.isBlank() ||
            gatewayId in current.gatewayPowerPending ||
            gatewayPowerHasPendingIntent(current.gatewayPower, gatewayId)
        ) return
        val expected = sessions.snapshot().also { if (it.session == null) return }
        gatewayPowerRequests.invalidate()
        gatewayPowerJob?.cancel()
        gatewayPowerJob = null
        _state.update {
            it.copy(gatewayPowerPending = it.gatewayPowerPending + gatewayId, gatewayPowerMessage = "")
        }
        viewModelScope.launch {
            val desired = if (on) "on" else "off"
            runCatching { withContext(Dispatchers.IO) { clientApi.setGatewayPower(gatewayId, desired) } }
                .onSuccess { acceptedItem ->
                    if (sessions.isCurrent(expected.epoch)) {
                        // Invalidate again on acceptance: a GET may have passed the pending check in
                        // the same scheduling turn in which the POST began.
                        gatewayPowerRequests.invalidate()
                        gatewayPowerJob?.cancel()
                        gatewayPowerJob = null
                        _state.update {
                            it.copy(
                                gatewayPower = gatewayPowerAfterAcceptedItem(it.gatewayPower, acceptedItem),
                                gatewayPowerPending = it.gatewayPowerPending - gatewayId,
                                gatewayPowerMessage = if (on) "已请求开启，等待网关上线" else "已请求关闭",
                                gatewayPowerRefreshError = "",
                            )
                        }
                        refreshGatewayPower()
                    }
                }
                .onFailure { error ->
                    if (sessions.isCurrent(expected.epoch)) {
                        gatewayPowerRequests.invalidate()
                        gatewayPowerJob?.cancel()
                        gatewayPowerJob = null
                        _state.update {
                            it.copy(
                                gatewayPowerPending = it.gatewayPowerPending - gatewayId,
                                gatewayPowerMessage = error.gatewayPowerUserMessage(),
                            )
                        }
                        refreshGatewayPower()
                    }
                }
        }
    }

    fun clearGatewayPowerMessage() = _state.update { it.copy(gatewayPowerMessage = "") }

    // ---- S24 决策 3 AI 语音服务 ---------------------------------------------------------------

    /** Settings foreground ticks keep one request in flight instead of cancelling it every 5 s. */
    fun loadVoiceProviders() {
        val expected = sessions.snapshot().also { if (it.session == null) return }
        if (_state.value.voiceProviderPending.isNotEmpty()) return
        if (voiceProviderJob?.isActive == true) return
        val generation = ++voiceProviderGeneration
        _state.update {
            it.copy(voiceProviders = if (it.voiceProviders is RemoteResource.Loaded) it.voiceProviders else RemoteResource.Loading)
        }
        voiceProviderJob = viewModelScope.launch {
            val result = runCatching { withContext(Dispatchers.IO) { clientApi.voiceProviders() } }
            if (!sessions.isCurrent(expected.epoch) || generation != voiceProviderGeneration) return@launch
            val notFound = (result.exceptionOrNull() as? ApiError)?.status == 404
            _state.update { state ->
                val updated: RemoteResource<ClientVoiceProviderList> = result.fold(
                    onSuccess = { RemoteResource.Loaded(it) },
                    onFailure = {
                        if (notFound) RemoteResource.Loaded(ClientVoiceProviderList(emptyList(), ""))
                        else RemoteResource.Failed(it.userMessage())
                    },
                )
                state.copy(
                    voiceProviderUnavailable = notFound,
                    voiceProviders = remoteResourceAfterRefresh(state.voiceProviders, updated),
                    voiceProviderMessage = if (result.isFailure && !notFound) {
                        "语音服务刷新失败：${result.exceptionOrNull()?.userMessage()}"
                    } else if (state.voiceProviderMessage.startsWith("语音服务刷新失败：")) {
                        ""
                    } else {
                        state.voiceProviderMessage
                    },
                )
            }
        }
    }

    /** 携带 GET 快照版本提交；冲突时保留用户选择并重读服务器值，不自动用新版本重发旧选择。 */
    fun selectVoiceProvider(providerId: String) {
        val id = providerId.trim()
        if (id.isEmpty() || _state.value.voiceProviderPending.isNotEmpty() || _state.value.voiceProviderConflict) return
        val loaded = (_state.value.voiceProviders as? RemoteResource.Loaded)?.value ?: return
        val provider = loaded.items.firstOrNull { it.id == id } ?: return
        if (!voiceProviderShouldSubmit(provider, loaded.selected)) {
            _state.update { it.copy(voiceProviderReview = null) }
            return
        }
        val expected = sessions.snapshot().also { if (it.session == null) return }
        val generation = ++voiceProviderGeneration
        _state.update {
            it.copy(
                voiceProviderPending = id,
                voiceProviderMessage = "",
                voiceProviderReview = id,
            )
        }
        viewModelScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) { clientApi.setVoiceProvider(id, loaded.configVersion) }
            }
            if (!sessions.isCurrent(expected.epoch) || generation != voiceProviderGeneration) return@launch
            _state.update { state ->
                result.fold(
                    onSuccess = {
                        state.copy(
                            voiceProviderPending = "",
                            voiceProviderReview = null,
                            voiceProviderConflict = false,
                            voiceProviderConflictVersion = null,
                            voiceProviders = RemoteResource.Loaded(it),
                        )
                    },
                    onFailure = { error ->
                        state.copy(
                            voiceProviderPending = "",
                            voiceProviderMessage = error.voiceProviderUserMessage(),
                            voiceProviderReview = id,
                            voiceProviderConflict = error.isVoiceProviderVersionConflict(),
                            voiceProviderConflictVersion = error.voiceProviderConflictVersion()
                                ?: if (error.isVoiceProviderVersionConflict()) loaded.configVersion + 1L else null,
                        )
                    },
                )
            }
            if (result.isFailure) loadVoiceProviders()
        }
    }

    fun clearVoiceProviderMessage() = _state.update { it.copy(voiceProviderMessage = "") }

    fun discardVoiceProviderConflict() {
        val state = _state.value
        val required = state.voiceProviderConflictVersion ?: 1L
        val loaded = (state.voiceProviders as? RemoteResource.Loaded)?.value
        if (loaded == null || loaded.configVersion < required) {
            _state.update { it.copy(voiceProviderMessage = "正在载入服务器最新设置，请稍候") }
            loadVoiceProviders()
            return
        }
        _state.update {
            it.copy(
                voiceProviderReview = null,
                voiceProviderConflict = false,
                voiceProviderConflictVersion = null,
                voiceProviderMessage = "已载入服务器最新设置，请重新选择",
            )
        }
    }

    // ---- S21 §F 跨页导航 --------------------------------------------------------------------

    /**
     * S36 C5-b: 拨打 from a record/contact carries the record's SIM (when it has one) and asks the
     * dialer to confirm and dial, instead of only filling the number in.
     */
    fun requestDial(number: String, simId: String? = null) =
        requestNavigation(ClientNavigationTarget.DIAL, number, simId, confirm = true)

    fun requestSms(number: String) = requestNavigation(ClientNavigationTarget.SMS, number)

    private fun requestNavigation(
        target: ClientNavigationTarget,
        number: String,
        simId: String? = null,
        confirm: Boolean = false,
    ) {
        val trimmed = number.trim()
        if (trimmed.isEmpty()) return
        _state.update {
            it.copy(
                contactCard = null,
                navigation = ClientNavigationRequest(target, trimmed, System.nanoTime(), simId, confirm),
            )
        }
    }

    fun consumeNavigation() = _state.update { it.copy(navigation = null) }

    override fun onCleared() {
        connectivity.unregisterNetworkCallback(networkCallback)
        foregroundRefresh.stop()
        settingsApplyWatch.stop()
        sessionListener.close()
        livenessListener.close()
        super.onCleared()
    }

}

private class LocalActionRejected(message: String, val transient: Boolean = false) : IllegalStateException(message)

internal fun gatewayBusyMessage(call: JSONObject): String = "这台网关设备正在${callOccupancyLabel(call)}，请等待结束"

internal fun callOccupancyLabel(call: JSONObject): String {
    // Android 的 optString(key, fallback) 对 JSON null 会返回字符串 "null"，不会退回 fallback，
    // 所以手机直拨（answeredByPlatform 为 null）必须显式过滤，否则永远读不到 originatingPlatform。
    val platform = when (callPlatformField(call)) {
        "ios" -> "iPhone 端通话"
        "android" -> "Android 端通话"
        "macos" -> "Mac 端通话"
        "web" -> "网页端通话"
        "ai" -> "AI 接听"
        "device" -> "网关本机通话"
        "pixel" -> call.gatewayKind().occupiedLabel
        else -> "处理另一通电话"
    }
    return platform
}

internal fun callOwnerLabel(call: JSONObject): String? {
    call.optString("answeredByDevice").takeIf(String::isNotBlank)?.let { return it }
    return occupancyPlatformLabel(callPlatformField(call), call.gatewayKind())
}

/** 接听方 first, 发起方 second — with JSON null spelled out, see [callOccupancyLabel]. */
private fun callPlatformField(call: JSONObject): String =
    call.optString("answeredByPlatform").takeIf { it.isNotBlank() && it != "null" }
        ?: call.optString("originatingPlatform")

/** The single platform→中文 map behind [callOwnerLabel] and the S20 D6 occupancy notice. */
internal fun occupancyPlatformLabel(platform: String?, kind: GatewayKind = GatewayKind.PIXEL): String? = when (platform) {
    "ios" -> "iPhone 端"
    "android" -> "Android 端"
    "macos" -> "Mac 端"
    "web" -> "网页端"
    "ai" -> "AI 接听"
    "device" -> "网关本机"
    "pixel" -> "${kind.deviceName}端"
    else -> null
}

internal fun primaryOwnedCall(calls: List<JSONObject>, mediaCallId: String?): JSONObject? {
    val active = calls.filter { it.optString("state") !in setOf("ended", "failed") }
    mediaCallId?.let { id ->
        active.firstOrNull { it.optString("id") == id && it.optBoolean("claimedByCurrentSession") }?.let { return it }
    }
    return active.firstOrNull {
        it.optBoolean("claimedByCurrentSession") &&
            it.optString("state") in setOf("outgoing_pending", "connecting", "active", "ending", "unknown")
    }
}

internal fun endingCallIdsAfterRefresh(pending: Set<String>, calls: RemoteList): Set<String> {
    if (calls !is RemoteList.Loaded) return pending
    val stillPending = calls.items.asSequence()
        .filter { it.optString("state") !in setOf("ended", "failed") }
        .map { it.optString("id") }
        .toSet()
    return pending intersect stillPending
}

/** 诊断里只留错误码/类名，绝不把面向用户的中文长句塞进日志字段。 */
internal fun Throwable.diagReason(): String =
    (this as? ApiError)?.code ?: this::class.java.simpleName

/**
 * S69：这是把异常变成用户可见提示的统一出口，顺手记 `ui.error_shown`（ClientDiag 内同 screen+message
 * 60 秒合并）。协程取消不是用户可见的失败，不记。
 */
internal fun Throwable.userMessage(site: String = "vm"): String = userMessageText().also { text ->
    if (this !is kotlinx.coroutines.CancellationException && this !is SessionChangedException) {
        ClientDiag.uiErrorShown(site, text, (this as? ApiError)?.code ?: javaClass.simpleName)
    }
}

/** S69：不经异常转换的本地/校验错误提示（如「请输入对方号码」）在赋值处调用，同样记 `ui.error_shown`。 */
internal fun String.asUiError(site: String, code: String? = null): String = also { ClientDiag.uiErrorShown(site, it, code) }

private fun Throwable.userMessageText(): String = when (this) {
    is LocalActionRejected -> message ?: "当前状态已变化，请重试"
    is PasskeyCredentialException -> message ?: "通行密钥操作失败"
    // The eight shared media codes read the same here as in the media session, so a dial-time
    // 503 and a handshake 503 never tell the user two different stories.
    is ApiError -> CallMediaFailureMessagePolicy.knownCodeMessage(code) ?: when (code) {
        "GATEWAY_BUSY" -> "网关正被另一通蜂窝通话占用"
        "ALREADY_CLAIMED" -> "来电已被其他端接听，状态已刷新"
        // S72 E 错误码。
        "SAME_DEVICE_INTERNAL" -> "同一设备上的两张卡不能互打"
        "OWN_OUTGOING_CALL" -> "这是你正在拨出的通话"
        // S30 §1.1 的 409：通话还没走完（还在打、还在归档录音、还在转写），删除要等它落地。
        "CALL_IN_USE" -> "通话仍在进行或处理中，稍后再删"
        else -> message
    }
    // S95b §C: English exception text (`Unable to resolve host…`, class names) never reaches the user.
    else -> message?.takeIf { Regex("\\p{IsHan}").containsMatchIn(it) }
        ?: if (this is java.io.IOException) "网络连接失败，请稍后重试" else "操作失败，请稍后重试"
}

/**
 * S21 §D — the four 409 refusals get their own Chinese wording; everything else keeps the shared
 * [userMessage] text so a network failure reads the same here as anywhere else in the app.
 */
internal fun Throwable.gatewayPowerUserMessage(): String =
    if (this is ApiError) gatewayPowerErrorMessage(code, userMessage()) else userMessage()

/** S24 决策 3: the server's own `message` first, the `PROVIDER_UNAVAILABLE` wording only as a fallback. */
internal fun Throwable.voiceProviderUserMessage(): String =
    if (this is ApiError && code in setOf("PROVIDER_VERSION_CONFLICT", "PROVIDER_VERSION_REQUIRED")) {
        "设置已被另一端更新，请核对后重试".asUiError("settings.voiceProvider", code)
    } else if (this is ApiError) {
        voiceProviderErrorMessage(code, message).asUiError("settings.voiceProvider", code)
    } else {
        voiceProviderErrorMessage("", userMessage())
    }

internal fun Throwable.isContactVersionConflict(): Boolean =
    this is ApiError && code in setOf("CONTACT_VERSION_CONFLICT", "CONTACT_VERSION_REQUIRED")

internal fun Throwable.contactConflictVersion(): Long =
    (this as? ApiError)?.details?.optLong("currentVersion", 1L)?.coerceAtLeast(1L) ?: 1L

internal fun Throwable.isVoiceProviderVersionConflict(): Boolean =
    this is ApiError && code in setOf("PROVIDER_VERSION_CONFLICT", "PROVIDER_VERSION_REQUIRED")

internal fun Throwable.voiceProviderConflictVersion(): Long? =
    if (isVoiceProviderVersionConflict()) {
        (this as? ApiError)?.details?.optLong("currentVersion")?.takeIf { it > 0 }
    } else {
        null
    }

internal fun Throwable.contactMutationUserMessage(): String =
    if (isContactVersionConflict()) "联系人已在另一端更新，请核对当前内容后重试".asUiError("contact.conflict", (this as ApiError).code) else userMessage()

internal fun Throwable.isSimVersionConflict(): Boolean =
    this is ApiError && status in setOf(409, 428) && code in setOf("VERSION_CONFLICT", "VERSION_REQUIRED")

internal fun Throwable.simConflictVersion(expectedVersion: Long): Long =
    (this as? ApiError)?.details?.optLong("currentVersion")?.takeIf { it > expectedVersion }
        ?: (expectedVersion + 1)

internal fun blocklistEntryIdForNumber(items: List<JSONObject>, number: String): String? {
    val target = number.filter(Char::isDigit)
    return items.firstOrNull { row ->
        val candidate = row.optString("remoteNumber")
        candidate == number || (target.isNotEmpty() && candidate.filter(Char::isDigit) == target)
    }?.optString("id")?.takeIf(String::isNotBlank)
}

internal fun Throwable.reportUserMessage(): String = when (this) {
    is ApiError -> when (code) {
        "PIXEL_ARCHIVE_DISABLED" -> PIXEL_ARCHIVE_DISABLED_MESSAGE
        else -> userMessage()
    }
    else -> "返回内容暂时无法读取，请稍后重试".also {
        if (this !is kotlinx.coroutines.CancellationException) ClientDiag.uiErrorShown("report", it, javaClass.simpleName)
    }
}

internal const val PIXEL_ARCHIVE_DISABLED_MESSAGE = "设备原始归档尚未开启。你仍可切换到“服务器录音”播放已保存的录音。"
