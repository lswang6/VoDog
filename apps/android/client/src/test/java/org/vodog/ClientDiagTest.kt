package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * S36 C3 / S36b D1: the diagnostic buffer must never cost the app anything — it drops everything
 * while logged out, what it does keep goes out in POSTs of at most 200 items, and once a POST fails
 * the batch survives on disk instead of vanishing.
 */
class ClientDiagTest {
    @After fun detach() {
        ClientDiag.install(null)
        ClientDiag.storeDir = null
    }

    private fun collector(events: MutableList<JSONObject>, ok: Boolean = true): (JSONArray) -> Boolean = { payload ->
        for (index in 0 until payload.length()) events += payload.getJSONObject(index)
        ok
    }

    private fun tempDir(): File = Files.createTempDirectory("diag").toFile().also { it.deleteOnExit() }

    @Test fun `nothing is recorded while logged out and batches never exceed the contract size`() {
        ClientDiag.install(null)
        repeat(10) { ClientDiag.log("logged.out") }

        val batches = CopyOnWriteArrayList<Int>()
        val done = CountDownLatch(1)
        ClientDiag.install { payload: JSONArray ->
            batches += payload.length()
            if (batches.sum() >= 600) done.countDown()
            true
        }
        repeat(600) { ClientDiag.log("t.event", mapOf("i" to it, "skipped" to null)) }
        ClientDiag.flushNow()

        assertTrue("diag never flushed: $batches", done.await(5, TimeUnit.SECONDS))
        // 退出登录期间的 10 条一条都没留下，登录后的 600 条一条都没丢。
        assertEquals(600, batches.sum())
        assertTrue("batch over 200: $batches", batches.all { it in 1..200 })
    }

    /** S36b D1: 设备与网络画像的字段形状——读不到的字段整键省略，`callId` 只走顶层。 */
    @Test fun `context and snapshot carry the device picture and omit whatever could not be read`() {
        val events = CopyOnWriteArrayList<JSONObject>()
        ClientDiag.install(collector(events))
        ClientDiag.installReaders(
            {
                DiagContextReading(
                    deviceModel = "Pixel 7 Pro",
                    deviceManufacturer = "Google",
                    osVersion = "16",
                    sdkInt = 36,
                    appVersion = "0.13.0-s36b-diag",
                    appBuild = 13,
                    locale = "zh-CN",
                    timeZone = "Asia/Shanghai",
                    pushRegistered = true,
                    micPermission = true,
                    notificationPermission = false,
                    notificationsEnabled = false,
                    installId = "11111111-2222-3333-4444-555555555555",
                )
            },
            {
                DiagSnapshotReading(
                    batteryLevel = 12,
                    batteryCharging = false,
                    thermal = 2,
                    powerSave = true,
                    transport = "cellular",
                    validated = true,
                    metered = true,
                    downKbps = 3_000,
                    upKbps = 900,
                    radio = null,
                    carrier = "CMCC",
                    appState = "fg",
                    inCall = true,
                    callId = "abc-123",
                    mediaState = "CONNECTED",
                    memAvailMB = 512,
                    memTotalMB = 7_800,
                    lowMemory = false,
                    uptimeS = 4_242,
                    seqDropped = 0,
                )
            },
        )

        ClientDiag.refreshContext()
        ClientDiag.refreshContext() // 值没变就不该再发一条
        ClientDiag.snapshot(force = true)
        ClientDiag.flushNow()

        val context = events.single { it.getString("event") == "client.context" }.getJSONObject("fields")
        assertEquals("android", context.getString("platform"))
        assertEquals("Pixel 7 Pro", context.getString("deviceModel"))
        assertEquals(36, context.getInt("sdkInt"))
        assertEquals(13, context.getInt("appBuild"))
        assertEquals("Asia/Shanghai", context.getString("timeZone"))
        assertTrue(context.getBoolean("pushRegistered"))
        assertFalse(context.getBoolean("notificationsEnabled"))
        assertEquals("11111111-2222-3333-4444-555555555555", context.getString("installId"))

        val snapshot = events.single { it.getString("event") == "client.snapshot" }
        assertEquals("abc-123", snapshot.getString("callId"))
        val fields = snapshot.getJSONObject("fields")
        assertEquals(12, fields.getInt("batteryLevel"))
        assertEquals("cellular", fields.getString("transport"))
        assertTrue(fields.getBoolean("metered"))
        assertEquals("CONNECTED", fields.getString("mediaState"))
        assertEquals(4_242, fields.getLong("uptimeS"))
        // 没读到的字段（这台机器没有 READ_PHONE_STATE）整键不出现，callId 不重复进 fields。
        assertFalse(fields.has("radio"))
        assertFalse(fields.has("callId"))
    }

    /** S36b D1: 上传失败不再静默丢——落盘、越 2000 行才算丢、下次登录先把文件传完。 */
    @Test fun `a failed flush survives on disk and uploads first next time`() {
        val dir = tempDir()
        val file = File(dir, "diag-ring.jsonl")
        ClientDiag.storeDir = dir
        ClientDiag.install { _: JSONArray -> false }
        repeat(10) { ClientDiag.log("offline.event", mapOf("i" to it)) }
        ClientDiag.flushNow()
        assertEquals(10, file.readLines().filter { it.isNotBlank() }.size)

        // 2000 行封顶：每轮 30 条（不到自动刷的 50 条）灌到越界为止。
        repeat(70) {
            repeat(30) { i -> ClientDiag.log("offline.event", mapOf("i" to i)) }
            ClientDiag.flushNow()
        }
        val capped = file.readLines().filter { it.isNotBlank() }
        assertEquals(2_000, capped.size)
        assertTrue("越界丢弃必须自报家门", capped.any { it.contains("diag.dropped") })

        val events = CopyOnWriteArrayList<JSONObject>()
        ClientDiag.install(collector(events))
        ClientDiag.uploadPersisted()
        assertEquals(2_000, events.size)
        assertFalse("文件全部上传成功后必须删掉", file.exists())
    }

