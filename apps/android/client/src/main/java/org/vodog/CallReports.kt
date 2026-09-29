package org.vodog

import org.json.JSONObject
import java.math.BigDecimal
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt

enum class ReportPeriod(val wireValue: String, val label: String) {
    DAYS_7("7d", "7天"), MONTH_1("1m", "1月"), MONTHS_6("6m", "6月"), YEAR_1("1y", "1年");
}

/**
 * S22 决策 10 报告 Tab 的日期控件: 三个预设加一个自定义起止。The presets are resolved against the
 * gateway's own calendar day (not the phone's), so a report taken at 00:30 local time in a different
 * zone still means "today" on the line that produced the calls.
 */
enum class ReportRangePreset(val label: String) {
    TODAY("今天"), DAYS_7("7 天"), DAYS_30("30 天"), CUSTOM("自定义");
}

/** Inclusive calendar-day range; the server turns it into `from`/`to` wall-clock bounds in [ReportWindow.timeZone]. */
data class ReportDateRange(val from: LocalDate, val to: LocalDate) {
    val fromWire: String get() = from.format(DateTimeFormatter.ISO_LOCAL_DATE)
    val toWire: String get() = to.format(DateTimeFormatter.ISO_LOCAL_DATE)
    val label: String get() = if (from == to) fromWire else "$fromWire 至 $toWire"
}

/** `null` for [ReportRangePreset.CUSTOM]: the caller keeps whatever the date picker produced. */
internal fun reportRangeFor(preset: ReportRangePreset, today: LocalDate): ReportDateRange? = when (preset) {
    ReportRangePreset.TODAY -> ReportDateRange(today, today)
    ReportRangePreset.DAYS_7 -> ReportDateRange(today.minusDays(6), today)
    ReportRangePreset.DAYS_30 -> ReportDateRange(today.minusDays(29), today)
    ReportRangePreset.CUSTOM -> null
}

/** The calendar day the report window is anchored on, read in the gateway's zone. */
internal fun reportToday(timeZone: String?, now: Instant = Instant.now()): LocalDate =
    now.atZone(resolveGatewayZoneId(timeZone)).toLocalDate()

/**
 * `DateRangePicker` hands back UTC midnight for the day the user tapped, so the day has to be read
 * back in UTC — reading it in the phone's zone moves the boundary a day east of Greenwich.
 */
internal fun reportDateFromPickerMillis(millis: Long): LocalDate =
    Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()

internal fun reportPickerMillis(date: LocalDate): Long =
    date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()

enum class OriginalTranscriptTrack(val wireValue: String, val label: String) {
    REMOTE_ORIGINAL("remote_original", "对方原声"),
    CALLER_ORIGINAL("caller_original", "我的原声");

    companion object {
        fun parse(value: String) = entries.singleOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("unknown transcript track")
    }
}

enum class RecordingAudioTrack(val wireValue: String, val label: String) {
    REMOTE_ORIGINAL("remote_original", "对方原声"),
    CALLER_ORIGINAL("caller_original", "我的原声"),
    CALLER_PLAYOUT("caller_playout", "通话播放声（含补偿）"),

    /** S36 C4: 服务器按时间轴混好的双人对话，只有 MP3 导出一条路，清单里没有对应 artifact。 */
    CONVERSATION("conversation", "对话混音");
}

internal fun OriginalTranscriptTrack.recordingAudioTrack(): RecordingAudioTrack = when (this) {
    OriginalTranscriptTrack.REMOTE_ORIGINAL -> RecordingAudioTrack.REMOTE_ORIGINAL
    OriginalTranscriptTrack.CALLER_ORIGINAL -> RecordingAudioTrack.CALLER_ORIGINAL
}

/**
 * `period` is nullable since S22: an explicit `from`/`to` window has no preset to report back, and a
 * control service that still answers with one is accepted unchanged.
 */
data class ReportWindow(
    val period: ReportPeriod?,
    val timeZone: String,
    val fromInclusive: String,
    val toExclusive: String,
)
data class ReportSim(val id: String, val label: String, val slotIndex: Int)

/**
 * One row of the 报告 tab. Everything S22 added is optional with a conservative default, so the same
 * build renders against a control service that predates 决策 10 (no classification, no transcript
 * state) without throwing: `blockRecommended = null` means 未分类, not "safe".
 */
