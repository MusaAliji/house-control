package com.housecontrol.devices

import android.content.Context
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

interface DeviceCloud {
    val connected:Boolean
    val knownCodes:MutableMap<String,Set<String>>
    val knownRanges:MutableMap<String,Map<String,Pair<Double,Double>>>
    fun listDevices():JSONArray
    fun status(ids:List<String>):Map<String,JSONArray>
    fun send(id:String,commands:JSONArray)
    fun prepare(id:String)
}

class SmartLifeService(context:Context):DeviceCloud {
    private val vault=Vault(context,"smartlife")
    private var session=vault.read()
    override val connected get()=session!=null
    override val knownCodes=mutableMapOf<String,Set<String>>()
    override val knownRanges=mutableMapOf<String,Map<String,Pair<Double,Double>>>()
    companion object { const val CLIENT="HA_3y9q4ak7g4ephrvke";const val LOGIN="https://apigw.iotbing.com" }
    fun info()=obj("connected" to connected,"userCode" to session?.optString("userCode").orEmpty(),"account" to session?.optString("username").orEmpty())
    @Synchronized fun signOut(){session=null;vault.write(null);knownCodes.clear();knownRanges.clear()}
    fun beginLogin(userCode:String):JSONObject {
        if(userCode.trim().isEmpty())throw DeviceFailure("Enter the User Code from the Smart Life app first.")
        val json=Http.call("POST","$LOGIN/v1.0/m/life/home-assistant/qrcode/tokens?clientid=$CLIENT&usercode=${enc(userCode.trim())}&schema=haauthorize") as JSONObject
        if(!json.optBoolean("success"))fail(json)
        val token=json.getJSONObject("result").getString("qrcode")
        return obj("token" to token,"qrContent" to "tuyaSmart--qrLogin?token=$token")
    }
    @Synchronized fun finishLogin(token:String,userCode:String):Boolean {
        val json=Http.call("GET","$LOGIN/v1.0/m/life/home-assistant/qrcode/tokens/${enc(token)}?clientid=$CLIENT&usercode=${enc(userCode.trim())}") as JSONObject
        val r=json.optJSONObject("result")?:return false
        if(!json.optBoolean("success")||!r.has("access_token"))return false
        session=obj("userCode" to userCode.trim(),"accessToken" to r.getString("access_token"),"refreshToken" to r.getString("refresh_token"),"expiresAt" to (json.optDouble("t",System.currentTimeMillis().toDouble())+r.optDouble("expire_time",7200.0)*1000),"uid" to r.optString("uid"),"endpoint" to r.getString("endpoint"),"username" to r.optString("username"))
        vault.write(session);return true
    }
    override fun listDevices():JSONArray {
        val out=JSONArray()
        val homes=request("GET","/v1.0/m/life/users/homes") as? JSONArray?:JSONArray()
        homes.objects().forEach { home -> val homeId=home.optString("ownerId");if(homeId.isNotEmpty()){
            val list=request("GET","/v1.0/m/life/ha/home/devices",obj("homeId" to homeId)) as? JSONArray?:JSONArray()
            list.objects().forEach { d -> val codes=(d.optJSONArray("status")?:JSONArray()).objects().map { it.optString("code") };knownCodes[d.getString("id")]=codes.toSet();out.put(obj("id" to d.getString("id"),"name" to d.optString("name",d.getString("id")),"category" to d.optString("category"),"product" to d.optString("product_name"),"online" to d.optBoolean("online"),"codes" to JSONArray(codes),"home" to home.optString("name"))) }
        }}
        return out
    }
    override fun status(ids:List<String>):Map<String,JSONArray> {
        val out=mutableMapOf<String,JSONArray>()
        ids.chunked(20).forEach { chunk -> (request("GET","/v1.0/m/life/ha/devices/detail",obj("devIds" to chunk.joinToString(","))) as? JSONArray)?.objects()?.forEach { d -> d.optJSONArray("status")?.let { out[d.getString("id")]=it;knownCodes[d.getString("id")]=(knownCodes[d.getString("id")]?:emptySet())+it.objects().map { it.optString("code") } } } }
        ids.forEach { prepare(it) };return out
    }
    override fun send(id:String,commands:JSONArray){if(commands.length()>0)request("POST","/v1.1/m/thing/${enc(id)}/commands",body=obj("commands" to commands))}
    override fun prepare(id:String){
        if(knownRanges.containsKey(id))return
        knownRanges[id]=emptyMap()
        try{val spec=request("GET","/v1.1/m/life/${enc(id)}/specifications") as? JSONObject?:return
            val ranges=mutableMapOf<String,Pair<Double,Double>>();var codes=knownCodes[id]?:emptySet()
            listOf("status","functions").forEach { (spec.optJSONArray(it)?:JSONArray()).objects().forEach { item -> val code=item.optString("code");codes=codes+code;try{val v=JSONObject(item.optString("values"));val lo=v.number("min");val hi=v.number("max");if(lo!=null&&hi!=null)ranges[code]=lo to hi}catch(_:Exception){} } }
            knownCodes[id]=codes;knownRanges[id]=ranges
        }catch(_:Exception){}
    }
    fun diagnostics(ids:List<String>):JSONObject {
        val out=JSONObject();(request("GET","/v1.0/m/life/ha/devices/detail",obj("devIds" to ids.joinToString(","))) as? JSONArray)?.objects()?.forEach { d ->
            val entry=d.copy();val id=d.getString("id");listOf("specification" to "/v1.1/m/life/${enc(id)}/specifications","strategy" to "/v1.0/m/life/devices/${enc(id)}/status").forEach { (key,path) -> try{entry.put(key,request("GET",path))}catch(e:Exception){entry.put("${key}_error",e.message)} };out.put(id,entry)
        };return out
    }
    @Synchronized private fun request(method:String,path:String,query:JSONObject=JSONObject(),body:JSONObject=JSONObject(),refresh:Boolean=true):Any {
        var s=session?:throw DeviceFailure("Not signed in to Smart Life")
        if(refresh && s.optDouble("expiresAt")-60000<System.currentTimeMillis()){
            try{val r=request("GET","/v1.0/m/token/${enc(s.getString("refreshToken"))}",refresh=false) as JSONObject
                s=s.copy().put("accessToken",r.getString("accessToken")).put("refreshToken",r.getString("refreshToken")).put("expiresAt",System.currentTimeMillis()+r.optDouble("expireTime",7200.0)*1000)
                if(r.has("uid"))s.put("uid",r.getString("uid"));session=s;vault.write(s)
            }catch(_:Exception){}
        }
        val rid=UUID.randomUUID().toString().lowercase();val hash=digest("MD5",rid+s.getString("refreshToken"));val secret=hmac(rid,hash).take(16)
        val q=if(query.length()>0)Transport.encrypt(query.toString(),secret) else "";val b=if(body.length()>0)Transport.encrypt(body.toString(),secret) else ""
        val headers=linkedMapOf("X-appKey" to CLIENT,"X-requestId" to rid,"X-sid" to "","X-time" to System.currentTimeMillis().toString(),"X-token" to s.getString("accessToken"))
        val text=headers.filterValues { it.isNotEmpty() }.entries.joinToString("||") { "${it.key}=${it.value}" }+q+b
        headers["X-sign"]=hmac(hash,text)
        val json=Http.call(method,s.getString("endpoint").trimEnd('/')+path+(if(q.isNotEmpty())"?encdata=${enc(q)}" else ""),if(b.isEmpty())null else obj("encdata" to b),headers) as JSONObject
        if(!json.optBoolean("success"))fail(json)
        val result=json.opt("result")?:JSONObject.NULL
        return if(result is String) { val plain=Transport.decrypt(result,secret);try{JSONTokener(plain).nextValue()}catch(_:Exception){plain} } else result
    }
    private fun fail(json:JSONObject):Nothing {val code=json.optString("code");throw DeviceFailure(if(code=="2001")"Device is offline — Smart Life cannot reach it over Wi-Fi (code 2001)" else "${json.optString("msg","Smart Life request failed")} (code $code)",code)}
    internal object Transport {
        private const val ALPHABET="ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
        fun encrypt(plain:String,secret:String,nonce:String?=null):String {val rng=SecureRandom();val iv=(nonce?: (0 until 12).map { ALPHABET[rng.nextInt(ALPHABET.length)] }.joinToString("")).toByteArray();val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.ENCRYPT_MODE,SecretKeySpec(secret.toByteArray(),"AES"),GCMParameterSpec(128,iv))};return Base64.getEncoder().encodeToString(iv)+Base64.getEncoder().encodeToString(cipher.doFinal(plain.toByteArray()))}
        fun decrypt(text:String,secret:String):String {val bytes=Base64.getDecoder().decode(text);if(bytes.size<=28)throw DeviceFailure("Could not decode Smart Life response");val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply{init(Cipher.DECRYPT_MODE,SecretKeySpec(secret.toByteArray(),"AES"),GCMParameterSpec(128,bytes.copyOfRange(0,12)))};return String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)),Charsets.UTF_8)}
    }
}

