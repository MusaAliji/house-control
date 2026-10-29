package com.housecontrol.devices

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.*

internal object TuyaMapper {
    val modes=linkedMapOf("cool" to "cold","heat" to "hot","dry" to "wet","fan" to "wind","auto" to "auto")
    val fans=linkedMapOf("auto" to "auto","low" to "low","medium" to "mid","high" to "high","turbo" to "strong")
    private val irModes=mapOf("cool" to 0,"heat" to 1,"auto" to 2,"fan" to 3,"dry" to 4)
    private val irFans=mapOf("auto" to 0,"low" to 1,"medium" to 2,"high" to 3,"turbo" to 3)
    fun infrared(codes:Set<String>)=codes.contains("PowerOn")||codes.contains("PowerOff")
    private fun range(code:String,ranges:Map<String,Pair<Double,Double>>,floor:Double=0.0)=ranges[code]?.takeIf { it.second>it.first } ?: if(code.endsWith("_v2")) Pair(if(floor>0)10.0 else 0.0,1000.0) else Pair(floor,255.0)
    private fun pick(candidates:List<String>,codes:Set<String>,custom:JSONObject,key:String)=custom.optString(key).takeIf { it.isNotEmpty() } ?: candidates.firstOrNull { codes.contains(it) }
    fun lightCommands(patch:JSONObject,state:JSONObject,link:JSONObject,codes:Set<String>,ranges:Map<String,Pair<Double,Double>>):JSONArray {
        val out=JSONArray(); val custom=link.optJSONObject("codes")?:JSONObject()
        fun add(code:String,value:Any){out.put(obj("code" to code,"value" to value))}
        if(patch.has("on"))add(pick(listOf("switch_led","switch_1","switch"),codes,custom,"switch")?:"switch_1",patch.getBoolean("on"))
        patch.number("brightness")?.let { b -> listOf("bright_value_v2","bright_value").firstOrNull { it in codes }?.let { val (lo,hi)=range(it,ranges,25.0); add(it,(lo+b*(hi-lo)).roundToInt()) } }
        patch.number("temp")?.let { k -> listOf("temp_value_v2","temp_value").firstOrNull { it in codes }?.let { val (lo,hi)=range(it,ranges); if("work_mode" in codes)add("work_mode","white"); add(it,(lo+((k-2200)/4300).coerceIn(0.0,1.0)*(hi-lo)).roundToInt()) } }
        Colors.hsv(patch.optString("color"))?.let { hsv -> listOf("colour_data_v2","colour_data").firstOrNull { it in codes }?.let { val scale=if(range(if(it.endsWith("_v2"))"bright_value_v2" else "bright_value",ranges).second>255)1000 else 255; if("work_mode" in codes)add("work_mode","colour"); add(it,obj("h" to hsv[0].toInt(),"s" to (hsv[1]*scale).toInt(),"v" to (max(.01,state.optDouble("brightness",1.0))*scale).toInt()).toString()) } }
        return out
    }
    fun lightState(status:JSONArray,ranges:Map<String,Pair<Double,Double>>):JSONObject = JSONObject().apply {
        status.objects().forEach { dp -> val code=dp.optString("code"); val value=dp.opt("value"); when(code){
            "switch_led","switch_1","switch" -> if(!has("on") && value is Boolean)put("on",value)
            "bright_value_v2","bright_value" -> (value as? Number)?.toDouble()?.let { val(lo,hi)=range(code,ranges,25.0); put("brightness",((it-lo)/(hi-lo)).coerceIn(.05,1.0)) }
            "temp_value_v2","temp_value" -> (value as? Number)?.toDouble()?.let { val(lo,hi)=range(code,ranges); put("temp",2200+((it-lo)/(hi-lo)).coerceIn(0.0,1.0)*4300) }
        } }
    }
    fun infraredKeys(patch:JSONObject):List<Pair<String,JSONObject>> = buildList {
        if(patch.has("on")){val key=if(patch.optBoolean("on"))"PowerOn" else "PowerOff"; add("on" to obj("code" to key,"value" to key))}
        irModes[patch.optString("mode")]?.let { add("mode" to obj("code" to "M","value" to it)) }
        patch.number("target")?.let { add("target" to obj("code" to "T","value" to it.toInt())) }
        irFans[patch.optString("fan")]?.let { add("fan" to obj("code" to "F","value" to it)) }
    }
    fun acCommands(patch:JSONObject,link:JSONObject,codes:Set<String>):JSONArray {
        if(infrared(codes))return JSONArray(infraredKeys(patch).map { it.second })
        val out=JSONArray();val custom=link.optJSONObject("codes")?:JSONObject()
        fun add(code:String,value:Any){out.put(obj("code" to code,"value" to value))}
        if(patch.has("on"))add(pick(listOf("switch","power","switch_1"),codes,custom,"switch")?:"switch",patch.getBoolean("on"))
        patch.number("target")?.let { add(custom.optString("target","temp_set"),it.toInt()) }
        modes[patch.optString("mode")]?.let { add(custom.optString("mode","mode"),it) }
        fans[patch.optString("fan")]?.let { value -> pick(listOf("fan_speed_enum","windspeed"),codes,custom,"fan")?.let { add(it,value) } }
        listOf("sleep","eco").forEach { if(patch.has(it)&&it in codes)add(it,patch.getBoolean(it)) }
        return out
    }
    fun acState(status:JSONArray)=JSONObject().apply { status.objects().forEach { dp -> val value=dp.opt("value");when(dp.optString("code")){
        "switch","power" -> if(value is Boolean)put("on",value)
        "temp_set" -> if(value is Number)put("target",value)
        "temp_current" -> if(value is Number)put("roomTemp",value)
        "mode" -> modes.entries.firstOrNull { it.value==value }?.let { put("mode",it.key) }
        "fan_speed_enum","windspeed" -> fans.entries.firstOrNull { it.value==value }?.let { put("fan",it.key) }
    } } }
    fun sensor(status:JSONArray):Double? = status.objects().firstOrNull { it.optString("code") in listOf("temp_current","va_temperature") }?.number("value")?.let { if(abs(it)>60)it/10 else it }
    fun features(codes:Set<String>,ranges:Map<String,Pair<Double,Double>>):JSONObject? {
        if(codes.isEmpty())return null
        val ir=infrared(codes)
        return obj("infrared" to ir,"modes" to JSONArray(if(ir) modes.keys.filter { (irModes[it]?:99).toDouble() in ((ranges["M"]?.first?:0.0)..(ranges["M"]?.second?:4.0)) } else if("mode" in codes)modes.keys.toList() else emptyList<String>()),"fans" to JSONArray(if(ir)listOf("auto","low","medium","high").filter { (irFans[it]?:99).toDouble() in ((ranges["F"]?.first?:0.0)..(ranges["F"]?.second?:3.0)) } else if("fan_speed_enum" in codes||"windspeed" in codes)fans.keys.toList() else emptyList<String>()),"sleep" to (!ir&&"sleep" in codes),"eco" to (!ir&&"eco" in codes),"swing" to false)
    }
}

