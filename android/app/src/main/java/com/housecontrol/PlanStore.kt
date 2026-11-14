package com.housecontrol

import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

class PlanStore(context: Context) {
    companion object { val BUNDLED = listOf("home", "studio", "house") }

    private val prefs = context.getSharedPreferences("home", Context.MODE_PRIVATE)
    private val file = AtomicFile(File(context.filesDir, "plan.json"))
    val earlier = EarlierHomes(File(context.filesDir, "Earlier homes"))
    var active: String = prefs.getString("plan", "home") ?: "home"
        private set
    val custom: JSONObject? get() = if (file.baseFile.exists()) JSONObject(String(file.readFully(), Charsets.UTF_8)) else null
    val hasCustom: Boolean get() = file.baseFile.exists()
    val revision: String? get() = if (hasCustom) MessageDigest.getInstance("SHA-256").digest(file.readFully()).take(8)
        .joinToString("") { "%02x".format(it.toInt() and 255) } else null

    init { if (active == "custom" && !hasCustom) select("home") }

    fun select(plan: String) {
        require(plan in BUNDLED || (plan == "custom" && hasCustom))
        active = plan
        check(prefs.edit().putString("plan", plan).commit())
    }

    fun save(text: String, select: Boolean = true) {
        require(text.toByteArray(Charsets.UTF_8).size <= 8 * 1024 * 1024) { "Floor plan is too large" }
        val plan = JSONObject(text)
        require(plan.optJSONArray("rooms")?.length()?.let { it > 0 } == true) { "Floor plan needs a nonempty rooms list" }
        earlier.keep(if (file.baseFile.exists()) file.readFully() else null, text.toByteArray(Charsets.UTF_8))
        val stream = file.startWrite()
        try { stream.write(text.toByteArray(Charsets.UTF_8)); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
        if (select) select("custom")
    }

    /** Makes a kept copy the home again; the home it replaces is kept in turn. */
    fun restore(id: String) {
        val home = earlier.find(id) ?: throw IllegalStateException("That earlier home is no longer kept.")
        save(home.file.readText(Charsets.UTF_8))
    }

    fun remove() { earlier.keep(if (file.baseFile.exists()) file.readFully() else null, ByteArray(0)); file.delete(); if (active == "custom") select("home") }
    fun boot(): JSONObject = JSONObject().put("platform", "android").put("mode", "panel")
        .put("plan", active).put("hasCustomPlan", hasCustom).also { if (active == "custom") it.put("config", custom) }
}
