package org.vodog

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S21 §A/§B/§D route shapes. Ids and search terms are user data, so the same "one path segment"
 * guarantee the S18 passkey routes have applies here too.
 */
class ContactApiRoutesTest {
    @Test fun `contact ids stay inside one path segment`() {
        assertEquals("/contacts/a%2Fb%20c", ClientApiRoutes.contact("a/b c"))
        assertEquals("/contacts/a%2Fb/phones", ClientApiRoutes.contactPhones("a/b"))
        assertEquals("/blocklist/a%2Fb", ClientApiRoutes.blocklistEntry("a/b"))
        assertEquals("/gateways/a%2Fb/power", ClientApiRoutes.gatewayPower("a/b"))
        assertEquals("/calls/a%2Fb/ai-transcript", ClientApiRoutes.aiTranscript("a/b"))
        assertEquals("/contacts/a%2Fb?expectedVersion=7", ClientApiRoutes.contact("a/b", 7))
    }

    @Test fun `contact replace and delete carry their frozen versions`() {
        val requests = mutableListOf<ClientRequest>()
        val api = ClientApi(transport = ClientTransport { request ->
            requests += request
            if (request.method == "PUT") {
                JSONObject().put("item", JSONObject().put("id", "c-1").put("displayName", "张三").put("version", 5))
            } else JSONObject()
        })
        val draft = ContactDraft("张三", phones = listOf(ContactPhoneDraft("186")))

        api.updateContact("c-1", draft, expectedVersion = 4)
        api.deleteContact("c-1", expectedVersion = 5)

        assertEquals(4L, requests[0].body!!.getLong("expectedVersion"))
        assertEquals("/contacts/c-1", requests[0].path)
        assertEquals("/contacts/c-1?expectedVersion=5", requests[1].path)
        assertNull(requests[1].body)
    }

