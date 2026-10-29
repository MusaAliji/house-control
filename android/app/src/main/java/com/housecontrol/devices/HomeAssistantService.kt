package com.housecontrol.devices

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import kotlin.math.roundToInt

class HomeAssistantService(context:Context):DeviceService {
    override val id="homeassistant"
    private val vault=Vault(context,id);private var config=vault.read()
    override val connected get()=config!=null
    override fun info()=config?.let { obj("connected" to true,"url" to it.optString("url"),"name" to it.optString("name","Home Assistant"),"version" to it.optString("version")) }?:obj("connected" to false)
    fun shareable()=config?.copy()
    fun adopt(value:JSONObject?){config=value?.takeIf { it.optString("url").isNotEmpty()&&it.optString("token").isNotEmpty() }?.copy();vault.write(config)}
    override fun disconnect(){adopt(null)}
    fun connect(url:String,token:String){
        val candidate=obj("url" to normalize(url),"token" to token.trim());if(token.trim().isEmpty())throw DeviceFailure("Paste a long-lived Home Assistant access token.")
        val about=call("GET","/api/config",candidate=candidate) as JSONObject
        candidate.put("name",about.optString("location_name","Home Assistant")).put("version",about.optString("version"));adopt(candidate)
    }
    private fun normalize(raw:String):String {var s=raw.trim().trimEnd('/');if(s.isEmpty())throw DeviceFailure("Enter your Home Assistant address");if(!s.contains("://"))s="http://$s";val uri=try{URI(s)}catch(_:Exception){throw DeviceFailure("Invalid Home Assistant address")};if(uri.scheme !in listOf("http","https")||uri.host.isNullOrEmpty()||uri.userInfo!=null)throw DeviceFailure("Invalid Home Assistant address");if(uri.port<0&&uri.scheme=="http"&&(uri.host.endsWith(".local")||uri.host=="homeassistant"))s=URI(uri.scheme,null,uri.host,8123,uri.path,uri.query,null).toString();return s}
    private fun call(method:String,path:String,body:JSONObject?=null,candidate:JSONObject?=null,raw:Boolean=false):Any {val c=candidate?:config?:throw DeviceFailure("Connect Home Assistant first");return try{Http.call(method,c.getString("url")+path,body,mapOf("Authorization" to "Bearer ${c.getString("token")}"),raw=raw)}catch(e:DeviceFailure){if(e.code in listOf("401","403"))throw DeviceFailure("Home Assistant refused the token. Create a new long-lived access token and connect again.");throw e}}
    override fun devices():JSONArray {
        val states=(call("GET","/api/states") as JSONArray).objects();val rooms=mutableMapOf<String,String>()
        try{val template="{% for e in states %}{{ e.entity_id }}\t{{ area_name(e.entity_id) or '' }}\n{% endfor %}";val text=call("POST","/api/template",obj("template" to template),raw=true).toString();text.lines().forEach { val parts=it.split('\t',limit=2);if(parts.size==2&&parts[1].isNotEmpty()&&parts[1]!="None")rooms[parts[0]]=parts[1] }}catch(_:Exception){}
        return JSONArray(states.mapNotNull { device(it)?.apply { rooms[optString("id")]?.let { put("room",it) } } }.sortedWith(compareBy({it.optString("kind")},{it.optString("name")})))
    }
    override fun read(ids:Set<String>):Map<String,JSONObject> = (call("GET","/api/states") as JSONArray).objects().filter { it.optString("entity_id") in ids }.associate { it.getString("entity_id") to reading(it) }
    override fun send(kind:String,id:String,patch:JSONObject,state:JSONObject){
        val domain=id.substringBefore('.');fun send(service:String,body:JSONObject=JSONObject()){call("POST","/api/services/$domain/$service",body.put("entity_id",id))}
        if(domain=="switch"){if(patch.has("on"))send(if(patch.optBoolean("on"))"turn_on" else "turn_off");return}
        if(domain=="light"){
            if(patch.has("on")&&!patch.optBoolean("on")){send("turn_off");return}
            val body=JSONObject();patch.number("brightness")?.let { body.put("brightness_pct",(it*100).roundToInt()) };patch.number("temp")?.let { body.put("color_temp_kelvin",it.toInt()) };Colors.rgb(patch.optString("color"))?.let { body.put("rgb_color",JSONArray(it.map { (it*255).roundToInt() })) };if(body.length()>0||patch.optBoolean("on"))send("turn_on",body);return
        }
        if(domain!="climate")return
        if(patch.has("on")&&!patch.optBoolean("on")){send("set_hvac_mode",obj("hvac_mode" to "off"));return}
        val raw=call("GET","/api/states/${enc(id)}") as JSONObject;val a=raw.optJSONObject("attributes")?:JSONObject();val modes=modeTable(a.optJSONArray("hvac_modes")?:JSONArray());val fans=fanTable(a.optJSONArray("fan_modes")?:JSONArray())
        if(patch.optBoolean("on")||patch.has("mode")){val mode=patch.optString("mode",state.optString("mode","cool"));(modes[mode]?:modes.values.firstOrNull())?.let { send("set_hvac_mode",obj("hvac_mode" to it)) }}
        patch.number("target")?.let { send("set_temperature",obj("temperature" to it)) };fans[patch.optString("fan")]?.let { send("set_fan_mode",obj("fan_mode" to it)) }
        if(patch.has("swing")){val available=(a.optJSONArray("swing_modes")?:JSONArray()).strings();val value=if(patch.optString("swing")=="off")"off" else available.firstOrNull { it!="off" }?:"on";send("set_swing_mode",obj("swing_mode" to value))}
        listOf("sleep","eco").forEach { if(patch.has(it))send("set_preset_mode",obj("preset_mode" to if(patch.optBoolean(it))it else "none")) }
    }
    companion object {
        private fun modeTable(modes:JSONArray):Map<String,String>{val names=modes.strings();return linkedMapOf("cool" to listOf("cool"),"heat" to listOf("heat"),"dry" to listOf("dry"),"fan" to listOf("fan_only"),"auto" to listOf("auto","heat_cool")).mapNotNull { (k,v)->v.firstOrNull { it in names }?.let { k to it } }.toMap()}
        private fun panelFan(name:String):String? {val n=name.lowercase();return when{listOf("turbo","max","strong","highest","powerful","boost","very high").any { n.contains(it) }->"turbo";n.contains("high")->"high";n.contains("med")||n.contains("mid")->"medium";listOf("low","quiet","silent").any{n.contains(it)}->"low";n.contains("auto")->"auto";else->null}}
        private fun fanTable(values:JSONArray):Map<String,String> = linkedMapOf<String,String>().apply { values.strings().filter { it.lowercase()!="off" }.forEach { name->panelFan(name)?.let { if(!containsKey(it))put(it,name) } } }
        private fun device(raw:JSONObject):JSONObject? {
            val id=raw.optString("entity_id");val a=raw.optJSONObject("attributes")?:JSONObject();val domain=id.substringBefore('.');val kind=when(domain){"light","switch"->"light";"climate"->"ac";"sensor"->if(a.optString("device_class")=="temperature"||a.optString("unit_of_measurement") in listOf("°C","°F"))"sensor" else return null;else->return null}
            val modes=(a.optJSONArray("supported_color_modes")?:JSONArray()).strings();val caps=mutableListOf<String>();if(domain=="light"){if(modes.any { it!="onoff" })caps.add("brightness");if("color_temp" in modes)caps.add("temp");if(modes.any { it in listOf("hs","xy","rgb","rgbw","rgbww") })caps.add("color")}
            return obj("service" to "homeassistant","id" to id,"name" to a.optString("friendly_name",id),"kind" to kind,"online" to (raw.optString("state") !in listOf("unavailable","unknown")),"capabilities" to JSONArray(caps),"detail" to "$domain · ${modes.joinToString(", ")}").apply{if(kind=="ac"){a.number("min_temp")?.let{put("min",it.coerceAtLeast(10.0))};a.number("max_temp")?.let{put("max",it.coerceAtMost(32.0))}}}
        }
        private fun reading(raw:JSONObject):JSONObject {
            val id=raw.optString("entity_id");val value=raw.optString("state");val a=raw.optJSONObject("attributes")?:JSONObject();val out=obj("online" to (value !in listOf("unavailable","unknown")));if(!out.optBoolean("online"))return out
            if(id.startsWith("light.")||id.startsWith("switch.")){
                val light=obj("on" to (value=="on"));if(value=="on")a.number("brightness")?.let{light.put("brightness",(it/255).coerceIn(.05,1.0))}
                when(a.optString("color_mode")){"color_temp"->a.number("color_temp_kelvin")?.let{light.put("temp",it.coerceIn(2200.0,6500.0)).put("color",JSONObject.NULL)};"hs","xy","rgb","rgbw","rgbww"->a.optJSONArray("rgb_color")?.takeIf{it.length()==3}?.let{light.put("color",Colors.hex(it.optDouble(0)/255,it.optDouble(1)/255,it.optDouble(2)/255))}}
                out.put("light",light)
            } else if(id.startsWith("climate.")){
                val modes=modeTable(a.optJSONArray("hvac_modes")?:JSONArray());val fans=fanTable(a.optJSONArray("fan_modes")?:JSONArray());val swings=(a.optJSONArray("swing_modes")?:JSONArray()).strings();val presets=(a.optJSONArray("preset_modes")?:JSONArray()).strings();val ac=obj("on" to (value!="off"));modes.entries.firstOrNull{it.value==value}?.let{ac.put("mode",it.key)}
                (a.number("temperature")?:a.number("target_temp_low")?.let{lo->a.number("target_temp_high")?.let{hi->((lo+hi)/2).roundToInt().toDouble()}})?.let{ac.put("target",it)};a.number("current_temperature")?.let{ac.put("roomTemp",it)};panelFan(a.optString("fan_mode"))?.takeIf{it in fans}?.let{ac.put("fan",it)}
                if(swings.isNotEmpty()&&a.has("swing_mode"))ac.put("swing",if(a.optString("swing_mode")=="off")"off" else "swing");listOf("sleep","eco").filter{it in presets}.forEach{ac.put(it,a.optString("preset_mode")==it)}
                out.put("ac",ac).put("features",obj("modes" to JSONArray(listOf("cool","heat","dry","fan","auto").filter{it in modes}),"fans" to JSONArray(listOf("auto","low","medium","high","turbo").filter{it in fans}),"swing" to ("off" in swings&&swings.size>1),"sleep" to ("sleep" in presets),"eco" to ("eco" in presets)))
            }else if(id.startsWith("sensor."))value.toDoubleOrNull()?.let{out.put("temperature",if(a.optString("unit_of_measurement")=="°F")(it-32)*5/9 else it)}
            return out
        }
    }
}
