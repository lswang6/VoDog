package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** S58 追加：网关类型只换文字；缺失/未知按 pixel，wire 值不变。 */
class S58GatewayKindTest {

    private fun sim(kind: Any?) = JSONObject().put("id", "sim-1").put("gatewayId", "abcdef0123456789")
        .put("gatewayKind", kind ?: JSONObject.NULL).toClientSim()

    private fun pixelDialled(kind: String?) = JSONObject().put("id", "c").put("originatingPlatform", "pixel")
        .apply { if (kind != null) put("gatewayKind", kind) }

    @Test fun missingOrUnknownKindReadsAsPixel() {
        assertEquals(GatewayKind.PIXEL, GatewayKind.of(null))
        assertEquals(GatewayKind.PIXEL, GatewayKind.of("mystery"))
        assertEquals(GatewayKind.PIXEL, sim(null).gatewayKind)
        assertEquals(GatewayKind.DJI4G, sim("dji4g").gatewayKind)
    }

    @Test fun shortLabelsFollowTheKind() {
        assertEquals("PX-abcdef01", sim(null).gatewayShortLabel)
        assertEquals("DJI-abcdef01", sim("dji4g").gatewayShortLabel)
        assertEquals("DJI-abcdef0123456789", sim("dji4g").gatewayFullLabel)
        assertEquals("网关待确认", sim(null).copy(gatewayId = null).gatewayShortLabel)
    }

    @Test fun directDialAndOccupancyWording() {
        assertEquals("通过手机拨打", s38CallBadgeLabel(pixelDialled(null)))
        assertEquals("通过 DJI 4G 模组拨打", s38CallBadgeLabel(pixelDialled("dji4g")))
        assertEquals("手机通话中", callOccupancyLabel(pixelDialled("pixel")))
        assertEquals("DJI 4G 模组通话中", callOccupancyLabel(pixelDialled("dji4g")))
        assertEquals("DJI 4G 模组通话中", callOccupantLabel(pixelDialled("dji4g")))
    }

    @Test fun deviceArchiveLabelChangesButWireValueStaysPixel() {
        assertEquals("Pixel 原始归档", RecordingSource.PIXEL.label(GatewayKind.PIXEL))
        assertEquals("DJI 4G 原始归档", RecordingSource.PIXEL.label(GatewayKind.DJI4G))
        assertEquals("服务器录音", RecordingSource.MEDIA_NODE.label(GatewayKind.DJI4G))
        assertEquals("pixel", RecordingSource.PIXEL.wireValue)
        assertEquals(GatewayKind.DJI4G, parseCallHistoryItem(pixelDialled("dji4g"), null).gatewayKind)
    }

    @Test fun deviceDialledCallsOpenTheDeviceArchiveByDefault() {
        assertEquals(RecordingSource.PIXEL, parseCallHistoryItem(pixelDialled("dji4g"), null).defaultRecordingSource)
        val relayed = JSONObject().put("id", "c").put("originatingPlatform", "ios")
        assertEquals(RecordingSource.MEDIA_NODE, parseCallHistoryItem(relayed, null).defaultRecordingSource)
        assertEquals(RecordingSource.MEDIA_NODE, parseCallHistoryItem(JSONObject().put("id", "c"), null).defaultRecordingSource)
        val report = JSONObject()
            .put("window", JSONObject().put("timeZone", "Asia/Shanghai").put("fromInclusive", "a").put("toExclusive", "b"))
            .put("items", org.json.JSONArray().put(JSONObject().put("callId", "c").put("startedAt", "t").put("direction", "outbound")
                .put("sim", JSONObject().put("id", "s").put("label", "SIM")).put("originatingPlatform", "pixel")))
        assertEquals(RecordingSource.PIXEL, parseCallReport(report).items.single().defaultRecordingSource)
    }
}