data class CallReportItem(
    val callId: String,
    val startedAt: String,
    val direction: String,
    val remoteNumber: String,
    val sim: ReportSim,
    val summary: String?,
    val actionItems: List<String>,
    val advertisingClassification: String,
    val recordingStatus: String,
    val callUrl: String,
    val transcriptUrl: String,
    val recordingUrl: String,
    val transcriptCompletedAt: String,
    val answeredAt: String? = null,
    val endedAt: String? = null,
    val gatewayTimeZone: String? = null,
    val contactName: String? = null,
    val contactId: String? = null,
    val blocked: Boolean = false,
    val blockedEntryId: String? = null,
    val answerMode: String? = null,
    val answeredByPlatform: String? = null,
    val transcriptState: String = TRANSCRIPT_STATE_NONE,
    val transcriptErrorCode: String? = null,
    val classification: String? = null,
    val blockRecommended: Boolean? = null,
    val blockCategory: String? = null,
    val blockReason: String? = null,
    val hasAiTranscript: Boolean = false,
    val aiTranscriptUrl: String = "",
    val gatewayKind: GatewayKind = GatewayKind.PIXEL,
    val originatingPlatform: String? = null,
    /** S67c: Control's `unseen` (missing on old Control = false). */
    val unseen: Boolean = false,
    /** S72: 同一 owner 的托管卡互打；旧 Control 不发 = false。 */
    val internal: Boolean = false,
    val peerSimId: String? = null,
    val peerSimLabel: String? = null,
) {
    /** S72 E: 「内部通话 A → B」，非内部为 null。 */
    val internalTitle: String?
        get() = internalCallTitle(internal, direction, sim.label, peerSimLabel)

    /** 设备上直拨的通话没有服务器录音，只有设备原始归档（`source=pixel`），默认直接打开它。 */
    val defaultRecordingSource: RecordingSource
        get() = if (originatingPlatform == "pixel") RecordingSource.PIXEL else RecordingSource.MEDIA_NODE
}

internal const val TRANSCRIPT_STATE_NONE = "none"

/** 接听方式 for the report card's second line (spec 客户端合同: AI 接听 / 超时 AI / 真人 / 未接). */
internal fun reportAnswerModeLabel(
    answerMode: String?,
    answeredByPlatform: String?,
    answeredAt: String?,
    internal: Boolean = false,
): String = when {
    answeredByPlatform == "ai" && answerMode == "timeout_ai" -> "超时 AI"
    answeredByPlatform == "ai" -> "AI 接听"
    answeredByPlatform == "device" -> "网关本机"
    !answeredAt.isNullOrBlank() && answeredAt != "null" -> "真人"
    // S72 B6: 内部通话不算未接。
    internal -> "无人接听"
    answerMode == "timeout_ai" -> "未接"
    else -> "未接"
}

/**
 * The summary slot when there is no transcript to show. `null` means "render the real summary";
 * every other state gets one sentence that says what the user can still do (S22 决策 6/10).
 */
internal fun reportSummaryPlaceholder(transcriptState: String): String? = when (transcriptState) {
    "succeeded" -> null
    "queued", "running", "retry" -> "转录处理中…"
    "failed" -> "转录失败，原始录音仍可查看"
    else -> "无转录：录音为空"
}

/** 未分类 caption: the classifier never ran on this row (historical rows keep `blockRecommended = null`). */
internal fun reportClassificationUnknown(item: CallReportItem): Boolean = item.blockRecommended == null
/**
 * 报告页的一页。S28 之后它带上了分页信封 [paging]；不带 `page` 的旧请求（和旧 Control）落在
 * [Page.unpaged] 上，`items` 的读法一个字都没变。
 */
data class CallReportPage(val window: ReportWindow, val paging: Page<CallReportItem>) {
    constructor(window: ReportWindow, items: List<CallReportItem>) : this(window, Page.unpaged(items))

    val items: List<CallReportItem> get() = paging.items
}

data class TranscriptSegment(
    val track: OriginalTranscriptTrack,
    val speaker: String,
    val text: String,
    val startMs: Double?,
    val endMs: Double?,
)
data class TranscriptProvider(
    val track: OriginalTranscriptTrack,
    val provider: String,
    val model: String?,
    val version: String?,
)

/**
 * One readable transcript block. Transcripts used to store one segment per spoken word, so history showed a
 * vertically stacked line per word with a per-word timestamp. Display merges consecutive segments of the same
 * track and speaker into running text; stored segments are never rewritten.
 */
data class TranscriptBlock(
    val track: OriginalTranscriptTrack,
    val speaker: String,
    val text: String,
    val startMs: Double?,
)

private val transcriptNoSpaceBefore = Regex("^[\\s,.;:!?%)}\\]、。，！？；：]")
private val transcriptNoSpaceAfter = Regex("[\\s({\\[“「『、。，！？；：]$")
private val transcriptCjkEnd = Regex("[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}]$")
private val transcriptCjkStart = Regex("^[\\p{IsHan}\\p{IsHiragana}\\p{IsKatakana}]")

/** Joins transcript fragments with the same spacing rules the server uses for word annotations. */
internal fun joinTranscriptText(parts: List<String>): String = parts.fold("") { text, part ->
    val word = part.trim()
    when {
        word.isEmpty() -> text
        text.isEmpty() -> word
        transcriptNoSpaceBefore.containsMatchIn(word) ||
            transcriptNoSpaceAfter.containsMatchIn(text) ||
            (transcriptCjkEnd.containsMatchIn(text) && transcriptCjkStart.containsMatchIn(word)) -> text + word
        else -> "$text $word"
    }
}

