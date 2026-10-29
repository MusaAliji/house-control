package com.housecontrol.devices

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Regression vectors from core/Tests/HouseCoreTests/DeviceTests.swift. */
class DeviceParityTest {
    private val bulb = setOf("switch_led", "work_mode", "bright_value_v2", "temp_value_v2", "colour_data_v2")
    private val ranges = mapOf("bright_value_v2" to (10.0 to 1000.0), "temp_value_v2" to (0.0 to 1000.0))
    private val infrared = setOf("PowerOn", "PowerOff", "T", "M", "F")

    @Test fun infraredCommandsMatchSwiftOrderingAndValueTypes() {
        val commands = TuyaMapper.acCommands(obj("on" to true, "mode" to "heat", "target" to 24), JSONObject(), infrared)
        assertEquals(3, commands.length())
        assertEquals("PowerOn", commands.getJSONObject(0).getString("code"))
        assertEquals("PowerOn", commands.getJSONObject(0).getString("value"))
        assertEquals("M", commands.getJSONObject(1).getString("code"))
        assertEquals(1, commands.getJSONObject(1).getInt("value"))
        assertEquals("T", commands.getJSONObject(2).getString("code"))
        assertEquals(24, commands.getJSONObject(2).getInt("value"))
        assertEquals(3, TuyaMapper.acCommands(obj("fan" to "high"), JSONObject(), infrared).getJSONObject(0).getInt("value"))
    }

    @Test fun bulbBrightnessUsesActualDeviceRangeAndReadsBack() {
        val commands = TuyaMapper.lightCommands(obj("on" to true, "brightness" to 0.5), JSONObject(), JSONObject(), bulb, ranges)
        assertEquals("switch_led", commands.getJSONObject(0).getString("code"))
        assertEquals(505, commands.getJSONObject(1).getInt("value"))
        val reading = TuyaMapper.lightState(JSONArray("""[{"code":"switch_led","value":true},{"code":"bright_value_v2","value":505}]"""), ranges)
        assertTrue(reading.getBoolean("on"))
        assertEquals(0.5, reading.getDouble("brightness"), 0.001)
        val plug = TuyaMapper.lightCommands(obj("on" to true), JSONObject(), JSONObject(), emptySet(), emptyMap())
        assertEquals("switch_1", plug.getJSONObject(0).getString("code"))
    }

    @Test fun whiteAndColourCommandsSelectWorkModeAndScale() {
        val white = TuyaMapper.lightCommands(obj("temp" to 6500), JSONObject(), JSONObject(), bulb, ranges)
        assertEquals("white", white.getJSONObject(0).getString("value"))
        assertEquals(1000, white.getJSONObject(1).getInt("value"))
        val colour = TuyaMapper.lightCommands(obj("color" to "#ff0000"), obj("brightness" to 0.8), JSONObject(), bulb, ranges)
        assertEquals("colour", colour.getJSONObject(0).getString("value"))
        val hsv = JSONObject(colour.getJSONObject(1).getString("value"))
        assertEquals(0, hsv.getInt("h")); assertEquals(1000, hsv.getInt("s")); assertEquals(800, hsv.getInt("v"))
    }

    @Test fun remoteDefersChangesWhileOffAndReplaysAfterPowerOn() {
        val remote = InfraredRemote(0)
        val sent = mutableListOf<JSONObject>()
        remote.apply("remote", obj("fan" to "high"), obj("on" to false, "fan" to "high")) { sent.add(it) }
        assertTrue(sent.isEmpty())
        remote.apply("remote", obj("on" to true), obj("on" to true, "fan" to "high")) { sent.add(it) }
        assertEquals(listOf("PowerOn", "F"), sent.map { it.getString("code") })
        assertEquals(3, sent[1].getInt("value"))
    }

    @Test fun remoteRecoversFromAutoModeAndRejectsOnlyUnsentFields() {
        val remote = InfraredRemote(0)
        var mode = 2
        val sent = mutableListOf<String>()
        val sender: (JSONObject) -> Unit = { command ->
            val code = command.getString("code")
            sent.add(code)
            if (code == "T" && (mode == 2 || command.getInt("value") == 31)) throw DeviceFailure("Unsupported", "2008")
            if (code == "M") mode = command.getInt("value")
        }
        val state = obj("on" to true, "mode" to "cool", "target" to 25, "fan" to "high")
        remote.apply("remote", obj("target" to 25), state, sender)
        assertEquals("T", sent.first())
        assertTrue(sent.contains("M"))
        assertEquals("T", sent.last())
        try {
            remote.apply("remote", obj("target" to 31), state.copy().put("target", 31), sender)
            fail("Remote accepted unsupported temperature")
        } catch (rejected: DeviceFailure) { assertEquals(listOf("target"), rejected.fields) }
    }

    @Test fun temperatureSensorsAndFeaturesMatchDeviceCapabilities() {
        assertEquals(23.5, TuyaMapper.sensor(JSONArray("""[{"code":"va_temperature","value":235}]"""))!!, 0.001)
        val features = TuyaMapper.features(infrared, mapOf("M" to (0.0 to 1.0), "F" to (0.0 to 2.0)))!!
        assertEquals(listOf("cool", "heat"), features.getJSONArray("modes").strings())
        assertEquals(listOf("auto", "low", "medium"), features.getJSONArray("fans").strings())
        assertFalse(features.getBoolean("sleep")); assertFalse(features.getBoolean("swing"))
    }

    @Test fun encryptedSmartLifeEnvelopeRoundTripsAndRejectsTampering() {
        val requestId = "11111111-2222-3333-4444-555555555555"
        val hash = digest("MD5", requestId + "refresh-token")
        val secret = hmac(requestId, hash).take(16)
        val plain = "{\"homeId\":\"42\"}"
        val cipher = SmartLifeService.Transport.encrypt(plain, secret, "ABCDEFGHJKMN")
        assertEquals(plain, SmartLifeService.Transport.decrypt(cipher, secret))
        assertTrue(cipher.startsWith("QUJDREVGR0hKS01O"))
        val bytes = java.util.Base64.getDecoder().decode(cipher)
        bytes[15] = (bytes[15].toInt() xor 1).toByte()
        assertThrows(Exception::class.java) {
            SmartLifeService.Transport.decrypt(java.util.Base64.getEncoder().encodeToString(bytes), secret)
        }
    }
}
