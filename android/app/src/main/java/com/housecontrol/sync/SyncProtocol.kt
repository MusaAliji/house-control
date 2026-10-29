package com.housecontrol.sync

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Base64
import org.json.JSONObject
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Wire-compatible with core/Sources/HouseCore/SyncProtocol.swift. Never log pairing links. */
class SyncPairing(val id: String, val name: String, key: ByteArray) {
    val key: ByteArray = key.copyOf()
    init { require(id.isNotBlank() && key.size == 32) }
    val link: String get() = "housecontrol://pair?v=1&id=${escape(id)}&name=${escape(name)}&key=${encode(key)}"
    fun toJson(): String = JSONObject().put("id", id).put("name", name)
        .put("key", Base64.getEncoder().encodeToString(key)).toString()
    fun derivedKey(): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256")); doFinal("HouseControl sync v1".toByteArray(Charsets.UTF_8))
    }
    companion object {
        private fun encode(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        private fun escape(text: String) = URLEncoder.encode(text, "UTF-8").replace("+", "%20")
        // URLComponents does not treat a literal '+' as a form-encoded space.
        private fun unescape(text: String) = URLDecoder.decode(text.replace("+", "%2B"), "UTF-8")
        fun parse(link: String): SyncPairing? = runCatching {
            val u = URI(link.trim())
            require(u.scheme == "housecontrol" && u.host == "pair")
            val items = linkedMapOf<String, String>()
            u.rawQuery.orEmpty().split('&').forEach { field ->
                val parts = field.split('=', limit = 2)
                val name = unescape(parts[0])
                if (!items.containsKey(name)) items[name] = unescape(parts.getOrElse(1) { "" })
            }
            require(items["v"] == "1")
            SyncPairing(requireNotNull(items["id"]), items["name"] ?: "Mac",
                Base64.getUrlDecoder().decode(requireNotNull(items["key"])))
        }.getOrNull()
        fun fromJson(json: String): SyncPairing? = runCatching {
            val o = JSONObject(json)
            SyncPairing(o.getString("id"), o.optString("name", "Mac"), Base64.getDecoder().decode(o.getString("key")))
        }.getOrNull()
    }
}

data class SyncState(val macName: String, val revision: String, val plan: String?,
    val userCode: String, val smartLifeConnected: Boolean, val connections: JSONObject?) {
    companion object {
        fun fromMessage(o: JSONObject): SyncState? {
            if (o.optString("type") != "state") return null
            return SyncState(o.optString("mac", "Mac"), o.optString("rev"),
                if (o.has("plan") && !o.isNull("plan")) o.getString("plan") else null,
                o.optString("userCode"), o.optBoolean("smartLife"), o.optJSONObject("connections"))
        }
    }
}
