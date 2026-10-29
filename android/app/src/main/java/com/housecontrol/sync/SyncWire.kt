package com.housecontrol.sync

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.SecureRandom
import org.bouncycastle.tls.CipherSuite
import org.bouncycastle.tls.PSKTlsClient
import org.bouncycastle.tls.ProtocolVersion
import org.bouncycastle.tls.crypto.impl.bc.BcTlsCrypto

internal object SyncWire {
    const val MAX_FRAME = 8 * 1024 * 1024
    fun client(pairing: SyncPairing) = object : PSKTlsClient(BcTlsCrypto(SecureRandom()),
        "housecontrol".toByteArray(Charsets.UTF_8), pairing.derivedKey()) {
        override fun getSupportedVersions(): Array<ProtocolVersion> = arrayOf(ProtocolVersion.TLSv12)
        override fun getSupportedCipherSuites(): IntArray = intArrayOf(CipherSuite.TLS_PSK_WITH_AES_128_GCM_SHA256)
    }
    fun read(input: InputStream): ByteArray {
        val data = DataInputStream(input)
        val length = data.readInt()
        require(length in 1..MAX_FRAME) { "Invalid sync frame length" }
        return ByteArray(length).also { data.readFully(it) }
    }
    fun write(output: OutputStream, bytes: ByteArray) {
        require(bytes.size in 1..MAX_FRAME) { "Invalid sync frame length" }
        val data = DataOutputStream(output)
        data.writeInt(bytes.size); data.write(bytes); data.flush()
    }
}
