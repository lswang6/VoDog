package org.vodog

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 设置 → SIM 与接听模式 →「应用状态」：保存之后到网关 ack 之间那几秒的全部判断。
 * 关键不变量是「`应用成功` 绝不能由保存前的旧快照印出来」——PUT 只推高 `version`，
 * `appliedVersion` 按设计还是旧的（services/control/test/control.test.ts:312）。
 */
class SettingsApplyPolicyTest {

    private fun applying(target: Long = 2, startedAt: Long = 0) =
        SettingsApplyPolicy.applying(simId = "sim-a", targetVersion = target, nowMs = startedAt)

    // ---- next() ---------------------------------------------------------------------------------

    @Test fun applyingBecomesAppliedOnceTheGatewayVersionCatchesUp() {
        val state = applying()
        assertEquals(
            SettingsApplyState.Applied(2),
            SettingsApplyPolicy.next(state, nowMs = 4_000, appliedVersion = 2, version = 2),
        )
        // 当前设置版本已经超过本次提交，说明另一端覆盖了它，不能把旧选择说成应用成功。
        assertEquals(
            SettingsApplyState.Superseded(2),
            SettingsApplyPolicy.next(state, nowMs = 4_000, appliedVersion = 3, version = 3),
        )
    }

    @Test fun applyingSurvivesTheStaleSnapshotAndEveryTickBeforeTheTimeout() {
        val state = applying()
        // 保存后立刻刷新拿到的旧快照：applied == version，但那是上一版，不能读成已确认。
        assertEquals(state, SettingsApplyPolicy.next(state, nowMs = 100, appliedVersion = 1, version = 1))
        assertEquals(state, SettingsApplyPolicy.next(state, nowMs = 2_000, appliedVersion = null, version = 2))
        assertEquals(
            state,
            SettingsApplyPolicy.next(state, nowMs = SettingsApplyPolicy.TIMEOUT_MS - 1, appliedVersion = 1, version = 2),
        )
    }

    @Test fun applyingTimesOutAtThirtySeconds() {
        assertEquals(30_000L, SettingsApplyPolicy.TIMEOUT_MS)
        assertEquals(2_000L, SettingsApplyPolicy.POLL_INTERVAL_MS)
        assertEquals(
            SettingsApplyState.TimedOut,
            SettingsApplyPolicy.next(applying(), nowMs = SettingsApplyPolicy.TIMEOUT_MS, appliedVersion = 1, version = 2),
        )
        assertEquals(
            SettingsApplyState.TimedOut,
            SettingsApplyPolicy.next(applying(startedAt = 1_000), nowMs = 40_000, appliedVersion = null, version = 2),
        )
    }

    @Test fun aNewerServerVersionSupersedesEvenWhenTheGatewayAckIsAhead() {
        val superseded = SettingsApplyPolicy.next(applying(target = 4), 2_000, appliedVersion = 5, version = 5)
        assertEquals(SettingsApplyState.Superseded(4), superseded)
        assertEquals(
            SettingsApplyLabel("设置已被另一端更新", SettingsApplyTone.WARNING),
            SettingsApplyPolicy.label(superseded, appliedVersion = 5, version = 5),
        )
    }

    @Test fun aPreviouslyAppliedChoiceBecomesSupersededAfterAnotherClientChangesIt() {
        assertEquals(
            SettingsApplyState.Superseded(4),
            SettingsApplyPolicy.next(SettingsApplyState.Applied(4), 9_000, appliedVersion = 5, version = 5),
        )
    }

    @Test fun dirtySimSettingsKeepTheirOriginalCasVersionUntilExplicitReload() {
        assertTrue(simDraftConflicted(6, 5, dirty = true, submittedTargetVersion = null, latchedConflictVersion = null))
        assertFalse(simDraftConflicted(6, 5, dirty = false, submittedTargetVersion = null, latchedConflictVersion = null))
        // A save accepted at version 6 protects that submitted draft while its fresh snapshot arrives.
        assertFalse(simDraftConflicted(6, 5, dirty = true, submittedTargetVersion = 6, latchedConflictVersion = null))
        assertTrue(simDraftConflicted(7, 5, dirty = true, submittedTargetVersion = 6, latchedConflictVersion = null))
        // A 409 latches even when the follow-up GET fails and still shows version 5.
        assertTrue(simDraftConflicted(5, 5, dirty = true, submittedTargetVersion = null, latchedConflictVersion = 6))
        assertTrue(simDraftConflicted(5, 5, dirty = false, submittedTargetVersion = null, latchedConflictVersion = 6))
    }

