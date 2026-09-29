package org.vodog.gateway

import android.telecom.CallAudioState
import android.telecom.VideoProfile
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoSpeakerRevertTest {
    @Test fun speakerDuringVideoRingbackIsReverted() {
        assertTrue(shouldRevertVideoSpeaker(CallAudioState.ROUTE_SPEAKER,
            listOf(VideoProfile.STATE_AUDIO_ONLY, VideoProfile.STATE_RX_ENABLED)))
    }

    @Test fun humanSpeakerOnAudioOnlyCallIsKept() {
        assertFalse(shouldRevertVideoSpeaker(CallAudioState.ROUTE_SPEAKER, listOf(VideoProfile.STATE_AUDIO_ONLY)))
    }

    @Test fun earpieceIsLeftAlone() {
        assertFalse(shouldRevertVideoSpeaker(CallAudioState.ROUTE_EARPIECE, listOf(VideoProfile.STATE_RX_ENABLED)))
    }

    @Test fun noCallsMeansNoRevert() {
        assertFalse(shouldRevertVideoSpeaker(CallAudioState.ROUTE_SPEAKER, emptyList()))
    }
}
