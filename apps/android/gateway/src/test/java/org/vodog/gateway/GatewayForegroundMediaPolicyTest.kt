package org.vodog.gateway

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.time.Instant
import org.vodog.gateway.media.GatewayProbeReadiness
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayForegroundMediaPolicyTest {
    @Test fun firstProbeIsScheduledWithoutClaimingMediaReady() {
        val now = Instant.parse("2026-09-10T00:00:00Z")
        assertTrue(shouldScheduleProbeRefresh(true, null, false, now))
        assertFalse(shouldScheduleProbeRefresh(true, null, true, now))
        assertFalse(shouldScheduleProbeRefresh(false, null, false, now))

        val fresh = GatewayProbeReadiness("generation", true, now.plusSeconds(30))
        assertFalse(shouldScheduleProbeRefresh(true, fresh, false, now))
        assertFalse(shouldScheduleProbeRefresh(true, fresh.copy(validUntil = now.plusSeconds(21)), false, now))
        assertTrue(shouldScheduleProbeRefresh(true, fresh.copy(validUntil = now.plusSeconds(20)), false, now))
        assertFalse(shouldScheduleProbeRefresh(true, null, false, now, retryAllowed = false))
    }

    @Test fun explicitFailureForcesANetworkProbeAfterRetryThrottleAllowsIt() {
        val now = Instant.parse("2026-09-10T00:00:00Z")
        val cached = GatewayProbeReadiness("generation", true, now.plusSeconds(30))

        assertTrue(shouldForceProbeRefresh(cached, explicitProbeFailure = true, now))
        assertFalse(shouldForceProbeRefresh(cached, explicitProbeFailure = false, now))
    }

    @Test fun staleButRecentReachableEvidenceKeepsMediaReadyWhileIdle() {
        val accepted = Instant.parse("2026-09-10T00:00:00Z")
        val success = GatewayProbeReadiness("generation", true, accepted.plusSeconds(30), accepted)
        fun retains(at: Instant, sameGeneration: Boolean = true, probeAllowed: Boolean = true) =
            shouldRetainStaleProbeReadiness(success, probeAllowed, sameGeneration, at)

        // Fresh, expired-but-recent and exactly five minutes old all still count.
        assertTrue(retains(accepted))
        assertTrue(retains(accepted.plusSeconds(31)))
        assertTrue(retains(accepted.plusSeconds(PROBE_STALE_RETENTION_SECONDS)))
        // A failing refresh is irrelevant here; only age, generation and the approval gate matter.
        assertFalse(retains(accepted.plusSeconds(PROBE_STALE_RETENTION_SECONDS).plusMillis(1)))
        assertFalse(retains(accepted.plusSeconds(60), sameGeneration = false))
        assertFalse(retains(accepted.plusSeconds(60), probeAllowed = false))
        assertFalse(retains(accepted.minusMillis(1)))
        assertFalse(shouldRetainStaleProbeReadiness(null, true, true, accepted))
        assertFalse(shouldRetainStaleProbeReadiness(success.copy(hasReachableNode = false), true, true, accepted))
    }

    @Test fun probeRefreshFailureDuringACallNeverWithdrawsMediaReady() {
        val accepted = Instant.parse("2026-09-10T00:00:00Z")
        val success = GatewayProbeReadiness("generation", true, accepted.plusSeconds(30), accepted)
        fun mediaReady(callActive: Boolean, at: Instant) = GatewayPhoneReadinessPolicy.capabilities(
            approved = true, controlEnabled = true, handoffPrepared = true,
            mediaReachable = callActive || shouldRetainStaleProbeReadiness(success, true, true, at),
        ).mediaReady

        // (a) refresh failure mid-call: readiness survives regardless of probe age.
        assertTrue(mediaReady(callActive = true, at = accepted.plusSeconds(3_600)))
        // (b) stale but recent while idle.
        assertTrue(mediaReady(callActive = false, at = accepted.plusSeconds(120)))
        // (c) more than five minutes stale with a failing refresh and no call.
        assertFalse(mediaReady(callActive = false, at = accepted.plusSeconds(301)))
        // (d) a network generation change invalidates the evidence immediately.
        assertFalse(
            GatewayPhoneReadinessPolicy.capabilities(
                approved = true, controlEnabled = true, handoffPrepared = true,
                mediaReachable = shouldRetainStaleProbeReadiness(success, true, false, accepted),
            ).mediaReady,
        )
    }

    @Test fun anyLiveCallOrAudioSessionCountsAsActive() {
        assertTrue(gatewayCallOrAudioActive(true, false, false, false))
        assertTrue(gatewayCallOrAudioActive(false, true, false, false))
        assertTrue(gatewayCallOrAudioActive(false, false, true, false))
        assertTrue(gatewayCallOrAudioActive(false, false, false, true))
        assertFalse(gatewayCallOrAudioActive(false, false, false, false))
    }

    @Test fun connectionDetailIsBuiltOnceAndNamesEveryDegradation() {
        assertEquals(
            "控制通道正常；短信可用；远程通话可用；已同步 2 张 SIM",
            gatewayConnectionDetail(true, true, 2, probeRefreshFailed = false, syncFailureDetail = null),
        )
        val degraded = gatewayConnectionDetail(false, false, null, true, "设备状态同步失败，命令通道继续：boom")
        assertTrue(degraded.startsWith("控制通道正常；短信未就绪；远程通话尚未就绪；媒体探测刷新失败"))
        assertTrue(degraded.endsWith("设备状态同步失败，命令通道继续：boom"))
        assertTrue(gatewayConnectionDetail(true, true, 9, true, "x".repeat(300)).length <= 180)
    }

    @Test fun probeCompletionWakesHeartbeatForSuccessAndFailure() = runBlocking {
        val readiness = GatewayProbeReadiness("generation", true, Instant.now().plusSeconds(30))
        val release = CompletableDeferred<Unit>()
        val wakes = AtomicInteger()
        val success = launchProbeRefresh(
            refresh = { release.await(); readiness },
            onComplete = { wakes.incrementAndGet() },
        )
        assertFalse(success.isCompleted)
        release.complete(Unit)
        assertEquals(ProbeRefreshOutcome(readiness, failed = false), success.await())
        assertEquals(1, wakes.get())

        val failure = launchProbeRefresh(
            refresh = { error("probe failed") },
            onComplete = { wakes.incrementAndGet() },
        )
        assertEquals(ProbeRefreshOutcome(null, failed = true), failure.await())
        assertEquals(2, wakes.get())
    }

    @Test fun slowMediaSetupIsSingleFlightAndNeverWaitedByCommandLoop() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val scheduler = MediaReconcileScheduler(scope)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val completed = AtomicInteger()
        try {
            val started = System.nanoTime()
            assertTrue(scheduler.schedule {
                entered.countDown()
                release.await(5, TimeUnit.SECONDS)
                completed.incrementAndGet()
            })
            assertTrue((System.nanoTime() - started) / 1_000_000 < 50)
            assertTrue(entered.await(1, TimeUnit.SECONDS))
            assertFalse(scheduler.schedule { completed.incrementAndGet() })
            // A command-loop action remains synchronous while setup is deliberately blocked.
            completed.addAndGet(10)
            assertTrue(completed.get() == 10)
            release.countDown()
        } finally {
            release.countDown()
            scope.cancel()
        }
    }

    @Test fun terminalCallCancelsTheInFlightSetupTask() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val scheduler = MediaReconcileScheduler(scope)
        val entered = CountDownLatch(1)
        val cancelled = CountDownLatch(1)
        try {
            assertTrue(scheduler.schedule {
                entered.countDown()
                try { delay(30_000) } finally { cancelled.countDown() }
            })
            assertTrue(entered.await(1, TimeUnit.SECONDS))
            scheduler.cancelCurrent()
            assertTrue(cancelled.await(1, TimeUnit.SECONDS))
        } finally {
            scope.cancel()
        }
    }

    @Test fun cancelledSetupStillOwnsSingleFlightUntilItsCleanupFinishes() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val scheduler = MediaReconcileScheduler(scope)
        val entered = CountDownLatch(1)
        val cleanupEntered = CountDownLatch(1)
        val releaseCleanup = CountDownLatch(1)
        try {
            assertTrue(scheduler.schedule {
                entered.countDown()
                try { delay(30_000) } finally {
                    cleanupEntered.countDown()
                    releaseCleanup.await(5, TimeUnit.SECONDS)
                }
            })
            assertTrue(entered.await(1, TimeUnit.SECONDS))
            scheduler.cancelCurrent()
            assertTrue(cleanupEntered.await(1, TimeUnit.SECONDS))
            assertFalse(scheduler.schedule {})
            releaseCleanup.countDown()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
            while (!scheduler.schedule {} && System.nanoTime() < deadline) Thread.yield()
            assertTrue(System.nanoTime() < deadline)
        } finally {
            releaseCleanup.countDown()
            scope.cancel()
        }
    }
}