    @Test fun settledStatesOnlyMoveWhenANewSaveStartsAnotherWait() {
        listOf(
            SettingsApplyState.Idle,
            SettingsApplyState.Applied(9),
            SettingsApplyState.Superseded(8),
            SettingsApplyState.TimedOut,
        ).forEach { settled ->
            assertEquals(settled, SettingsApplyPolicy.next(settled, nowMs = 99_000, appliedVersion = 9, version = 9))
        }
        // 再保存一次 = 新的 Applying（视图模型走的就是这个构造器），于是重新开始等。
        val again = SettingsApplyPolicy.applying("sim-a", targetVersion = 3, nowMs = 60_000)
        assertEquals(60_000L, again.startedAt)
        assertEquals(3L, again.targetVersion)
        assertEquals(
            SettingsApplyState.Applied(3),
            SettingsApplyPolicy.next(again, nowMs = 62_000, appliedVersion = 3, version = 3),
        )
    }

    // ---- label() / subtitle() -------------------------------------------------------------------

    @Test fun labelsAndTonesCoverEveryState() {
        val pending = SettingsApplyPolicy.label(applying(), appliedVersion = 1, version = 2)
        assertEquals("正在应用中…", pending.text)
        assertEquals(SettingsApplyTone.PENDING, pending.tone)

        val success = SettingsApplyPolicy.label(SettingsApplyState.Applied(2), appliedVersion = 2, version = 2)
        assertEquals("应用成功", success.text)
        assertEquals(SettingsApplyTone.SUCCESS, success.tone)

        // 从未保存也能确认（网关早就跟上了）时同样是绿的一行。
        assertEquals(
            SettingsApplyTone.SUCCESS,
            SettingsApplyPolicy.label(SettingsApplyState.Idle, appliedVersion = 7, version = 7).tone,
        )

        listOf(SettingsApplyState.TimedOut, SettingsApplyState.Idle, SettingsApplyState.Applied(2)).forEach { state ->
            val warning = SettingsApplyPolicy.label(state, appliedVersion = 1, version = 2)
            assertEquals("设置已保存，但设备尚未确认应用。", warning.text)
            assertEquals(SettingsApplyTone.WARNING, warning.tone)
        }
        assertEquals(
            SettingsApplyTone.WARNING,
            SettingsApplyPolicy.label(SettingsApplyState.Idle, appliedVersion = null, version = 3).tone,
        )
        // 连 settings 都没有的号码没有“已保存”这回事：不报警告，也不画那一行。
        val none = SettingsApplyPolicy.label(SettingsApplyState.Idle, appliedVersion = null, version = 0)
        assertEquals(SettingsApplyTone.NONE, none.tone)
        assertEquals("", none.text)
    }

    @Test fun successNeverComesFromAStaleSnapshot() {
        // 等待中 + 保存前的快照（applied == version == 1，目标是 2）必须仍然是「正在应用中…」。
        val stale = SettingsApplyPolicy.label(applying(), appliedVersion = 1, version = 1)
        assertEquals("正在应用中…", stale.text)
        assertEquals(SettingsApplyTone.PENDING, stale.tone)
        // 快照追上来之后，即使状态还没被推进，也会自愈成成功——离开页面回来的那一路靠这个。
        val caughtUp = SettingsApplyPolicy.label(applying(), appliedVersion = 2, version = 2)
        assertEquals(SettingsApplyTone.SUCCESS, caughtUp.tone)
    }

    @Test fun subtitleFollowsTheSameThreeOutcomes() {
        assertEquals("正在应用中…", SettingsApplyPolicy.subtitle(applying(), appliedVersion = 1, version = 2))
        assertEquals("网关已确认", SettingsApplyPolicy.subtitle(SettingsApplyState.Idle, appliedVersion = 2, version = 2))
        assertEquals("等待网关确认", SettingsApplyPolicy.subtitle(SettingsApplyState.TimedOut, appliedVersion = 1, version = 2))
    }

