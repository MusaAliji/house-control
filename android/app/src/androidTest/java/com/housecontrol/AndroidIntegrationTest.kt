package com.housecontrol

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.platform.app.InstrumentationRegistry
import com.housecontrol.devices.DeviceHub
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.Closeable
import java.io.File
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.Collections
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONTokener

/** Runs on Android: verifies Keystore, AtomicFile and the real native device bridge. */
class AndroidIntegrationTest {
    private lateinit var context: Context
    private lateinit var directory: File
    private val preferences = mutableListOf<String>()

    @Before fun isolateStorage() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val prefix = "test-${UUID.randomUUID()}-"
        directory = File(target.cacheDir, prefix).apply { mkdirs() }
        context = object : ContextWrapper(target) {
            override fun getFilesDir(): File = directory
            override fun getSharedPreferences(name: String, mode: Int): android.content.SharedPreferences {
                val isolated = prefix + name
                preferences.add(isolated)
                return target.getSharedPreferences(isolated, mode)
            }
        }
    }

    @After fun cleanup() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        preferences.distinct().forEach { target.deleteSharedPreferences(it) }
        directory.deleteRecursively()
    }

    @Test fun planImportPreservesExactSyncRevisionAndSelectionAcrossRestart() {
        val original = "{\"name\":\"Küche\",\"rooms\":[{\"id\":\"kitchen\"}]}\n"
        val store = PlanStore(context)
        assertEquals("home", store.active)
        store.save(original)
        assertEquals("custom", store.active)
        assertEquals("Küche", store.custom!!.getString("name"))
        val expected = MessageDigest.getInstance("SHA-256").digest(original.toByteArray()).take(8)
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        assertEquals(expected, store.revision)
        assertEquals(expected, PlanStore(context).revision)
        assertEquals("custom", PlanStore(context).active)
        store.select("studio")
        store.save(original.replace("Küche", "Updated"), select = false)
        assertEquals("studio", PlanStore(context).active)
        assertEquals("Updated", store.custom!!.getString("name"))
        store.remove()
        assertFalse(store.hasCustom)
        assertNull(store.revision)
    }

    @Test fun invalidPlanCannotReplaceCurrentHome() {
        val store = PlanStore(context)
        store.save("{\"rooms\":[{}]}")
        val revision = store.revision
        for (invalid in listOf("not json", "{}", "{\"rooms\":[]}", "{\"rooms\":true}")) {
            try { store.save(invalid); fail("Accepted invalid floor plan") } catch (_: Exception) { }
            assertEquals(revision, store.revision)
            assertEquals("custom", store.active)
        }
        store.remove()
        assertEquals("home", store.active)
    }

    @Test fun credentialsAreEncryptedPersistAndCannotBeMovedBetweenAccounts() {
        val secret = "synthetic-token-${UUID.randomUUID()}"
        val vault = SecureStore(context)
        vault.write("smartlife", secret)
        assertEquals(secret, SecureStore(context).read("smartlife"))
        val prefs = context.getSharedPreferences("secrets", Context.MODE_PRIVATE)
        val ciphertext = prefs.getString("smartlife", null)!!
        assertFalse(ciphertext.contains(secret))
        vault.write("smartlife", secret)
        assertNotEquals(ciphertext, prefs.getString("smartlife", null)) // fresh GCM nonce
        prefs.edit().putString("hue", ciphertext).commit()
        try { vault.read("hue"); fail("Ciphertext accepted under a different account") } catch (_: Exception) { }
        vault.write("smartlife", null)
        assertNull(SecureStore(context).read("smartlife"))
    }

    @Test fun nativeHubReadsAndCommandsHomeAssistantWithRealHttpAndToken() {
        FakeHomeAssistant().use { server ->
            val hub = DeviceHub(context)
            hub.homeAssistant.connect(server.url, "test-access-token")
            hub.setLinks(JSONObject("""{"lights":[{"id":"desk","link":{"service":"homeassistant","id":"light.desk"}}],"acs":[{"id":"ac","link":{"service":"homeassistant","id":"climate.office"},"sensor":{"service":"homeassistant","id":"sensor.office"}}]}"""))
            val reading = hub.poll()
            assertTrue(reading.getJSONObject("lights").getJSONObject("desk").getBoolean("on"))
            assertEquals(128.0 / 255, reading.getJSONObject("lights").getJSONObject("desk").getDouble("brightness"), 0.001)
            assertEquals(25.0, reading.getJSONObject("acs").getJSONObject("ac").getDouble("roomTemp"), 0.001)
            assertEquals("cool", reading.getJSONObject("acs").getJSONObject("ac").getString("mode"))
            assertEquals("medium", reading.getJSONObject("acs").getJSONObject("ac").getString("fan"))
            val result = hub.command(JSONObject("""{"id":"desk","kind":"light","patch":{"brightness":0.4,"color":"#ff0000"},"state":{"on":true}}"""))
            assertFalse(result.has("error"))
            val sent = server.requests.last { it.path == "/api/services/light/turn_on" }
            assertEquals(40, JSONObject(sent.body).getInt("brightness_pct"))
            assertEquals("light.desk", JSONObject(sent.body).getString("entity_id"))
            assertEquals(255, JSONObject(sent.body).getJSONArray("rgb_color").getInt(0))
            assertTrue(server.requests.all { it.authorization == "Bearer test-access-token" })
            hub.homeAssistant.disconnect()
            val rejected = hub.command(JSONObject("""{"id":"desk","patch":{"on":true},"state":{"on":true}}"""))
            assertTrue(rejected.has("error"))
        }
    }

    @Test fun unlinkedDemosWorkAndUnsupportedHomeKitReportsFailure() {
        val hub = DeviceHub(context)
        assertTrue(hub.command(JSONObject("""{"id":"demo","patch":{"on":true}}""")).getBoolean("ok"))
        hub.setLinks(JSONObject("""{"lights":[{"id":"apple","link":{"service":"homekit","id":"accessory"}}]}"""))
        val result = hub.command(JSONObject("""{"id":"apple","patch":{"on":true}}"""))
        assertTrue(result.getString("error").contains("unavailable on Android"))
    }

    @Test fun bundledWebViewRendersActualHomeGeometry() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        try {
            fun findWeb(view: View): WebView? {
                if (view is WebView) return view
                if (view is ViewGroup) for (i in 0 until view.childCount) findWeb(view.getChildAt(i))?.let { return it }
                return null
            }
            lateinit var web: WebView
            instrumentation.runOnMainSync { web = findWeb(activity.findViewById(android.R.id.content))!! }
            fun evaluate(script: String): String {
                val complete = CountDownLatch(1)
                var result = "null"
                instrumentation.runOnMainSync { web.evaluateJavascript(script) { result = it; complete.countDown() } }
                assertTrue("WebView evaluation timed out", complete.await(15, TimeUnit.SECONDS))
                return result
            }
            val deadline = System.currentTimeMillis() + 30000
            while (evaluate("Boolean(window.__house?.world)") != "true" && System.currentTimeMillis() < deadline) Thread.sleep(200)
            assertEquals("Home must finish loading", "true", evaluate("Boolean(window.__house?.world)"))
            val pixels = evaluate("""(() => {
                window.__house.world.settle(8);
                const c = document.querySelector('canvas'), gl = c.getContext('webgl2');
                const pixels = new Uint8Array(c.width * c.height * 4);
                gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                const colours = new Set();
                for (let i = 0; i < pixels.length; i += 64) colours.add((pixels[i] << 16) | (pixels[i+1] << 8) | pixels[i+2]);
                return JSON.stringify({colours: colours.size, error: gl.getError()});
            })()""")
            val reading = JSONObject(JSONTokener(pixels).nextValue() as String)
            assertEquals("WebGL must render without errors", 0, reading.getInt("error"))
            assertTrue("3D home must contain geometry, not a blank canvas: $reading", reading.getInt("colours") > 30)
        } finally { instrumentation.runOnMainSync { activity.finish() } }
    }

    private class FakeHomeAssistant : Closeable {
        data class Request(val path: String, val authorization: String, val body: String)
        private val listener = ServerSocket(0, 10, java.net.InetAddress.getByName("127.0.0.1"))
        private val thread = Executors.newSingleThreadExecutor()
        val requests: MutableList<Request> = Collections.synchronizedList(mutableListOf())
        val url get() = "http://127.0.0.1:${listener.localPort}"
        @Volatile private var running = true

        init {
            thread.execute {
                while (running) {
                    try {
                        listener.accept().use { socket ->
                            socket.soTimeout = 5000
                            val input = socket.getInputStream().bufferedReader()
                            val first = input.readLine() ?: return@use
                            val path = first.split(' ')[1]
                            val headers = mutableMapOf<String, String>()
                            while (true) {
                                val line = input.readLine() ?: break
                                if (line.isEmpty()) break
                                val parts = line.split(':', limit = 2)
                                if (parts.size == 2) headers[parts[0].lowercase()] = parts[1].trim()
                            }
                            val count = headers["content-length"]?.toIntOrNull() ?: 0
                            val chars = CharArray(count)
                            var offset = 0
                            while (offset < count) { val read = input.read(chars, offset, count - offset); if (read < 0) break; offset += read }
                            requests.add(Request(path, headers["authorization"].orEmpty(), String(chars)))
                            val response = when (path) {
                                "/api/config" -> """{"location_name":"Lab","version":"test"}"""
                                "/api/states" -> STATES
                                "/api/states/climate.office" -> CLIMATE
                                else -> "[]"
                            }.toByteArray()
                            socket.getOutputStream().apply {
                                write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${response.size}\r\nConnection: close\r\n\r\n".toByteArray())
                                write(response); flush()
                            }
                        }
                    } catch (_: Exception) { if (running) throw IllegalStateException("Lab server failed") }
                }
            }
        }

        override fun close() { running = false; listener.close(); thread.shutdownNow() }
        companion object {
            const val CLIMATE = """{"entity_id":"climate.office","state":"cool","attributes":{"temperature":23,"current_temperature":22,"hvac_modes":["off","cool","heat","fan_only"],"fan_mode":"mid","fan_modes":["auto","low","mid","high"]}}"""
            const val STATES = """[{"entity_id":"light.desk","state":"on","attributes":{"brightness":128,"color_mode":"rgb","rgb_color":[255,0,0]}},$CLIMATE,{"entity_id":"sensor.office","state":"77","attributes":{"device_class":"temperature","unit_of_measurement":"°F"}}]"""
        }
    }
}
