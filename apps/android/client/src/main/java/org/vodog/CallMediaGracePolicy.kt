package org.vodog

/**
 * Media-failure grace (S19 port of the iOS MediaGracePolicy): a failed media handshake keeps the
 * call for [GRACE_SECONDS] with a retry choice instead of hanging up; only a server revocation
 * ends it at once. The UI reads [FOOTNOTE] and [GRACE_SECONDS]; the media work package owns the
 * rest of this object.
 */
object CallMediaGracePolicy {
    const val GRACE_SECONDS = 30
    const val FOOTNOTE = "30 秒内未恢复音频将自动结束通话"
    const val GRACE_MILLIS = GRACE_SECONDS * 1_000L

    /** Any status carrying one of these codes means the server already ended or revoked the call. */
    val SERVER_ENDED_CODES: Set<String> = setOf("MEDIA_REVOKED")

    enum class Plan { END_IMMEDIATELY, HOLD_FOR_GRACE }

    fun plan(error: Throwable): Plan =
        if (error is ApiError && error.code in SERVER_ENDED_CODES) Plan.END_IMMEDIATELY
        else Plan.HOLD_FOR_GRACE
}

/**
 * Tracks the single call whose media failure is waiting out the grace window. [consume] succeeds
 * exactly once, and only for the call that is actually pending, so a stale timer can never end a
 * call that has since been replaced, reconnected or stopped.
 */
class CallMediaGraceTracker {
    private var pendingCallId: String? = null

    @Synchronized
    fun isPending(): Boolean = pendingCallId != null

    @Synchronized
    fun pendingCallId(): String? = pendingCallId

    @Synchronized
    fun begin(callId: String) {
        pendingCallId = callId
    }

    @Synchronized
    fun cancel() {
        pendingCallId = null
    }

    @Synchronized
    fun consume(callId: String): Boolean {
        if (pendingCallId != callId) return false
        pendingCallId = null
        return true
    }
}
