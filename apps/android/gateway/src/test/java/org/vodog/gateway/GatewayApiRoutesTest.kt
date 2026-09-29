package org.vodog.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class GatewayApiRoutesTest {
    @Test fun commandIdIsEncodedAsSinglePathSegment() {
        assertEquals(
            "/gateway/commands/a%2Fb%20c/ack",
            GatewayApiRoutes.ack("a/b c"),
        )
    }

    @Test fun commandKeepsFenceAndCursorSeparate() {
        val command = GatewayCommand("id", generation = 7, sequence = 31)
        assertEquals(7L, command.generation)
        assertEquals(31L, command.sequence)
    }

    @Test fun snapshotResponseReadsReleasedCallIdsWithoutPruningWhenMissing() {
        val missing = parseTelecomSnapshotResult(org.json.JSONObject()
            .put("accepted", true).put("replayed", false).put("busyState", "idle"))
        assertEquals(emptyList<String>(), missing.releasedCallIds)
        val present = parseTelecomSnapshotResult(org.json.JSONObject()
            .put("accepted", true).put("replayed", true).put("busyState", "busy")
            .put("releasedCallIds", org.json.JSONArray().put("11111111-1111-4111-8111-111111111111")))
        assertEquals(listOf("11111111-1111-4111-8111-111111111111"), present.releasedCallIds)
        assertEquals(true, present.replayed)
    }

    @Test fun snapshotResponseParsesTheCallLogPurgeQueueTolerantly() {
        val missing = parseTelecomSnapshotResult(org.json.JSONObject()
            .put("accepted", true).put("replayed", false).put("busyState", "idle"))
        assertEquals(emptyList<CallLogPurge>(), missing.callLogPurges)
        val purges = parseTelecomSnapshotResult(org.json.JSONObject()
            .put("accepted", true).put("replayed", false).put("busyState", "idle")
            .put("callLogPurges", org.json.JSONArray()
                .put(org.json.JSONObject().put("purgeId", "p-1").put("callId", "c-1")
                    .put("deviceCallId", org.json.JSONObject.NULL)
                    .put("remoteNumber", "19900000103").put("direction", "incoming")
                    .put("startedAt", "2026-09-18T10:00:00.000Z").put("endedAt", "2026-09-18T10:03:00.000Z"))
                // A JSON null, a missing id, a non-object and an unparsable time each drop only themselves.
                .put(org.json.JSONObject().put("purgeId", "p-2").put("callId", "c-2")
                    .put("remoteNumber", org.json.JSONObject.NULL).put("startedAt", "not-a-time"))
                .put(org.json.JSONObject().put("callId", "c-3"))
                .put(org.json.JSONObject().put("purgeId", "p-4"))
                .put("not-an-object")))
            .callLogPurges
        assertEquals(listOf("p-1", "p-2"), purges.map { it.purgeId })
        assertEquals(
            CallLogPurge("p-1", "c-1", null, "19900000103", "incoming",
                Instant.parse("2026-09-18T10:00:00Z"), Instant.parse("2026-09-18T10:03:00Z")),
            purges.first(),
        )
        assertNull(purges[1].remoteNumber)
        assertNull(purges[1].startedAt)
    }

    @Test fun callLogPurgeAcksPostTheirOwnRouteAndChunkAtFifty() {
        val bodies = mutableListOf<String>()
        val urls = mutableListOf<String>()
        val api = GatewayApi("token", { true }, GatewayHttpTransport {
            urls.add(it.url); bodies.add(String(requireNotNull(it.jsonBody)))
            GatewayHttpResponse(200, """{"accepted":true,"acked":1}""")
        })
        api.ackCallLogPurges(listOf(CallLogPurgeAck("p-1", "deleted", 1), CallLogPurgeAck("p-2", "not_found", 0)))
        assertEquals("/gateway/call-log-purges/ack", GatewayApiRoutes.CALL_LOG_PURGE_ACK)
        assertEquals(1, urls.size)
        assertEquals(true, urls.single().endsWith(GatewayApiRoutes.CALL_LOG_PURGE_ACK))
        val acks = org.json.JSONObject(bodies.single()).getJSONArray("acks")
        assertEquals(2, acks.length())
        assertEquals("p-1", acks.getJSONObject(0).getString("purgeId"))
        assertEquals("deleted", acks.getJSONObject(0).getString("status"))
        assertEquals(1, acks.getJSONObject(0).getInt("deletedRows"))
        assertEquals("not_found", acks.getJSONObject(1).getString("status"))
        assertEquals(0, acks.getJSONObject(1).getInt("deletedRows"))

        bodies.clear(); urls.clear()
        api.ackCallLogPurges((1..60).map { CallLogPurgeAck("p-$it", "not_found", 0) })
        assertEquals(listOf(50, 10), bodies.map { org.json.JSONObject(it).getJSONArray("acks").length() })
        api.ackCallLogPurges(emptyList())
        assertEquals(2, urls.size)
    }

    @Test fun outgoingSmsObservationPostsTheFixedGatewayRouteAndParsesDisposition() {
        lateinit var request: GatewayHttpRequest
        val api = GatewayApi("device-token", { true }, GatewayHttpTransport {
            request = it
            GatewayHttpResponse(202, """{"accepted":true,"replayed":false,"disposition":"local_only"}""")
        })
        val payload = org.json.JSONObject()
            .put("eventId", "11111111-1111-4111-8111-111111111111")
            .put("generation", 4)
            .put("simId", "22222222-2222-4222-8222-222222222222")
            .put("assignmentVersion", 7)
            .put("remoteNumber", "1001298")
            .put("body", "1")
            .put("sentAt", "2026-09-21T06:00:00Z")
        val result = api.reportOutgoingSmsObserved(payload)
        assertEquals(true, request.url.endsWith("/gateway/sms/outgoing-observed"))
        assertEquals("POST", request.method)
        assertEquals("Bearer device-token", request.authorization)
        assertEquals(payload.toString(), String(requireNotNull(request.jsonBody)))
        assertEquals(true, result.accepted)
        assertEquals(false, result.replayed)
        assertEquals("local_only", result.disposition)
        assertNull(result.smsId)
    }

    @Test fun heartbeatIgnoresUnknownKeysExceptOptionalNumberBlocklist() {
        assertEquals(
            null,
            parseNumberBlocklist(org.json.JSONObject().put("unknownExtra", true)),
        )
        val snapshot = parseNumberBlocklist(org.json.JSONObject().put(
            "numberBlocklist",
            org.json.JSONObject().put("version", 4).put(
                "items",
                org.json.JSONArray().put(
                    org.json.JSONObject().put("simId", "11111111-1111-4111-8111-111111111111")
                        .put("numbers", org.json.JSONArray().put("+8619900000101")),
                ),
            ),
        ))
        assertEquals(4L, snapshot?.version)
        assertEquals(listOf("+8619900000101"), snapshot?.items?.single()?.numbers)
        assertEquals(emptyList<String>(), snapshot?.items?.single()?.smsNumbers)
    }

    @Test fun v2HeartbeatAdvertisesDurableDispositionAndParsesExactFinalizedProofs() {
        lateinit var request:GatewayHttpRequest
        val response="""{"gateway":{"id":"g-1","deviceEpoch":2,"serverSequence":1},"commands":[],"replayHorizon":{
          "phase":"proposed","protocolVersion":2,"gatewayId":"gateway-a","generation":2,"fromInclusive":1,
          "retireBeforeSequence":2,"revision":1,"proofDigest":"${"a".repeat(43)}","commandCount":1,
          "kindCounts":{"dial":1},"finalizedProofs":[{"generation":2,"sequence":1,"commandId":"command-a",
          "fingerprint":"${"f".repeat(43)}","kind":"dial","serverStatus":"rejected",
          "serverReason":"media_capability_withdrawn","entryDigest":"${"e".repeat(43)}"}]}}"""
        val state=ReplayHorizonState("gateway-a",2,1,0,"",1,0,"",true,false,localBlocked=true,rejectionReason="local")
        val result=GatewayApi("token",{true},GatewayHttpTransport{request=it;GatewayHttpResponse(200,response)})
            .heartbeat(true,0,replayState=state)
        val body=org.json.JSONObject(String(requireNotNull(request.jsonBody)))
        assertEquals(1,body.getJSONObject("capabilities").getInt("commandReplayHorizonVersion"))
        assertEquals(1,body.getJSONObject("capabilities").getInt("commandReplayFinalizedProofVersion"))
        assertEquals("local_blocked",body.getJSONObject("replayHorizonState").getString("disposition"))
        assertEquals("media_capability_withdrawn",result.replayHorizon?.finalizedProofs?.single()?.serverReason)
    }

    @Test fun controlQuarantineIsTypedAndDoesNotThrowTheHeartbeat() {
        val response="""{"gateway":{"id":"g-1","deviceEpoch":2,"serverSequence":1},"commands":[],
          "replayHorizon":{"phase":"quarantined"}}"""
        val result=GatewayApi("token",{true},GatewayHttpTransport{GatewayHttpResponse(200,response)})
            .heartbeat(true,0)
        assertEquals(true,result.replayHorizonControlQuarantined)
        assertEquals(null,result.replayHorizon)
    }

    @Test fun mediaRoutesEncodeCallIdAsOneSegment() {
        assertEquals("/gateway/calls/a%2Fb/media/options", GatewayApiRoutes.mediaOptions("a/b"))
        assertEquals("/gateway/calls/a%2Fb/recording-archives", GatewayApiRoutes.recordingArchives("a/b"))
        assertEquals("/gateway/recording-archives/id/objects/remote_original.wav.gz", GatewayApiRoutes.recordingArchiveObject("id", "remote_original.wav.gz"))
        assertEquals("/gateway/calls/a%2Fb/media/offer", GatewayApiRoutes.mediaOffer("a/b"))
    }
}
