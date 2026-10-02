package org.vodog.gateway

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

enum class DeviceCallDirection(val wireValue: String) { INCOMING("incoming"), OUTGOING("outgoing"), UNKNOWN("unknown") }
enum class DeviceCallState(val wireValue: String?) {
    RINGING("ringing"), DIALING("dialing"), ACTIVE("active"), ENDED(null), UNKNOWN(null)
}

/** How long after a dial a still-unbound reservation may adopt the Telecom call that appears late. */
internal const val OUTGOING_BINDING_GRACE_SECONDS = 180L
/** How long a non-terminal journal record with no live Telecom call is kept before it is declared absent. */
internal const val STALE_RECORD_GRACE_MILLIS = 5 * 60_000L

data class DeviceCallRecord(
    val deviceCallId: String,
    val phoneAccountHandle: String?,
    val creationTimeMillis: Long?,
    val direction: DeviceCallDirection,
    val state: DeviceCallState,
    val observedAt: String,
    val remoteNumber: String?,
    val incomingEventId: String?,
    val incomingPayload: String?,
    val incomingReported: Boolean,
    val serverCallId: String?,
    val outgoingReservationExpiresAt: String? = null,
    /**
     * S22 decision 9: the last executed ANSWER for this call carried Control's `answeredBy:"ai"`.
     *
     * This journal is the smallest durable per-call record that the media path already reads
     * ([GatewayAudioLifecycleCoordinator] resolves the exact ACTIVE call through it), so the flag
     * survives a process restart between the ANSWER and the media reconcile without adding a store.
     * Rows written before this field decode as false, i.e. the human 3 s prebuffer window.
     */
    val answeredByAi: Boolean = false,
    /**
     * S38 §2: the user dialled this call on the Pixel itself; no VoDog dial command exists.
     *
     * It is set by the accepted `calls/outgoing-observed` report, and it is what keeps the exact-call
     * selectors (and therefore the WebRTC media session) away from a leg that has no remote party.
     */
    val deviceOriginated: Boolean = false,
    /** S38 §2: the one-shot outgoing observation was settled; rows written before S38 decode as false. */
    val outgoingReported: Boolean = false,
    /**
     * S38 §2: the exact body of the first outgoing observation, frozen before it was ever sent.
     *
     * Control replays a repeated `eventId` only when the request fingerprint matches, and both
     * `telecomState` and `observedAt` move between heartbeats. Without this, a lost response to a
     * DIALING report would be re-sent as ACTIVE, get a 409, and strand the record with no call id —
     * the same reason the incoming path freezes [incomingPayload].
     */
    val outgoingPayload: String? = null,
    /**
     * S72b: a Control ANSWER command was executed for this incoming call (remote client or AI).
     * An incoming call that reaches ACTIVE without one was answered on the Pixel itself, keeps its
     * audio on the phone and never gets a WebRTC session. Rows written before S72b decode as true,
     * i.e. exactly the pre-S72b media behaviour.
     */
    val remoteAnswered: Boolean = false,
    /**
     * S94: the owner unmuted this AI-answered call on the Pixel and took it over. Durable so that a
     * process restart mid-call never rebuilds a media leg (and then hangs up on its prebuffer failure).
     */
    val ownerJoined: Boolean = false,
)

