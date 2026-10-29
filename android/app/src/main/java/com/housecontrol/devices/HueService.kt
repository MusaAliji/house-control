package com.housecontrol.devices

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import kotlin.math.roundToInt

/** Hue uses trust-on-first-use at pairing, then strictly pins its leaf certificate. */
class HueService(context:Context):DeviceService {
    override val id="hue";private val vault=Vault(context,id);private var config=vault.read()
    override val connected get()=config!=null
    private var seen:String?=null
    override fun info()=config?.let{obj("connected" to true,"host" to it.optString("host"),"name" to it.optString("name","Hue Bridge"),"bridgeId" to it.optString("bridgeId"))}?:obj("connected" to false)
    fun shareable()=config?.copy()
    fun adopt(value:JSONObject?){config=value?.takeIf{it.optString("host").isNotEmpty()&&it.optString("key").isNotEmpty()}?.copy();vault.write(config)}
    override fun disconnect(){adopt(null)}
    internal fun eventStream(): HttpURLConnection {
        val c = config?.copy() ?: throw DeviceFailure("Pair a Hue Bridge first")
        return (URL("https://${c.getString("host")}/eventstream/clip/v2").openConnection() as HttpURLConnection).apply {
            tls(this, c)
            connectTimeout = 12000
            readTimeout = 60000
            setRequestProperty("Accept", "text/event-stream")
            setRequestProperty("hue-application-key", c.getString("key"))
        }
    }
    private fun tls(connection:HttpURLConnection,c:JSONObject,pairing:Boolean=false){
        if(connection !is HttpsURLConnection)return
        val expected=c.optString("certificate");val expectedHost=URL("https://${c.getString("host")}").host
        if(expected.isEmpty()&&!pairing)throw DeviceFailure("Pair this Hue Bridge again to establish its certificate")
        val trust=object:X509TrustManager {
            override fun getAcceptedIssuers()=emptyArray<X509Certificate>()
            override fun checkClientTrusted(chain:Array<out X509Certificate>?,authType:String?) {throw java.security.cert.CertificateException("Client certificate is not supported")}
            override fun checkServerTrusted(chain:Array<out X509Certificate>?,authType:String?){
                val leaf=chain?.firstOrNull()?:throw java.security.cert.CertificateException("Hue certificate missing")
                val fingerprint=hex(MessageDigest.getInstance("SHA-256").digest(leaf.encoded))
                if(expected.isNotEmpty()&&expected!=fingerprint)throw java.security.cert.CertificateException("Hue Bridge certificate changed. Pair again.")
                seen=fingerprint
            }
        }
        connection.sslSocketFactory=SSLContext.getInstance("TLS").apply{init(null,arrayOf(trust),SecureRandom())}.socketFactory
        connection.hostnameVerifier=javax.net.ssl.HostnameVerifier{host,_->host==expectedHost}
        connection.instanceFollowRedirects=false
    }
    fun pair(raw:String,bridgeId:String?=null,name:String?=null){
        val host=raw.trim().removePrefix("https://").removePrefix("http://").trimEnd('/')
        val url=try{URL("https://$host/api")}catch(_:Exception){throw DeviceFailure("Enter the bridge address")}
        if(url.host.isEmpty()||url.userInfo!=null||url.path!="/api")throw DeviceFailure("Enter the bridge address")
        val candidate=obj("host" to host,"bridgeId" to bridgeId,"name" to (name?:"Hue Bridge"))
        val answer=(Http.call("POST",url.toString(),obj("devicetype" to "house_control#Android","generateclientkey" to true),configure={tls(it,candidate,true)}) as? JSONArray)?.optJSONObject(0)?:throw DeviceFailure("This address did not answer like a Hue Bridge")
        answer.optJSONObject("error")?.let{throw DeviceFailure(if(it.optInt("type")==101)"Press the round button on the Hue Bridge." else it.optString("description","Hue pairing failed"),it.optString("type"))}
        val key=answer.optJSONObject("success")?.optString("username")?.takeIf{it.isNotEmpty()}?:throw DeviceFailure("Hue Bridge returned no key")
        candidate.put("key",key).put("certificate",seen?:throw DeviceFailure("Hue certificate could not be pinned"));config=candidate
        try{val bridge=get("bridge").optJSONObject(0);if(bridge!=null){candidate.put("bridgeId",bridge.optString("bridge_id"));val device=get("device").objects().firstOrNull{(it.optJSONArray("services")?:JSONArray()).objects().any{it.optString("rid")==bridge.optString("id")}};device?.optJSONObject("metadata")?.optString("name")?.let{candidate.put("name",it)}}}catch(_:Exception){}
        adopt(candidate)
    }
    private fun call(method:String,path:String,body:JSONObject?=null):JSONObject {
        val c=config?:throw DeviceFailure("Pair a Hue Bridge first")
        val answer=Http.call(method,"https://${c.getString("host")}$path",body,mapOf("hue-application-key" to c.getString("key")),configure={tls(it,c)}) as? JSONObject?:throw DeviceFailure("Invalid Hue response")
        answer.optJSONArray("errors")?.optJSONObject(0)?.let{throw DeviceFailure("Hue: ${it.optString("description","Bridge refused the request")}")};return answer
    }
    private fun get(type:String)=call("GET","/clip/v2/resource/$type").optJSONArray("data")?:JSONArray()
    override fun devices():JSONArray {
        val rooms=mutableMapOf<String,String>();get("room").objects().forEach{room->(room.optJSONArray("children")?:JSONArray()).objects().forEach{rooms[it.optString("rid")]=room.optJSONObject("metadata")?.optString("name").orEmpty()}}
        val hardware=get("device").objects().associateBy{it.optString("id")};val offline=get("zigbee_connectivity").objects().filter{it.optString("status")!="connected"}.mapNotNull{it.optJSONObject("owner")?.optString("rid")}.toSet()
        val out=JSONArray();get("light").objects().forEach{light->val owner=light.optJSONObject("owner")?.optString("rid").orEmpty();val caps=listOf("dimming" to "brightness","color_temperature" to "temp","color" to "color").filter{light.has(it.first)}.map{it.second};out.put(obj("service" to id,"id" to light.getString("id"),"name" to (light.optJSONObject("metadata")?.optString("name")?:"Hue light"),"kind" to "light","room" to rooms[owner],"online" to (owner !in offline),"capabilities" to JSONArray(caps),"detail" to (light.optJSONObject("metadata")?.optString("archetype","light")?:"light")+" · "+caps.joinToString(", ")))}
        get("temperature").objects().forEach{sensor->val owner=sensor.optJSONObject("owner")?.optString("rid").orEmpty();out.put(obj("service" to id,"id" to sensor.getString("id"),"name" to (hardware[owner]?.optJSONObject("metadata")?.optString("name")?:"Hue sensor"),"kind" to "sensor","room" to rooms[owner],"online" to (owner !in offline),"capabilities" to JSONArray(),"detail" to "temperature sensor"))};return out
    }
    override fun read(ids:Set<String>):Map<String,JSONObject> {
        val out=mutableMapOf<String,JSONObject>();if(ids.isEmpty())return out
        get("light").objects().filter{it.optString("id") in ids}.forEach{raw->val state=JSONObject();raw.optJSONObject("on")?.let{state.put("on",it.optBoolean("on"))};raw.optJSONObject("dimming")?.number("brightness")?.let{state.put("brightness",(it/100).coerceIn(.05,1.0))};val ct=raw.optJSONObject("color_temperature");if(ct?.optBoolean("mirek_valid")==true&&ct.number("mirek")!=null)state.put("temp",(1_000_000/ct.getDouble("mirek").coerceAtLeast(1.0)).coerceIn(2200.0,6500.0)).put("color",JSONObject.NULL)else raw.optJSONObject("color")?.optJSONObject("xy")?.let{state.put("color",Colors.fromXY(it.optDouble("x"),it.optDouble("y")))};out[raw.getString("id")]=obj("online" to true,"light" to state)}
        get("temperature").objects().filter{it.optString("id") in ids}.forEach{raw->val t=raw.optJSONObject("temperature");val v=t?.optJSONObject("temperature_report")?.number("temperature")?:t?.number("temperature");out[raw.getString("id")]=obj("online" to true,"temperature" to v)};return out
    }
    override fun send(kind:String,id:String,patch:JSONObject,state:JSONObject){
        if(kind!="light")throw DeviceFailure("Hue has no air conditioners")
        val body=JSONObject();if(patch.has("on"))body.put("on",obj("on" to patch.getBoolean("on")))else if(state.optBoolean("on")&&listOf("brightness","temp","color").any{patch.has(it)})body.put("on",obj("on" to true))
        patch.number("brightness")?.let{body.put("dimming",obj("brightness" to (it*1000).roundToInt()/10.0))};patch.number("temp")?.let{body.put("color_temperature",obj("mirek" to (1_000_000/it.coerceAtLeast(1000.0)).roundToInt()))};Colors.xy(patch.optString("color"))?.let{body.put("color",obj("xy" to obj("x" to it[0],"y" to it[1])))};if(body.length()>0)call("PUT","/clip/v2/resource/light/${enc(id)}",body)
    }
}
