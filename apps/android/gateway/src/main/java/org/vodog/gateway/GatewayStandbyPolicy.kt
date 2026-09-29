package org.vodog.gateway

import org.json.JSONObject

/**
 * S21 §D — the standby beacon, expressed as pure decisions so [GatewayStandbyService] holds no policy
 * of its own (the same split [CommandDoorbellPolicy] uses for the command doorbell).
 *
 * Architecture decision 5: while the gateway is OFF and the user has locally allowed remote power-on,
 * the device keeps exactly **one** hanging request alive — `POST /api/v1/gateway/standby`, device
 * credential authenticated, carrying no phone, SMS, media or SIM data. This is the single controlled
 * exception to "OFF = no outbound connection"; turning the local switch off closes the whole owner and
 * restores zero outbound connections.
 */
internal enum class StandbyDisplayState(val label: String) {
    /** The local switch is off, or the gateway is ON and the main service owns the connection. */
    DISABLED("未启用"),
    /** A hanging standby request is in flight. */
    HOLDING("待命中"),
    /** The last attempt failed; the loop is waiting out its backoff. */
    BACKOFF("退避中"),
}

/** Everything the loop carries between rounds. None of it is policy the service decides itself. */
internal data class StandbyState(val consecutiveFailures: Int = 0)

/** What the loop should do for one round. */
internal data class StandbyPlan(val run: Boolean, val holdMs: Int = 0, val backoffMs: Long = 0L)

/** One standby round. `desiredPower` is only ever `"on"`: an OFF request arrives over the heartbeat. */
data class StandbyResult(val desiredPower: String?, val heldMs: Long)

internal object GatewayStandbyPolicy {
    /** The control service's own ceiling (`GATEWAY_STANDBY_MAX_HOLD_MS`). */
    const val HOLD_MS = 20_000

    /** Connect, TLS and the server's own early return all have to fit inside this extra margin. */
    const val REQUEST_MARGIN_MS = 5_000L

    /**
     * The owned OkHttp read timeout for the standby transport. §D requires at least hold + 10 s, and
     * the default 20 s used by every other owner would abort a full-length 20 s hold.
     */
    const val READ_TIMEOUT_SECONDS = 35L

    const val INITIAL_BACKOFF_MS = 2_000L
    const val MAX_BACKOFF_MS = 30_000L

    /**
     * The beacon runs only while the user allows remote power-on *and* the gateway is locally OFF.
     * An enabled gateway already has the heartbeat, which carries `remotePowerAllowed` and delivers
     * the OFF request, so a second connection would be pure duplication.
     */
    fun plan(allowRemotePower: Boolean, controlEnabled: Boolean, state: StandbyState): StandbyPlan {
        if (!allowRemotePower || controlEnabled) return StandbyPlan(run = false)
        return StandbyPlan(run = true, holdMs = HOLD_MS, backoffMs = backoffMs(state.consecutiveFailures))
    }

    /** 2 s, 4 s, 8 s, 16 s, then capped at 30 s. Any accepted round returns to zero. */
    fun backoffMs(consecutiveFailures: Int): Long {
        if (consecutiveFailures <= 0) return 0L
        val steps = (consecutiveFailures - 1).coerceIn(0, 16)
        return (INITIAL_BACKOFF_MS shl steps).coerceAtMost(MAX_BACKOFF_MS)
    }

    fun onSuccess(): StandbyState = StandbyState(consecutiveFailures = 0)

    fun onFailure(state: StandbyState): StandbyState =
        state.copy(consecutiveFailures = (state.consecutiveFailures + 1).coerceAtMost(MAX_COUNTED_FAILURES))

    private const val MAX_COUNTED_FAILURES = 1_000_000
}

/**
 * The outcome of the last remote power request, carried on the *next* standby or heartbeat request and
 * cleared only once that request is accepted. A gate failure (missing permission, unpaired device) is
 * reported with `ok:false` and its reason, so the remote user learns why the gateway stayed off.
 */
internal fun powerResultJson(desired: String, ok: Boolean, reason: String?, at: String): JSONObject {
    require(desired == "on" || desired == "off") { "unknown desired power" }
    return JSONObject()
        .put("desired", desired)
        .put("ok", ok)
        .put("at", at)
        .also { body -> reason?.takeIf(String::isNotBlank)?.let { body.put("reason", it.take(120)) } }
}

internal fun standbyRequestBody(
    holdMs: Int,
    remotePowerAllowed: Boolean,
    lastPowerResult: JSONObject?,
): JSONObject = JSONObject()
    .put("holdMs", holdMs.coerceIn(1, GatewayStandbyPolicy.HOLD_MS))
    .put("remotePowerAllowed", remotePowerAllowed)
    .also { body -> lastPowerResult?.let { body.put("lastPowerResult", it) } }

internal fun parseStandbyResult(response: JSONObject) = StandbyResult(
    desiredPower = parseDesiredPower(response, accepted = "on"),
    heldMs = response.optLong("heldMs", 0L).coerceAtLeast(0L),
)

/**
 * Only the value this caller may act on is accepted; absent, null or anything else reads as "no
 * request". The standby beacon takes `"on"` and the heartbeat takes `"off"` — a mixed-up value must
 * never be able to power the gateway in the direction the channel does not own.
 */
internal fun parseDesiredPower(response: JSONObject, accepted: String): String? =
    response.optString("desiredPower").takeIf { it == accepted }

/** A blocked local OFF reason for the remote user, mapped from the local enable gate. */
internal fun remotePowerBlockedReason(decision: EnableDecision): String? =
    (decision as? EnableDecision.Blocked)?.reason