/** Device-protected crash/reboot journal. Caller numbers stay in this app-private store and are never logged. */
class DeviceCallJournal(context: Context) {
    private val prefs = context.createDeviceProtectedStorageContext()
        .getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun observeAdded(
        phoneAccountHandle: String?,
        creationTimeMillis: Long?,
        direction: DeviceCallDirection,
        state: DeviceCallState,
        remoteNumber: String?,
        boundDeviceCallIds: Set<String>,
    ): String =
        synchronized(LOCK) {
        val records = read().toMutableList()
        val existing = recoverableDeviceCall(
            records, phoneAccountHandle, creationTimeMillis, direction, boundDeviceCallIds,
        ) ?: recoverableOutgoingReservation(
            records, phoneAccountHandle, direction, remoteNumber, boundDeviceCallIds, Instant.now(),
            creationTimeMillis,
        )
        if (existing != null) {
            replace(records, existing.copy(
                state = state,
                observedAt = now(),
                remoteNumber = remoteNumber ?: existing.remoteNumber,
                creationTimeMillis = creationTimeMillis?.takeIf { it > 0 } ?: existing.creationTimeMillis,
            ))
            write(records)
            return@synchronized existing.deviceCallId
        }
        val record = DeviceCallRecord(
            deviceCallId = UUID.randomUUID().toString(),
            phoneAccountHandle = phoneAccountHandle,
            creationTimeMillis = creationTimeMillis?.takeIf { it > 0 },
            direction = direction,
            state = state,
            observedAt = now(),
            remoteNumber = remoteNumber,
            incomingEventId = if (direction == DeviceCallDirection.INCOMING) UUID.randomUUID().toString() else null,
            incomingPayload = null,
            incomingReported = false,
            serverCallId = null,
            outgoingReservationExpiresAt = null,
        )
        records += record
        check(records.size <= MAX_RECORDS) { "call journal capacity exhausted" }
        write(records)
        record.deviceCallId
    }

    fun update(deviceCallId: String, state: DeviceCallState) = synchronized(LOCK) {
        mutate(deviceCallId) { it.copy(state = state, observedAt = now()) }
    }

    fun updateObservation(
        deviceCallId: String,
        phoneAccountHandle: String?,
        creationTimeMillis: Long?,
        direction: DeviceCallDirection,
        state: DeviceCallState,
        remoteNumber: String?,
    ) = synchronized(LOCK) {
        mutate(deviceCallId) {
            val resolvedDirection = if (direction == DeviceCallDirection.UNKNOWN) it.direction else direction
            it.copy(
                phoneAccountHandle = phoneAccountHandle ?: it.phoneAccountHandle,
                creationTimeMillis = creationTimeMillis?.takeIf { value -> value > 0 } ?: it.creationTimeMillis,
                direction = resolvedDirection,
                state = state,
                observedAt = now(),
                remoteNumber = remoteNumber ?: it.remoteNumber,
                incomingEventId = it.incomingEventId ?: if (resolvedDirection == DeviceCallDirection.INCOMING) {
                    UUID.randomUUID().toString()
                } else null,
            )
        }
    }

    fun markEnded(deviceCallId: String) = synchronized(LOCK) {
        mutate(deviceCallId) { it.copy(state = DeviceCallState.ENDED, observedAt = now()) }
    }

    /**
     * Records which route answered this call, durably and before Telecom is asked to accept it.
     *
     * The value is always written from the executing command, never latched: a rejected AI answer
     * followed by a human answer of the same still-ringing call must fall back to the human window.
     */
    fun markAnswerRoute(deviceCallId: String, answeredByAi: Boolean) = synchronized(LOCK) {
        mutate(deviceCallId) {
            if (it.answeredByAi == answeredByAi && it.remoteAnswered) it
            else it.copy(answeredByAi = answeredByAi, remoteAnswered = true)
        }
    }

    /** S94: written once from the owner-join IO work; never cleared for the rest of this call. */
    fun markOwnerJoined(deviceCallId: String) = synchronized(LOCK) {
        mutate(deviceCallId) { if (it.ownerJoined) it else it.copy(ownerJoined = true) }
    }

    /** Reserves the exact durable ID that onCallAdded must bind to after placeCall returns. */
    fun reserveOutgoing(
        serverCallId: String,
        protectedPhoneAccountHandle: String,
        remoteNumber: String,
        expiresAt: String,
    ): DeviceCallRecord = synchronized(LOCK) {
        UUID.fromString(serverCallId)
        val expiry = Instant.parse(expiresAt)
        require(expiry.isAfter(Instant.now()))
        // The dial command's own expiry is a server-side delivery deadline, not a Telecom binding deadline. Binding
        // stays possible for a bounded grace window so a slow placeCall/onCallAdded never orphans the server call ID.
        val bindingExpiry = maxOf(expiry, Instant.now().plusSeconds(OUTGOING_BINDING_GRACE_SECONDS))
        val records = read().toMutableList()
        records.singleOrNull { it.serverCallId == serverCallId }?.let { existing ->
            require(existing.direction == DeviceCallDirection.OUTGOING &&
                existing.phoneAccountHandle == protectedPhoneAccountHandle &&
                existing.remoteNumber == remoteNumber) { "outgoing reservation collision" }
            return@synchronized existing
        }
        val record = DeviceCallRecord(
            UUID.randomUUID().toString(), protectedPhoneAccountHandle, null,
            DeviceCallDirection.OUTGOING, DeviceCallState.UNKNOWN, now(), remoteNumber,
            null, null, false, serverCallId, bindingExpiry.toString(),
        )
        records += record
        check(records.size <= MAX_RECORDS) { "call journal capacity exhausted" }
        write(records)
        record
    }

