package com.housecontrol.sync

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.EOFException

class SyncProtocolTest {
    private val key = ByteArray(32) { it.toByte() }
    private fun pairing() = SyncPairing("mac-42", "Musa’s Mac + studio & kitchen", key)

    @Test fun pairingLinkRoundTripsUnicodeAndQueryDelimiters() {
        val original = pairing()
        val decoded = requireNotNull(SyncPairing.parse("  ${original.link}\n"))
        assertEquals(original.id, decoded.id)
        assertEquals(original.name, decoded.name)
        assertArrayEquals(key, decoded.key)
        assertFalse(original.link.contains(' '))
    }
    @Test fun acceptsSwiftUrlComponentsLiteralPlusAndKeepsFirstDuplicate() {
        val link = "housecontrol://pair?v=1&id=first&id=second&name=Mac+Studio&key=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        val parsed = requireNotNull(SyncPairing.parse(link))
        assertEquals("first", parsed.id)
        assertEquals("Mac+Studio", parsed.name)
        assertArrayEquals(key, parsed.key)
    }
    @Test fun rejectsMalformedAndNonPairingLinks() {
        val valid = pairing().link
        val invalid = listOf("", "https://example.com", valid.replace("housecontrol:", "https:"),
            valid.replace("//pair?", "//other?"), valid.replace("v=1", "v=2"),
            "housecontrol://pair?v=1&id=&key=AA", "housecontrol://pair?v=1&id=mac",
            "housecontrol://pair?v=1&id=mac&key=!!!", "housecontrol://pair?v=1&id=mac&key=AA",
            "housecontrol://pair?v=1&id=mac&key=%ZZ")
        invalid.forEach { assertNull(it, SyncPairing.parse(it)) }
    }
    @Test fun missingNameDefaultsToMacAndStandardBase64StorageRoundTrips() {
        val p = requireNotNull(SyncPairing.parse("housecontrol://pair?v=1&id=mac&key=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"))
        assertEquals("Mac", p.name)
        val stored = requireNotNull(SyncPairing.fromJson(pairing().toJson()))
        assertArrayEquals(key, stored.key)
        assertEquals(pairing().name, stored.name)
        assertNull(SyncPairing.fromJson("{}"))
    }
    @Test fun hmacMatchesFixedIndependentVector() {
        // Independently computed HMAC-SHA256(key: bytes 0...31, message: UTF-8 label).
        // Swift CryptoKit uses the same key/message ordering in SyncTransport.parameters.
        val expected = "f752501247f992b8c8a906e77f37d24b3c56baafc89675fec1780ad85a4fb042"
        assertEquals(expected, pairing().derivedKey().joinToString("") { "%02x".format(it.toInt() and 255) })
    }
    @Test fun constructionCopiesCallerKey() {
        val supplied = key.copyOf()
        val p = SyncPairing("mac", "Mac", supplied)
        supplied.fill(0)
        assertArrayEquals(key, p.key)
    }
    @Test fun statePreservesPlanBytesConnectionsAndMissingPlan() {
        val plan = "{\"name\":\"Küche\", \"rooms\":[]}\n"
        val state = requireNotNull(SyncState.fromMessage(JSONObject().put("type", "state").put("mac", "Mac")
            .put("rev", "sha256").put("plan", plan).put("smartLife", true)
            .put("userCode", "account").put("connections", JSONObject().put("ha", JSONObject().put("url", "http://ha")))))
        assertEquals(plan, state.plan)
        assertTrue(state.smartLifeConnected)
        assertEquals("http://ha", state.connections!!.getJSONObject("ha").getString("url"))
        assertNull(SyncState.fromMessage(JSONObject("{\"type\":\"state\",\"rev\":\"sha256\"}"))!!.plan)
        assertNull(SyncState.fromMessage(JSONObject("{\"type\":\"hello\"}")))
    }
    @Test fun frameUsesBigEndianLengthAndSupportsConsecutiveMessages() {
        val out = ByteArrayOutputStream()
        val first = "{\"type\":\"hello\"}".toByteArray()
        SyncWire.write(out, first); SyncWire.write(out, byteArrayOf(42))
        assertArrayEquals(byteArrayOf(0, 0, 0, first.size.toByte()), out.toByteArray().copyOfRange(0, 4))
        val input = ByteArrayInputStream(out.toByteArray())
        assertArrayEquals(first, SyncWire.read(input))
        assertArrayEquals(byteArrayOf(42), SyncWire.read(input))
    }
    @Test fun frameHandlesFragmentedReads() {
        val out = ByteArrayOutputStream(); SyncWire.write(out, ByteArray(513) { (it % 255).toByte() })
        val fragmented = object : ByteArrayInputStream(out.toByteArray()) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int = super.read(buffer, offset, minOf(1, length))
        }
        assertEquals(513, SyncWire.read(fragmented).size)
    }
    @Test fun rejectsEmptyOversizeNegativeAndTruncatedFrames() {
        for (length in listOf(0, -1, SyncWire.MAX_FRAME + 1)) {
            val out = ByteArrayOutputStream(); DataOutputStream(out).writeInt(length)
            assertThrows(IllegalArgumentException::class.java) { SyncWire.read(ByteArrayInputStream(out.toByteArray())) }
        }
        assertThrows(IllegalArgumentException::class.java) { SyncWire.write(ByteArrayOutputStream(), byteArrayOf()) }
        assertThrows(EOFException::class.java) { SyncWire.read(ByteArrayInputStream(byteArrayOf(0, 0, 0, 2, 1))) }
        assertThrows(EOFException::class.java) { SyncWire.read(ByteArrayInputStream(byteArrayOf(0, 0))) }
    }
}