class TuyaService(context:Context):DeviceCloud {
    private val vault=Vault(context,"tuya");private var credentials=vault.read();private var token="";private var expiry=0L
    override val knownCodes=mutableMapOf<String,Set<String>>();override val knownRanges=mutableMapOf<String,Map<String,Pair<Double,Double>>>()
    companion object { val hosts=mapOf("eu" to "openapi.tuyaeu.com","eu-w" to "openapi-weaz.tuyaeu.com","us" to "openapi.tuyaus.com","us-e" to "openapi-ueaz.tuyaus.com","cn" to "openapi.tuyacn.com","in" to "openapi.tuyain.com","sg" to "openapi-sg.iotbing.com") }
    override val connected get()=credentials?.let { it.optString("accessId").isNotEmpty()&&it.optString("accessSecret").isNotEmpty()&&hosts.containsKey(it.optString("region")) }?:false
    fun info()=obj("configured" to connected,"accessId" to credentials?.optString("accessId").orEmpty(),"region" to (credentials?.optString("region")?:"eu"),"hasSecret" to !credentials?.optString("accessSecret").isNullOrEmpty())
    fun save(accessId:String,accessSecret:String,region:String){credentials=if(accessId.trim().isEmpty())null else obj("accessId" to accessId.trim(),"accessSecret" to accessSecret.trim().ifEmpty { credentials?.optString("accessSecret").orEmpty() },"region" to region);vault.write(credentials);token="";expiry=0;knownCodes.clear();knownRanges.clear()}
    override fun prepare(id:String){}
    override fun listDevices():JSONArray {val out=JSONArray();var last="";do{val query=linkedMapOf("size" to "50");if(last.isNotEmpty())query["last_row_key"]=last;val r=request("GET","/v1.0/iot-01/associated-users/devices",query) as JSONObject;(r.optJSONArray("devices")?:JSONArray()).objects().forEach { d -> val codes=(d.optJSONArray("status")?:JSONArray()).objects().map { it.optString("code") };knownCodes[d.getString("id")]=codes.toSet();out.put(obj("id" to d.getString("id"),"name" to d.optString("name"),"category" to d.optString("category"),"product" to d.optString("product_name"),"online" to d.optBoolean("online"),"codes" to JSONArray(codes))) };last=if(r.optBoolean("has_more"))r.optString("last_row_key") else ""}while(last.isNotEmpty());return out}
    override fun status(ids:List<String>):Map<String,JSONArray>{val out=mutableMapOf<String,JSONArray>();ids.chunked(20).forEach { chunk -> (request("GET","/v1.0/iot-03/devices/status",mapOf("device_ids" to chunk.joinToString(","))) as? JSONArray)?.objects()?.forEach { d -> d.optJSONArray("status")?.let { out[d.getString("id")]=it;knownCodes[d.getString("id")]=it.objects().map { it.optString("code") }.toSet() } } };return out}
    override fun send(id:String,commands:JSONArray){if(commands.length()>0)request("POST","/v1.0/iot-03/devices/${enc(id)}/commands",body=obj("commands" to commands))}
    @Synchronized private fun request(method:String,path:String,query:Map<String,String> = emptyMap(),body:JSONObject?=null,authorized:Boolean=true,retry:Boolean=true):Any {
        val c=credentials?:throw DeviceFailure("Tuya credentials are not set");if(!connected)throw DeviceFailure("Tuya credentials are incomplete")
        if(authorized&&(token.isEmpty()||expiry<System.currentTimeMillis()+60000)){val r=request("GET","/v1.0/token",mapOf("grant_type" to "1"),authorized=false) as JSONObject;token=r.getString("access_token");expiry=System.currentTimeMillis()+r.optLong("expire_time",3600)*1000}
        val signed=path+if(query.isEmpty())"" else query.toSortedMap().entries.joinToString("&","?"){"${enc(it.key)}=${enc(it.value)}"}
        val t=System.currentTimeMillis().toString();val access=if(authorized)token else "";val sign=hmac(c.getString("accessSecret"),c.getString("accessId")+access+t+"$method\n${digest("SHA-256",body?.toString()?:"")}\n\n$signed").uppercase()
        val headers=mutableMapOf("client_id" to c.getString("accessId"),"sign" to sign,"t" to t,"sign_method" to "HMAC-SHA256");if(authorized)headers["access_token"]=access
        val json=Http.call(method,"https://${hosts[c.getString("region")]}$signed",body,headers) as JSONObject
        if(json.optBoolean("success"))return json.opt("result")?:JSONObject.NULL
        val code=json.optString("code");if(authorized&&retry&&code in listOf("1010","1011")){token="";return request(method,path,query,body,true,false)}
        throw DeviceFailure("${json.optString("msg","Tuya request failed")} (code $code)",code)
    }
}
