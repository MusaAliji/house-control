package com.housecontrol

import android.content.Context
import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.housecontrol.sync.SyncClient
import com.housecontrol.sync.SyncPairing
import com.housecontrol.sync.SyncState
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Optional live Windows test. Supply companionHost/Port/Link instrumentation arguments.
 * Emulator uses 10.0.2.2; a physical device uses the Windows LAN address.
 */
class WindowsCompanionTest {
    @Test fun windowsPairingTransfersPlanAndRecognizesMatchingRevision() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("A running Windows companion is required", args.containsKey("companionLink"))
        val pairing = requireNotNull(SyncPairing.parse(requireNotNull(args.getString("companionLink"))))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val target = instrumentation.targetContext
        val prefix = "windows-test-${UUID.randomUUID()}"
        val folder = File(target.cacheDir, prefix).apply { mkdirs() }
        val prefs = mutableSetOf<String>()
        val context = object : ContextWrapper(target) {
            override fun getFilesDir(): File = folder
            override fun getSharedPreferences(name: String, mode: Int): android.content.SharedPreferences {
                val isolated = "$prefix-$name"; prefs.add(isolated)
                return target.getSharedPreferences(isolated, mode)
            }
        }
        val plans = PlanStore(context)
        val received = CountDownLatch(1)
        val refreshed = CountDownLatch(1)
        var first: SyncState? = null
        var second: SyncState? = null
        var failure: Throwable? = null
        var saved: String? = null
        lateinit var client: SyncClient
        var started = false
        try {
            instrumentation.runOnMainSync {
                client = SyncClient(context, { saved }, { saved = it })
                started = true
                client.fixedEndpoint = InetSocketAddress(args.getString("companionHost", "10.0.2.2"), requireNotNull(args.getString("companionPort")).toInt())
                client.deviceName = "Android Windows integration"
                client.planRevision = { plans.revision }
                client.onState = { state ->
                    try {
                        if (first == null) {
                            first = state
                            plans.save(requireNotNull(state.plan))
                            received.countDown()
                        } else { second = state; refreshed.countDown() }
                    } catch (error: Throwable) { failure = error; received.countDown(); refreshed.countDown() }
                }
                client.pair(pairing); client.start()
            }
            assertTrue("Windows did not send a plan over TLS-PSK", received.await(25, TimeUnit.SECONDS))
            failure?.let { throw it }
            assertEquals("Windows sync smoke", plans.custom!!.getString("name"))
            assertEquals(first!!.revision, plans.revision)
            assertEquals(pairing.name, first!!.macName)
            assertNotNull(SyncPairing.fromJson(requireNotNull(saved)))
            instrumentation.runOnMainSync { assertTrue(client.isConnected); client.refresh() }
            assertTrue("Windows did not answer the revision refresh", refreshed.await(15, TimeUnit.SECONDS))
            failure?.let { throw it }
            assertNull("Matching revision should omit unchanged plan", second!!.plan)
            assertEquals(plans.revision, second!!.revision)
        } finally {
            if (started) instrumentation.runOnMainSync { client.stop() }
            prefs.forEach { target.deleteSharedPreferences(it) }
            folder.deleteRecursively()
        }
    }
}
