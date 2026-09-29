package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * S39 删除全链路闭合的 Android 用户端一侧：AI 对话浮层按 ID 校验后关闭、导出临时文件的过期规则、
 * 三端一字不差的删除确认文案。
 *
 * [ClientViewModel] 要 `Application` 才能构造（这个模块没有 Robolectric），所以「404 关浮层」分两半
 * 钉：触发条件用假 [ClientTransport] 钉在 [ClientApi.call] 上（404 原样抛成 `ApiError(status=404)`），
 * 落地用纯 reducer [clientStateWithoutAiTranscript] 钉。中间那句
 * `refreshVisibleScope → validateOpenAiTranscript` 的接线只有装机能看见。
 */
class S39DeleteSyncTest {

    private val callId = "11111111-1111-4111-8111-111111111111"

    // ---- §E AI 对话浮层 404 关闭 ---------------------------------------------------------------

    @Test fun aDeletedCallComesBackAsA404FromTheCallRoute() {
        var asked: ClientRequest? = null
        val api = ClientApi(
            SessionCoordinator(Session("access", "refresh", "caller_test")),
            ClientTransport { request ->
                asked = request
                throw ApiError(404, "NOT_FOUND", "call not found")
            },
        )
        val error = assertThrows(ApiError::class.java) { api.call(callId) }
        assertEquals(404, error.status)
        assertEquals("GET", asked?.method)
        assertEquals(ClientApiRoutes.call(callId), asked?.path)
    }

    @Test fun the404ClosesTheOpenAiTranscriptSheetAndSaysWhy() {
        val open = ClientUiState(
            aiTranscriptCallId = callId,
            aiTranscripts = mapOf(
                callId to RemoteResource.Loaded(listOf(ClientAiTranscriptSegment("ai", "喂你好", null))),
                "call-2" to RemoteResource.Loaded(emptyList()),
            ),
        )
        val closed = clientStateWithoutAiTranscript(open, callId)
        assertNull(closed.aiTranscriptCallId)
        assertEquals("这条通话记录已在另一端删除", closed.message)
        assertEquals(CALL_DELETED_ELSEWHERE_MESSAGE, closed.message)
        // 缓存也丢掉：同一个 id 再也读不回内容了，留着只会在重开时显示一份没有出处的对话。
        assertFalse(callId in closed.aiTranscripts)
        assertTrue("call-2" in closed.aiTranscripts)
    }

    @Test fun aLate404NeverClosesTheSheetTheUserOpenedAfterwards() {
        val open = ClientUiState(aiTranscriptCallId = "call-2")
        // 迟到的那条请求说的是另一通，用户已经换看 call-2 了。
        assertSame(open, clientStateWithoutAiTranscript(open, callId))
        assertSame(open, clientStateWithoutAiTranscript(open, ""))
        val nothingOpen = ClientUiState()
        assertSame(nothingOpen, clientStateWithoutAiTranscript(nothingOpen, callId))
    }

    @Test fun deletingTheCallOnThisDeviceAlsoClosesTheSheet() {
        val open = ClientUiState(aiTranscriptCallId = callId)
        assertNull(clientStateWithoutCall(open, callId).aiTranscriptCallId)
        assertEquals(callId, clientStateWithoutCall(open, "call-9").aiTranscriptCallId)
    }

    // ---- §F 导出临时文件的过期规则 -------------------------------------------------------------

    @Test fun exportsOlderThanAnHourAreTheOnlyOnesCollected() {
        val now = 1_800_000_000_000L
        val hour = RECORDING_EXPORT_TTL_MS
        assertEquals(60 * 60 * 1000L, hour)
        assertEquals("exports", RECORDING_EXPORT_DIR_NAME)
        val dir = Files.createTempDirectory("caller-export-policy").toFile()
        try {
            fun export(name: String, mtime: Long) = File(dir, name).apply {
                writeBytes(byteArrayOf(1, 2, 3))
                setLastModified(mtime)
            }
            // mtime 的分辨率在有些文件系统上是 1–2 秒，所以偏移一律按小时 / 半小时算。
            val stale = export("stale.mp3", now - 2 * hour)
            val fresh = export("fresh.mp3", now - hour / 2)
            val future = export("future.mp3", now + hour)
            val unknown = export("unknown.mp3", 0)

            val expired = expiredRecordingExports(listOf(stale, fresh, future, unknown), now)
            // 读不到 mtime 的当过期处理 —— 这是缓存目录，留着没有意义。
            assertEquals(listOf("stale.mp3", "unknown.mp3"), expired.map(File::getName).sorted())
            assertTrue(expiredRecordingExports(emptyList(), now).isEmpty())
            // 正好到点的那一份还留着（边界不含等号），下一轮才收。
            assertTrue(expiredRecordingExports(listOf(export("edge.mp3", now - hour)), now).isEmpty())
        } finally {
            dir.deleteRecursively()
        }
    }

    // ---- §G 删除确认文案 -----------------------------------------------------------------------

    @Test fun theConfirmCopyNowMentionsThePhonesOwnCallLog() {
        val confirm = callDeleteConfirm()
        assertEquals("删除这条通话记录？", confirm.title)
        assertEquals("录音、转写、报告条目和手机上的通话记录会一起删除，无法恢复。", confirm.message)
        assertEquals("删除", confirm.confirmLabel)
    }
}
