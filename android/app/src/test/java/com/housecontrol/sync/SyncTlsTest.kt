package com.housecontrol.sync

import org.bouncycastle.tls.CipherSuite
import org.bouncycastle.tls.PSKTlsServer
import org.bouncycastle.tls.ProtocolVersion
import org.bouncycastle.tls.TlsClientProtocol
import org.bouncycastle.tls.TlsPSKIdentityManager
import org.bouncycastle.tls.TlsServerProtocol
import org.bouncycastle.tls.crypto.impl.bc.BcTlsCrypto
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SyncTlsTest {
    private val pairing = SyncPairing("fixture-mac", "Mac", ByteArray(32) { it.toByte() })
    private fun server(key: ByteArray) = object : PSKTlsServer(BcTlsCrypto(SecureRandom()), object : TlsPSKIdentityManager {
        override fun getHint(): ByteArray = "housecontrol".toByteArray()
        override fun getPSK(identity: ByteArray): ByteArray? =
            if (identity.contentEquals("housecontrol".toByteArray())) key.copyOf() else null
    }) {
        override fun getSupportedVersions(): Array<ProtocolVersion> = arrayOf(ProtocolVersion.TLSv12)
        override fun getSupportedCipherSuites(): IntArray = intArrayOf(CipherSuite.TLS_PSK_WITH_AES_128_GCM_SHA256)
    }

    @Test(timeout = 15000) fun connectsUsingExactMacCipherAndExchangesFramedMessages() {
        val workers = Executors.newSingleThreadExecutor()
        try {
            ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { listener ->
                val received = workers.submit<ByteArray> {
                    listener.accept().use { socket ->
                        socket.soTimeout = 5000
                        val tls = TlsServerProtocol(socket.getInputStream(), socket.getOutputStream())
                        tls.accept(server(pairing.derivedKey()))
                        val request = SyncWire.read(tls.inputStream)
                        SyncWire.write(tls.outputStream, "{\"type\":\"state\",\"rev\":\"fixture\"}".toByteArray())
                        request
                    }
                }
                Socket(InetAddress.getLoopbackAddress(), listener.localPort).use { socket ->
                    socket.soTimeout = 5000
                    val tls = TlsClientProtocol(socket.getInputStream(), socket.getOutputStream())
                    tls.connect(SyncWire.client(pairing))
                    SyncWire.write(tls.outputStream, "{\"type\":\"hello\",\"device\":\"Android\",\"rev\":\"\"}".toByteArray())
                    assertEquals("{\"type\":\"state\",\"rev\":\"fixture\"}", String(SyncWire.read(tls.inputStream)))
                    assertEquals("{\"type\":\"hello\",\"device\":\"Android\",\"rev\":\"\"}", String(received.get(5, TimeUnit.SECONDS)))
                }
            }
        } finally { workers.shutdownNow() }
    }

    @Test(timeout = 15000) fun wrongPairingKeyCannotCompleteHandshake() {
        val workers = Executors.newSingleThreadExecutor()
        try {
            ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { listener ->
                val rejected = workers.submit<Boolean> {
                    listener.accept().use { socket ->
                        socket.soTimeout = 5000
                        try {
                            TlsServerProtocol(socket.getInputStream(), socket.getOutputStream()).accept(server(pairing.derivedKey()))
                            false
                        } catch (_: IOException) { true }
                    }
                }
                Socket(InetAddress.getLoopbackAddress(), listener.localPort).use { socket ->
                    socket.soTimeout = 5000
                    val wrong = SyncPairing("fixture-mac", "Mac", ByteArray(32) { 99 })
                    assertThrows(IOException::class.java) {
                        TlsClientProtocol(socket.getInputStream(), socket.getOutputStream()).connect(SyncWire.client(wrong))
                    }
                    assertTrue(rejected.get(5, TimeUnit.SECONDS))
                }
            }
        } finally { workers.shutdownNow() }
    }
}