/** Merges consecutive segments of the same track and speaker into one block, dropping per-word timing. */
internal fun mergeTranscriptSegments(segments: List<TranscriptSegment>): List<TranscriptBlock> {
    val blocks = mutableListOf<TranscriptBlock>()
    for (segment in segments) {
        val text = segment.text.trim()
        if (text.isEmpty()) continue
        val last = blocks.lastOrNull()
        if (last != null && last.track == segment.track && last.speaker == segment.speaker) {
            blocks[blocks.lastIndex] = last.copy(text = joinTranscriptText(listOf(last.text, text)))
        } else {
            blocks += TranscriptBlock(segment.track, segment.speaker, text, segment.startMs)
        }
    }
    return blocks
}
data class TranscriptResult(
    val text: String,
    val segments: List<TranscriptSegment>,
    val providers: List<TranscriptProvider>,
    val advertisingClassification: String,
    val includeInReports: Boolean,
    val summary: String?,
    val actionItems: List<String>,
)
data class CallTranscript(
    val id: String,
    val callId: String,
    val status: String,
    val attempts: Int,
    val nextAttemptAt: String?,
    val errorCode: String?,
    val errorMessage: String?,
    val result: TranscriptResult?,
    val createdAt: String,
    val updatedAt: String,
    val completedAt: String?,
)

enum class RecordingSource(val wireValue: String, val label: String) {
    MEDIA_NODE("media_node", "服务器录音"),
    PIXEL("pixel", "Pixel 原始归档");

    /** S58: 只有设备原始归档随网关类型换说法，wire 值恒为 `pixel`。 */
    fun label(kind: GatewayKind): String = if (this == PIXEL) kind.archiveLabel else label
}

data class RecordingArtifact(
    val track: RecordingAudioTrack,
    val mediaType: String,
    val bytes: Long,
    val sha256: String,
    val captureComplete: Boolean?,
    val gapCount: Long,
    val droppedFrames: Long,
    val sourceRole: String = if (track == RecordingAudioTrack.CALLER_PLAYOUT) "derived_playout" else "original_capture",
    val playoutComplete: Boolean? = null,
    val recoveryFrames: Long = 0,
    val durationMs: Long? = null,
) {
    constructor(
        track: OriginalTranscriptTrack,
        mediaType: String,
        bytes: Long,
        sha256: String,
        captureComplete: Boolean?,
        gapCount: Long,
        droppedFrames: Long,
    ) : this(track.recordingAudioTrack(), mediaType, bytes, sha256, captureComplete, gapCount, droppedFrames)
}
data class RecordingManifest(
    val source: RecordingSource,
    val version: Int,
    val archiveId: String?,
    val callId: String,
    val finalizedAt: String,
    val archiveComplete: Boolean,
    val captureComplete: Boolean?,
    val artifacts: List<RecordingArtifact>,
    val derivedArtifacts: List<RecordingArtifact> = emptyList(),
) {
    fun artifact(track: OriginalTranscriptTrack) = artifact(track.recordingAudioTrack())
    fun artifact(track: RecordingAudioTrack) = (artifacts + derivedArtifacts).singleOrNull { it.track == track }

    fun pairArtifacts(mode: RecordingPairMode): List<RecordingArtifact> {
        val requestedTracks = when (mode) {
            RecordingPairMode.ORIGINALS -> listOf(RecordingAudioTrack.REMOTE_ORIGINAL, RecordingAudioTrack.CALLER_ORIGINAL)
            RecordingPairMode.COMPENSATED -> {
                if (source != RecordingSource.PIXEL || version != 3) return emptyList()
                listOf(RecordingAudioTrack.REMOTE_ORIGINAL, RecordingAudioTrack.CALLER_PLAYOUT)
            }
        }
        return requestedTracks.map { artifact(it) ?: return emptyList() }.takeIf { selected ->
            selected.all { it.bytes > 0 } &&
                selected[0].sourceRole == "original_capture" &&
                selected[1].sourceRole == if (mode == RecordingPairMode.ORIGINALS) "original_capture" else "derived_playout"
        }.orEmpty()
    }

    fun pairDurationMs(mode: RecordingPairMode): Long? =
        pairArtifacts(mode).mapNotNull { it.durationMs }.maxOrNull()
}

sealed interface RemoteResource<out T> {
    data object NotLoaded : RemoteResource<Nothing>
    data object Loading : RemoteResource<Nothing>
    data class Loaded<T>(val value: T) : RemoteResource<T>
    data class Failed(val message: String) : RemoteResource<Nothing>
}

enum class HistoryViewerKind { TRANSCRIPT, RECORDING }

data class CallDetailUiState(
    val item: CallReportItem,
    val viewer: HistoryViewerKind,
    val transcript: RemoteResource<CallTranscript?> = RemoteResource.NotLoaded,
    val recordings: Map<RecordingSource, RemoteResource<RecordingManifest?>> =
        RecordingSource.entries.associateWith { RemoteResource.NotLoaded },
    val selectedRecordingSource: RecordingSource = RecordingSource.MEDIA_NODE,
)

internal data class AsyncRequestToken(val sessionEpoch: Long, val serial: Long, val key: String)
internal class AsyncRequestGuard {
    private val serial = AtomicLong()
    fun next(sessionEpoch: Long, key: String) = AsyncRequestToken(sessionEpoch, serial.incrementAndGet(), key)
    fun invalidate() { serial.incrementAndGet() }
    fun accepts(token: AsyncRequestToken, currentSessionEpoch: Long, currentKey: String): Boolean =
        token.sessionEpoch == currentSessionEpoch && token.serial == serial.get() && token.key == currentKey
}

