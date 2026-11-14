package com.housecontrol

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** A copy of the home as it was before something replaced it. */
data class EarlierHome(val file: File, val date: Long, val name: String, val rooms: Int, val devices: Int) {
    val id: String get() = file.name
}

/**
 * Homes kept beside plan.json before something replaces them (a file, the editor, a paired computer).
 * Port of PlanStore.keepEarlier in core/Sources/HouseCore/PlanStore.swift.
 */
class EarlierHomes(private val directory: File, private val now: () -> Long = System::currentTimeMillis) {
    companion object {
        const val LIMIT = 40 // copies kept; the oldest go first
        private const val SAME_HOME_WINDOW = 3_600_000L

        fun sameHome(a: JSONObject, b: JSONObject): Boolean {
            fun rooms(p: JSONObject) = (p.optJSONArray("rooms")?.let { r -> (0 until r.length()).mapNotNull { r.optJSONObject(it)?.optString("id")?.takeIf { id -> id.isNotEmpty() } } } ?: emptyList()).sorted()
            return a.optString("name") == b.optString("name") && rooms(a) == rooms(b)
        }
        fun revision(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).take(8).joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    /** The kept copies, newest first. */
    fun list(): List<EarlierHome> = (directory.listFiles { f -> f.extension == "json" } ?: emptyArray()).mapNotNull { file ->
        try {
            val plan = JSONObject(file.readText(Charsets.UTF_8))
            val rooms = plan.optJSONArray("rooms") ?: return@mapNotNull null
            EarlierHome(file, file.lastModified(), plan.optString("name").ifEmpty { "Home" }, rooms.length(),
                (plan.optJSONArray("lights")?.length() ?: 0) + (plan.optJSONArray("acs")?.length() ?: 0))
        } catch (_: Exception) { null }
    }.sortedByDescending { it.date }

    fun find(id: String): EarlierHome? = list().firstOrNull { it.id == id }

    /**
     * Keeps `current` before `next` replaces it. A different home (another name, other rooms) is
     * always kept; an edit of the same one at most once an hour. Never throws: keeping a copy must
     * not block saving the home.
     */
    fun keep(current: ByteArray?, next: ByteArray) {
        if (current == null || current.contentEquals(next)) return
        try {
            val old = JSONObject(String(current, Charsets.UTF_8))
            val fresh = try { JSONObject(String(next, Charsets.UTF_8)) } catch (_: Exception) { JSONObject() }
            val kept = list()
            if (sameHome(old, fresh) && kept.firstOrNull()?.let { now() - it.date < SAME_HOME_WINDOW } == true) return
            if (kept.any { it.file.readBytes().contentEquals(current) }) return
            directory.mkdirs()
            val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date(now()))
            File(directory, "plan-$stamp-${revision(current)}.json").writeBytes(current)
            list().drop(LIMIT).forEach { it.file.delete() }
        } catch (_: Exception) { }
    }
}
