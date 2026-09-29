package org.vodog.gateway

/**
 * Safe product boundary for the privileged audio work proven in BCP.
 *
 * The current app deliberately enables no capture, injection, mute, answer or dial path.
 * SMS code has a separate compile-time approval gate and remains disabled in this build.
 * See THIRD_PARTY.md for provenance and GPL information.
 */
interface TelephonyAudioEndpoint {
    val capability: Capability
    fun start(
        onDownlinkPcm: (ByteArray, Long) -> Unit,
        nextUplinkPcm: () -> ByteArray?,
        onFailure: (Failure) -> Unit = {},
    ): Result<Unit>
    fun stopAndRelease()
    /** S56: an early-media endpoint starts capture only; ACTIVE adds the uplink and a fresh S41 zero-PCM watchdog. */
    fun arm() = Unit
    /** S70 diagnostics: the AudioRecord's actual sample rate, null before capture exists. */
    fun captureSampleRate(): Int? = null

    data class Failure(val stage: Stage, val code: Code) {
        enum class Stage { INITIALIZATION, CAPTURE, PLAYBACK }
        enum class Code { UNAVAILABLE, INITIALIZATION_FAILED, IO_FAILED, CALLBACK_FAILED }
    }

    sealed interface Capability {
        data class Unavailable(val reason: String) : Capability
        data object Ready : Capability
    }
}

class DisabledTelephonyAudioEndpoint : TelephonyAudioEndpoint {
    private val unavailable = TelephonyAudioEndpoint.Capability.Unavailable("本阶段未启用特权蜂窝音频适配器")
    override val capability: TelephonyAudioEndpoint.Capability = unavailable
    override fun start(
        onDownlinkPcm: (ByteArray, Long) -> Unit,
        nextUplinkPcm: () -> ByteArray?,
        onFailure: (TelephonyAudioEndpoint.Failure) -> Unit,
    ) = Result.failure<Unit>(IllegalStateException(unavailable.reason)).also {
        runCatching { onFailure(TelephonyAudioEndpoint.Failure(
            TelephonyAudioEndpoint.Failure.Stage.INITIALIZATION,
            TelephonyAudioEndpoint.Failure.Code.UNAVAILABLE,
        )) }
    }
    override fun stopAndRelease() = Unit
}
