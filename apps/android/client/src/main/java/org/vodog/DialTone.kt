package org.vodog

import android.media.AudioManager
import android.media.ToneGenerator

/**
 * Maps dial-pad keys to Android's DTMF tone constants. `+` is not a DTMF digit and stays silent, which matches the
 * iPhone phone app and the iOS/web dialpads.
 */
internal fun dtmfToneType(key: String): Int? = when (key) {
    "1" -> ToneGenerator.TONE_DTMF_1
    "2" -> ToneGenerator.TONE_DTMF_2
    "3" -> ToneGenerator.TONE_DTMF_3
    "4" -> ToneGenerator.TONE_DTMF_4
    "5" -> ToneGenerator.TONE_DTMF_5
    "6" -> ToneGenerator.TONE_DTMF_6
    "7" -> ToneGenerator.TONE_DTMF_7
    "8" -> ToneGenerator.TONE_DTMF_8
    "9" -> ToneGenerator.TONE_DTMF_9
    "0" -> ToneGenerator.TONE_DTMF_0
    "*" -> ToneGenerator.TONE_DTMF_S
    "#" -> ToneGenerator.TONE_DTMF_P
    else -> null
}

/**
 * Short DTMF key-press feedback for the dialpad. Best-effort: devices without a usable tone generator simply stay
 * silent instead of failing the key press.
 */
class DialTonePlayer {
    private var generator: ToneGenerator? = null
    private var unavailable = false

    fun play(key: String) {
        val tone = dtmfToneType(key) ?: return
        if (unavailable) return
        val active = generator ?: runCatching {
            ToneGenerator(AudioManager.STREAM_DTMF, TONE_VOLUME_PERCENT)
        }.getOrNull()?.also { generator = it }
        if (active == null) {
            unavailable = true
            return
        }
        runCatching { active.startTone(tone, TONE_DURATION_MS) }
    }

    fun release() {
        generator?.release()
        generator = null
    }

    private companion object {
        const val TONE_VOLUME_PERCENT = 80
        const val TONE_DURATION_MS = 120
    }
}