    /**
     * Marks unbound outgoing UNKNOWN reservations that cannot be live any more as ENDED.
     *
     * ACTIVE/RINGING/DIALING rows are never converted here: only onCallRemoved or markEnded may end a live
     * Telecom call. A transient isInCall=false or an observation older than five minutes is not absence evidence.
     */
    fun markProvablyAbsentRecordsEnded(
        liveDeviceCallIds: Set<String>,
        graceMillis: Long = STALE_RECORD_GRACE_MILLIS,
        now: Instant = Instant.now(),
    ): Int = synchronized(LOCK) {
        val records = read().toMutableList()
        val stale = staleNonTerminalRecords(records, liveDeviceCallIds, now, graceMillis)
        if (stale.isEmpty()) return@synchronized 0
        val staleIds = stale.mapTo(mutableSetOf()) { it.deviceCallId }
        records.replaceAll { record ->
            if (record.deviceCallId in staleIds) {
                record.copy(state = DeviceCallState.ENDED, observedAt = now.toString())
            } else record
        }
        write(records)
        stale.size
    }

    fun recordsForSnapshot(): List<DeviceCallRecord> = synchronized(LOCK) { read() }
    fun find(deviceCallId: String): DeviceCallRecord? = synchronized(LOCK) {
        read().singleOrNull { it.deviceCallId == deviceCallId }
    }
    fun pendingIncoming(): List<DeviceCallRecord> = synchronized(LOCK) {
        read().filter {
            it.direction == DeviceCallDirection.INCOMING && !it.incomingReported && it.incomingEventId != null
        }
    }

    fun persistIncomingPayload(deviceCallId: String, payload: JSONObject): DeviceCallRecord? = synchronized(LOCK) {
        mutate(deviceCallId) { if (it.incomingPayload == null) it.copy(incomingPayload = payload.toString()) else it }
        read().firstOrNull { it.deviceCallId == deviceCallId }
    }

    fun markIncomingReported(deviceCallId: String, serverCallId: String?) = synchronized(LOCK) {
        mutate(deviceCallId) { it.copy(incomingReported = true, serverCallId = serverCallId ?: it.serverCallId) }
    }

    fun suppressIncomingReport(deviceCallId: String) = markIncomingReported(deviceCallId, null)

    /** S38 §2: outgoing Telecom calls this gateway never dialled and has not reported yet. */
    fun pendingUnboundOutgoing(): List<DeviceCallRecord> = synchronized(LOCK) {
        pendingUnboundOutgoing(read(), Instant.now())
    }

    /** Freezes the first outgoing observation body so a retry is byte-identical to Control. */
    fun persistOutgoingPayload(deviceCallId: String, payload: JSONObject): DeviceCallRecord? = synchronized(LOCK) {
        mutate(deviceCallId) { if (it.outgoingPayload == null) it.copy(outgoingPayload = payload.toString()) else it }
        read().firstOrNull { it.deviceCallId == deviceCallId }
    }

    /**
     * Settles the one-shot outgoing observation. `serverCallId` is null when Control accepted the
     * report but recorded nothing (feature off, SIM not owned here); the row is still never resent.
     */
    fun markOutgoingReported(deviceCallId: String, serverCallId: String?) = synchronized(LOCK) {
        mutate(deviceCallId) {
            it.copy(
                outgoingReported = true,
                deviceOriginated = true,
                serverCallId = serverCallId ?: it.serverCallId,
            )
        }
    }

    fun pruneAfterAcceptedSnapshot(releasedCallIds: Set<String>) = synchronized(LOCK) {
        write(pruneAfterSnapshot(read(), releasedCallIds))
    }

