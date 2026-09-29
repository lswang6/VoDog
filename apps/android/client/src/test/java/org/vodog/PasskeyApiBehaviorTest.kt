package org.vodog

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class PasskeyApiBehaviorTest {
    @Test fun authenticationPassesServerOptionsToCredentialManagerAndPostsItsAssertionVerbatim() {
        val requests = mutableListOf<ClientRequest>()
        val options = JSONObject()
            .put("challenge", "challenge-1")
            .put("rpId", "control.example.com")
            .put("allowCredentials", JSONArray())
        val assertion = JSONObject()
            .put("id", "credential-id")
            .put("rawId", "credential-id")
            .put("type", "public-key")
            .put("response", JSONObject().put("clientDataJSON", "signed-client-data"))
        val api = ClientApi(transport = ClientTransport { request ->
            requests += request
            when (request.path) {
                ClientApiRoutes.PASSKEY_AUTH_OPTIONS -> JSONObject()
                    .put("challengeId", "00000000-0000-4000-8000-000000000001")
                    .put("options", options)
                ClientApiRoutes.PASSKEY_AUTH_VERIFY -> JSONObject()
                    .put("token", "passkey-access")
                    .put("refreshToken", "passkey-refresh")
                    .put("user", JSONObject().put("username", "alice@example.test").put("role", "admin"))
                else -> error("unexpected ${request.path}")
            }
        })

        val challenge = api.passkeyAuthenticationOptions(" Alice@Example.Test ")
        val session = api.verifyPasskeyAuthentication(challenge.challengeId, assertion.toString())

        assertEquals(options.toString(), challenge.requestJson)
        assertEquals("Alice@Example.Test", requests[0].body!!.getString("username"))
        assertNull(requests[0].bearerToken)
        assertEquals("android", requests[1].body!!.getString("platform"))
        assertEquals(assertion.toString(), requests[1].body!!.getJSONObject("response").toString())
        assertNull(requests[1].bearerToken)
        assertEquals(Session("passkey-access", "passkey-refresh", "alice@example.test", "admin"), session)
    }

    @Test fun registrationUsesTheSharedSessionRefreshAndNeverReinstallsAResultAfterLogout() {
        val old = Session("old-access", "old-refresh", "alice@example.test")
        val refreshed = Session("new-access", "new-refresh", old.username)
        val sessions = SessionCoordinator(old)
        val refreshStarted = CountDownLatch(1)
        val releaseRefresh = CountDownLatch(1)
        val registrationOptions = JSONObject().put("challenge", "register-challenge")
        val api = ClientApi(sessions, ClientTransport { request ->
            when (request.path) {
                ClientApiRoutes.PASSKEY_REGISTER_OPTIONS -> {
                    if (request.bearerToken == old.token) throw ApiError(401, "UNAUTHORIZED", "expired")
                    assertEquals(refreshed.token, request.bearerToken)
                    JSONObject()
                        .put("challengeId", "00000000-0000-4000-8000-000000000002")
                        .put("options", registrationOptions)
                }
                ClientApiRoutes.REFRESH -> {
                    refreshStarted.countDown()
                    assertTrue(releaseRefresh.await(5, TimeUnit.SECONDS))
                    JSONObject().put("token", refreshed.token).put("refreshToken", refreshed.refreshToken)
                }
                else -> error("unexpected ${request.path}")
            }
        })
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<PasskeyChallenge> { api.passkeyRegistrationOptions() }
            assertTrue(refreshStarted.await(5, TimeUnit.SECONDS))
            sessions.clear()
            releaseRefresh.countDown()

            val cause = runCatching { result.get(5, TimeUnit.SECONDS) }.exceptionOrNull()?.cause
            assertTrue(cause is SessionChangedException)
            assertNull(sessions.snapshot().session)
        } finally {
            executor.shutdownNow()
        }
    }

    @Test fun registrationPostsTheCredentialManagerAttestationWithTheCurrentBearer() {
        val current = Session("access", "refresh", "alice@example.test")
        val sessions = SessionCoordinator(current)
        val attestation = JSONObject()
            .put("id", "new-credential")
            .put("rawId", "new-credential")
            .put("type", "public-key")
            .put("response", JSONObject().put("attestationObject", "attestation"))
        var verifyRequest: ClientRequest? = null
        val api = ClientApi(sessions, ClientTransport { request ->
            when (request.path) {
                ClientApiRoutes.PASSKEY_REGISTER_VERIFY -> {
                    verifyRequest = request
                    JSONObject().put("verified", true)
                }
                else -> error("unexpected ${request.path}")
            }
        })

        assertTrue(api.verifyPasskeyRegistration("00000000-0000-4000-8000-000000000003", attestation.toString()))

        val sent = checkNotNull(verifyRequest)
        assertEquals(current.token, sent.bearerToken)
        assertEquals(attestation.toString(), sent.body!!.getJSONObject("response").toString())
        assertEquals("00000000-0000-4000-8000-000000000003", sent.body.getString("challengeId"))
        assertSame(current, sessions.snapshot().session)
    }

    @Test fun listParsesPreMigrationRowsWithNullsBesideFullMetadataRows() {
        val legacy = JSONObject()
            .put("id", "b2xkLXJvdw")
            .put("createdAt", "2025-01-02T03:04:05.000Z")
            .put("deviceType", JSONObject.NULL)
            .put("backedUp", JSONObject.NULL)
            .put("transports", JSONObject.NULL)
            .put("label", JSONObject.NULL)
            .put("displayName", JSONObject.NULL)
            .put("aaguid", JSONObject.NULL)
            .put("clientPlatform", JSONObject.NULL)
            .put("authenticatorAttachment", JSONObject.NULL)
            .put("lastUsedAt", JSONObject.NULL)
        val current = JSONObject()
            .put("id", "bmV3LXJvdw")
            .put("createdAt", "2026-02-03T04:05:06.000Z")
            .put("deviceType", "multiDevice")
            .put("backedUp", true)
            .put("transports", JSONArray().put("internal").put("hybrid"))
            .put("label", "工作手机")
            .put("displayName", "iCloud Keychain")
            .put("aaguid", "fbfc3007-154e-4ecc-8c0b-6e020557d7bd")
            .put("clientPlatform", "iOS App")
            .put("authenticatorAttachment", "platform")
            .put("lastUsedAt", "2026-03-04T05:06:07.000Z")
        var listPath: String? = null
        val api = ClientApi(
            SessionCoordinator(Session("access", "refresh", "alice")),
            ClientTransport { request ->
                listPath = request.path
                JSONObject().put("items", JSONArray().put(legacy).put(current))
            },
        )

        val items = api.passkeys()

        assertEquals(ClientApiRoutes.PASSKEYS, listPath)
        assertEquals(2, items.size)
        assertEquals(
            PasskeyItem(id = "b2xkLXJvdw", createdAt = "2025-01-02T03:04:05.000Z"),
            items[0],
        )
        assertEquals(
            PasskeyItem(
                id = "bmV3LXJvdw",
                createdAt = "2026-02-03T04:05:06.000Z",
                deviceType = "multiDevice",
                backedUp = true,
                transports = listOf("internal", "hybrid"),
                label = "工作手机",
                displayName = "iCloud Keychain",
                aaguid = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
                clientPlatform = "iOS App",
                authenticatorAttachment = "platform",
                lastUsedAt = "2026-03-04T05:06:07.000Z",
            ),
            items[1],
        )
    }

    @Test fun listRejectsARowWithoutAnIdInsteadOfRenderingABlankEntry() {
        val api = ClientApi(transport = ClientTransport {
            JSONObject().put("items", JSONArray().put(JSONObject().put("id", "   ")))
        })

        assertThrows(IllegalArgumentException::class.java) { api.passkeys() }
    }

    /**
     * PATCH cannot go through `java.net.HttpURLConnection`; since S30 DELETE cannot either (Android
     * adds a `Content-Type`/`Transfer-Encoding` to a body-less DELETE and Fastify answers 415), so
     * these are the two methods that leave over OkHttp. Both must still carry the same bearer and
     * `Accept`, and must still be replayed by the shared 401 refresh in `request()`.
     */
    @Test fun onlyPatchAndDeleteLeaveOverOkHttp() {
        assertTrue(methodNeedsOkHttp("PATCH"))
        assertTrue(methodNeedsOkHttp("DELETE"))
        assertFalse(methodNeedsOkHttp("GET"))
        assertFalse(methodNeedsOkHttp("POST"))
        assertFalse(methodNeedsOkHttp("PUT"))
    }

    /**
     * 生产事故的钉子：一条 body-less DELETE 必须**一个 body 头都不带**。`Request.Builder.delete()`
     * 会塞一个空 body（于是带上 `Content-Length`/`Content-Type`），所以传输层必须用
     * `method("DELETE", null)`。
     */
    @Test fun aDeleteIsBuiltWithNoBodyAndNoContentType() {
        val request = okHttpClientRequest(
            "https://example.invalid/api/v1",
            ClientRequest("DELETE", "/calls/call-1", null, null, "access-token"),
        )

        assertEquals("DELETE", request.method)
        assertEquals("https://example.invalid/api/v1/calls/call-1", request.url.toString())
        assertNull(request.body)
        assertNull(request.header("Content-Type"))
        assertNull(request.header("Content-Length"))
        assertNull(request.header("Transfer-Encoding"))
        assertEquals("application/json", request.header("Accept"))
        assertEquals("Bearer access-token", request.header("Authorization"))
        // 删除不用幂等键，所以这个头也不该出现。
        assertNull(request.header("Idempotency-Key"))

        // PATCH 那条路一个字没变：还是 JSON body。
        val patch = okHttpClientRequest(
            "https://example.invalid/api/v1",
            ClientRequest("PATCH", "/passkeys/p-1", JSONObject().put("label", "iPad"), "key-1", "access-token"),
        )
        assertEquals("application/json; charset=utf-8", patch.body?.contentType().toString())
        assertEquals("key-1", patch.header("Idempotency-Key"))
    }

    /**
     * 端到端：DELETE 真的从 OkHttp 出去，服务端收到的那条报文里没有 content-type，也没有
     * chunked 编码；204 空体照旧解成空 JSON。
     */
    @Test fun aDeleteReachesTheServerAsABareRequestAndTolerates204() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(204))
            val api = ClientApi(
                SessionCoordinator(Session("access", "refresh", "alice")),
                UrlConnectionClientTransport(
                    connectionFactory = { error("DELETE must not touch HttpURLConnection") },
                    baseUrl = server.url("/api/v1").toString(),
                ),
            )

            api.deleteCall("call-1")

            val sent = server.takeRequest()
            assertEquals("DELETE", sent.method)
            assertEquals("/api/v1/calls/call-1", sent.path)
            assertEquals("Bearer access", sent.getHeader("Authorization"))
            assertEquals("application/json", sent.getHeader("Accept"))
            assertNull(sent.getHeader("Content-Type"))
            assertNull(sent.getHeader("Transfer-Encoding"))
            assertEquals(0L, sent.bodySize)
        }
    }

    /** 同一条路也要照常被共享的 401 刷新重放，并把服务端的错误码原样带出来。 */
    @Test fun aDeleteIsReplayedAfterOneUnauthorizedAndSurfacesTheServerCode() {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse().setResponseCode(401)
                    .setBody(JSONObject().put("error", JSONObject().put("code", "UNAUTHORIZED").put("message", "expired")).toString()),
            )
            server.enqueue(
                MockResponse().setResponseCode(200)
                    .setBody(JSONObject().put("token", "new-access").put("refreshToken", "new-refresh").toString()),
            )
            server.enqueue(
                MockResponse().setResponseCode(409)
                    .setBody(JSONObject().put("error", JSONObject().put("code", "CALL_IN_USE").put("message", "in use")).toString()),
            )
            val sessions = SessionCoordinator(Session("old-access", "old-refresh", "alice"))
            val api = ClientApi(
                sessions,
                UrlConnectionClientTransport(baseUrl = server.url("/api/v1").toString()),
            )

            val error = assertThrows(ApiError::class.java) { api.deleteCall("call-1") }

            assertEquals(409, error.status)
            assertEquals("CALL_IN_USE", error.code)
            assertEquals("DELETE", server.takeRequest().method)
            assertEquals("/api/v1/auth/refresh", server.takeRequest().path)
            val retry = server.takeRequest()
            assertEquals("DELETE", retry.method)
            assertEquals("Bearer new-access", retry.getHeader("Authorization"))
            assertNull(retry.getHeader("Content-Type"))
        }
    }

    @Test fun renameSendsAPatchOverOkHttpAndIsReplayedAfterOneUnauthorized() {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse().setResponseCode(401)
                    .setBody(JSONObject().put("error", JSONObject().put("code", "UNAUTHORIZED").put("message", "expired")).toString()),
            )
            server.enqueue(
                MockResponse().setResponseCode(200)
                    .setBody(JSONObject().put("token", "new-access").put("refreshToken", "new-refresh").toString()),
            )
            server.enqueue(
                MockResponse().setResponseCode(200)
                    .setBody(JSONObject().put("item", JSONObject().put("id", "cGstMQ").put("label", "家里的 iPad")).toString()),
            )
            val sessions = SessionCoordinator(Session("old-access", "old-refresh", "alice"))
            val api = ClientApi(
                sessions,
                UrlConnectionClientTransport(baseUrl = server.url("/api/v1").toString()),
            )

            val accepted = api.renamePasskey("cGstMQ", "家里的 iPad")
            assertEquals("cGstMQ", accepted.id)
            assertEquals("家里的 iPad", accepted.label)

            val first = server.takeRequest()
            assertEquals("PATCH", first.method)
            assertEquals("/api/v1/passkeys/cGstMQ", first.path)
            assertEquals("Bearer old-access", first.getHeader("Authorization"))
            assertEquals("application/json", first.getHeader("Content-Type")?.substringBefore(';'))
            assertEquals("application/json", first.getHeader("Accept"))
            assertEquals("家里的 iPad", JSONObject(first.body.readUtf8()).getString("label"))

            val refresh = server.takeRequest()
            assertEquals("POST", refresh.method)
            assertEquals("/api/v1/auth/refresh", refresh.path)

            val retry = server.takeRequest()
            assertEquals("PATCH", retry.method)
            assertEquals("/api/v1/passkeys/cGstMQ", retry.path)
            assertEquals("Bearer new-access", retry.getHeader("Authorization"))
            assertEquals("家里的 iPad", JSONObject(retry.body.readUtf8()).getString("label"))
            assertEquals("new-refresh", sessions.snapshot().session!!.refreshToken)
        }
    }

    @Test fun renameSurfacesTheServersNotFoundCodeFromTheOkHttpBranch() {
        MockWebServer().use { server ->
            server.enqueue(
                MockResponse().setResponseCode(404)
                    .setBody(JSONObject().put("error", JSONObject().put("code", "NOT_FOUND").put("message", "未找到")).toString()),
            )
            val api = ClientApi(
                SessionCoordinator(Session("access", "refresh", "alice")),
                UrlConnectionClientTransport(baseUrl = server.url("/api/v1").toString()),
            )

            val error = assertThrows(ApiError::class.java) { api.renamePasskey("cGstMQ", "名称") }

            assertEquals(404, error.status)
            assertEquals("NOT_FOUND", error.code)
            assertEquals("未找到", error.message)
        }
    }

    @Test fun deleteAcceptsAnEmptyTwoHundredFourBody() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(204))
            val api = ClientApi(
                SessionCoordinator(Session("access", "refresh", "alice")),
                UrlConnectionClientTransport(baseUrl = server.url("/api/v1").toString()),
            )

            api.deletePasskey("cGstMQ")

            val request = server.takeRequest()
            assertEquals("DELETE", request.method)
            assertEquals("/api/v1/passkeys/cGstMQ", request.path)
            assertEquals("Bearer access", request.getHeader("Authorization"))
        }
    }
}
