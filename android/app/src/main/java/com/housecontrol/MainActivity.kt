package com.housecontrol

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.*
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import com.google.zxing.BarcodeFormat
import com.google.zxing.integration.android.IntentIntegrator
import com.journeyapps.barcodescanner.BarcodeEncoder
import com.housecontrol.devices.DeviceHub
import com.housecontrol.sync.SyncClient
import com.housecontrol.sync.SyncPairing
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.Executors

/** The same bundled Three.js UI as iOS, with an Android-owned native bridge. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var plans: PlanStore
    private lateinit var hub: DeviceHub
    private lateinit var sync: SyncClient
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var active = false
    private var ready = false
    private var pollInFlight = false
    private var generation = 0
    private var settings: AlertDialog? = null
    private var loginDialog: AlertDialog? = null
    private var pairingDialog: AlertDialog? = null
    private var loginToken: String? = null
    private var loginUser = ""
    private var loginExpires = 0L
    private var suggestedUserCode = ""
    private var loginPolling = false
    private var destroyed = false
    private val bg = Color.rgb(15, 19, 27)
    private val card = Color.rgb(27, 33, 44)
    private val accent = Color.rgb(110, 191, 255)
    private val origin = "https://appassets.androidplatform.net"
    private val indexPath = "/assets/dist/index.html"
    @Volatile private var boot = "{}"
    @Volatile private var editorBoot = "{}"
    private var pendingChooser: ValueCallback<Array<Uri>>? = null
    private lateinit var container: FrameLayout
    /** The floor plan editor: a second page of the same web bundle, over the home, as on the iPhone. */
    private var editor: WebView? = null
    private var editorGeneration = 0
    private var editorOpening = false
    /** The editor's Import or Export call, waiting for the system file picker. */
    private var pendingFile: Pair<JSONObject, Int>? = null
    private var pendingExport: String? = null
    private var planChoiceDialog: AlertDialog? = null
    private val prefs get() = getPreferences(MODE_PRIVATE)
    /** The plan revision this phone and the computer last agreed on: tells which side changed it. */
    private var syncedRevision: String?
        get() = prefs.getString("syncedPlanRevision", null)
        set(value) { prefs.edit().putString("syncedPlanRevision", value).apply() }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = bg
        window.navigationBarColor = bg
        plans = PlanStore(this)
        val secrets = SecureStore(this)
        hub = DeviceHub(this)
        hub.onStale = {
            main.removeCallbacks(poller)
            if (active) main.post(poller)
        }
        sync = SyncClient(this, { secrets.read("sync") }, { secrets.write("sync", it) })
        sync.planRevision = { plans.revision }
        // A phone paired before plans travelled both ways holds the computer's plan as it was sent.
        // Once only: a later relaunch must not mistake a home made here since for the agreed one.
        if (!prefs.getBoolean("syncMigrated", false)) {
            if (sync.isPaired && syncedRevision == null) syncedRevision = plans.revision
            prefs.edit().putBoolean("syncMigrated", true).apply()
        }
        sync.onState = { state ->
            suggestedUserCode = state.userCode
            prefs.edit().putLong("lastSync", System.currentTimeMillis()).apply()
            // The computer's connections where newer; then whatever this phone changed since goes back.
            background({
                val changed = state.connections?.let(hub::adoptConnections) ?: false
                Triple(changed, hub.shareableConnections(), hub.info().optString("userCode"))
            }, report = false) { (changed, shared, userCode) ->
                sync.sendConnections(shared, userCode)
                if (changed) reloadHome() else refreshSettingsIfOpen()
            }
            reconcilePlan(state)
        }
        sync.onStatus = { refreshSettingsIfOpen() }
        web = makeWeb({ boot }, Bridge(forEditor = false))
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        container = FrameLayout(this).apply {
            setBackgroundColor(bg)
            fitsSystemWindows = true
            addView(web, ViewGroup.LayoutParams(-1, -1))
            setOnApplyWindowInsetsListener { view, insets ->
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                insets.consumeSystemWindowInsets()
            }
        }
        setContentView(container)
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        }
        reloadHome()
        if (intent?.data != null) acceptPairing(intent.data.toString())
        else if (!prefs.getBoolean("welcomed", false)) welcome()
    }

    /** One page of the bundled web UI (the home or the editor), with the bridge and a locked-down origin. */
    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWeb(bootPayload: () -> String, bridge: Bridge): WebView = WebView(this).apply {
        setBackgroundColor(bg)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.setSupportMultipleWindows(false)
        addJavascriptInterface(bridge, "HouseAndroid")
        webChromeClient = object : WebChromeClient() {
            // The editor's "Trace a picture" asks for an image through an <input type="file">.
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                pendingChooser?.onReceiveValue(null)
                pendingChooser = callback
                return try {
                    startActivityForResult(params.createIntent(), PICK_PICTURE)
                    true
                } catch (_: Exception) { pendingChooser = null; false }
            }
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) android.util.Log.d("HouseControlWeb", message.message())
                return true
            }
        }
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this@MainActivity)).build()
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                if (uri.scheme != "https" || uri.host != "appassets.androidplatform.net") return blocked()
                if (uri.path == indexPath) {
                    val injection = "<script>window.__HOUSE_BOOT__=${bootPayload()};</script>"
                    val html = assets.open("dist/index.html").bufferedReader().use { it.readText() }
                        .replace("<head>", "<head>$injection<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'\">")
                    return WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(html.toByteArray()))
                }
                return loader.shouldInterceptRequest(uri) ?: blocked()
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // The bridge is never exposed to a remote document, even on the local origin.
                if (request.url.toString().substringBefore('?') == "$origin$indexPath") return false
                if (request.isForMainFrame && request.hasGesture()) openExternal(request.url)
                return true
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) toast("Could not load home: ${error.description}")
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                toast("The home renderer stopped. Reopening House Control.")
                recreate()
                return true
            }
        }
    }

    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(byteArrayOf()))

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        intent.data?.let { acceptPairing(it.toString()) }
    }

    override fun onResume() {
        super.onResume(); active = true; web.onResume(); editor?.onResume(); sync.start()
        hub.start()
        main.removeCallbacks(poller); main.post(poller)
        checkLogin()
    }

    override fun onPause() {
        active = false; sync.stop(); hub.stop(); main.removeCallbacks(poller); web.onPause(); editor?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        destroyed = true; main.removeCallbacksAndMessages(null); sync.stop(); hub.stop()
        settings?.dismiss(); loginDialog?.dismiss(); pairingDialog?.dismiss(); planChoiceDialog?.dismiss()
        closeEditor()
        web.removeJavascriptInterface("HouseAndroid"); web.destroy(); worker.shutdownNow()
        super.onDestroy()
    }

    @Deprecated("Activity back dispatch is used for the native/WebView boundary")
    @SuppressLint("GestureBackNavigation") // API 33+ uses the registered OnBackInvokedCallback above.
    override fun onBackPressed() { handleBack() }

    private fun handleBack() {
        val open = editor
        if (open != null) {
            // The editor closes its sheets first, then asks about unsaved changes.
            open.evaluateJavascript("Boolean(window.house?.back?.())") { handled ->
                if (handled != "true" && editor === open) closeEditor()
            }
            return
        }
        web.evaluateJavascript("Boolean(window.house?.back?.())") { handled ->
            if (handled != "true") finish()
        }
    }

    private val poller = object : Runnable {
        override fun run() {
            if (!active || destroyed) return
            if (ready && !pollInFlight) {
                pollInFlight = true
                val page = generation
                background({ hub.poll() }, report = false, onError = { pollInFlight = false }) {
                    pollInFlight = false
                    if (generation == page) call("applyRemote", it)
                }
            }
            main.postDelayed(this, 12000)
        }
    }

    private fun reloadHome() {
        ready = false; generation++
        val page = generation
        background({
            hub.setLinks(if (plans.active == "custom") plans.custom else null)
            plans.boot().put("smartLife", hub.info()).toString().replace("<", "\\u003c")
        }) { payload ->
            if (page == generation) { boot = payload; web.loadUrl("$origin$indexPath?mode=panel") }
        }
        // A connection made or dropped (in Settings or over the editor): the editor's lists follow.
        editor?.let { view -> background({ hub.servicesInfo() }, report = false) { info -> if (editor === view) invoke(view, "servicesChanged", info) } }
    }

    /** `forEditor`: the bridge of the editor's page, which answers the editor's calls. */
    inner class Bridge(private val forEditor: Boolean) {
        @JavascriptInterface fun postMessage(text: String) {
            // A whole floor plan (up to 8 MiB) travels in Save and Export.
            if (text.length > 9 * 1024 * 1024) return
            val message = runCatching { JSONObject(text) }.getOrNull() ?: return
            main.post {
                if (destroyed) return@post
                if (forEditor) { handleEditor(message); return@post }
                when (message.optString("type")) {
                    "ready" -> {
                        ready = !message.has("error")
                        if (ready) { call("shown"); main.removeCallbacks(poller); main.post(poller) }
                    }
                    "command" -> {
                        val page = generation
                        background({ hub.command(message) }, onError = { error ->
                            if (page == generation) call("reply", message.optInt("callId"), JSONObject().put("error", error.message ?: "Device command failed"))
                        }) { result -> if (page == generation) call("reply", message.optInt("callId"), result) }
                    }
                    "haptic" -> haptic(web, message.optString("kind"))
                    "openSettings" -> showSettings()
                    "openEditor" -> openEditor()
                    "selectPlan" -> { plans.select(message.optString("plan")); reloadHome() }
                }
            }
        }
    }

    private fun haptic(view: View, kind: String) = view.performHapticFeedback(when (kind) {
        "tick" -> HapticFeedbackConstants.CLOCK_TICK
        "medium", "heavy", "error" -> HapticFeedbackConstants.LONG_PRESS
        "success" -> if (android.os.Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.KEYBOARD_TAP
        else -> HapticFeedbackConstants.KEYBOARD_TAP
    })

    private fun call(function: String, vararg args: Any?) = invoke(web, function, *args)

    private fun invoke(view: WebView?, function: String, vararg args: Any?) {
        val serialized = args.joinToString(",") { value -> when (value) {
            null -> "null"
            is String -> JSONObject.quote(value)
            else -> value.toString()
        } }
        view?.evaluateJavascript("window.house?.$function?.($serialized)", null)
    }

    // MARK: Editor

    /** Opens the floor plan editor on the plan this phone shows (a demo becomes the user's own on Save). */
    private fun openEditor() {
        settings?.dismiss()
        if (editor != null || editorOpening) return
        editorOpening = true
        background({ editorPayload() }, onError = { editorOpening = false; showError(it) }) { payload ->
            editorOpening = false
            if (editor != null) return@background
            editorBoot = payload
            editorGeneration++
            val view = makeWeb({ editorBoot }, Bridge(forEditor = true))
            editor = view
            container.addView(view, ViewGroup.LayoutParams(-1, -1))
            view.loadUrl("$origin$indexPath?mode=editor")
        }
    }

    private fun closeEditor() {
        val view = editor ?: return
        editor = null
        editorGeneration++
        pendingFile = null; pendingExport = null
        container.removeView(view)
        view.removeJavascriptInterface("HouseAndroid"); view.destroy()
    }

    private fun editorPayload(): String {
        val boot = plans.boot().put("mode", "editor")
        if (!boot.has("config")) boot.put("config", JSONObject(assets.open("dist/plans/${plans.active}.json").bufferedReader().use { it.readText() }))
        boot.put("smartLife", hub.info()).put("tuya", hub.tuya.info()).put("services", hub.servicesInfo())
        return boot.toString().replace("<", "\\u003c")
    }

    /** What the editor asks of the phone: the same calls the iPhone and the computers answer. */
    private fun handleEditor(message: JSONObject) {
        val view = editor ?: return
        val page = editorGeneration
        fun reply(result: JSONObject) {
            if (page == editorGeneration && message.has("callId")) invoke(view, "reply", message.optInt("callId"), result)
        }
        fun fail(error: Exception) = reply(JSONObject().put("error", error.message ?: "Something went wrong"))
        fun work(job: () -> JSONObject) = background(job, onError = ::fail) { reply(it) }
        when (message.optString("type")) {
            "ready" -> {}
            "close" -> closeEditor()
            "haptic" -> haptic(view, message.optString("kind"))
            "openConnection" -> when (message.optString("service")) {
                "smartlife" -> if (hub.info().optBoolean("connected")) showSettings() else smartLife()
                "homeassistant" -> homeAssistant()
                "hue" -> hue()
                else -> appleHome()
            }
            "savePlan" -> {
                val config = message.optJSONObject("config") ?: return reply(JSONObject().put("error", "No floor plan to save."))
                val text = config.toString()
                background({ plans.save(text) }, onError = ::fail) {
                    reloadHome()
                    sync.sendPlan(text) // when the computer is away, the next sync sends it
                    haptic(view, "success")
                    reply(JSONObject().put("ok", true))
                }
            }
            "importPlan" -> {
                pendingFile = message to page
                startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = "application/json"
                }, EDITOR_IMPORT)
            }
            "exportPlan" -> {
                val config = message.optJSONObject("config") ?: return reply(JSONObject().put("error", "No floor plan to export."))
                pendingFile = message to page
                pendingExport = config.toString(2)
                val name = config.optString("name", "Home").replace(Regex("[\\\\/:*?\"<>|]"), "").ifBlank { "Home" }
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = "application/json"; putExtra(Intent.EXTRA_TITLE, "$name.json")
                }, EDITOR_EXPORT)
            }
            "services.info" -> work { hub.servicesInfo() }
            "devices.all" -> work { hub.allDevices() }
            "services.discover" -> reply(JSONObject().put("found", org.json.JSONArray())) // no LAN discovery on Android yet
            "homeassistant.connect" -> background({
                hub.connectHomeAssistant(message.optString("url").trim(), message.optString("token").trim()); hub.servicesInfo()
            }, onError = ::fail) { reply(it); reloadHome() }
            "hue.pair" -> background({
                hub.pairHue(message.optString("host"), message.optString("bridgeId").ifBlank { null }, message.optString("name").ifBlank { null })
                hub.servicesInfo()
            }, onError = { error ->
                // The bridge's button not pressed yet: the editor asks again in a moment.
                if (error is com.housecontrol.devices.DeviceFailure && error.code == "101") reply(JSONObject().put("waiting", true)) else fail(error)
            }) { reply(it); reloadHome() }
            "service.disconnect" -> background({
                when (message.optString("service")) {
                    "homeassistant", "hue" -> hub.disconnect(message.optString("service"))
                    "smartlife" -> hub.signOut()
                    "tuya" -> hub.saveTuya("", "", "eu")
                    else -> throw IllegalArgumentException("This platform is unavailable on Android.")
                }
                hub.servicesInfo()
            }, onError = ::fail) { reply(it); reloadHome() }
            "smartlife.begin" -> work {
                val ticket = hub.beginLogin(message.optString("userCode"))
                val png = java.io.ByteArrayOutputStream().also {
                    BarcodeEncoder().encodeBitmap(ticket.getString("qrContent"), BarcodeFormat.QR_CODE, 600, 600).compress(Bitmap.CompressFormat.PNG, 100, it)
                }.toByteArray()
                JSONObject().put("token", ticket.getString("token"))
                    .put("qr", "data:image/png;base64," + android.util.Base64.encodeToString(png, android.util.Base64.NO_WRAP))
            }
            "smartlife.poll" -> background({ hub.finishLogin(message.optString("token"), message.optString("userCode")) }, onError = ::fail) { connected ->
                reply(JSONObject().put("connected", connected).put("info", hub.info()))
                if (connected) reloadHome()
            }
            "smartlife.signOut" -> background({ hub.signOut(); hub.info() }, onError = ::fail) { reply(it); reloadHome() }
            "tuya.devices" -> work { JSONObject().put("devices", hub.listDevices()) }
            "tuya.save" -> background({
                hub.saveTuya(message.optString("accessId"), message.optString("accessSecret"), message.optString("region", "eu")); hub.tuya.info()
            }, onError = ::fail) { reply(it); reloadHome() }
            else -> reply(JSONObject().put("error", "This is not available on Android yet."))
        }
    }

    /** The editor's Import or Export came back from the system file picker. */
    private fun editorFileResult(requestCode: Int, resultCode: Int, uri: Uri?) {
        val (message, page) = pendingFile ?: return
        val export = pendingExport
        pendingFile = null; pendingExport = null
        val view = editor
        fun reply(result: JSONObject) { if (view != null && page == editorGeneration) invoke(view, "reply", message.optInt("callId"), result) }
        if (resultCode != RESULT_OK || uri == null) return reply(JSONObject().put("cancelled", true))
        if (requestCode == EDITOR_IMPORT) {
            background({ JSONObject(String(readPlanFile(uri), Charsets.UTF_8)) },
                onError = { reply(JSONObject().put("error", "This file is not a floor plan.")) }) { reply(JSONObject().put("config", it)) }
        } else {
            background({
                contentResolver.openOutputStream(uri, "wt")?.use { it.write((export ?: "").toByteArray(Charsets.UTF_8)) } ?: error("Could not write the file")
            }, onError = { reply(JSONObject().put("error", it.message ?: "Could not write the file")) }) { reply(JSONObject().put("ok", true)) }
        }
    }

    private fun readPlanFile(uri: Uri): ByteArray = contentResolver.openInputStream(uri)?.use { stream ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            require(output.size() + count <= 8 * 1024 * 1024) { "Floor plan is too large" }
            output.write(buffer, 0, count)
        }
        output.toByteArray()
    } ?: error("Could not open floor plan")

    // MARK: Plan sync

    /** Decides which way the floor plan goes: to whichever side did not change it since the two
     *  last agreed. When both did, the user chooses. Same rules as the iPhone. */
    private fun reconcilePlan(state: com.housecontrol.sync.SyncState) {
        val local = plans.revision
        val remote = state.revision
        if (local != null && local == remote) { syncedRevision = local; planChoiceDialog?.dismiss(); return }
        val mine = plans.customText
        if (local == null || mine == null) { if (remote.isNotEmpty()) adopt(state); return }
        when {
            remote.isEmpty() || remote == syncedRevision -> sync.sendPlan(mine) // only this phone changed it
            local == syncedRevision -> adopt(state)
            state.plan != null -> askWhichPlan(state, state.plan)
        }
    }

    /** Takes the computer's plan as this phone's home. */
    private fun adopt(state: com.housecontrol.sync.SyncState) {
        val text = state.plan ?: return
        val first = !plans.hasCustom
        try {
            // The first plan becomes the home; later ones only replace it (a demo picked here stays).
            plans.save(text, first || plans.active == "custom")
        } catch (error: Exception) { showError(error); return }
        syncedRevision = plans.revision
        reloadHome()
        editor?.let { invoke(it, "planArrived", plans.custom, state.macName) }
        toast(if (first) "${plans.custom?.optString("name", "Your home")} arrived from ${state.macName}" else "Updated from ${state.macName}")
    }

    private fun askWhichPlan(state: com.housecontrol.sync.SyncState, theirs: String) {
        if (planChoiceDialog?.isShowing == true) return
        val phoneName = plans.custom?.optString("name", "Home") ?: "Home"
        val computerName = runCatching { JSONObject(theirs).optString("name", "Home") }.getOrDefault("Home")
        val computer = state.macName
        planChoiceDialog = AlertDialog.Builder(this).setTitle("Which home do you keep?")
            .setMessage(if (phoneName == computerName)
                "“$phoneName” was changed both here and on $computer since they last synced. The one you keep replaces the other on both."
            else "This phone has “$phoneName”, $computer has “$computerName”. The one you keep replaces the other on both.")
            .setPositiveButton("Keep this phone’s") { _, _ ->
                val mine = plans.customText
                if (mine != null && sync.sendPlan(mine)) toast("Sent to $computer")
                else {
                    // Next time the computer shows this plan unchanged, ours goes over.
                    syncedRevision = PlanStore.revision(theirs.toByteArray(Charsets.UTF_8))
                    toast("$computer is not connected; it gets your plan next time")
                }
            }
            .setNegativeButton("Keep $computer’s") { _, _ -> adopt(state) }
            .setNeutralButton("Decide later", null)
            .show()
    }

    private fun <T> background(work: () -> T, report: Boolean = true, onError: ((Exception) -> Unit)? = null, done: (T) -> Unit = {}) {
        if (destroyed) return
        worker.execute {
            try {
                val value = work()
                main.post { if (!destroyed) done(value) }
            } catch (error: Exception) {
                main.post { if (!destroyed) { if (onError != null) onError(error) else if (report) showError(error) } }
            }
        }
    }

    private fun welcome() {
        val body = column()
        label(body, "Your home, in your pocket", 26)
        label(body, "Explore the live 3D demo, tap lamps to switch them, hold for colour and brightness, or open an air conditioner to set its temperature.")
        label(body, "Pair with House Control on your Windows PC or Mac to bring over your home and device links. Both devices use your Wi-Fi.")
        val dialog = dialog("Welcome to House Control", body)
        dialog.setOnDismissListener { welcomed() }
        button(body, "Set up my home") { welcomed(); dialog.dismiss(); newHome() }
        button(body, "Pair with computer") { welcomed(); dialog.dismiss(); pairing() }
        button(body, "Explore the demo") { welcomed(); dialog.dismiss() }
        dialog.show()
    }

    private fun welcomed() { getPreferences(MODE_PRIVATE).edit().putBoolean("welcomed", true).apply() }
    private fun refreshSettingsIfOpen() { if (settings?.isShowing == true) showSettings() }

    private fun showEarlierHomes() {
        val homes = plans.earlier.list().take(12)
        val format = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.MEDIUM, java.text.DateFormat.SHORT)
        val titles = homes.map { "${it.name} · ${it.rooms} rooms, ${it.devices} devices · ${format.format(java.util.Date(it.date))}" }.toTypedArray()
        AlertDialog.Builder(this).setTitle("Earlier homes").setItems(titles) { _, which ->
            val home = homes[which]
            AlertDialog.Builder(this).setTitle("Bring back ${home.name}?")
                .setMessage("It becomes the home on this phone. The home here now is kept under Earlier homes.")
                .setPositiveButton("Bring back") { _, _ ->
                    try { plans.restore(home.id); reloadHome(); plans.customText?.let(sync::sendPlan) } catch (error: Exception) { showError(error) }
                    showSettings()
                }.setNegativeButton("Cancel") { _, _ -> showSettings() }.show()
        }.setNegativeButton("Close") { _, _ -> showSettings() }.show()
    }

    private fun showSettings() {
        settings?.dismiss()
        val body = column()
        section(body, "Home")
        if (plans.hasCustom) button(body, "${if (plans.active == "custom") "✓  " else ""}${plans.custom?.optString("name", "My home")}") { plans.select("custom"); reloadHome(); showSettings() }
        for ((id, title) in listOf("home" to "Apartment · demo", "studio" to "Studio · demo", "house" to "House on two floors · demo")) {
            button(body, "${if (plans.active == id) "✓  " else ""}$title") { plans.select(id); reloadHome(); showSettings() }
        }
        button(body, "Edit floor plan") { openEditor() }
        button(body, "New home…") { newHome() }
        button(body, "Import floor plan…") {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE); type = "application/json"
            }, IMPORT_PLAN)
        }
        if (plans.hasCustom) button(body, "Remove your home") {
            AlertDialog.Builder(this).setTitle("Remove your floor plan?").setMessage("You can import it or sync it from your computer again.")
                .setPositiveButton("Remove") { _, _ -> plans.remove(); reloadHome(); showSettings() }.setNegativeButton("Cancel", null).show()
        }
        if (plans.earlier.list().isNotEmpty()) button(body, "Earlier homes…") { settings?.dismiss(); showEarlierHomes() }
        section(body, "Computer")
        label(body, sync.pairing?.name ?: "Bring your home over")
        label(body, when (sync.status) {
            SyncClient.Status.UNPAIRED -> "Not paired"
            SyncClient.Status.SEARCHING -> "Looking for your computer on this Wi-Fi…"
            SyncClient.Status.CONNECTING -> "Connecting…"
            SyncClient.Status.CONNECTED -> "Connected · up to date"
            SyncClient.Status.FAILED -> sync.error ?: "Could not sync"
        }, 13)
        val last = getPreferences(MODE_PRIVATE).getLong("lastSync", 0)
        if (last > 0) label(body, "Last synced ${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(last))}", 13)
        if (sync.pairing != null) {
            button(body, "Sync now") { sync.refresh() }
            button(body, "Unpair…") {
                AlertDialog.Builder(this).setTitle("Unpair from computer?").setMessage("Your current floor plan stays on this Android device.")
                    .setPositiveButton("Unpair") { _, _ ->
                        sync.unpair(); prefs.edit().remove("lastSync").remove("syncedPlanRevision").apply()
                        planChoiceDialog?.dismiss(); suggestedUserCode = ""; showSettings()
                    }
                    .setNegativeButton("Cancel", null).show()
            }
        } else button(body, "Pair with computer") { pairing() }
        section(body, "Smart Life / Tuya Smart")
        val info = hub.info()
        if (info.optBoolean("connected")) {
            label(body, info.optString("account").ifBlank { "Signed in" })
            button(body, "Sign out…") {
                AlertDialog.Builder(this).setTitle("Sign out of Smart Life?")
                    .setPositiveButton("Sign out") { _, _ -> background({ hub.signOut() }) { reloadHome(); showSettings() } }
                    .setNegativeButton("Cancel", null).show()
            }
        } else button(body, "Connect Smart Life") { smartLife() }
        section(body, "More connections")
        label(body, "Home Assistant and Hue connections arrive over your encrypted computer pairing. You can also connect them here.", 13)
        button(body, "Home Assistant") { homeAssistant() }
        button(body, "Philips Hue") { hue() }
        button(body, "Apple Home compatibility") { appleHome() }
        section(body, "About")
        label(body, "House Control ${BuildConfig.VERSION_NAME}\nNo account of its own. No analytics.\nCredentials stay encrypted on this device.", 13)
        button(body, "Reload home") { reloadHome(); settings?.dismiss() }
        settings = dialog("Settings", body).apply { show() }
    }

    private fun appleHome() {
        AlertDialog.Builder(this).setTitle("Apple Home")
            .setMessage("Android cannot use Apple's HomeKit framework. Devices also available through Home Assistant or Hue can be linked through those integrations in the floor plan editor. Existing homekit links require relinking; they cannot be controlled directly by this Android app.")
            .setPositiveButton("OK", null).show()
    }

    /** Starts a home of the user's own: one room, or a copy of a demo layout. The editor opens on it. */
    private fun newHome() {
        settings?.dismiss()
        val body = column()
        val name = field(body, "Name", "My home")
        label(body, "Start from", 13)
        val templates = listOf(null to "One room", "studio" to "Studio layout", "home" to "Apartment layout", "house" to "House on two floors")
        val group = RadioGroup(this)
        val choices = templates.map { (_, title) ->
            RadioButton(this).apply { id = View.generateViewId(); text = title; textSize = 16f; setTextColor(Color.WHITE) }.also(group::addView)
        }
        group.check(choices.first().id)
        body.addView(group)
        if (plans.hasCustom) label(body, "Your current home is kept under Earlier homes.", 13)
        val dialog = AlertDialog.Builder(this).setTitle("New home").setView(ScrollView(this).apply { addView(body) })
            .setNegativeButton("Cancel", null).setPositiveButton("Create and edit", null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val title = name.text.toString().trim().ifEmpty { "My home" }
                val template = templates.getOrNull(choices.indexOfFirst { it.id == group.checkedRadioButtonId })?.first
                background({
                    val plan = template?.let { JSONObject(assets.open("dist/plans/$it.json").bufferedReader().use { r -> r.readText() }) } ?: blankPlan()
                    val text = plan.put("name", title).toString()
                    plans.save(text)
                    text
                }) { text ->
                    dialog.dismiss(); reloadHome(); sync.sendPlan(text)
                    main.postDelayed({ openEditor() }, 300)
                }
            }
        }
        dialog.show()
    }

    /** The same one-room plan as the iPhone's `PlanEditor.blank`. */
    private fun blankPlan(): JSONObject = JSONObject("""{"version":1,"wallHeight":2.6,"interiorWallHeight":1.25,
        "camera":{"azimuth":34,"elevation":47},
        "rooms":[{"id":"living","name":"Living room","rect":[0,0,5,4],"floor":"oak"}],
        "openings":[],"furniture":[],"lights":[],"acs":[],
        "scenes":[{"id":"bright","name":"Bright","icon":"sun","lights":{"*":{"on":true,"brightness":1}}},
                  {"id":"off","name":"All off","icon":"moon","lights":{"*":{"on":false}},"acs":{"*":{"on":false}}}]}""")

    private fun pairing() {
        val body = column()
        label(body, "On Windows, use the floor-plan menu or right-click the tray icon → Pair Android / iPhone. On Mac, right-click the menu-bar icon → Pair Phone. Both devices need the same Wi-Fi.")
        val link = field(body, "housecontrol://pair?…")
        val dialog = dialog("Pair with computer", body)
        pairingDialog?.dismiss()
        pairingDialog = dialog
        button(body, "Scan pairing QR code") {
            IntentIntegrator(this).setDesiredBarcodeFormats(listOf(IntentIntegrator.QR_CODE))
                .setPrompt("Scan the pairing code on your computer").setBeepEnabled(false).setOrientationLocked(false).initiateScan()
        }
        button(body, "Pair using pasted link") {
            if (acceptPairing(link.text.toString())) dialog.dismiss()
        }
        dialog.show()
    }

    private fun acceptPairing(text: String): Boolean {
        val pairing = SyncPairing.parse(text)
        if (pairing == null) { toast("That is not a House Control pairing code"); return false }
        sync.pair(pairing); welcomed(); pairingDialog?.dismiss(); if (active) sync.start()
        toast("Paired with ${pairing.name}"); refreshSettingsIfOpen()
        return true
    }

    private fun smartLife() {
        val body = column()
        label(body, "In Smart Life or Tuya Smart: Me → Settings → Account and Security → User Code.")
        val user = field(body, "User Code", suggestedUserCode)
        val dialog = dialog("Connect Smart Life", body)
        lateinit var begin: Button
        begin = button(body, "Show sign-in code") {
            if (user.text.isBlank()) { user.error = "Enter your User Code"; return@button }
            user.isEnabled = false
            begin.isEnabled = false
            loginUser = user.text.toString().trim()
            background({ hub.beginLogin(loginUser) }, onError = { user.isEnabled = true; begin.isEnabled = true; showError(it) }) { ticket ->
                dialog.dismiss()
                showLogin(ticket.getString("token"), ticket.getString("qrContent"))
            }
        }
        begin.contentDescription = "Request Smart Life sign-in QR code"
        dialog.show()
    }

    private fun showLogin(token: String, content: String) {
        loginToken = token; loginExpires = System.currentTimeMillis() + 300000
        val body = column()
        label(body, "Scan this QR with the Smart Life app. Share the image to another screen, or display it on your paired computer.")
        val bitmap = BarcodeEncoder().encodeBitmap(content, BarcodeFormat.QR_CODE, 600, 600)
        body.addView(ImageView(this).apply {
            setImageBitmap(bitmap); contentDescription = "Smart Life sign-in QR code"; setBackgroundColor(Color.WHITE)
        }, LinearLayout.LayoutParams(dp(250), dp(250)).apply { gravity = android.view.Gravity.CENTER_HORIZONTAL; topMargin = dp(16) })
        label(body, "Waiting for confirmation in Smart Life…", 14)
        button(body, "Share code image") { shareQR(bitmap) }
        button(body, "Show on computer") { toast(if (sync.showQR(content)) "Code displayed on computer" else "Connect to your paired computer first") }
        loginDialog = dialog("Smart Life sign-in", body).apply {
            setOnDismissListener { loginToken = null; sync.showQR(null) }
            show()
        }
        sync.showQR(content)
        checkLogin()
    }

    private fun checkLogin() {
        val token = loginToken ?: return
        if (destroyed || loginPolling) return
        if (System.currentTimeMillis() >= loginExpires) {
            loginDialog?.dismiss(); toast("Sign-in code expired. Request a new one."); return
        }
        loginPolling = true
        background({ hub.finishLogin(token, loginUser) }, onError = {
            loginPolling = false
            if (loginToken == token) main.postDelayed({ checkLogin() }, 2000)
        }) { connected ->
            loginPolling = false
            if (loginToken != token) return@background
            if (connected) {
                loginDialog?.dismiss(); toast("Smart Life connected"); reloadHome(); refreshSettingsIfOpen()
            } else main.postDelayed({ checkLogin() }, 2000)
        }
    }

    private fun shareQR(bitmap: Bitmap) {
        val folder = File(cacheDir, "shared").apply { mkdirs() }
        val file = File(folder, "smart-life-sign-in.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = "image/png"; putExtra(Intent.EXTRA_STREAM, uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }, "Share sign-in code"))
    }

    private fun homeAssistant() {
        val body = column()
        val url = field(body, "http://homeassistant.local:8123")
        val token = field(body, "Long-lived access token").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        val dialog = dialog("Home Assistant", body)
        button(body, "Connect") { background({ hub.connectHomeAssistant(url.text.toString().trim(), token.text.toString().trim()) }) { dialog.dismiss(); toast("Home Assistant connected"); reloadHome() } }
        button(body, "Disconnect") { background({ hub.disconnect("homeassistant") }) { dialog.dismiss(); reloadHome(); toast("Home Assistant disconnected") } }
        dialog.show()
    }

    private fun hue() {
        val body = column()
        label(body, "Enter the Hue Bridge address, press the physical link button on the bridge, then tap Pair.")
        val host = field(body, "192.168.1.10")
        val dialog = dialog("Philips Hue", body)
        button(body, "Pair bridge") { background({ hub.pairHue(host.text.toString().trim()) }) { dialog.dismiss(); toast("Hue connected"); reloadHome() } }
        button(body, "Disconnect") { background({ hub.disconnect("hue") }) { dialog.dismiss(); reloadHome(); toast("Hue disconnected") } }
        dialog.show()
    }

    @Deprecated("The Activity result boundary is shared with the ZXing scanner")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == PICK_PICTURE) {
            pendingChooser?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            pendingChooser = null
            return
        }
        if (requestCode == EDITOR_IMPORT || requestCode == EDITOR_EXPORT) { editorFileResult(requestCode, resultCode, data?.data); return }
        val scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (scan != null) { scan.contents?.let { acceptPairing(it) }; return }
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == IMPORT_PLAN && resultCode == RESULT_OK) data?.data?.let { uri ->
            background({ plans.save(String(readPlanFile(uri), Charsets.UTF_8)) }) { reloadHome(); refreshSettingsIfOpen(); toast("Floor plan imported") }
        }
    }

    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(10), dp(20), dp(24)); setBackgroundColor(bg) }
    private fun dialog(title: String, body: LinearLayout): AlertDialog = AlertDialog.Builder(this)
        .setTitle(title).setView(ScrollView(this).apply { addView(body) }).setPositiveButton("Done", null).create()
    private fun label(body: LinearLayout, text: String, size: Int = 16) = TextView(this).apply {
        this.text = text; textSize = size.toFloat(); setTextColor(if (size < 16) Color.LTGRAY else Color.WHITE)
        setPadding(0, dp(10), 0, dp(10)); body.addView(this)
    }
    private fun section(body: LinearLayout, text: String) { label(body, text, 19).apply { setTextColor(accent); setTypeface(null, Typeface.BOLD) } }
    private fun button(body: LinearLayout, text: String, action: () -> Unit): Button = Button(this).apply {
        this.text = text; isAllCaps = false; textSize = 16f; setTextColor(accent)
        background = GradientDrawable().apply { setColor(card); cornerRadius = dp(14).toFloat() }
        body.addView(this, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8); bottomMargin = dp(2) })
        minHeight = dp(48); setOnClickListener { action() }
    }
    private fun field(body: LinearLayout, hint: String, initial: String = "") = EditText(this).apply {
        this.hint = hint; setText(initial); setTextColor(Color.WHITE); setHintTextColor(Color.GRAY)
        setSingleLine(true); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        body.addView(this, LinearLayout.LayoutParams(-1, dp(56)))
    }
    private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()
    private fun toast(message: String) { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
    private fun showError(error: Exception) { AlertDialog.Builder(this).setTitle("Could not complete action").setMessage(error.message ?: "Try again").setPositiveButton("OK", null).show() }
    private fun openExternal(uri: Uri) {
        if (uri.scheme !in listOf("https", "http")) return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }.onFailure { toast("No browser is available") }
    }
    companion object {
        private const val IMPORT_PLAN = 701; private const val PICK_PICTURE = 702
        private const val EDITOR_IMPORT = 703; private const val EDITOR_EXPORT = 704
    }
}