    fun clear() = synchronized(LOCK) { prefs.edit().clear().commit() }

    private fun mutate(deviceCallId: String, transform: (DeviceCallRecord) -> DeviceCallRecord) {
        val records = read().toMutableList()
        val index = records.indexOfFirst { it.deviceCallId == deviceCallId }
        if (index >= 0) {
            records[index] = transform(records[index])
            write(records)
        }
    }

    private fun replace(records: MutableList<DeviceCallRecord>, record: DeviceCallRecord) {
        val index = records.indexOfFirst { it.deviceCallId == record.deviceCallId }
        if (index >= 0) records[index] = record
    }

    private fun read(): List<DeviceCallRecord> = try {
        val array = JSONArray(prefs.getString(KEY_RECORDS, "[]"))
        List(array.length()) { index -> array.getJSONObject(index).toRecord() }
    } catch (_: Exception) {
        throw IllegalStateException("device call journal is unreadable")
    }

    private fun write(records: List<DeviceCallRecord>) {
        val array = JSONArray()
        records.forEach { array.put(it.toJson()) }
        check(prefs.edit().putString(KEY_RECORDS, array.toString()).commit()) { "call journal commit failed" }
    }

    private fun now() = Instant.now().toString()

    private companion object {
        const val NAME = "gateway_device_call_journal"
        const val KEY_RECORDS = "records"
        const val MAX_RECORDS = 32
        val LOCK = Any()
    }
}

/** Telecom reports the same destination with or without '+', spaces or parentheses; compare the dialable digits. */
internal fun dialNumberMatchKey(value: String?): String? =
    value?.filter(Char::isDigit)?.takeIf { it.isNotEmpty() }

internal fun recoverableDeviceCall(
    records: List<DeviceCallRecord>,
    phoneAccountHandle: String?,
    creationTimeMillis: Long?,
    direction: DeviceCallDirection,
    boundDeviceCallIds: Set<String>,
): DeviceCallRecord? = records.filter {
    creationTimeMillis != null && creationTimeMillis > 0 &&
        it.creationTimeMillis == creationTimeMillis &&
        it.deviceCallId !in boundDeviceCallIds &&
        it.state != DeviceCallState.ENDED && it.direction == direction &&
        it.phoneAccountHandle == phoneAccountHandle
}.singleOrNull()

internal fun recoverableOutgoingReservation(
    records: List<DeviceCallRecord>,
    phoneAccountHandle: String?,
    direction: DeviceCallDirection,
    remoteNumber: String?,
    boundDeviceCallIds: Set<String>,
    now: Instant,
): DeviceCallRecord? = recoverableOutgoingReservation(
    records, phoneAccountHandle, direction, remoteNumber, boundDeviceCallIds, now, null,
)

internal fun recoverableOutgoingReservation(
    records: List<DeviceCallRecord>,
    phoneAccountHandle: String?,
    direction: DeviceCallDirection,
    remoteNumber: String?,
    boundDeviceCallIds: Set<String>,
    now: Instant,
    creationTimeMillis: Long?,
): DeviceCallRecord? {
    val expectedNumber = dialNumberMatchKey(remoteNumber) ?: return null
    return records.filter {
        direction == DeviceCallDirection.OUTGOING && it.direction == DeviceCallDirection.OUTGOING &&
            it.creationTimeMillis == null && it.serverCallId != null &&
            it.deviceCallId !in boundDeviceCallIds && it.state == DeviceCallState.UNKNOWN &&
            it.phoneAccountHandle == phoneAccountHandle &&
            dialNumberMatchKey(it.remoteNumber) == expectedNumber &&
            // A reservation may only adopt a call that started after the reservation itself was written.
            (creationTimeMillis == null || observedAtMillis(it)?.let { stamp -> creationTimeMillis >= stamp } == true) &&
            it.outgoingReservationExpiresAt?.let(Instant::parse)?.isAfter(now) == true
    }.singleOrNull()
}