internal const val DEFAULT_GATEWAY_TIME_ZONE = "Asia/Shanghai"

internal fun deviceReportTimeZone(zone: ZoneId = ZoneId.systemDefault()): String = zone.id

internal fun isIanaTimeZone(zone: String): Boolean {
    val id = zone.trim()
    if (id.isEmpty() || id.length > 100 || id == "Asia/Beijing" || '+' in id) return false
    return runCatching { ZoneId.of(id); true }.getOrDefault(false)
}

internal fun gatewayDisplayTimeZone(vararg candidates: String?): String =
    candidates.firstOrNull { candidate -> candidate != null && isIanaTimeZone(candidate) }
        ?: DEFAULT_GATEWAY_TIME_ZONE

internal fun resolveGatewayZoneId(preferred: String?): ZoneId =
    ZoneId.of(gatewayDisplayTimeZone(preferred))

internal fun formatGatewayDateTime(value: String, timeZone: String?): String {
    val instant = parseInstant(value) ?: return "时间待确认"
    return instant.atZone(resolveGatewayZoneId(timeZone)).format(GATEWAY_DATE_TIME)
}

/** S72 占用条「自 hh:mm」。 */
internal fun formatGatewayTime(value: String, timeZone: String?): String {
    val instant = parseInstant(value) ?: return "时间待确认"
    return instant.atZone(resolveGatewayZoneId(timeZone)).format(GATEWAY_TIME)
}

internal fun formatGatewayDate(value: String, timeZone: String?): String {
    val instant = parseInstant(value) ?: return "日期待确认"
    return instant.atZone(resolveGatewayZoneId(timeZone)).format(GATEWAY_DATE)
}

internal fun talkDurationSeconds(answeredAt: String?, endedAt: String?): Int? {
    val answered = parseInstant(answeredAt) ?: return null
    val ended = parseInstant(endedAt) ?: return null
    return ((ended.toEpochMilli() - answered.toEpochMilli()) / 1000.0).roundToInt().coerceAtLeast(0)
}

internal fun talkDurationLabel(answeredAt: String?, endedAt: String?): String? =
    talkDurationShortLabel(answeredAt, endedAt)?.let { "通话时长 $it" }

/** The compact form the report card's second line uses: "48 秒" / "2 分 05 秒". */
internal fun talkDurationShortLabel(answeredAt: String?, endedAt: String?): String? =
    talkDurationSeconds(answeredAt, endedAt)?.let { seconds ->
        if (seconds < 60) "$seconds 秒" else "%d 分 %02d 秒".format(seconds / 60, seconds % 60)
    }

/**
 * Report/list timestamps drop the parts the reader already knows: today shows the clock only, this
 * year shows 月-日, anything older keeps the full date.
 */
internal fun formatCompactGatewayDateTime(
    value: String,
    timeZone: String?,
    now: Instant = Instant.now(),
): String {
    val instant = parseInstant(value) ?: return "时间待确认"
    val zone = resolveGatewayZoneId(timeZone)
    val moment = instant.atZone(zone)
    val today = now.atZone(zone).toLocalDate()
    return when {
        moment.toLocalDate() == today -> moment.format(GATEWAY_TIME)
        moment.toLocalDate().year == today.year -> moment.format(GATEWAY_MONTH_DAY_TIME)
        else -> moment.format(GATEWAY_DATE_TIME)
    }
}

internal fun formatPlayerTime(durationMs: Long): String {
    val total = (durationMs.coerceAtLeast(0) / 1000L).toInt()
    return "%d:%02d".format(total / 60, total % 60)
}

internal fun transcriptStatusIsInFlight(status: String?): Boolean =
    status in setOf("queued", "running", "retry")

internal fun historyDetailKey(
    viewer: HistoryViewerKind,
    callId: String,
    source: RecordingSource? = null,
): String = when (viewer) {
    HistoryViewerKind.TRANSCRIPT -> "transcript:$callId"
    HistoryViewerKind.RECORDING -> "recording:$callId:${source?.wireValue.orEmpty()}"
}

internal fun recordingAttachmentFileName(
    callId: String,
    source: RecordingSource,
    track: RecordingAudioTrack,
    mediaType: String,
): String {
    // S36 C4: mp3 导出的产物既不是 wav 也不是 ogg，扩展名必须跟着实际内容走。
    val ext = when (mediaType) {
        "audio/mpeg" -> "mp3"
        "audio/wav" -> "wav"
        else -> "ogg"
    }
    return "call-$callId-${source.wireValue}-${track.wireValue}.$ext"
}

internal fun jsonDisplayTimeZone(json: JSONObject, fallback: String? = null): String =
    gatewayDisplayTimeZone(json.nullableString("gatewayTimeZone"), fallback)

