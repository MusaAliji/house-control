package com.housecontrol.sync

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import java.io.Closeable
import java.util.ArrayDeque

/** Android Bonjour browser; all callbacks are dispatched on the main looper. */
class ServiceDiscovery(context: Context) {
    data class Found(val name: String, val host: String, val port: Int, val txt: Map<String, String>) {
        val urlHost: String get() = if (host.contains(':')) "[$host]" else host
    }
    private val app = context.applicationContext
    private val nsd = app.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val main = Handler(Looper.getMainLooper())

    fun watch(type: String, onFound: (Found) -> Unit, onError: (String) -> Unit = {}): Closeable {
        var stopped = false
        var resolving = false
        val pending = ArrayDeque<NsdServiceInfo>()
        val wifi = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val lock = wifi.createMulticastLock("housecontrol-discovery").apply { setReferenceCounted(false) }
        runCatching { lock.acquire() }
        fun resolveNext() {
            if (stopped || resolving || pending.isEmpty()) return
            resolving = true
            val service = pending.removeFirst()
            @Suppress("DEPRECATION")
            try { nsd.resolveService(service, object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, code: Int) { main.post { resolving = false; resolveNext() } }
                override fun onServiceResolved(info: NsdServiceInfo) { main.post {
                    resolving = false
                    if (!stopped) {
                        @Suppress("DEPRECATION") val host = info.host?.hostAddress
                        if (host != null) onFound(Found(info.serviceName, host, info.port,
                            info.attributes.mapValues { String(it.value, Charsets.UTF_8) }))
                        resolveNext()
                    }
                } }
            }) } catch (_: Exception) {
                resolving = false
                main.post { resolveNext() }
            }
        }
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) = Unit
            override fun onDiscoveryStopped(t: String) = Unit
            override fun onStartDiscoveryFailed(t: String, code: Int) { main.post { if (!stopped) onError("Local network discovery failed ($code)") } }
            override fun onStopDiscoveryFailed(t: String, code: Int) = Unit
            override fun onServiceLost(info: NsdServiceInfo) { main.post { pending.removeAll { it.serviceName == info.serviceName } } }
            override fun onServiceFound(info: NsdServiceInfo) { main.post {
                if (!stopped) { pending.add(info); resolveNext() }
            } }
        }
        main.post {
            if (!stopped) runCatching { nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener) }
                .onFailure { onError(it.message ?: "Local network discovery unavailable") }
        }
        return Closeable { main.post {
            stopped = true
            pending.clear()
            runCatching { nsd.stopServiceDiscovery(listener) }
            if (lock.isHeld) lock.release()
        } }
    }

    fun browse(type: String, seconds: Double = 3.0, callback: (List<Found>) -> Unit) {
        val found = linkedMapOf<String, Found>()
        val handle = watch(type, { found["${it.name}:${it.host}:${it.port}"] = it })
        main.postDelayed({ handle.close(); callback(found.values.sortedBy { it.name }) }, (seconds * 1000).toLong())
    }
}