    // ---- 契约解析 --------------------------------------------------------------------------------

    @Test fun targetVersionComesFromThePutResponseNotTheStaleAppliedVersion() {
        // control.test.ts:312 的回包形状：新的 version，appliedVersion 仍是 null。
        val response = JSONObject("""{"settings":{"mode":"normal","timeoutSeconds":60,"version":2,"appliedVersion":null}}""")
        assertEquals(2L, SettingsApplyPolicy.targetVersion(response, expectedVersion = 1))
        assertNull(response.simSettingsVersions().appliedVersion)
        assertEquals(2L, response.simSettingsVersions().version)
        // 不回 settings 的旧服务器退回 CAS 的下一格。
        assertEquals(2L, SettingsApplyPolicy.targetVersion(JSONObject(), expectedVersion = 1))
        assertEquals(6L, SettingsApplyPolicy.targetVersion(JSONObject("""{"settings":{"version":5}}"""), expectedVersion = 5))
    }

    @Test fun simSettingsVersionsSeparatesMissingFromZero() {
        val sim = JSONObject("""{"id":"sim-a","settings":{"version":4,"appliedVersion":3}}""")
        assertEquals(SimSettingsVersions(version = 4, appliedVersion = 3), sim.simSettingsVersions())
        assertNull(JSONObject("""{"settings":{"version":4}}""").simSettingsVersions().appliedVersion)
        assertNull(JSONObject("""{"settings":{"version":4,"appliedVersion":null}}""").simSettingsVersions().appliedVersion)
        assertEquals(SimSettingsVersions(0, null), JSONObject("""{"id":"sim-a"}""").simSettingsVersions())
    }

    // ---- 轮询 -----------------------------------------------------------------------------------

    @Test fun watchPollsAtTheApplyCadenceAndStopsOnceTheGatewayConfirms() = runBlocking {
        val gate = Channel<Unit>(Channel.RENDEZVOUS)
        val slept = mutableListOf<Long>()
        var refreshes = 0
        var stillApplying = true
        val scope = CoroutineScope(Job() + Dispatchers.Unconfined)
        val watch = SettingsApplyWatch(
            scope = scope,
            refresh = { refreshes += 1 },
            evaluate = { stillApplying },
            sleep = { slept += it; gate.receive() },
        )

        assertFalse(watch.running)
        watch.start()
        assertTrue(watch.running)
        // 保存那一刻 mutate 已经刷新过一次，所以轮询先等一拍再请求。
        assertEquals(0, refreshes)
        assertEquals(listOf(SettingsApplyPolicy.POLL_INTERVAL_MS), slept)

        gate.send(Unit)
        assertEquals(1, refreshes)
        assertEquals(listOf(2_000L, 2_000L), slept)

        watch.resume()
        assertEquals("已经在等的时候 resume 不该叠第二个 ticker", 1, refreshes)

        stillApplying = false
        gate.send(Unit)
        assertEquals(2, refreshes)
        assertFalse("确认之后就不该再发请求", watch.running)
        assertTrue("收工的轮询没有接收者了", gate.trySend(Unit).isFailure)

        scope.cancel()
    }

    @Test fun watchStopsWithTheSettingsScreenAndCanResumeWhenItComesBack() = runBlocking {
        val gate = Channel<Unit>(Channel.RENDEZVOUS)
        var refreshes = 0
        val scope = CoroutineScope(Job() + Dispatchers.Unconfined)
        val watch = SettingsApplyWatch(
            scope = scope,
            refresh = { refreshes += 1 },
            evaluate = { true },
            sleep = { gate.receive() },
        )

        watch.start()
        watch.stop()
        assertFalse(watch.running)
        assertTrue("停掉的轮询不再收 tick", gate.trySend(Unit).isFailure)
        assertEquals(0, refreshes)

        watch.resume()
        assertTrue("回到设置页要接着等", watch.running)
        gate.send(Unit)
        assertEquals(1, refreshes)

        watch.stop()
        scope.cancel()
    }
}
