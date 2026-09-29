package org.vodog

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ClientSessionRefreshTest {
    private val original = Session("old-access", "old-refresh", "alice")

    @Test fun refreshNetworkFailureKeepsStoredCredentials() {
        val changes = Collections.synchronizedList(mutableListOf<Session?>())
        val invalidations = AtomicInteger()
        val sessions = SessionCoordinator(original, changes::add) { invalidations.incrementAndGet() }
        val api = ClientApi(sessions, ClientTransport { request ->
            when (request.path) {
                ClientApiRoutes.ME -> throw unauthorized()
                ClientApiRoutes.REFRESH -> throw IOException("offline")
                else -> error("unexpected ${request.path}")
            }
        })

        assertThrows(IOException::class.java) { api.me() }

        assertSame(original, sessions.snapshot().session)
        assertTrue(changes.isEmpty())
        assertEquals(0, invalidations.get())
    }

    @Test fun explicitRefresh401ClearsCredentials() {
        val changes = Collections.synchronizedList(mutableListOf<Session?>())
        val invalidations = AtomicInteger()
        val sessions = SessionCoordinator(original, changes::add) { invalidations.incrementAndGet() }
        val api = ClientApi(sessions, ClientTransport { request ->
            when (request.path) {
                ClientApiRoutes.ME, ClientApiRoutes.REFRESH -> throw unauthorized()
                else -> error("unexpected ${request.path}")
            }
        })

        assertThrows(ApiError::class.java) { api.me() }

        assertNull(sessions.snapshot().session)
        assertEquals(listOf(null), changes)
        assertEquals(1, invalidations.get())
    }

    @Test fun concurrentApiInstancesShareOneRefreshRotation() {
        val refreshCount = AtomicInteger()
        val oldRequests = CountDownLatch(2)
        val refreshStarted = CountDownLatch(1)
        val releaseRefresh = CountDownLatch(1)
        val sessions = SessionCoordinator(original)
        val transport = ClientTransport { request ->
            when (request.path) {
                ClientApiRoutes.ME -> {
                    if (request.bearerToken == original.token) {
                        oldRequests.countDown()
                        throw unauthorized()
                    }
                    assertEquals("new-access", request.bearerToken)
                    JSONObject().put("user", JSONObject().put("username", "alice"))
                }
                ClientApiRoutes.REFRESH -> {
                    refreshCount.incrementAndGet()
                    assertEquals("old-refresh", request.body!!.getString("refreshToken"))
                    refreshStarted.countDown()
                    assertTrue(releaseRefresh.await(5, TimeUnit.SECONDS))
                    refreshResponse()
                }
                else -> error("unexpected ${request.path}")
            }
        }
        val executor = Executors.newFixedThreadPool(2)
        try {
            val first = executor.submit<JSONObject> { ClientApi(sessions, transport).me() }
            val second = executor.submit<JSONObject> { ClientApi(sessions, transport).me() }
            assertTrue(oldRequests.await(5, TimeUnit.SECONDS))
            assertTrue(refreshStarted.await(5, TimeUnit.SECONDS))
            releaseRefresh.countDown()

            assertEquals("alice", first.get(5, TimeUnit.SECONDS).getJSONObject("user").getString("username"))
            assertEquals("alice", second.get(5, TimeUnit.SECONDS).getJSONObject("user").getString("username"))
            assertEquals(1, refreshCount.get())
            assertEquals("new-refresh", sessions.snapshot().session!!.refreshToken)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test fun logoutDropsRefreshResultThatCompletesLater() {
        val changes = Collections.synchronizedList(mutableListOf<Session?>())
        val refreshStarted = CountDownLatch(1)
        val releaseRefresh = CountDownLatch(1)
        val sessions = SessionCoordinator(original, changes::add)
        val api = blockingRefreshApi(sessions, refreshStarted, releaseRefresh)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val request = executor.submit<JSONObject> { api.me() }
            assertTrue(refreshStarted.await(5, TimeUnit.SECONDS))

            sessions.clear()
            releaseRefresh.countDown()

            val cause = assertThrows(Exception::class.java) { request.get(5, TimeUnit.SECONDS) }.cause
            assertTrue(cause is SessionChangedException)
            assertNull(sessions.snapshot().session)
            assertEquals(listOf(null), changes)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test fun accountSwitchDropsPreviousAccountsLateRefresh() {
        val changes = Collections.synchronizedList(mutableListOf<Session?>())
        val refreshStarted = CountDownLatch(1)
        val releaseRefresh = CountDownLatch(1)
        val sessions = SessionCoordinator(original, changes::add)
        val oldEpoch = sessions.snapshot().epoch
        val api = blockingRefreshApi(sessions, refreshStarted, releaseRefresh)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val request = executor.submit<JSONObject> { api.me() }
            assertTrue(refreshStarted.await(5, TimeUnit.SECONDS))
            val bob = Session("bob-access", "bob-refresh", "bob")

            assertTrue(sessions.install(oldEpoch, bob))
            releaseRefresh.countDown()

            val cause = assertThrows(Exception::class.java) { request.get(5, TimeUnit.SECONDS) }.cause
            assertTrue(cause is SessionChangedException)
            assertEquals(bob, sessions.snapshot().session)
            assertEquals(listOf(bob), changes)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test fun logoutAtomicallyReturnsTheSessionItInvalidatedAndRejectsLateLogin() {
        val sessions = SessionCoordinator(original)
        val loginEpoch = sessions.snapshot().epoch

        assertSame(original, sessions.clear())
        assertNull(sessions.snapshot().session)
        assertTrue(!sessions.install(loginEpoch, Session("late-access", "late-refresh", "alice")))
        assertNull(sessions.snapshot().session)
    }

    @Test fun restoredProfileUsesAuthoritativeRoleAndKeepsRefreshedTokens() {
        val sessions = SessionCoordinator(original)
        val expected = sessions.snapshot()
        val api = ClientApi(sessions, ClientTransport { request ->
            when (request.path) {
                ClientApiRoutes.ME -> if (request.bearerToken == "old-access") {
                    throw unauthorized()
                } else {
                    JSONObject().put("user", JSONObject().put("username", "alice").put("role", "admin"))
                }
                ClientApiRoutes.REFRESH -> refreshResponse()
                else -> error("unexpected ${request.path}")
            }
        })

        val profile = api.meProfile(expected)
        val latest = sessions.updateProfile(expected, profile.username, profile.role).session!!

        assertEquals("new-access", latest.token)
        assertEquals("new-refresh", latest.refreshToken)
        assertEquals("admin", latest.role)
        assertEquals(expected.epoch, sessions.snapshot().epoch)
    }

    @Test fun profileUpdateDuringRefreshIsMergedIntoRotatedSession() {
        val refreshStarted = CountDownLatch(1)
        val releaseRefresh = CountDownLatch(1)
        val sessions = SessionCoordinator(original)
        val expected = sessions.snapshot()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val refreshed = executor.submit<SessionSnapshot> {
                sessions.refresh(expected) {
                    refreshStarted.countDown()
                    assertTrue(releaseRefresh.await(5, TimeUnit.SECONDS))
                    Session("new-access", "new-refresh", "alice")
                }
            }
            assertTrue(refreshStarted.await(5, TimeUnit.SECONDS))
            sessions.updateProfile(expected, "alice", "admin")
            releaseRefresh.countDown()

            val latest = refreshed.get(5, TimeUnit.SECONDS).session!!
            assertEquals("new-access", latest.token)
            assertEquals("new-refresh", latest.refreshToken)
            assertEquals("admin", latest.role)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test fun profileUpdateBeforeRefreshDoesNotSkipTokenRotation() {
        val sessions = SessionCoordinator(original)
        val beforeProfile = sessions.snapshot()
        sessions.updateProfile(beforeProfile, "alice", "admin")
        val refreshCount = AtomicInteger()
        val api = ClientApi(sessions, ClientTransport { request ->
            when (request.path) {
                ClientApiRoutes.ME -> if (request.bearerToken == "old-access") {
                    throw unauthorized()
                } else {
                    JSONObject().put("user", JSONObject().put("username", "alice").put("role", "admin"))
                }
                ClientApiRoutes.REFRESH -> {
                    refreshCount.incrementAndGet()
                    refreshResponse()
                }
                else -> error("unexpected ${request.path}")
            }
        })

        api.me()

        assertEquals(1, refreshCount.get())
        assertEquals(Session("new-access", "new-refresh", "alice", "admin"), sessions.snapshot().session)
    }

    @Test fun unauthorizedInvalidationAcceptsProfileOnlyChangeButNotRotatedCredentials() {
        val sessions = SessionCoordinator(original)
        val beforeProfile = sessions.snapshot()
        sessions.updateProfile(beforeProfile, "alice", "admin")
        assertTrue(sessions.invalidate(beforeProfile))
        assertNull(sessions.snapshot().session)

        val rotatedSessions = SessionCoordinator(original)
        val stale = rotatedSessions.snapshot()
        rotatedSessions.refresh(stale) { Session("new-access", "new-refresh", "alice") }
        assertTrue(!rotatedSessions.invalidate(stale))
        assertEquals("new-access", rotatedSessions.snapshot().session!!.token)
    }

    @Test fun lateProfileCannotUpdateSameUsernameRelogin() {
        val sessions = SessionCoordinator(original)
        val stale = sessions.snapshot()
        assertTrue(sessions.install(stale.epoch, Session("replacement-access", "replacement-refresh", "alice")))

        assertThrows(SessionChangedException::class.java) {
            sessions.updateProfile(stale, "alice", "admin")
        }
        assertEquals("", sessions.snapshot().session!!.role)
    }

    @Test fun meProfileRejectsUnknownRole() {
        val sessions = SessionCoordinator(original)
        val api = ClientApi(sessions, ClientTransport {
            JSONObject().put("user", JSONObject().put("username", "alice").put("role", "superuser"))
        })

        assertThrows(IllegalArgumentException::class.java) { api.meProfile(sessions.snapshot()) }
    }

    private fun blockingRefreshApi(
        sessions: SessionCoordinator,
        refreshStarted: CountDownLatch,
        releaseRefresh: CountDownLatch,
    ) = ClientApi(sessions, ClientTransport { request ->
        when (request.path) {
            ClientApiRoutes.ME -> throw unauthorized()
            ClientApiRoutes.REFRESH -> {
                refreshStarted.countDown()
                assertTrue(releaseRefresh.await(5, TimeUnit.SECONDS))
                refreshResponse()
            }
            else -> error("unexpected ${request.path}")
        }
    })

    private fun refreshResponse() = JSONObject()
        .put("token", "new-access")
        .put("refreshToken", "new-refresh")

    private fun unauthorized() = ApiError(401, "UNAUTHORIZED", "expired")
}
