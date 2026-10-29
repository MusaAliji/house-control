package com.housecontrol.devices

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** Source port of the shared iOS DeviceHub. Call network operations off the UI thread. */
class DeviceHub(context:Context) {
    val smartLife=SmartLifeService(context)
    val tuya=TuyaService(context)
    val homeAssistant=HomeAssistantService(context)
    val hue=HueService(context)
    val services:List<DeviceService> = listOf(homeAssistant,hue)
    var onStale: (() -> Unit)? = null
    private val live = LiveUpdates(homeAssistant, hue) { onStale?.invoke() }
    @Volatile private var running = false
    fun start() { running = true; refreshLive() }
    fun stop() { running = false; live.stop() }
    private fun refreshLive() {
        if (!running) return
        fun ids(platform: String) = links.values.flatMap { link ->
            listOf(if (link.platform == platform) link.target else "",
                if (link.sensor?.optString("service") == platform) link.sensor.optString("id") else "")
        }.filter { it.isNotEmpty() }.toSet()
        live.start(ids("homeassistant"), ids("hue"))
    }
    private val infrared=InfraredRemote()
    private data class Link(val kind:String,val platform:String,val target:String,val data:JSONObject,val sensor:JSONObject?)
    @Volatile private var links:Map<String,Link> = emptyMap()
    private val locks=ConcurrentHashMap<String,Any>()
    private val cloud:DeviceCloud? get()=if(smartLife.connected)smartLife else if(tuya.connected)tuya else null
    val connected get()=cloud!=null||services.any{it.connected}
    val hasLinks get()=links.isNotEmpty()
    val canPoll get()=links.values.any{if(it.platform=="smartlife")cloud!=null else services.any{s->s.id==it.platform&&s.connected}||it.sensor!=null}
    fun info()=smartLife.info()
    fun servicesInfo()=obj("smartlife" to smartLife.info().put("connected",cloud!=null),"homeassistant" to homeAssistant.info(),"hue" to hue.info(),"homekit" to obj("connected" to false,"supported" to false,"reason" to "Apple HomeKit has no Android device-control API. Link devices through Home Assistant or Hue."))
    fun setLinks(plan:JSONObject?){
        val out=mutableMapOf<String,Link>();listOf("light" to "lights","ac" to "acs").forEach{(kind,key)->(plan?.optJSONArray(key)?:JSONArray()).objects().forEach{device->
            val id=device.optString("id");val direct=device.optJSONObject("link");val tuya=device.optJSONObject("tuya");val sensor=device.optJSONObject("sensor")?.takeIf{it.optString("id").isNotEmpty()}
            if(id.isNotEmpty()){
                if(direct!=null&&direct.optString("id").isNotEmpty())out[id]=Link(kind,direct.optString("service"),direct.getString("id"),direct,sensor)
                else if(tuya!=null&&tuya.optString("deviceId").isNotEmpty())out[id]=Link(kind,"smartlife",tuya.getString("deviceId"),tuya,sensor)
                else if(kind=="ac"&&sensor!=null)out[id]=Link(kind,"","",JSONObject(),sensor)
            }
        }};links=out;refreshLive()
    }
    fun command(message:JSONObject):JSONObject {
        val id=message.optString("id");val link=links[id]?:return obj("ok" to true)
        val patch=message.optJSONObject("patch")?:JSONObject();val state=message.optJSONObject("state")?:JSONObject()
        if(link.target.isEmpty())return obj("ok" to true)
        return synchronized(locks.getOrPut("${link.platform}:${link.target}"){Any()}){
            try{
                if(link.platform=="smartlife"){
                    val c=cloud?:throw DeviceFailure("Connect Smart Life first");c.prepare(link.target);val codes=c.knownCodes[link.target]?:emptySet();val ranges=c.knownRanges[link.target]?:emptyMap()
                    if(link.kind=="light")c.send(link.target,TuyaMapper.lightCommands(patch,state,link.data,codes,ranges))
                    else if(TuyaMapper.infrared(codes))infrared.apply(link.target,patch,state){c.send(link.target,JSONArray().put(it))}
                    else c.send(link.target,TuyaMapper.acCommands(patch,link.data,codes))
                }else{
                    val service=services.firstOrNull{it.id==link.platform}?:throw DeviceFailure("${link.platform} is unavailable on Android. Connect this device through Home Assistant or Hue.")
                    if(!service.connected)throw DeviceFailure("Connect ${service.id} first")
                    service.send(link.kind,link.target,patch,state)
                }
                obj("ok" to true)
            }catch(e:Exception){onStale?.invoke();obj("ok" to false,"error" to (e.message?:"Device command failed")).apply{if(e is DeviceFailure&&e.fields.isNotEmpty())put("failed",JSONArray(e.fields))}}
        }
    }
    fun poll():JSONObject {
        val snapshot=links;val lights=JSONObject();val acs=JSONObject();val features=JSONObject();val errors=JSONObject();val c=cloud
        if(c!=null){val cloudLinks=snapshot.filterValues{it.platform=="smartlife"};if(cloudLinks.isNotEmpty())try{
            val ids=cloudLinks.values.flatMap{listOf(it.target,it.data.optString("sensorId"))}.filter{it.isNotEmpty()}.distinct();val status=c.status(ids)
            cloudLinks.forEach{(id,link)->
                val ranges=c.knownRanges[link.target]?:emptyMap();if(link.kind=="light")status[link.target]?.let{lights.put(id,TuyaMapper.lightState(it,ranges))}
                else{
                    TuyaMapper.features(c.knownCodes[link.target]?:emptySet(),ranges)?.let{features.put(id,it)}
                    val state=status[link.target]?.let{TuyaMapper.acState(it)}?:JSONObject();status[link.data.optString("sensorId")]?.let{TuyaMapper.sensor(it)}?.let{state.put("roomTemp",it)};if(state.length()>0)acs.put(id,state)
                }
            }
        }catch(e:Exception){errors.put("smartlife",e.message)}}
        val readings=mutableMapOf<String,Map<String,JSONObject>>()
        services.filter{it.connected}.forEach{service->
            val ids=snapshot.values.flatMap{link->listOf(if(link.platform==service.id)link.target else "",if(link.sensor?.optString("service")==service.id)link.sensor.optString("id") else "")}.filter{it.isNotEmpty()}.toSet()
            if(ids.isNotEmpty())try{readings[service.id]=service.read(ids)}catch(e:Exception){errors.put(service.id,e.message)}
        }
        snapshot.forEach{(id,link)->
            val reading=readings[link.platform]?.get(link.target)
            if(reading!=null&&reading.optBoolean("online",true)){
                reading.optJSONObject("light")?.let{lights.put(id,it)}
                reading.optJSONObject("ac")?.let{acs.put(id,(acs.optJSONObject(id)?:JSONObject()).merge(it))}
                reading.optJSONObject("features")?.let{features.put(id,it)}
            }
            if(link.kind=="ac")link.sensor?.let{sensor->val platform=sensor.optString("service");val sensorId=sensor.optString("id");val temperature=if(platform=="smartlife")try{c?.status(listOf(sensorId))?.get(sensorId)?.let{TuyaMapper.sensor(it)}}catch(_:Exception){null}else readings[platform]?.get(sensorId)?.number("temperature");temperature?.let{acs.put(id,(acs.optJSONObject(id)?:JSONObject()).put("roomTemp",it))}}
        }
        return obj("lights" to lights,"acs" to acs,"features" to features,"errors" to errors)
    }
    fun listDevices():JSONArray=(cloud?:throw DeviceFailure("Connect Smart Life first")).listDevices()
    fun allDevices():JSONObject {
        val devices=JSONArray();val errors=JSONObject()
        cloud?.let{c->try{c.listDevices().objects().forEach{d->
            val codes=(d.optJSONArray("codes")?:JSONArray()).strings().toSet();val category=d.optString("category");val kind=if(category in listOf("kt","ktkzq","infrared_ac")||TuyaMapper.infrared(codes)||"temp_set" in codes)"ac" else if(category in listOf("wsdcg","wk","wnykq")||("temp_current" in codes&&"switch_led" !in codes))"sensor" else "light"
            val caps=mutableListOf<String>();if(codes.any{it in listOf("bright_value","bright_value_v2")})caps.add("brightness");if(codes.any{it in listOf("temp_value","temp_value_v2")})caps.add("temp");if(codes.any{it in listOf("colour_data","colour_data_v2")})caps.add("color")
            devices.put(d.put("service","smartlife").put("kind",kind).put("capabilities",JSONArray(caps)).put("detail",listOf(d.optString("product"),category).filter{it.isNotEmpty()}.joinToString(" · ")))
        }}catch(e:Exception){errors.put("smartlife",e.message)}}
        services.filter{it.connected}.forEach{try{it.devices().objects().forEach{devices.put(it)}}catch(e:Exception){errors.put(it.id,e.message)}}
        return obj("devices" to devices,"errors" to errors)
    }
    fun shareableConnections()=JSONObject().apply{homeAssistant.shareable()?.let{put("homeassistant",it)};hue.shareable()?.let{put("hue",it)}}
    fun adoptConnections(shared:JSONObject){homeAssistant.adopt(shared.optJSONObject("homeassistant"));hue.adopt(shared.optJSONObject("hue"));refreshLive()}
    fun beginLogin(userCode:String)=smartLife.beginLogin(userCode)
    fun finishLogin(token:String,userCode:String)=smartLife.finishLogin(token,userCode)
    fun signOut()=smartLife.signOut()
    fun saveTuya(accessId:String,accessSecret:String,region:String)=tuya.save(accessId,accessSecret,region)
    fun diagnostics(ids:List<String>)=smartLife.diagnostics(ids)
}