/** Web 通话行的号码行：`<号码 || 名称 || 未命名号码> · <网关短标签>`；没有 SIM 就不显示。 */
internal fun callLineLabel(sim: JSONObject?): String? {
    sim ?: return null
    val number = sim.nullableString("phoneLabel")?.takeIf(String::isNotBlank)
        ?: sim.nullableString("label")?.takeIf(String::isNotBlank)
        ?: "未命名号码"
    val gateway = sim.nullableString("gatewayId")?.takeIf(String::isNotBlank)?.let(sim.gatewayKind()::shortLabel) ?: "网关待确认"
    return "$number · $gateway"
}

/** 未接来电：呼入、从未接听、已结束或失败，且不是被拦截的来电、不是内部通话（S72 B6）。 */
internal fun isMissedIncomingCall(call: JSONObject): Boolean =
    call.optString("direction") == "incoming" &&
        !call.optBoolean("internal") &&
        call.optString("answeredAt").let { it.isBlank() || it == "null" } &&
        call.optString("state") in setOf("ended", "failed") &&
        call.optString("failureReason") != "number_blocked"

/** S72 A5: 行上的未接说法——忙线自动拒接单列「忙线未接」；不是未接回 null。 */
internal fun missedCallLabel(call: JSONObject): String? = when {
    !isMissedIncomingCall(call) -> null
    call.optString("failureReason") == "busy_auto_rejected" -> "忙线未接"
    else -> "未接来电"
}

/** S72 E: 呼入腿「对端卡 → 本卡」，呼出腿「本卡 → 对端卡」；非内部回 null。 */
internal fun internalCallTitle(internal: Boolean, direction: String, ownSimLabel: String?, peerSimLabel: String?): String? {
    if (!internal) return null
    val own = ownSimLabel?.takeIf { it.isNotBlank() && it != "null" } ?: "本卡"
    val peer = peerSimLabel?.takeIf { it.isNotBlank() && it != "null" } ?: "另一张卡"
    return if (direction == "outgoing") "内部通话 $own → $peer" else "内部通话 $peer → $own"
}

/** S81: 通话 DTO 的被叫 SIM 显示名（号码备注名称，缺省号码）；Control 仅非空时输出。 */
internal fun calledSimLabel(call: JSONObject): String? =
    call.nullableString("simLabel")?.takeIf { it.isNotBlank() && it != "null" }

/** 通话 DTO 版：本卡取合并进来的 `sim`，服务端 DTO 没有该对象时用 S81 `simLabel`（phoneLabel 优先，与行上号码线路一致）。 */
internal fun internalCallTitle(call: JSONObject): String? {
    val sim = call.optJSONObject("sim")
    val own = sim?.nullableString("phoneLabel")?.takeIf(String::isNotBlank) ?: sim?.nullableString("label")
        ?: calledSimLabel(call)
    return internalCallTitle(call.optBoolean("internal"), call.optString("direction"), own, call.nullableString("peerSimLabel"))
}

/**
 * S72 D7: 内部通话以呼入腿为代表。Control 应在服务端合并；这里只在 DTO 带 `peerCallId` 且对端呼入腿就在
 * 同一页时隐藏呼出腿，缺字段就两行都显示（都带「内部通话」标题）。
 */
internal fun hideMergedInternalLegs(calls: List<JSONObject>): List<JSONObject> {
    val incomingInternal = calls.filter { it.optBoolean("internal") && it.optString("direction") == "incoming" }
        .mapTo(HashSet()) { it.optString("id") }
    if (incomingInternal.isEmpty()) return calls
    return calls.filterNot {
        it.optBoolean("internal") && it.optString("direction") == "outgoing" &&
            it.nullableString("peerCallId") in incomingInternal
    }
}

internal fun parseCallHistoryItem(call: JSONObject, sim: JSONObject?): CallReportItem {
    val simId = call.optString("simId")
    val simLabel = sim?.nullableString("phoneLabel")?.takeIf(String::isNotBlank)
        ?: sim?.optString("label")?.ifBlank { "SIM" }
        ?: "SIM"
    return CallReportItem(
        callId = call.optString("id"),
        startedAt = call.optString("startedAt"),
        direction = call.optString("direction"),
        remoteNumber = call.optString("remoteNumber"),
        sim = ReportSim(
            simId,
            simLabel,
            if (sim == null || !sim.has("slotIndex") || sim.isNull("slotIndex")) 0 else sim.optInt("slotIndex"),
        ),
        summary = null,
        actionItems = emptyList(),
        advertisingClassification = "unknown",
        recordingStatus = call.optString("recordingStatus"),
        callUrl = "",
        transcriptUrl = "",
        recordingUrl = "",
        transcriptCompletedAt = "",
        answeredAt = call.nullableString("answeredAt"),
        endedAt = call.nullableString("endedAt"),
        gatewayTimeZone = jsonDisplayTimeZone(call, sim?.nullableString("timeZone")),
        contactName = call.nullableString("contactName"),
        contactId = call.nullableString("contactId"),
        blocked = call.optBoolean("blocked"),
        blockedEntryId = call.nullableString("blockedEntryId"),
        answerMode = call.nullableString("answerMode"),
        answeredByPlatform = call.nullableString("answeredByPlatform"),
        gatewayKind = call.gatewayKind(),
        originatingPlatform = call.nullableString("originatingPlatform"),
        internal = call.optBoolean("internal"),
        peerSimId = call.nullableString("peerSimId"),
        peerSimLabel = call.nullableString("peerSimLabel"),
    )
}

