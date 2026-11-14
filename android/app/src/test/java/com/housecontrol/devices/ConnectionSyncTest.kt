package com.housecontrol.devices

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** The same cases as Windows' devices.test.cjs and the Mac's DeviceHub stamps. */
class ConnectionSyncTest {
    private var stored = JSONObject()
    private var clock = 1_700_000_000.0
    private val sync = ConnectionSync({ JSONObject(stored.toString()) }, { stored = it }, { clock })
    private var ha: JSONObject? = JSONObject().put("url", "http://lab").put("token", "secret")
    private var hue: JSONObject? = JSONObject().put("host", "bridge").put("key", "private")
    private val platforms = listOf(
        ConnectionSync.Platform("homeassistant", { ha?.let { JSONObject(it.toString()) } }, { ha = it }),
        ConnectionSync.Platform("hue", { hue?.let { JSONObject(it.toString()) } }, { hue = it }),
    )

    @Test fun unstampedPeerFillsInOnlyWhatWasNeverStampedHere() {
        assertTrue(sync.adopt(JSONObject("""{"homeassistant":{"url":"http://old","token":"x"}}"""), platforms))
        assertEquals("http://old", ha?.getString("url"))
        sync.stamp("homeassistant")
        assertFalse(sync.adopt(JSONObject("""{"homeassistant":{"url":"http://lab","token":"secret"}}"""), platforms))
        assertEquals("http://old", ha?.getString("url"))
    }

    @Test fun newerSideWinsAndMissingPlatformIsLeftAlone() {
        sync.stamp("homeassistant")
        val ours = sync.shareable(platforms).getJSONObject("homeassistant").getDouble("updated")
        assertEquals(clock, ours, 0.0)
        assertFalse(sync.adopt(JSONObject().put("homeassistant", JSONObject().put("url", "http://older").put("token", "x").put("updated", ours - 10)), platforms))
        assertTrue(sync.adopt(JSONObject().put("homeassistant", JSONObject().put("url", "http://new").put("token", "t").put("updated", ours + 10)), platforms))
        assertEquals("""{"url":"http://new","token":"t"}""", ha.toString()) // the stamp is not stored in the connection
        assertNotNull(hue)
    }

    @Test fun disconnectsTravelAsRemovedBothWays() {
        sync.stamp("hue")
        val ours = stored.getDouble("hue")
        assertTrue(sync.adopt(JSONObject().put("hue", JSONObject().put("removed", true).put("updated", ours + 5)), platforms))
        assertNull(hue)
        val shared = sync.shareable(platforms).getJSONObject("hue")
        assertTrue(shared.getBoolean("removed")); assertEquals(ours + 5, shared.getDouble("updated"), 0.0)
        // Our own later disconnect beats the computer's older connection.
        clock += 100; ha = null; sync.stamp("homeassistant")
        assertFalse(sync.adopt(JSONObject().put("homeassistant", JSONObject().put("url", "http://new").put("token", "t").put("updated", ours + 50)), platforms))
        assertNull(ha)
    }

    @Test fun stampsAlwaysMoveForward() {
        sync.stamp("hue"); val first = stored.getDouble("hue")
        sync.stamp("hue"); assertTrue(stored.getDouble("hue") > first) // same clock reading
    }
}
