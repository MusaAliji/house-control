package com.housecontrol.devices

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Live notifications trigger the same state read as polling; streams never invent state. */
internal class LiveUpdates(
    private val homeAssistant: HomeAssistantService,
    private val hue: HueService,
    private val onChange: () -> Unit
) {
    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build()
    private val readers = Executors.newCachedThreadPool { work -> Thread(work, "house-events").apply { isDaemon = true } }
    private var socket: WebSocket? = null
    @Volatile private var stream: HttpURLConnection? = null
    @Volatile private var generation = 0
    private var signature: String? = null
    private val changed = Runnable { onChange() }

    @Synchronized fun stop() {
        generation++; signature = null
        socket?.cancel(); socket = null
        stream?.disconnect(); stream = null
        main.removeCallbacksAndMessages(null)
    }

    @Synchronized fun start(entities: Set<String>, resources: Set<String>) {
        val config = homeAssistant.shareable()
        val next = listOf(config?.toString(), hue.shareable()?.toString(), entities.sorted(), resources.sorted()).joinToString("|")
        if (signature == next) return
        stop(); signature = next
        val token = generation
        if (config != null && entities.isNotEmpty()) connectHomeAssistant(config, entities, token)
        if (hue.connected && resources.isNotEmpty()) connectHue(resources, token)
    }

    private fun changed(token: Int) {
        main.post {
            if (token == generation) {
                main.removeCallbacks(changed)
                main.postDelayed(changed, 350)
            }
        }
    }

    private fun connectHomeAssistant(config: JSONObject, entities: Set<String>, token: Int) {
        if (token != generation) return
        val url = config.getString("url").replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") + "/api/websocket"
        socket = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (token != generation) return
                val message = runCatching { JSONObject(text) }.getOrNull() ?: return
                when (message.optString("type")) {
                    "auth_required" -> webSocket.send(obj("type" to "auth", "access_token" to config.getString("token")).toString())
                    "auth_ok" -> webSocket.send(obj("id" to 1, "type" to "subscribe_events", "event_type" to "state_changed").toString())
                    "auth_invalid" -> webSocket.cancel()
                    "event" -> if (message.optJSONObject("event")?.optJSONObject("data")?.optString("entity_id") in entities) changed(token)
                }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { retry() }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { retry() }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
            private fun retry() { main.postDelayed({ if (token == generation) connectHomeAssistant(config, entities, token) }, 15000) }
        })
    }

    private fun connectHue(resources: Set<String>, token: Int) {
        if (token != generation) return
        readers.execute {
            var connection: HttpURLConnection? = null
            try {
                val opened = hue.eventStream()
                connection = opened
                synchronized(this) {
                    if (token != generation) { opened.disconnect(); return@execute }
                    stream = opened
                }
                require(opened.responseCode in 200..299)
                opened.inputStream.bufferedReader().use { reader ->
                    val data = StringBuilder()
                    while (token == generation) {
                        val line = reader.readLine() ?: break
                        if (line.startsWith("data:")) data.append(line.substring(5).trim()).append('\n')
                        if (line.isEmpty() && data.isNotEmpty()) {
                            val events = runCatching { JSONArray(data.toString()) }.getOrNull()
                            if (events?.objects()?.any { event ->
                                event.optJSONArray("data")?.objects()?.any { it.optString("id") in resources } == true
                            } == true) changed(token)
                            data.setLength(0)
                        }
                    }
                }
            } catch (_: Exception) {
                // Polling still covers unavailable streams and reconnect intervals.
            } finally {
                connection?.disconnect()
                synchronized(this) { if (stream === connection) stream = null }
                main.postDelayed({ if (token == generation) connectHue(resources, token) }, 15000)
            }
        }
    }
}
