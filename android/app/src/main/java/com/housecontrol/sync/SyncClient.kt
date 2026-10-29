package com.housecontrol.sync

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.bouncycastle.tls.TlsClientProtocol
import org.bouncycastle.tls.TlsFatalAlert
import org.bouncycastle.tls.TlsFatalAlertReceived
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors

/** Foreground-only companion sync. Pairing persistence must be backed by encrypted storage. */
class SyncClient(context: Context, readSecret: () -> String?, private val writeSecret: (String?) -> Unit) {
    enum class Status { UNPAIRED, SEARCHING, CONNECTING, CONNECTED, FAILED }
    private val main = Handler(Looper.getMainLooper())
    private val discovery = ServiceDiscovery(context)
    private val workers = Executors.newCachedThreadPool { r -> Thread(r, "house-sync").apply { isDaemon = true } }
    private val writer = Executors.newSingleThreadExecutor { r -> Thread(r, "house-sync-send").apply { isDaemon = true } }
    var pairing: SyncPairing? = readSecret()?.let(SyncPairing::fromJson); private set
    var status = if (pairing == null) Status.UNPAIRED else Status.SEARCHING; private set
    var error: String? = null; private set
    var deviceName = Build.MODEL ?: "Android"
    var planRevision: (() -> String?)? = null
    var onStatus: (() -> Unit)? = null
    var onState: ((SyncState) -> Unit)? = null
    var fixedEndpoint: InetSocketAddress? = null
    val isPaired get() = pairing != null
    val isConnected get() = status == Status.CONNECTED
    private var running = false
    private var generation = 0
    private var browser: Closeable? = null
    private var socket: Socket? = null
    private var channel: TlsClientProtocol? = null
    private var qrContent: String? = null
    private var qrUnsent = false
    private var catalog: JSONArray? = null
    private val retry = Runnable { search() }

    fun pair(value: SyncPairing) {
        teardown(); pairing = value; writeSecret(value.toJson()); set(Status.SEARCHING)
        if (running) search()
    }
    fun unpair() {
        teardown(); pairing = null; qrContent = null; qrUnsent = false; catalog = null
        writeSecret(null); set(Status.UNPAIRED)
    }
    fun start() { if (!running) { running = true; if (isPaired) search() } }
    fun stop() { running = false; teardown(); if (isPaired) set(Status.SEARCHING) }
    fun refresh() {
        if (!running || !isPaired) return
        if (isConnected) hello() else { teardown(); search() }
    }
    fun showQR(content: String?): Boolean { qrContent = content; qrUnsent = true; return flushQR() }
    fun sendCatalog(devices: JSONArray) { catalog = devices; flushCatalog() }
    private fun set(value: Status, detail: String? = null) {
        if (status == value && error == detail) return
        status = value; error = detail; onStatus?.invoke()
    }
    private fun teardown() {
        generation++; main.removeCallbacks(retry); browser?.close(); browser = null
        // Closing the underlying socket immediately interrupts a blocked handshake/read.
        runCatching { socket?.close() }; socket = null; channel = null
    }
    private fun search() {
        if (!running || pairing == null || socket != null || browser != null) return
        val current = pairing ?: return
        if (status != Status.FAILED) set(Status.SEARCHING)
        fixedEndpoint?.let { connect(it, current); return }
        val token = generation
        browser = discovery.watch("_housecontrol._tcp.", { found ->
            if (token == generation && running && socket == null && found.txt["id"] == current.id) {
                connect(InetSocketAddress(found.host, found.port), current)
            }
        }, { detail ->
            if (token == generation) { set(Status.FAILED, detail); scheduleRetry() }
        })
    }
    private fun connect(endpoint: InetSocketAddress, pairing: SyncPairing) {
        browser?.close(); browser = null
        val token = generation
        val connection = Socket()
        socket = connection
        set(Status.CONNECTING)
        workers.execute {
            try {
                connection.tcpNoDelay = true; connection.keepAlive = true
                connection.connect(endpoint, 10_000)
                connection.soTimeout = 15_000
                val tls = TlsClientProtocol(connection.getInputStream(), connection.getOutputStream())
                tls.connect(SyncWire.client(pairing))
                connection.soTimeout = 0
                main.post { if (token == generation && running) { channel = tls; hello() } }
                while (!connection.isClosed) {
                    val bytes = SyncWire.read(tls.inputStream)
                    val message = runCatching { JSONObject(String(bytes, Charsets.UTF_8)) }.getOrNull() ?: continue
                    val state = SyncState.fromMessage(message) ?: continue
                    main.post { if (token == generation && running) {
                        set(Status.CONNECTED); flushQR(); flushCatalog(); onState?.invoke(state)
                    } }
                }
            } catch (e: Exception) {
                main.post { if (token == generation && running) {
                    channel = null; socket = null
                    if (e is TlsFatalAlert || e is TlsFatalAlertReceived) {
                        set(Status.FAILED, "${pairing.name} did not accept this pairing. Pair again from your computer's pairing menu.")
                    } else set(Status.SEARCHING)
                    scheduleRetry()
                } }
            } finally { runCatching { connection.close() } }
        }
    }
    private fun send(message: JSONObject) {
        val tls = channel ?: return
        val token = generation
        writer.execute {
            try {
                val bytes = message.toString().toByteArray(Charsets.UTF_8)
                SyncWire.write(tls.outputStream, bytes)
            } catch (_: Exception) {
                main.post { if (token == generation && running) { teardown(); set(Status.SEARCHING); scheduleRetry() } }
            }
        }
    }
    private fun hello() = send(JSONObject().put("type", "hello").put("device", deviceName).put("rev", planRevision?.invoke() ?: ""))
    private fun flushQR(): Boolean {
        if (!qrUnsent || !isConnected) return false
        val message = JSONObject().put("type", "showQR")
        qrContent?.let { message.put("content", it) }
        send(message); qrUnsent = false; return true
    }
    private fun flushCatalog() {
        if (!isConnected) return
        val devices = catalog ?: return
        send(JSONObject().put("type", "catalog").put("devices", devices)); catalog = null
    }
    private fun scheduleRetry() {
        if (!running || !isPaired) return
        browser?.close(); browser = null; main.removeCallbacks(retry); main.postDelayed(retry, 3000)
    }
    companion object { const val MAX_FRAME = SyncWire.MAX_FRAME }
}
