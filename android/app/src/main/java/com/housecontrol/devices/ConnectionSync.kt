package com.housecontrol.devices

import org.json.JSONObject

/**
 * Which device changed Home Assistant or Hue last, so the newer side wins when the phone and the
 * computer disagree. The same rules as `core/Sources/HouseCore/DeviceHub.swift` and Windows'
 * `devices.cjs`: stamps are seconds since 1970, a disconnect travels as `removed`, and a platform
 * missing from what the other side shared is left alone.
 */
class ConnectionSync(
    private val load: () -> JSONObject,
    private val save: (JSONObject) -> Unit,
    private val now: () -> Double = { System.currentTimeMillis() / 1000.0 },
) {
    /** A shareable platform: its connection as it travels, and how to take one (null disconnects). */
    class Platform(val id: String, val shareable: () -> JSONObject?, val adopt: (JSONObject?) -> Unit)

    private fun stamps(): JSONObject = runCatching(load).getOrNull() ?: JSONObject()

    /** A connection made or dropped on this phone. */
    @Synchronized fun stamp(id: String) {
        val all = stamps()
        all.put(id, maxOf(now(), all.optDouble(id, 0.0) + 0.001))
        save(all)
    }

    /** Address and token / bridge key with when they were set, or `removed` after a disconnect. */
    @Synchronized fun shareable(platforms: List<Platform>): JSONObject {
        val known = stamps()
        val out = JSONObject()
        for (platform in platforms) {
            val updated = known.optDouble(platform.id, 0.0)
            val config = platform.shareable()
            if (config != null) out.put(platform.id, config.put("updated", updated))
            else if (updated > 0) out.put(platform.id, JSONObject().put("removed", true).put("updated", updated))
        }
        return out
    }

    /** Takes what the computer shared, platform by platform, where it is newer than what this phone
     *  has. Returns true when a connection changed here. */
    @Synchronized fun adopt(shared: JSONObject, platforms: List<Platform>): Boolean {
        val known = stamps()
        var changed = false
        for (platform in platforms) {
            val incoming = shared.optJSONObject(platform.id) ?: continue
            val theirs = incoming.optDouble("updated", 0.0).takeIf { !it.isNaN() } ?: 0.0
            val ours = known.optDouble(platform.id, 0.0)
            // A computer without stamps (an older version) only fills in what was never set here.
            val newer = if (theirs > 0) theirs > ours else ours == 0.0
            if (!newer) continue
            val before = platform.shareable()?.toString()
            if (incoming.optBoolean("removed")) platform.adopt(null)
            else platform.adopt(JSONObject(incoming.toString()).apply { remove("updated"); remove("removed") })
            known.put(platform.id, theirs)
            if (platform.shareable()?.toString() != before) changed = true
        }
        save(known)
        return changed
    }
}