internal fun reportHistoryRowKey(callId: String) = "report:$callId"
internal fun allCallsHistoryRowKey(callId: String) = "call:$callId"

private fun parseInstant(value: String?): Instant? =
    value?.takeUnless { it.isBlank() || it == "null" }?.let { runCatching { Instant.parse(it) }.getOrNull() }

private val GATEWAY_DATE_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
private val GATEWAY_DATE: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd")
private val GATEWAY_MONTH_DAY_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("MM-dd HH:mm")
private val GATEWAY_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

/**
 * Report page decoder. S22 turned this endpoint into "every call in the window", so a row may carry
 * no transcript at all: every field the older contract guaranteed (`advertisingClassification`,
 * `transcriptCompletedAt`, `window.period`) is now read as optional. A missing key degrades the row,
 * it never fails the page.
 *
 * S28: the pager envelope is *additive* — the paged response still carries `window` and `items`, so
 * one decoder serves both routes. A body without `totalPages` (the unpaged route, or a Control that
 * predates S28) decodes to [Page.unpaged] and the pager hides itself.
 */
internal fun parseCallReport(
    json: JSONObject,
    requestedPageSize: Int = RecordsPagingPolicy.DEFAULT_PAGE_SIZE,
): CallReportPage {
    val window = json.getJSONObject("window")
    val period = window.nullableString("period")
        ?.let { wire ->
            ReportPeriod.entries.singleOrNull { it.wireValue == wire }
                ?: throw IllegalArgumentException("unknown report period")
        }
    val items = json.getJSONArray("items")
    return CallReportPage(
        ReportWindow(period, window.getString("timeZone"), window.getString("fromInclusive"), window.getString("toExclusive")),
        readPageEnvelope(json, List(items.length()) { index ->
            val item = items.getJSONObject(index)
            val sim = item.getJSONObject("sim")
            CallReportItem(
                callId = item.getString("callId"),
                startedAt = item.getString("startedAt"),
                direction = item.getString("direction"),
                remoteNumber = item.nullableString("remoteNumber").orEmpty(),
                sim = ReportSim(sim.getString("id"), sim.getString("label"), sim.optInt("slotIndex")),
                gatewayKind = item.gatewayKind(),
                summary = item.nullableString("summary"),
                actionItems = item.optionalStringList("actionItems"),
                advertisingClassification = item.nullableString("advertisingClassification") ?: "unknown",
                recordingStatus = item.nullableString("recordingStatus").orEmpty(),
                callUrl = item.nullableString("callUrl").orEmpty(),
                transcriptUrl = item.nullableString("transcriptUrl").orEmpty(),
                recordingUrl = item.nullableString("recordingUrl").orEmpty(),
                transcriptCompletedAt = item.nullableString("transcriptCompletedAt").orEmpty(),
                answeredAt = item.nullableString("answeredAt"),
                endedAt = item.nullableString("endedAt"),
                gatewayTimeZone = item.nullableString("gatewayTimeZone"),
                contactName = item.nullableString("contactName"),
                contactId = item.nullableString("contactId"),
                blocked = item.optBoolean("blocked"),
                blockedEntryId = item.nullableString("blockedEntryId"),
                answerMode = item.nullableString("answerMode"),
                answeredByPlatform = item.nullableString("answeredByPlatform"),
                transcriptState = item.nullableString("transcriptState") ?: TRANSCRIPT_STATE_NONE,
                transcriptErrorCode = item.optJSONObject("transcriptError")?.nullableString("code"),
                classification = item.nullableString("classification"),
                blockRecommended = item.nullableBoolean("blockRecommended"),
                blockCategory = item.nullableString("blockCategory"),
                blockReason = item.nullableString("blockReason"),
                hasAiTranscript = item.optBoolean("hasAiTranscript"),
                aiTranscriptUrl = item.nullableString("aiTranscriptUrl").orEmpty(),
                originatingPlatform = item.nullableString("originatingPlatform"),
                unseen = item.optBoolean("unseen"),
                internal = item.optBoolean("internal"),
                peerSimId = item.nullableString("peerSimId"),
                peerSimLabel = item.nullableString("peerSimLabel"),
            )
        }, requestedPageSize),
    )
}

