package org.vodog.gateway.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class GatewayDiagnosticDecoderTest {
    @Test fun probeDiagnosticSurvivesAnEncodeDecodeRoundTrip() {
        val snapshot = GatewayProbeDiagnosticSnapshot(
            generation = "generation-a",
            stage = "accepted",
            optionsStatus = "ok",
            optionsDurationMs = 143L,
            resultsStatus = "http_503",
            resultsDurationMs = 0L,
            nodeOutcomes = listOf(
                GatewayProbeNodeOutcomes("control-node", 3, 0, 0),
                GatewayProbeNodeOutcomes("relay-node", 1, 2, 0),
            ),
            validUntil = "2026-09-11T00:00:30Z",
            localReady = true,
        )
        assertEquals(snapshot, decodeGatewayProbeDiagnostic(encodeGatewayProbeDiagnostic(snapshot)))
    }

    @Test fun probeDiagnosticDecoderToleratesMissingAndHostileFields() {
        assertNull(decodeGatewayProbeDiagnostic("not json"))
        val sparse = decodeGatewayProbeDiagnostic("""{"stage":"options"}""")
        assertEquals("options", sparse?.stage)
        assertEquals("unknown", sparse?.optionsStatus)
        assertNull(sparse?.optionsDurationMs)
        assertNull(sparse?.validUntil)
        assertTrue(sparse?.nodeOutcomes?.isEmpty() == true)
        val clamped = decodeGatewayProbeDiagnostic(
            """{"stage":"accepted","nodes":[{"nodeId":"control-node","ok":99,"timeout":-4,"networkError":2}]}""",
        )
        assertEquals(GatewayProbeNodeOutcomes("control-node", 3, 0, 2), clamped?.nodeOutcomes?.single())
    }

    @Test fun qualityDiagnosticSurvivesAnEncodeDecodeRoundTrip() {
        val snapshot = GatewayMediaQualityDiagnosticSnapshot(
            stage = "accepted",
            networkGeneration = "generation-a",
            measuredAt = Instant.parse("2026-09-11T00:00:00Z"),
            expiresAt = Instant.parse("2026-09-11T00:05:00Z"),
            acceptedCount = 1,
            nodes = listOf(
                GatewayMediaQualityNodeDiagnostic("control-node", "ok", 100, 99, 2000.0, 180.0, 55.0, 4.0),
            ),
        )
        assertEquals(snapshot, decodeGatewayMediaQualityDiagnostic(encodeGatewayMediaQualityDiagnostic(snapshot)))

        val disabled = GatewayMediaQualityDiagnosticSnapshot(
            stage = "disabled",
            networkGeneration = "generation-a",
            measuredAt = Instant.parse("2026-09-11T00:00:00Z"),
        )
        assertEquals(disabled, decodeGatewayMediaQualityDiagnostic(encodeGatewayMediaQualityDiagnostic(disabled)))
    }

    @Test fun qualityStageLabelsAreUserFacingChinese() {
        assertEquals("尚无记录", gatewayMediaQualityStageLabel(null))
        assertEquals("服务端未开启", gatewayMediaQualityStageLabel("disabled"))
        assertEquals("已上报", gatewayMediaQualityStageLabel("accepted"))
        assertEquals("测量失败", gatewayMediaQualityStageLabel("failed"))
        assertEquals("已取消", gatewayMediaQualityStageLabel("cancelled"))
        assertEquals("unknown", gatewayMediaQualityStageLabel("unknown"))
        assertNull(decodeGatewayMediaQualityDiagnostic("{}"))
    }
}
