package org.vodog.gateway

import org.vodog.gateway.media.GatewayProbeNodeOutcomes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class GatewayStatusDisplayTest {
    @Test fun heartbeatAgeIsDerivedFromThePersistedWallClock() {
        val now = 1_800_000_000_000L
        assertNull(gatewayHeartbeatAgeText(null, now))
        assertEquals("上次心跳 刚刚", gatewayHeartbeatAgeText(now, now))
        assertEquals("上次心跳 刚刚", gatewayHeartbeatAgeText(now + 5_000L, now))
        assertEquals("上次心跳 3 秒前", gatewayHeartbeatAgeText(now - 3_000L, now))
        assertEquals("上次心跳 59 秒前", gatewayHeartbeatAgeText(now - 59_999L, now))
        assertEquals("上次心跳 1 分钟前", gatewayHeartbeatAgeText(now - 60_000L, now))
        assertEquals("上次心跳 2 小时前", gatewayHeartbeatAgeText(now - 7_200_000L, now))
        assertEquals("上次心跳 1 天前", gatewayHeartbeatAgeText(now - 86_400_000L, now))
    }

    /** S20 D7 split the one run-on subtitle into a heartbeat line plus separate capability pills. */
    @Test fun heroSubtitleKeepsOnlyTheHeartbeatLineOrItsPlaceholder() {
        assertEquals("上次心跳 3 秒前", gatewayHeroSubtitle("上次心跳 3 秒前", ServerConnection.ONLINE))
        assertEquals("尚未收到心跳", gatewayHeroSubtitle(null, ServerConnection.CONNECTING))
        assertEquals("尚未收到心跳", gatewayHeroSubtitle(null, ServerConnection.OFFLINE))
        assertEquals(
            "使用 Pixel 本机接打电话和收发短信",
            gatewayHeroSubtitle("上次心跳 3 秒前", ServerConnection.DISABLED),
        )
        assertEquals("请先置入管理员发放的设备凭据", gatewayHeroSubtitle(null, ServerConnection.UNPAIRED))
    }

    @Test fun capabilityPillsStillComeFromTheAdvertisedHeartbeatDetail() {
        val ready = gatewayConnectionDetail(true, true, 2, probeRefreshFailed = false, syncFailureDetail = null)
        assertEquals(listOf("短信可用", "远程通话可用"), gatewayCapabilityPills(ready))
        assertEquals(
            listOf("短信未就绪", "远程通话尚未就绪"),
            gatewayCapabilityPills(gatewayConnectionDetail(false, false, null, false, null)),
        )
        // Neither the SIM count nor a diagnostic segment may leak into the pills.
        assertEquals(
            listOf("短信可用", "远程通话尚未就绪"),
            gatewayCapabilityPills(gatewayConnectionDetail(true, false, 2, true, "设备状态同步失败")),
        )
        assertEquals(emptyList<String>(), gatewayCapabilityPills(""))
    }

    /** The network card must not repeat what the hero already shows, but must keep the rest. */
    @Test fun connectionDetailExtrasKeepOnlyWhatTheHeroDoesNotShow() {
        assertEquals(
            emptyList<String>(),
            gatewayConnectionDetailExtras(gatewayConnectionDetail(true, true, null, false, null)),
        )
        assertEquals(
            listOf("已同步 2 张 SIM", "媒体探测刷新失败（已保留既有可达证据）", "设备状态同步失败"),
            gatewayConnectionDetailExtras(gatewayConnectionDetail(true, false, 2, true, "设备状态同步失败")),
        )
        assertEquals(emptyList<String>(), gatewayConnectionDetailExtras(""))
    }

    @Test fun serverTimestampsAreRenderedInTheDeviceTimeZone() {
        val shanghai = java.time.ZoneId.of("Asia/Shanghai")
        assertEquals(
            "2026-09-11 20:30:00",
            gatewayLocalTimestampText("2026-09-11T12:30:00Z", shanghai),
        )
        assertEquals("时间未知", gatewayLocalTimestampText(null, shanghai))
        assertEquals("时间未知", gatewayLocalTimestampText("  ", shanghai))
        // An unparsable stamp is shown as-is rather than silently dropped.
        assertEquals("稍后补录", gatewayLocalTimestampText("稍后补录", shanghai))
    }

    @Test fun simPillsKeepTheMeaningOfEveryPreviousOwnershipAndModeString() {
        val binding = ServerSimBinding(
            simId = "sim-1", slotIndex = 0, label = "SIM 1", assignmentVersion = 3,
            subscriptionId = 11, phoneAccountHandle = "handle", iccidFingerprint = "f".repeat(64),
            routable = true,
        )
        assertEquals("归属：等待同步", gatewaySimOwnershipLabel(null))
        assertEquals("归属：已分配", gatewaySimOwnershipLabel(binding))
        assertEquals("归属：未分配", gatewaySimOwnershipLabel(binding.copy(routable = false)))

        assertEquals("接听：等待同步", gatewaySimAnswerModeLabel(null))
        val applied = AppliedSimSettings("sim-1", "normal", 30, 1L, 3, 2L)
        assertEquals("接听：普通", gatewaySimAnswerModeLabel(applied))
        assertEquals("接听：AI 代接", gatewaySimAnswerModeLabel(applied.copy(mode = "ai")))
        assertEquals("接听：30 秒转 AI", gatewaySimAnswerModeLabel(applied.copy(mode = "timeout_ai")))
    }

    @Test fun probeRowsAndValidityAreRenderedWithoutThrowing() {
        assertEquals(
            "relay-node：成功 3 · 超时 0 · 网络错误 0",
            gatewayProbeNodeLine(GatewayProbeNodeOutcomes("relay-node", 3, 0, 0)),
        )
        val now = Instant.parse("2026-09-11T00:00:00Z")
        assertEquals("无有效期", gatewayProbeValidityText(null, now))
        assertEquals("无有效期", gatewayProbeValidityText("not-a-time", now))
        assertEquals("有效期剩余 30 秒", gatewayProbeValidityText("2026-09-11T00:00:30Z", now))
        assertEquals("有效期已过 15 秒", gatewayProbeValidityText("2026-09-10T23:59:45Z", now))
    }

    /** The colour boundary is the heartbeat's own refresh lead, so the two cannot drift apart. */
    @Test fun probeEvidenceFreshnessSplitsAtTheHeartbeatRefreshLead() {
        val now = Instant.parse("2026-09-11T00:00:00Z")
        assertEquals(20L, PROBE_REFRESH_AHEAD_SECONDS)
        assertEquals(GatewayProbeFreshness.UNKNOWN, gatewayProbeFreshness(null, now))
        assertEquals(GatewayProbeFreshness.UNKNOWN, gatewayProbeFreshness("not-a-time", now))
        assertEquals(GatewayProbeFreshness.FRESH, gatewayProbeFreshness("2026-09-11T00:00:21Z", now))
        assertEquals(GatewayProbeFreshness.EXPIRING, gatewayProbeFreshness("2026-09-11T00:00:20Z", now))
        assertEquals(GatewayProbeFreshness.EXPIRING, gatewayProbeFreshness("2026-09-11T00:00:00Z", now))
        assertEquals(GatewayProbeFreshness.EXPIRED, gatewayProbeFreshness("2026-09-10T23:59:59Z", now))
    }

    @Test fun replayHorizonAndBuildGateSummariesCoverEveryState() {
        assertEquals("未启用或暂不可读", gatewayReplayHorizonSummary(null))
        val state = ReplayHorizonState("gateway", 2L, 7L, 3L, "digest", 5L, 3L, "digest", true, false)
        assertEquals("已就绪（阻断序号 7 · 已提交 5）", gatewayReplayHorizonSummary(state))
        assertEquals("登记中（阻断序号 7）", gatewayReplayHorizonSummary(state.copy(ready = false)))
        assertEquals("已隔离，需人工处理", gatewayReplayHorizonSummary(state.copy(quarantined = true)))
        assertEquals("已开启", gatewayBuildGateLabel(true))
        assertEquals("未开启", gatewayBuildGateLabel(false))
    }
}