internal fun parseCallTranscript(json: JSONObject): CallTranscript? {
    if (!json.has("transcript") || json.isNull("transcript")) return null
    val value = json.getJSONObject("transcript")
    val result = if (value.isNull("result")) null else value.getJSONObject("result").let { result ->
        val segments = result.getJSONArray("segments")
        val providers = result.getJSONArray("providers")
        TranscriptResult(
            text = result.getString("text"),
            segments = List(segments.length()) { index -> segments.getJSONObject(index).let { segment ->
                TranscriptSegment(
                    OriginalTranscriptTrack.parse(segment.getString("track")),
                    segment.getString("speaker"),
                    segment.getString("text"),
                    segment.nullableDouble("startMs"),
                    segment.nullableDouble("endMs"),
                )
            } },
            providers = List(providers.length()) { index -> providers.getJSONObject(index).let { provider ->
                TranscriptProvider(
                    OriginalTranscriptTrack.parse(provider.getString("track")),
                    provider.getString("provider"),
                    provider.nullableString("model"),
                    provider.nullableString("version"),
                )
            } },
            advertisingClassification = result.getString("advertisingClassification"),
            includeInReports = result.getBoolean("includeInReports"),
            summary = result.nullableString("summary"),
            actionItems = result.stringList("actionItems"),
        )
    }
    val error = value.optJSONObject("error")
    return CallTranscript(
        id = value.getString("id"), callId = value.getString("callId"), status = value.getString("status"),
        attempts = value.getInt("attempts"), nextAttemptAt = value.nullableString("nextAttemptAt"),
        errorCode = error?.nullableString("code"), errorMessage = error?.nullableString("message"),
        result = result, createdAt = value.getString("createdAt"), updatedAt = value.getString("updatedAt"),
        completedAt = value.nullableString("completedAt"),
    )
}

internal fun parseRecordingManifest(
    json: JSONObject,
    expectedCallId: String,
    expectedSource: RecordingSource,
): RecordingManifest? {
    if (!json.has("recording") || json.isNull("recording")) return null
    val value = json.getJSONObject("recording")
    require(value.getString("callId").equals(expectedCallId, ignoreCase = true)) { "recording manifest identity mismatch" }
    return when (expectedSource) {
        RecordingSource.MEDIA_NODE -> parseMediaNodeRecording(value)
        RecordingSource.PIXEL -> parsePixelRecording(value)
    }
}

private fun parseMediaNodeRecording(value: JSONObject): RecordingManifest {
    require(value.strictSafeInt("version") == 1 &&
        (!value.has("source") || value.getString("source") == RecordingSource.MEDIA_NODE.wireValue)) {
        "recording source or version mismatch"
    }
    val array = value.getJSONArray("artifacts")
    val entries = List(array.length()) { array.getJSONObject(it) }
    val expectedNames = setOf("remote_original.ogg", "caller_original.ogg", "timeline.jsonl")
    require(entries.map { it.getString("name") }.toSet() == expectedNames && entries.size == expectedNames.size) {
        "recording manifest tracks invalid"
    }
    entries.forEach(::requireArtifactMetadata)
    return RecordingManifest(
        source = RecordingSource.MEDIA_NODE,
        version = 1,
        archiveId = null,
        callId = value.getString("callId"),
        finalizedAt = requireIsoDate(value.getString("finalizedAt")),
        archiveComplete = value.strictBoolean("complete"),
        captureComplete = null,
        artifacts = OriginalTranscriptTrack.entries.map { track ->
            val raw = entries.single { it.getString("name") == "${track.wireValue}.ogg" }
            RecordingArtifact(
                track.recordingAudioTrack(),
                "audio/ogg",
                raw.strictSafeLong("bytes"),
                raw.getString("sha256"),
                null,
                0,
                0,
                durationMs = raw.optionalDurationMs(),
            )
        },
    )
}