/** Unbound outgoing UNKNOWN reservations older than the grace window with no live Telecom registry entry. */
internal fun staleNonTerminalRecords(
    records: List<DeviceCallRecord>,
    liveDeviceCallIds: Set<String>,
    now: Instant,
    graceMillis: Long,
): List<DeviceCallRecord> = records.filter { record ->
    record.state == DeviceCallState.UNKNOWN &&
        record.direction == DeviceCallDirection.OUTGOING &&
        record.creationTimeMillis == null &&
        record.deviceCallId !in liveDeviceCallIds &&
        observedAtMillis(record)?.let { stamp -> now.toEpochMilli() - stamp >= graceMillis } == true
}

private fun observedAtMillis(record: DeviceCallRecord): Long? =
    runCatching { Instant.parse(record.observedAt).toEpochMilli() }.getOrNull()

/**
 * S38 §2: outgoing calls the user placed on the Pixel dialer itself.
 *
 * An unexpired reservation on the same phone account means a VoDog dial is still waiting for
 * `onCallAdded` to bind it, so nothing on that SIM may be claimed as phone-originated yet — claiming
 * it would steal the reservation's call and report it twice. UNKNOWN has no wire state at all and is
 * simply left for the next heartbeat, by which time Telecom has reported a real one.
 */
internal fun pendingUnboundOutgoing(records: List<DeviceCallRecord>, now: Instant): List<DeviceCallRecord> {
    val reservingAccounts = records.filter {
        it.direction == DeviceCallDirection.OUTGOING && it.serverCallId != null &&
            it.creationTimeMillis == null &&
            runCatching { Instant.parse(it.outgoingReservationExpiresAt) }.getOrNull()?.isAfter(now) == true
    }.mapTo(mutableSetOf()) { it.phoneAccountHandle }
    return records.filter {
        it.direction == DeviceCallDirection.OUTGOING && it.serverCallId == null && !it.outgoingReported &&
            it.state != DeviceCallState.UNKNOWN && it.phoneAccountHandle !in reservingAccounts
    }
}

/** The `telecomState` the outgoing-observed route accepts. UNKNOWN is not an observation. */
internal fun outgoingObservedTelecomState(state: DeviceCallState): String? = when (state) {
    DeviceCallState.DIALING, DeviceCallState.RINGING -> "dialing"
    DeviceCallState.ACTIVE -> "active"
    DeviceCallState.ENDED -> "ended"
    DeviceCallState.UNKNOWN -> null
}

internal fun confirmedAbsentCallIds(records: List<DeviceCallRecord>): List<String> = records.mapNotNull {
    it.serverCallId?.takeIf { _ -> it.state == DeviceCallState.ENDED }
}.distinct()

/** How long a locally settled incoming row is kept after it ended, before the prune pass removes it. */
internal const val SUPPRESSED_INCOMING_RETENTION_MILLIS = 10 * 60_000L

/**
 * A terminal incoming row that was settled locally rather than by the control service.
 *
 * `incomingReported` with no `serverCallId` is exactly the suppressed case — a number-blocklist
 * rejection (S21 §B), and the rare accepted report that returned no call id. Such a row is inert: it
 * cannot confirm absence or be released by a snapshot (both need a `serverCallId`), cannot be
 * re-reported ([DeviceCallJournal.pendingIncoming] skips reported rows), cannot be recovered
 * ([recoverableDeviceCall] skips ENDED) and never appears in the snapshot `calls` array (ENDED has no
 * wire value). Before this it was also unprunable, so blocked calls accumulated against MAX_RECORDS
 * until [DeviceCallJournal.observeAdded] threw inside the InCallService, and kept
 * `deviceCallPending` true so a credential change stayed blocked forever.
 *
 * Only ENDED qualifies: a blocked call that is still RINGING has not been disconnected by Telecom yet.
 */
internal fun suppressedIncomingIsPrunable(
    record: DeviceCallRecord,
    now: Instant,
    retentionMillis: Long = SUPPRESSED_INCOMING_RETENTION_MILLIS,
): Boolean = record.direction == DeviceCallDirection.INCOMING &&
    record.state == DeviceCallState.ENDED &&
    record.incomingReported &&
    record.serverCallId == null &&
    observedAtMillis(record)?.let { observed -> now.toEpochMilli() - observed >= retentionMillis } == true