    /** S36b D1: 断网时同一条路径会每秒失败一次，时间线上只该留「第一条 + 一条带 repeat 的汇总」。 */
    @Test fun `repeated identical api errors collapse into one event with a repeat count`() {
        val events = CopyOnWriteArrayList<JSONObject>()
        ClientDiag.install(collector(events))
        repeat(100) { ClientDiag.logApiError("/calls", 503, "GATEWAY_OFFLINE") }
        ClientDiag.logApiError("/sms", 500, "INTERNAL")
        ClientDiag.flushNow()

        val offline = events.filter { it.getJSONObject("fields").optString("serverCode") == "GATEWAY_OFFLINE" }
        assertEquals("100 次同类失败只能留 2 条: ${events.map { it.getJSONObject("fields") }}", 2, offline.size)
        assertFalse("第一条是即时的，不带 repeat", offline[0].getJSONObject("fields").has("repeat"))
        assertEquals(503, offline[0].getJSONObject("fields").getInt("code"))
        assertEquals(100, offline[1].getJSONObject("fields").getInt("repeat"))
        // 另一条路径是另一个窗口，不会被并进来。
        assertEquals(1, events.count { it.getJSONObject("fields").optString("serverCode") == "INTERNAL" })
    }

    /** S69: 网络层异常按类名分类；协程取消与非 IO 异常不记。 */
    @Test fun `network exceptions map to an errorType and cancellation is never logged`() {
        assertEquals("timeout", networkErrorType(java.net.SocketTimeoutException("read timed out")))
        assertEquals("timeout", networkErrorType(java.io.InterruptedIOException("timeout")))
        assertEquals(null, networkErrorType(java.io.InterruptedIOException("interrupted")))
        assertEquals("dns", networkErrorType(java.net.UnknownHostException("x")))
        assertEquals("tls", networkErrorType(javax.net.ssl.SSLHandshakeException("x")))
        assertEquals("offline", networkErrorType(java.net.ConnectException("refused")))
        assertEquals("other", networkErrorType(java.io.IOException("reset")))
        assertEquals(null, networkErrorType(kotlinx.coroutines.CancellationException("cancelled")))
        assertEquals(null, networkErrorType(org.json.JSONException("bad json")))

        val events = CopyOnWriteArrayList<JSONObject>()
        ClientDiag.install(collector(events))
        repeat(5) { ClientDiag.logNetworkError("/calls?includeBlocked=true", java.net.ConnectException("x"), 12) }
        ClientDiag.logNetworkError("/calls", kotlinx.coroutines.CancellationException("x"), 1)
        ClientDiag.flushNow()
        val errors = events.filter { it.getString("event") == "api.error" }
        assertEquals(2, errors.size)
        val first = errors[0].getJSONObject("fields")
        assertEquals(0, first.getInt("code"))
        assertEquals("offline", first.getString("errorType"))
        assertEquals("号码与 query 保留（S69 决定 6）", "/calls?includeBlocked=true", first.getString("path"))
        assertEquals(5, errors[1].getJSONObject("fields").getInt("repeat"))
        assertTrue(errors.all { it.getString("level") == "warn" })
    }

    /** S69: ui.error_shown 同 (screen, message) 60 秒合并；每条事件带记录时的顶层 appVersion。 */
    @Test fun `ui errors dedupe per screen and message and every event carries appVersion`() {
        val events = CopyOnWriteArrayList<JSONObject>()
        ClientDiag.install(collector(events))
        ClientDiag.screen = "call"
        repeat(3) { ClientDiag.uiErrorShown("vm", "网关离线", "GATEWAY_OFFLINE") }
        ClientDiag.uiErrorShown("vm", "")
        ClientDiag.screen = "sms"
        ClientDiag.uiErrorShown("vm", "网关离线")
        ClientDiag.flushNow()
        val shown = events.filter { it.getString("event") == "ui.error_shown" }
        assertEquals(listOf("call", "sms", "call"), shown.map { it.getJSONObject("fields").getString("screen") })
        assertEquals(3, shown[2].getJSONObject("fields").getInt("repeat"))
        assertEquals("GATEWAY_OFFLINE", shown[0].getJSONObject("fields").getString("code"))
        val version = "${BuildConfig.VERSION_NAME}(${BuildConfig.VERSION_CODE})"
        assertTrue(events.isNotEmpty() && events.all { it.getString("appVersion") == version })
    }

    /** S69：本地/校验提示走 asUiError，原样返回文案并记一条 ui.error_shown；空串不记。 */
    @Test fun `asUiError returns the text unchanged and logs one ui error`() {
        val events = CopyOnWriteArrayList<JSONObject>()
        ClientDiag.install(collector(events))
        ClientDiag.screen = "call"
        assertEquals("请输入对方号码", "请输入对方号码".asUiError("call.validate"))
        assertEquals("", "".asUiError("call.validate"))
        ClientDiag.flushNow()
        val shown = events.filter { it.getString("event") == "ui.error_shown" }
        assertEquals(1, shown.size)
        val fields = shown[0].getJSONObject("fields")
        assertEquals("call.validate", fields.getString("site"))
        assertEquals("请输入对方号码", fields.getString("message"))
        assertEquals("warn", shown[0].getString("level"))
    }
}
