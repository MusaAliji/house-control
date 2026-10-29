package com.housecontrol.devices

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.math.*

internal fun obj(vararg fields: Pair<String, Any?>) = JSONObject().apply { fields.forEach { put(it.first, it.second ?: JSONObject.NULL) } }
internal fun JSONArray.objects() = (0 until length()).mapNotNull { optJSONObject(it) }
internal fun JSONArray.strings() = (0 until length()).map { optString(it) }
internal fun JSONObject.copy() = JSONObject(toString())
internal fun JSONObject.merge(other: JSONObject): JSONObject = apply { other.keys().forEach { put(it, other.get(it)) } }
internal fun JSONObject.number(key: String): Double? = if (has(key) && !isNull(key)) optString(key).toDoubleOrNull() else null
internal fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
internal fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
internal fun digest(name: String, s: String) = hex(MessageDigest.getInstance(name).digest(s.toByteArray()))
internal fun hmac(key: String, text: String): String = hex(Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key.toByteArray(), "HmacSHA256")) }.doFinal(text.toByteArray()))
class DeviceFailure(message: String, val code: String = "", val fields: List<String> = emptyList()) : Exception(message)

/** Credentials are encrypted with a non-exportable Android Keystore key. */
internal class Vault(context: Context, private val name: String) {
    private val store = com.housecontrol.SecureStore(context)
    fun read(): JSONObject? = store.read(name)?.let { try { JSONObject(it) } catch (_: Exception) { null } }
    fun write(value: JSONObject?) { store.write(name, value?.toString()) }
}

internal object Http {
    fun call(method: String, url: String, body: JSONObject? = null, headers: Map<String, String> = emptyMap(), raw: Boolean = false, configure: (HttpURLConnection) -> Unit = {}): Any {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 12000; connection.readTimeout = 15000; connection.requestMethod = method
            connection.instanceFollowRedirects = false
            configure(connection)
            headers.forEach { (k, v) -> connection.setRequestProperty(k, v) }
            if (body != null) { connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json"); connection.outputStream.use { it.write(body.toString().toByteArray()) } }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            if (status !in 200..299) throw DeviceFailure("HTTP $status: ${text.take(200)}", status.toString())
            return if(raw) text else try { JSONTokener(text).nextValue() } catch (_: Exception) { text }
        } finally { connection.disconnect() }
    }
}

interface DeviceService {
    val id: String
    val connected: Boolean
    fun info(): JSONObject
    fun devices(): JSONArray
    fun read(ids: Set<String>): Map<String, JSONObject>
    fun send(kind: String, id: String, patch: JSONObject, state: JSONObject)
    fun disconnect()
    fun watch(ids:Set<String>) {}
}

internal object Colors {
    fun rgb(hex: String): DoubleArray? = hex.trim().removePrefix("#").takeIf { it.length == 6 }?.toLongOrNull(16)?.let { doubleArrayOf((it shr 16 and 255) / 255.0, (it shr 8 and 255) / 255.0, (it and 255) / 255.0) }
    fun hex(r: Double, g: Double, b: Double) = "#%02x%02x%02x".format((r.coerceIn(0.0, 1.0)*255).roundToInt(), (g.coerceIn(0.0, 1.0)*255).roundToInt(), (b.coerceIn(0.0, 1.0)*255).roundToInt())
    fun hsv(hex: String): DoubleArray? { val c = rgb(hex) ?: return null; val (r,g,b)=c; val hi=c.maxOrNull()!!; val lo=c.minOrNull()!!; val d=hi-lo; var h=if(d==0.0)0.0 else if(hi==r)60*((g-b)/d%6) else if(hi==g)60*((b-r)/d+2) else 60*((r-g)/d+4); if(h<0)h+=360; return doubleArrayOf(h,if(hi==0.0)0.0 else d/hi,hi) }
    fun xy(hex: String): DoubleArray? { val c=rgb(hex)?.map { if(it>0.04045)((it+0.055)/1.055).pow(2.4) else it/12.92 } ?: return null; val (r,g,b)=c; val x=r*0.4124+g*0.3576+b*0.1805; val y=r*0.2126+g*0.7152+b*0.0722; val z=r*0.0193+g*0.1192+b*0.9505; return if(x+y+z==0.0) doubleArrayOf(.3127,.3290) else doubleArrayOf(x/(x+y+z),y/(x+y+z)) }
    fun fromXY(x:Double,y:Double):String { if(y<=0)return "#ffffff"; val xx=x/y; val z=(1-x-y)/y; val rgb=doubleArrayOf(xx*3.2406-1.5372-z*.4986,-xx*.9689+1.8758+z*.0415,xx*.0557-.204+z*1.057); val top=max(rgb.maxOrNull()!!,1e-9); val c=rgb.map { (it/top).coerceAtLeast(0.0) }.map { if(it<=.0031308)12.92*it else 1.055*it.pow(1/2.4)-.055 }; return hex(c[0],c[1],c[2]) }
}