private fun parsePixelRecording(value: JSONObject): RecordingManifest {
    val version = value.strictSafeInt("version")
    require(value.getString("source") == RecordingSource.PIXEL.wireValue && version in setOf(2, 3)) {
        "recording source or version mismatch"
    }
    val archiveId = value.getString("archiveId")
    require(UUID_REGEX.matches(archiveId) && UUID_REGEX.matches(value.getString("callId"))) { "recording archive identity invalid" }
    val array = value.getJSONArray("tracks")
    val entries = List(array.length()) { array.getJSONObject(it) }
    val expectedTracks = OriginalTranscriptTrack.entries.map { it.wireValue }.toSet()
    require(entries.size == expectedTracks.size && entries.map { it.getString("track") }.toSet() == expectedTracks) {
        "recording manifest tracks invalid"
    }
    val artifacts = entries.map { raw ->
        require(raw.getString("mediaType") == "audio/wav") { "recording media type invalid" }
        val sourceRole = raw.optString("sourceRole")
        require(sourceRole.isBlank() || sourceRole == "original_capture") { "recording source role invalid" }
        if (version == 3) require(sourceRole == "original_capture") { "v3 original source role missing" }
        val bytes = raw.strictSafeLong("bytes")
        require(bytes in 44..MAX_PIXEL_RECORDING_BYTES && raw.getString("sha256").matches(SHA256)) {
            "recording manifest metadata invalid"
        }
        RecordingArtifact(
            track = OriginalTranscriptTrack.parse(raw.getString("track")).recordingAudioTrack(),
            mediaType = "audio/wav",
            bytes = bytes,
            sha256 = raw.getString("sha256"),
            captureComplete = raw.strictBoolean("captureComplete"),
            gapCount = requireCount(raw.strictSafeLong("gapCount")),
            droppedFrames = requireCount(raw.strictSafeLong("droppedFrames")),
            durationMs = raw.optionalDurationMs(),
        )
    }
    val derivedArtifacts = when (version) {
        2 -> {
            require(!value.has("derivedTracks")) { "v2 recording must not contain derived tracks" }
            emptyList()
        }
        else -> {
            require(value.getString("manifestSha256").matches(SHA256)) { "v3 manifest fingerprint invalid" }
            val derived = value.getJSONArray("derivedTracks")
            require(derived.length() == 1) { "v3 derived tracks invalid" }
            val raw = derived.getJSONObject(0)
            require(raw.getString("track") == RecordingAudioTrack.CALLER_PLAYOUT.wireValue &&
                raw.getString("sourceRole") == "derived_playout" && raw.getString("mediaType") == "audio/wav") {
                "v3 derived track identity invalid"
            }
            val bytes = raw.strictSafeLong("bytes")
            require(bytes in 44..MAX_PIXEL_RECORDING_BYTES && raw.getString("sha256").matches(SHA256)) {
                "v3 derived track metadata invalid"
            }
            listOf(RecordingArtifact(
                track = RecordingAudioTrack.CALLER_PLAYOUT,
                mediaType = "audio/wav",
                bytes = bytes,
                sha256 = raw.getString("sha256"),
                captureComplete = null,
                gapCount = requireCount(raw.strictSafeLong("gapCount")),
                droppedFrames = 0,
                sourceRole = "derived_playout",
                playoutComplete = raw.strictBoolean("playoutComplete"),
                recoveryFrames = requireCount(raw.strictSafeLong("recoveryFrames")),
                durationMs = raw.optionalDurationMs(),
            ))
        }
    }
    val timeline = value.getJSONObject("timeline")
    require(timeline.getString("mediaType") == "application/x-ndjson") { "recording timeline media type invalid" }
    require(timeline.strictSafeLong("bytes") in 1..MAX_PIXEL_RECORDING_BYTES && timeline.getString("sha256").matches(SHA256)) {
        "recording timeline metadata invalid"
    }
    requireIsoDate(value.getString("startedAt"))
    val captureComplete = value.strictBoolean("captureComplete")
    require(value.strictBoolean("archiveComplete") && captureComplete == artifacts.all { it.captureComplete == true }) {
        "recording completion metadata invalid"
    }
    return RecordingManifest(
        source = RecordingSource.PIXEL,
        version = version,
        archiveId = archiveId,
        callId = value.getString("callId"),
        finalizedAt = requireIsoDate(value.getString("endedAt")),
        archiveComplete = true,
        captureComplete = captureComplete,
        artifacts = artifacts,
        derivedArtifacts = derivedArtifacts,
    )
}

private fun requireArtifactMetadata(value: JSONObject) {
    require(value.strictSafeLong("bytes") in 0..MAX_RECORDING_ARTIFACT_BYTES && value.getString("sha256").matches(SHA256)) {
        "recording manifest metadata invalid"
    }
}

private fun requireIsoDate(value: String): String = value.also {
    require(runCatching { java.time.Instant.parse(it) }.isSuccess) { "recording timestamp invalid" }
}

private fun requireCount(value: Long): Long = value.also { require(it >= 0) { "recording count invalid" } }

private fun JSONObject.strictBoolean(key: String): Boolean {
    val raw = get(key)
    require(raw is Boolean) { "$key must be a boolean" }
    return raw
}

private fun JSONObject.strictSafeInt(key: String): Int {
    val value = strictSafeLong(key)
    require(value in Int.MIN_VALUE..Int.MAX_VALUE) { "$key must be a safe integer" }
    return value.toInt()
}

private fun JSONObject.strictSafeLong(key: String): Long {
    val raw = get(key)
    require(raw is Number) { "$key must be a number" }
    val decimal = raw.toString().toBigDecimalOrNull()
    require(decimal != null && decimal.stripTrailingZeros().scale() <= 0 && decimal.abs() <= MAX_JSON_SAFE_INTEGER_DECIMAL) {
        "$key must be a safe integer"
    }
    return decimal.longValueExact()
}

private fun JSONObject.optionalDurationMs(): Long? {
    if (!has("durationMs") || isNull("durationMs")) return null
    val value = strictSafeLong("durationMs")
    require(value >= 0) { "recording duration invalid" }
    return value
}

private fun JSONObject.nullableString(key: String): String? =
    if (!has(key) || isNull(key)) null else getString(key)
private fun JSONObject.nullableDouble(key: String): Double? =
    if (!has(key) || isNull(key)) null else getDouble(key)
private fun JSONObject.nullableBoolean(key: String): Boolean? =
    if (!has(key) || isNull(key)) null else getBoolean(key)
private fun JSONObject.stringList(key: String): List<String> {
    val array = getJSONArray(key)
    return List(array.length()) { array.getString(it) }
}
private fun JSONObject.optionalStringList(key: String): List<String> =
    if (!has(key) || isNull(key)) emptyList() else stringList(key)

private const val MAX_RECORDING_ARTIFACT_BYTES = 512L * 1024 * 1024
private const val MAX_JSON_SAFE_INTEGER = 9_007_199_254_740_991L
private val MAX_JSON_SAFE_INTEGER_DECIMAL = BigDecimal.valueOf(MAX_JSON_SAFE_INTEGER)
private const val MAX_PIXEL_RECORDING_BYTES = 1024L * 1024 * 1024
private val SHA256 = Regex("^[0-9a-f]{64}$")
private val UUID_REGEX = Regex("^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
