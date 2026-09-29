package org.vodog.gateway

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** S36b D2: the shape a reader depends on, and the gate that keeps signal events rare. */
class GatewayDeviceStatusTest {
    private fun eventFields(reading: DeviceStatusReading): JSONObject {
        val json = JSONObject()
        deviceStatusFields(reading).forEach { (key, value) -> if (value != null) json.put(key, value) }
        return json
    }

    @Test fun statusNestsWhatItReadAndOmitsWhatItCouldNotRead() {
        val fields = eventFields(DeviceStatusReading(
            batteryLevel = 47, charging = false, batteryTemperatureC = 31.4, batteryHealth = 2,
            thermal = 1, memoryFreeMB = 812L, uptimeS = 4200L, doze = false, powerSave = true,
            standby = "on", connection = "ONLINE",
            transport = "wifi", validated = true, metered = false, downKbps = 43000, upKbps = 21000,
            wifiRssi = -58, callState = 0, audioMode = 3,
            sims = listOf(SimStatusReading(
                slot = 0, carrier = "China Mobile", simState = 5, radio = 13,
                signalLevel = 3, dbm = -91, roaming = false, dataActivity = 0,
            )),
        ))

        assertEquals(47, fields.getJSONObject("battery").getInt("level"))
        assertEquals(31.4, fields.getJSONObject("battery").getDouble("temperatureC"), 0.001)
        assertEquals("wifi", fields.getJSONObject("network").getString("transport"))
        assertEquals(-58, fields.getJSONObject("network").getInt("wifiRssi"))
        assertEquals("on", fields.getString("standby"))
        val sim = fields.getJSONArray("sims").getJSONObject(0)
        assertEquals(0, sim.getInt("slot"))
        assertEquals(3, sim.getInt("signalLevel"))
        assertEquals(-91, sim.getInt("dbm"))

        // No phone permission: `sims` is absent, and so is every other field that could not be read.
        val blind = eventFields(DeviceStatusReading(batteryLevel = 12, uptimeS = 30L))
        assertFalse(blind.has("sims"))
        assertFalse(blind.has("network"))
        assertFalse(blind.has("callState"))
        assertFalse(blind.has("thermal"))
        assertEquals(12, blind.getJSONObject("battery").getInt("level"))
        // An empty list still says "readable, no SIM" - that is not the same as absent.
        assertEquals(0, JSONArray(
            eventFields(DeviceStatusReading(sims = emptyList())).getJSONArray("sims").toString()
        ).length())
    }

    @Test fun cellularWapProxyAndApnRideInTheNetworkGroup() {
        // S53: Unicom `3gwap` forces 192.0.2.172:80 - HTTPS works through it, TURN does not.
        val network = eventFields(DeviceStatusReading(
            transport = "cellular", validated = true, httpProxy = httpProxyLabel("192.0.2.172", 80), apn = "3gwap",
        )).getJSONObject("network")
        assertEquals("192.0.2.172:80", network.getString("httpProxy"))
        assertEquals("3gwap", network.getString("apn"))
        assertTrue(network.getBoolean("validated"))
        assertFalse(eventFields(DeviceStatusReading(transport = "wifi")).getJSONObject("network").has("httpProxy"))
        assertEquals(null, httpProxyLabel("", 0))
        assertEquals(null, httpProxyLabel(null, 80))
        assertEquals("proxy.local", httpProxyLabel("proxy.local", -1))
        // Switching APN is a level change, so it logs at once.
        assertFalse(deviceStatusLevels(DeviceStatusReading(apn = "3gwap")) == deviceStatusLevels(DeviceStatusReading(apn = "3gnet")))
    }

    @Test fun onlyLevelTypeFieldsMakeAnImmediateEvent() {
        val base = DeviceStatusReading(
            batteryLevel = 50, thermal = 0, transport = "cellular",
            sims = listOf(SimStatusReading(slot = 0, signalLevel = 3)),
        )
        // Temperature, free memory, uptime and bandwidth move constantly and must not trigger one.
        assertEquals(
            deviceStatusLevels(base),
            deviceStatusLevels(base.copy(batteryTemperatureC = 40.0, memoryFreeMB = 1L, uptimeS = 9L, downKbps = 7)),
        )
        assertTrue(deviceStatusLevels(base) != deviceStatusLevels(base.copy(batteryLevel = 49)))
        assertTrue(deviceStatusLevels(base) != deviceStatusLevels(
            base.copy(sims = listOf(SimStatusReading(slot = 0, signalLevel = 2)))
        ))
    }

    @Test fun signalGateFiresOncePerChangePerSlot() {
        val gate = SignalLevelGate()
        assertTrue(gate.changed(0, "3"))
        assertFalse(gate.changed(0, "3"))
        assertTrue(gate.changed(0, "2"))
        // A second SIM has its own history: slot 1 at the same level is still news.
        assertTrue(gate.changed(1, "2"))
        assertFalse(gate.changed(1, "2"))
        assertTrue(gate.changed(0, "3"))
    }

    @Test fun `S69 device status logs on change or after the 15 minute fallback only`() {
        val levels = deviceStatusLevels(DeviceStatusReading(batteryLevel = 50))
        val moved = deviceStatusLevels(DeviceStatusReading(batteryLevel = 49))
        assertTrue(deviceStatusDue(levels, null, 0L, null))
        assertFalse(deviceStatusDue(levels, levels, 60_000L, 0L))
        assertFalse(deviceStatusDue(levels, levels, DEVICE_STATUS_FALLBACK_MS - 1, 0L))
        assertTrue(deviceStatusDue(levels, levels, DEVICE_STATUS_FALLBACK_MS, 0L))
        assertTrue(deviceStatusDue(moved, levels, 60_000L, 0L))
        // A clock that went backwards re-anchors instead of going silent.
        assertTrue(deviceStatusDue(levels, levels, 0L, 60_000L))
    }
}