    @Test fun `provider update carries the config version and parses the increment`() {
        var captured: ClientRequest? = null
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            JSONObject().put("items", JSONArray()).put("selected", "xai").put("configVersion", 9)
        })
        val result = api.setVoiceProvider("xai", expectedVersion = 8)
        assertEquals(8L, checkNotNull(captured).body!!.getLong("expectedVersion"))
        assertEquals(9L, result.configVersion)
    }

    @Test fun `the contacts list encodes its query and clamps the page size`() {
        assertEquals("/contacts?limit=200&offset=0", ClientApiRoutes.contacts())
        assertEquals("/contacts?limit=50&offset=100", ClientApiRoutes.contacts(limit = 50, offset = 100))
        assertEquals("/contacts?limit=200&offset=0&query=%E5%BC%A0%20%E4%B8%89", ClientApiRoutes.contacts("  张 三  "))
        // A caller cannot page past the server's own cap, and a negative offset is not sent.
        assertEquals("/contacts?limit=200&offset=0", ClientApiRoutes.contacts(limit = 9_999, offset = -5))
    }

    @Test fun `lookup encodes the plus sign so a national number is not smuggled in`() {
        assertEquals("/contacts/lookup?number=%2B8619900000101", ClientApiRoutes.contactLookup("+8619900000101"))
        assertEquals("/contacts/lookup?number=199%200000", ClientApiRoutes.contactLookup("199 0000"))
    }

    @Test fun `the interception route clamps to the contract limit`() {
        assertEquals("/blocklist/interceptions?limit=100", ClientApiRoutes.interceptions())
        assertEquals("/blocklist/interceptions?limit=20", ClientApiRoutes.interceptions(20))
        assertEquals("/blocklist/interceptions?limit=100", ClientApiRoutes.interceptions(5_000))
    }

    @Test fun `blocking a number sends the number and the source call id`() {
        var captured: ClientRequest? = null
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            JSONObject().put("item", JSONObject().put("id", "b-1").put("remoteNumber", "+86186"))
        })
        assertEquals("b-1", api.block("+86186", "call-1", ClientApiRoutes.BLOCK_SCOPE_CALL).getString("id"))
        val sent = checkNotNull(captured)
        assertEquals("POST", sent.method)
        assertEquals("/blocklist", sent.path)
        assertEquals("+86186", sent.body!!.getString("remoteNumber"))
        assertEquals("call-1", sent.body.getString("sourceCallId"))
        assertEquals("call", sent.body.getString("scope"))
        // Blocking from a place with no call behind it omits the optional field entirely.
        api.block("+86186", null, ClientApiRoutes.BLOCK_SCOPE_CALL)
        assertTrue(!checkNotNull(captured).body!!.has("sourceCallId"))
    }

    /** S66: each list is read on its own; an unknown scope never reaches the wire. */
    @Test fun `the blocklist is read per scope`() {
        var captured: ClientRequest? = null
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            JSONObject().put("items", org.json.JSONArray())
        })
        api.blocklist(ClientApiRoutes.BLOCK_SCOPE_CALL)
        assertEquals("/blocklist?scope=call", checkNotNull(captured).path)
        api.blocklist(ClientApiRoutes.BLOCK_SCOPE_SMS)
        assertEquals("/blocklist?scope=sms", checkNotNull(captured).path)
        assertTrue(runCatching { ClientApiRoutes.blocklist("all") }.isFailure)
    }

    @Test fun `unblock is a DELETE that tolerates the 204 empty body`() {
        var captured: ClientRequest? = null
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            JSONObject()
        })
        api.unblock("b-1")
        assertEquals("DELETE", checkNotNull(captured).method)
        assertEquals("/blocklist/b-1", checkNotNull(captured).path)
    }

    @Test fun `the power request only accepts on and off`() {
        val api = ClientApi(transport = ClientTransport { JSONObject().put("item", JSONObject().put("gatewayId", "g-1")) })
        assertEquals("g-1", api.setGatewayPower("g-1", "on").getString("gatewayId"))
        assertThrows(IllegalArgumentException::class.java) { api.setGatewayPower("g-1", "reboot") }
    }

    @Test fun `a null lookup item is a miss, not a parse failure`() {
        val missing = ClientApi(transport = ClientTransport { JSONObject().put("item", JSONObject.NULL) })
        assertNull(missing.lookupContact("+86186"))
        val absent = ClientApi(transport = ClientTransport { JSONObject() })
        assertNull(absent.lookupContact("+86186"))
        val hit = ClientApi(transport = ClientTransport {
            JSONObject().put("item", JSONObject().put("id", "c-1").put("displayName", "张三"))
        })
        assertEquals("张三", checkNotNull(hit.lookupContact("+86186")).toClientContact().displayName)
    }

    @Test fun `the import call returns the server counters untouched`() {
        var captured: ClientRequest? = null
        val api = ClientApi(transport = ClientTransport { request ->
            captured = request
            JSONObject().put("total", 2).put("created", 1).put("merged", 1).put("phonesSkipped", 3)
        })
        val payload = ContactImport.payload(
            listOf(ContactDraft("张三", phones = listOf(ContactPhoneDraft("186")))),
            "device-1",
        )
        val result = api.importContacts(payload)
        assertEquals(ContactImportResult(total = 2, created = 1, merged = 1, phonesSkipped = 3), result)
        assertEquals("/contacts/import", checkNotNull(captured).path)
        assertEquals("android", checkNotNull(captured).body!!.getString("source"))
    }

    @Test fun `collection routes read the items array the contract promises`() {
        val api = ClientApi(transport = ClientTransport { request ->
            when (request.path) {
                "/blocklist/interceptions?limit=100" -> JSONObject().put(
                    "items",
                    JSONArray().put(
                        JSONObject().put("id", "i-1").put("kind", "sms").put("remoteNumber", "106")
                            .put("occurredAt", "2026-09-11T10:00:00.000Z"),
                    ),
                )
                "/gateways/power" -> JSONObject().put(
                    "items",
                    JSONArray().put(JSONObject().put("gatewayId", "g-1").put("online", true)),
                )
                "/calls/call-1/ai-transcript" -> JSONObject().put(
                    "items",
                    JSONArray().put(JSONObject().put("role", "ai").put("text", "你好")),
                )
                else -> JSONObject().put("items", JSONArray())
            }
        })
        assertEquals("i-1", api.interceptions().single().getString("id"))
        assertTrue(api.gatewayPowers().single().toClientGatewayPower().online)
        assertEquals("你好", api.aiTranscript("call-1").single().toAiTranscriptSegment().text)
        assertTrue(api.contacts().isEmpty())
    }
}
