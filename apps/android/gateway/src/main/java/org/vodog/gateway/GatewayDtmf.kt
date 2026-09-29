package org.vodog.gateway

import org.json.JSONObject
import java.time.Instant

/** One tone, then a gap: without the stop an IVR hears a single long tone instead of two digits. */
internal const val DTMF_TONE_MS = 150L
internal const val DTMF_GAP_MS = 100L

/** Exactly what `Call.playDtmfTone` accepts. `isDigit()` would admit Unicode digits it cannot send. */
internal fun dtmfDigits(raw: String?): String? = raw?.takeIf {
    it.isNotEmpty() && it.length <= 32 && it.all { digit -> digit in '0'..'9' || digit == '*' || digit == '#' }
}

/** The addressed call: the bound one, or the only active call when the payload carries no binding. */
internal fun dtmfDeviceCallId(requested: String?, snapshots: List<TelecomCallSnapshot>): String? =
    requested?.takeIf(String::isNotBlank)
        ?: snapshots.singleOrNull { it.state == ActualTelecomState.ACTIVE }?.localId

internal fun playDtmfDigits(
    digits: String,
    play: (Char) -> Unit,
    stop: () -> Unit,
    sleep: (Long) -> Unit = Thread::sleep,
) = digits.forEach { digit ->
    play(digit)
    sleep(DTMF_TONE_MS)
    stop()
    sleep(DTMF_GAP_MS)
}

/**
 * S36 C2: in-call DTMF. Its own dispatch branch on purpose - a tone is not a call action, so it
 * never enters [CallCommandSpec] or the call-execution journal and the ACK is the whole proof.
 */
class GatewayDtmfCoordinator(
    private val api: GatewayApi,
    private val identity: GatewayCommandIdentity? = null,
    private val replayStore: GatewayReplayHorizonStore? = null,
) {
    fun handle(command: GatewayCommand) {
        val replayEvidence = identity?.let {
            ReplayAckEvidence(command.sequence, commandReplayFingerprint(it.gatewayId, command))
        }
        val payload = runCatching { JSONObject(command.payloadJson) }.getOrNull()
        val digits = dtmfDigits(payload?.optString("digits"))
        val call = dtmfDeviceCallId(payload?.optString("deviceCallId"), GatewayTelecomCallRegistry.snapshots())
            ?.let(GatewayTelecomCallRegistry::call)
        val reason = when {
            digits == null -> "invalid_digits"
            call == null -> "no_call"
            // Tones replayed after the 20 s window land in the wrong IVR menu, which is worse than none.
            command.expiresAt == null || !Instant.parse(command.expiresAt).isAfter(Instant.now()) -> "command_expired"
            else -> null
        }
        if (reason != null) {
            api.ackCommand(command, "rejected",
                JSONObject().put("phase", "not_executed").put("reason", reason), replayEvidence, replayStore)
            return
        }
        val target = checkNotNull(call)
        playDtmfDigits(checkNotNull(digits), target::playDtmfTone, target::stopDtmfTone)
        api.ackCommand(command, "acked", JSONObject().put("digits", digits.length), replayEvidence, replayStore)
    }
}
