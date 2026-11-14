package com.housecontrol

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class EarlierHomesTest {
    @get:Rule val tmp = TemporaryFolder()
    private fun home(name: String, vararg ids: String, extra: String = "") =
        """{"name":"$name","extra":"$extra","rooms":[${ids.joinToString(",") { """{"id":"$it"}""" }}]}""".toByteArray()

    @Test fun replacedHomeIsKeptAndEditsOnceAnHour() {
        var clock = 1_700_000_000_000L
        val kept = EarlierHomes(tmp.newFolder("earlier")) { clock }
        kept.keep(null, home("A", "a")); assertTrue(kept.list().isEmpty())
        kept.keep(home("A", "a"), home("A", "a")); assertTrue(kept.list().isEmpty())
        kept.keep(home("A", "a"), home("B", "b")); assertEquals(1, kept.list().size)
        kept.list().single().file.setLastModified(clock)
        kept.keep(home("B", "b"), home("B", "b", extra = "1")) // same home, within the hour
        assertEquals(1, kept.list().size)
        clock += 2 * 3_600_000L
        kept.keep(home("B", "b"), home("B", "b", extra = "2")) // same home, an hour later
        assertEquals(2, kept.list().size)
        kept.keep(home("A", "a"), home("C", "c")) // identical copy of A already kept
        assertEquals(2, kept.list().size)
    }

    @Test fun oldestCopiesAreDroppedPastTheLimit() {
        var clock = 1_700_000_000_000L
        val dir = tmp.newFolder("limit"); val kept = EarlierHomes(dir) { clock }
        repeat(EarlierHomes.LIMIT + 5) { i -> kept.keep(home("H$i", "r$i"), home("next", "n")); clock += 1000
            dir.listFiles()!!.forEach { it.setLastModified(clock) } }
        assertTrue(kept.list().size <= EarlierHomes.LIMIT)
    }
}
