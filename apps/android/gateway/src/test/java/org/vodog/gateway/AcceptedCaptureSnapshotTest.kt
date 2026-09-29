package org.vodog.gateway

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class AcceptedCaptureSnapshotTest {
    @Test fun localActiveMustWaitForAnAcceptedActiveSnapshot() {
        val frozenDialing = JSONObject("""{"calls":[{"callId":"call-a","state":"dialing"}]}""")
        // A concurrently ACTIVE local journal must not turn the earlier frozen payload into evidence.
        assertEquals(emptySet<String>(), activeCallIdsInAcceptedSnapshot(frozenDialing))
        val acceptedActive = JSONObject("""{"calls":[{"callId":"call-a","state":"active"}]}""")
        assertEquals(setOf("call-a"), activeCallIdsInAcceptedSnapshot(acceptedActive))
        assertEquals(emptySet<String>(), activeCallIdsInAcceptedSnapshot(frozenDialing))
    }

    @Test fun onlyBoundActiveCallsQualifyAndDuplicatesCollapse() {
        val snapshot = JSONObject("""{"calls":[
            {"callId":"call-a","state":"active"}, {"callId":"call-a","state":"active"},
            {"callId":"call-b","state":"ringing"}, {"callId":"call-c","state":"dialing"},
            {"callId":null,"state":"active"}, {"state":"active"}, {"callId":"","state":"active"}
        ]}""")
        assertEquals(setOf("call-a"), activeCallIdsInAcceptedSnapshot(snapshot))
        assertEquals(emptySet<String>(), activeCallIdsInAcceptedSnapshot(JSONObject("""{"calls":[]}""")))
    }
}
