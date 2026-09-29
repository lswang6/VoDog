package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class GatewayReplayHorizonPolicyTest {
    private val identity=GatewayCommandIdentity("gateway-a",2,"a".repeat(64))
    private fun state(blocking:Long=1,prepared:Long=0,digest:String="",committed:Long=1,committedRevision:Long=0,committedDigest:String="",quarantined:Boolean=false)=
        ReplayHorizonState("gateway-a",2,blocking,prepared,digest,committed,committedRevision,committedDigest,true,quarantined)
    private fun proof(phase:String="proposed",from:Long=1,floor:Long=3,revision:Long=1,
                      digest:String="a".repeat(43), counts: Map<String, Long> = mapOf("dial" to floor-from))=
        ReplayHorizonProof(phase,"gateway-a",2,from,floor,revision,digest, floor-from, counts)

    @Test fun lowSequenceAndOldGenerationAreQuarantinedBeforeAnyCoordinator(){
        assertEquals(ReplayCommandGate.RETIRED,replayGate(state(blocking=5),identity,GatewayCommand("old",2,4,payloadJson="not-json")))
        assertEquals(ReplayCommandGate.QUARANTINE,replayGate(state(),identity,GatewayCommand("epoch",1,99,payloadJson="not-json")))
        assertEquals(ReplayCommandGate.BLOCKED,replayGate(state().copy(localBlocked=true),identity,GatewayCommand("blocked",2,99,payloadJson="not-json")))
    }
    @Test fun preparedProofMustBeMonotonicAndCollisionFree(){
        assertNull(validateReplayTransition(state(),proof()))
        assertEquals("horizon_floor_rollback",validateReplayTransition(state(blocking=5,prepared=2,digest="old",committedRevision=2),proof(floor=4,revision=3)))
        assertEquals("horizon_prepared_collision",validateReplayTransition(state(blocking=3,prepared=1,digest="a".repeat(43)),proof(digest="b".repeat(43))))
    }
    @Test fun controlCommitRequiresExactPreparedTuple(){
        assertNull(validateReplayTransition(state(blocking=3,prepared=1,digest="a".repeat(43)),proof(phase="control_committed")))
        assertEquals("horizon_unprepared_commit",validateReplayTransition(state(blocking=3,prepared=1,digest="a".repeat(43)),proof(phase="control_committed",revision=2)))
    }
    @Test fun replayKindsRemainDialAnswerHangupSmsSimSettingsAndDtmf(){
        assertNull(validateReplayTransition(state(),proof(counts=mapOf(
            "dial" to 2,"answer" to 0,"hangup" to 0,"send_sms" to 0,"apply_sim_settings" to 0,"dtmf" to 0,
        ))))
        // S36 C2: a window covering a dtmf command must validate, or the gateway self-quarantines.
        assertNull(validateReplayTransition(state(),proof(counts=mapOf("dial" to 1,"dtmf" to 1))))
        assertEquals("horizon_invalid",validateReplayTransition(state(),proof(counts=mapOf("dial" to 2,"number_blocklist" to 0))))
    }
    @Test fun acceptedTypedNotExecutedAckIsSafeToRetire(){
        assertTrue(replayAcceptedAckSafeToRetire("""{"sideEffectDisposition":"not_executed"}"""))
        assertFalse(replayAcceptedAckSafeToRetire("""{"sideEffectDisposition":"effect_started"}"""))
        assertFalse(replayAcceptedAckSafeToRetire("""{"status":"rejected"}"""))
        assertFalse(replayAcceptedAckSafeToRetire("not-json"))
    }

    @Test fun committedGcKeepsEveryUnsafeRowAndBoundsTenThousandSafeRows(){
        val rows=(1L..10_000L).map{it to (it!=9_999L)}
        assertEquals(listOf(9_999L),retainedLedgerSequences(rows,10_001L))
    }
    @Test fun wireFingerprintMatchesControlForUnicodeEscapesAndNestedKeyOrder(){
        val payload="""{"nested":{"z":true,"a":null},"smsId":"00000000-0000-0000-0000-000000000002","body":"测试 / newline\n","simId":"00000000-0000-0000-0000-000000000003"}"""
        val command=GatewayCommand("00000000-0000-0000-0000-000000000001",2,3,
            kind="send_sms",payloadJson=payload)
        assertEquals("c7kTEi-26T9H54aJkU9-0Tl1qbFisGaFNcUnstqWepA",
            commandReplayFingerprint("00000000-0000-0000-0000-000000000004",command))
    }

    @Test fun canonicalCodecMatchesJsonStringifyForSlashControlsSurrogatesAndNumbers() {
        val raw = """{"slash":"a/b","pair":"😀","lone":"\ud800","controls":"x\n\t\u0001","n1":1.0,"max":9007199254740991,"negzero":-0.0}"""
        assertEquals(
            "{\"controls\":\"x\\n\\t\\u0001\",\"lone\":\"\\ud800\",\"max\":9007199254740991,\"n1\":1,\"negzero\":0,\"pair\":\"😀\",\"slash\":\"a/b\"}",
            canonicalJson(raw),
        )
        listOf(
            "0.5",
            "1.0000000000000000000000000000000001",
            "9007199254740990.9",
            "1e23",
            "5e-324",
            "9007199254740992",
        ).forEach { unsupported ->
            assertThrows(IllegalArgumentException::class.java) {
                canonicalJson("{\"number\":$unsupported}")
            }
        }
    }

    @Test fun canonicalCodecMatchesJavascriptArrayIndexPropertyEnumeration() {
        val raw = """{"nested":{"10":"ten","2":"two","4294967295":"not-index","01":"leading","4294967294":"last-index","0":"zero","a":"letter"}}"""
        assertEquals(
            "{\"nested\":{\"0\":\"zero\",\"2\":\"two\",\"10\":\"ten\",\"4294967294\":\"last-index\",\"01\":\"leading\",\"4294967295\":\"not-index\",\"a\":\"letter\"}}",
            canonicalJson(raw),
        )
        val command = GatewayCommand(
            "00000000-0000-0000-0000-000000000011", 2, 12,
            kind = "apply_sim_settings", payloadJson = raw,
        )
        assertEquals(
            "bETlNVBhyuRiGwUsnwIoddF9CkPTQ95UkHw8iXHbhWE",
            commandReplayFingerprint("00000000-0000-0000-0000-000000000004", command),
        )
    }
}