internal class InfraredRemote(private val spacingMillis: Long = 1000) {
    private val last=mutableMapOf<String,Long>();private val deferred=mutableMapOf<String,MutableSet<String>>()
    fun apply(id:String,patch:JSONObject,state:JSONObject,send:(JSONObject)->Unit){
        val wanted=JSONObject();listOf("on","mode","target","fan").filter { patch.has(it) }.forEach { wanted.put(it,patch.get(it)) }
        if(!state.optBoolean("on")&&!wanted.has("on")){deferred.getOrPut(id){mutableSetOf()}.addAll(wanted.keys().asSequence().toList());return}
        if(wanted.optBoolean("on"))deferred.remove(id)?.filter { !wanted.has(it)&&state.has(it) }?.forEach { wanted.put(it,state.get(it)) }
        if(wanted.has("on")&&!wanted.optBoolean("on"))deferred.remove(id)
        val keys=TuyaMapper.infraredKeys(wanted);var index=0;var replayed=false
        fun press(command:JSONObject){val wait=spacingMillis-(System.currentTimeMillis()-(last[id]?:0));if(wait>0)Thread.sleep(wait);try{send(command)}finally{last[id]=System.currentTimeMillis()}}
        while(index<keys.size){val key=keys[index];try{press(key.second);index++}catch(e:Exception){
            val pending=keys.drop(index).map { it.first }
            if(e is DeviceFailure && e.code=="2008"&&!replayed&&state.optBoolean("on")&&key.first!="on"){
                replayed=true;val rest=state.copy();(pending+keys.take(index).map { it.first }).forEach { rest.remove(it) };TuyaMapper.infraredKeys(rest).forEach { try{press(it.second)}catch(_:Exception){} };continue
            }
            throw DeviceFailure(if(e is DeviceFailure && e.code=="2008")"This remote has no infrared code for that setting (Tuya code 2008)" else e.message?:"Remote command failed",(e as? DeviceFailure)?.code?:"",pending)
        }}
    }
}
