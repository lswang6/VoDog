package org.vodog.gateway

import java.time.Instant

/**
 * S20 D7 — "当前占用", derived entirely from what the gateway already knows locally.
 *
 * The source is the device call journal plus the SIM snapshot; nothing here needs a new server field.
 * The client platform that owns the call is deliberately absent: the Pixel cannot know it, and
 * guessing would contradict the control service.
 */
internal data class GatewayOccupancySim(
    val slotIndex: Int,
    /** The HMAC'd handle: the journal stores that form, never the raw `PhoneAccountHandle`. */
    val protectedPhoneAccountHandle: String?,
)

internal data class GatewayOccupancyRow(
    val slotIndex: Int?,
    val direction: DeviceCallDirection,
    val state: DeviceCallState,
    val startedAtMs: Long?,
    /** Last four digits only, e.g. `***0101`; null when the journal has no usable number. */
    val maskedNumber: String?,
)

/** Only a call Telecom currently reports as live counts as occupancy. */
private val OCCUPYING_STATES = setOf(DeviceCallState.RINGING, DeviceCallState.DIALING, DeviceCallState.ACTIVE)

/**
 * Non-terminal journal records, newest first, joined to their SIM slot. Unbound outgoing
 * reservations (state UNKNOWN) are excluded on purpose: a reservation is not yet an occupied SIM.
 */
internal fun gatewayOccupancyRows(
    records: List<DeviceCallRecord>,
    sims: List<GatewayOccupancySim>,
): List<GatewayOccupancyRow> {
    val slotByHandle = sims.mapNotNull { sim ->
        sim.protectedPhoneAccountHandle?.let { it to sim.slotIndex }
    }.toMap()
    return records
        .filter { it.state in OCCUPYING_STATES }
        .map { record ->
            GatewayOccupancyRow(
                slotIndex = record.phoneAccountHandle?.let(slotByHandle::get),
                direction = record.direction,
                state = record.state,
                startedAtMs = gatewayOccupancyStartedAtMs(record),
                maskedNumber = gatewayMaskedTailNumber(record.remoteNumber),
            )
        }
        .sortedByDescending { it.startedAtMs ?: Long.MIN_VALUE }
}

/** Telecom's creation time when it exists; otherwise the first observation of the record. */
internal fun gatewayOccupancyStartedAtMs(record: DeviceCallRecord): Long? =
    record.creationTimeMillis?.takeIf { it > 0L }
        ?: runCatching { Instant.parse(record.observedAt).toEpochMilli() }.getOrNull()

/**
 * The number is app-private and must not be shown in full on a screen anyone can walk up to. The
 * masking matches the admin reports: a fixed prefix plus the last four digits.
 */
internal fun gatewayMaskedTailNumber(number: String?): String? {
    val digits = number?.filter(Char::isDigit).orEmpty()
    return if (digits.length < 4) null else "***${digits.takeLast(4)}"
}

internal fun gatewayCallDirectionLabel(direction: DeviceCallDirection): String = when (direction) {
    DeviceCallDirection.INCOMING -> "来电"
    DeviceCallDirection.OUTGOING -> "去电"
    DeviceCallDirection.UNKNOWN -> "方向未知"
}

internal fun gatewayCallStateLabel(state: DeviceCallState): String = when (state) {
    DeviceCallState.RINGING -> "振铃"
    DeviceCallState.DIALING -> "拨号"
    DeviceCallState.ACTIVE -> "通话中"
    DeviceCallState.ENDED -> "已结束"
    DeviceCallState.UNKNOWN -> "状态未知"
}

/** `SIM 1 · 来电 · 开始于 3 分钟前 · 通话中`. A slot the SIM snapshot cannot name reads as 未知 SIM. */
internal fun gatewayOccupancyLine(row: GatewayOccupancyRow, nowMs: Long): String = listOf(
    row.slotIndex?.let { "SIM ${it + 1}" } ?: "未知 SIM",
    gatewayCallDirectionLabel(row.direction),
    "开始于 ${row.startedAtMs?.let { gatewayRelativeAgeText(it, nowMs) } ?: "时间未知"}",
    gatewayCallStateLabel(row.state),
).joinToString(" · ")

/** The confirmation body for a destructive action while the Pixel is occupied. */
internal fun gatewayOccupancyInterruptionWarning(rows: List<GatewayOccupancyRow>): String? {
    if (rows.isEmpty()) return null
    val names = rows.map { row -> row.slotIndex?.let { "SIM ${it + 1}" } ?: "未知 SIM" }.distinct()
    return "${names.joinToString("、")} 通话中，关闭将中断远程通话。"
}