/**
 * S38 §2: a settled phone-dialled row that Control declined to record.
 *
 * `outgoingReported` with no `serverCallId` is exactly that case — the feature switch is off or the
 * SIM has no owner — and the row is then as inert as a suppressed incoming one: it cannot be
 * re-reported, cannot confirm absence, cannot be released and never enters the snapshot. Without
 * this it would sit in the journal forever and count against the 32-record cap.
 */
internal fun observedOutgoingIsPrunable(
    record: DeviceCallRecord,
    now: Instant,
    retentionMillis: Long = SUPPRESSED_INCOMING_RETENTION_MILLIS,
): Boolean = record.direction == DeviceCallDirection.OUTGOING &&
    record.state == DeviceCallState.ENDED &&
    record.outgoingReported &&
    // A recorded row is normally released by the snapshot response; the retention below is only the
    // safety net for one Control never echoed back (it closed the lock-less row without releasing).
    (record.serverCallId == null || record.deviceOriginated) &&
    observedAtMillis(record)?.let { observed -> now.toEpochMilli() - observed >= retentionMillis } == true

internal fun pruneAfterSnapshot(
    records: List<DeviceCallRecord>,
    releasedCallIds: Set<String>,
    now: Instant = Instant.now(),
): List<DeviceCallRecord> = records.filterNot { record ->
    val releasedByServer = record.state == DeviceCallState.ENDED &&
        record.serverCallId != null &&
        record.serverCallId in releasedCallIds
    releasedByServer || suppressedIncomingIsPrunable(record, now) || observedOutgoingIsPrunable(record, now)
}

internal fun DeviceCallRecord.toJson() = JSONObject()
    .put("deviceCallId", deviceCallId)
    .put("phoneAccountHandle", phoneAccountHandle ?: JSONObject.NULL)
    .put("creationTimeMillis", creationTimeMillis ?: JSONObject.NULL)
    .put("direction", direction.name)
    .put("state", state.name)
    .put("observedAt", observedAt)
    .put("remoteNumber", remoteNumber ?: JSONObject.NULL)
    .put("incomingEventId", incomingEventId ?: JSONObject.NULL)
    .put("incomingPayload", incomingPayload ?: JSONObject.NULL)
    .put("incomingReported", incomingReported)
    .put("serverCallId", serverCallId ?: JSONObject.NULL)
    .put("outgoingReservationExpiresAt", outgoingReservationExpiresAt ?: JSONObject.NULL)
    .put("answeredByAi", answeredByAi)
    .put("deviceOriginated", deviceOriginated)
    .put("outgoingReported", outgoingReported)
    .put("outgoingPayload", outgoingPayload ?: JSONObject.NULL)
    .put("remoteAnswered", remoteAnswered)
    .put("ownerJoined", ownerJoined)

internal fun JSONObject.toRecord() = DeviceCallRecord(
    deviceCallId = getString("deviceCallId"),
    phoneAccountHandle = nullableString("phoneAccountHandle"),
    creationTimeMillis = if (isNull("creationTimeMillis")) null else optLong("creationTimeMillis").takeIf { it > 0 },
    direction = DeviceCallDirection.valueOf(getString("direction")),
    state = DeviceCallState.valueOf(getString("state")),
    observedAt = getString("observedAt"),
    remoteNumber = nullableString("remoteNumber"),
    incomingEventId = nullableString("incomingEventId"),
    incomingPayload = nullableString("incomingPayload"),
    incomingReported = optBoolean("incomingReported"),
    serverCallId = nullableString("serverCallId"),
    outgoingReservationExpiresAt = nullableString("outgoingReservationExpiresAt"),
    // Absent in rows written before S22; a missing answer route is the human prebuffer window.
    answeredByAi = optBoolean("answeredByAi"),
    // Absent in rows written before S38: a pre-S38 call was never phone-originated.
    deviceOriginated = optBoolean("deviceOriginated"),
    outgoingReported = optBoolean("outgoingReported"),
    outgoingPayload = nullableString("outgoingPayload"),
    // Absent in rows written before S72b: keep today's behaviour (media for any ACTIVE incoming).
    remoteAnswered = optBoolean("remoteAnswered", true),
    ownerJoined = optBoolean("ownerJoined"),
)

private fun JSONObject.nullableString(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)
