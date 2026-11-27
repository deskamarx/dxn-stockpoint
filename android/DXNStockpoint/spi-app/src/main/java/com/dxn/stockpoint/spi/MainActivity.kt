package com.dxn.stockpoint.spi

import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.text.InputType
import android.util.Base64
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.net.URL

/**
 * Production-grade host for a trimmed DXN Stockpoint suite.
 *
 * Contains **only** three workspaces: Stockpoint, Intelligence and PV Planner
 * (Flow and the marketing Overview are removed). The trimmed shell is bundled
 * in `assets/`; the embedded Stockpoint/Intelligence app is served from
 * [stockpointBase] (hosted app by default, or a self-hosted full-stack shop
 * server) so stock, orders and customer data sync against the real backend.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var prefs: SharedPreferences
    private var showingOffline = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val stockpointBase: String
        get() = prefs.getString(KEY_BASE, null)?.takeIf { it.isNotBlank() } ?: DEFAULT_BASE

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(BG) }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), 0, dp(4), 0); setBackgroundColor(HEADER)
        }
        header.addView(
            TextView(this).apply {
                text = getString(R.string.app_name); setTextColor(INK); textSize = 16f
                setTypeface(typeface, Typeface.BOLD); letterSpacing = 0.02f
                setPadding(0, dp(14), 0, dp(14)); contentDescription = getString(R.string.app_name)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        header.addView(actionLabel(getString(R.string.action_reload)) { loadTrimmed() })
        header.addView(actionLabel(getString(R.string.action_address)) { editAddress() })

        web = buildWebView()
        root.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)))
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        applyEdgeToEdge(root)
        registerBackHandler()

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else loadTrimmed()
    }

    private fun buildWebView(): WebView = WebView(this).apply {
        setBackgroundColor(BG)
        settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true
            loadWithOverviewMode = true; useWideViewPort = true
            builtInZoomControls = true; displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false; allowContentAccess = false
            allowFileAccessFromFileURLs = false; allowUniversalAccessFromFileURLs = false
            setSupportMultipleWindows(false); javaScriptCanOpenWindowsAutomatically = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setGeolocationEnabled(false); saveFormData = true
            userAgentString = "$userAgentString DXNStockpoint/${BuildConfig.VERSION_NAME}"
            setSavePassword(false)
        }
        val webView = this
        CookieManager.getInstance().apply { setAcceptCookie(true); setAcceptThirdPartyCookies(webView, false); flush() }
        webViewClient = SpiClient(); webChromeClient = SpiChromeClient()
        setDownloadListener { url, _, contentDisposition, mimeType, _ -> handleDownload(url, contentDisposition, mimeType) }
        addJavascriptInterface(DownloadBridge(), "DxnDownload")
    }

    private fun loadTrimmed() {
        val base = stockpointBase.trimEnd('/') + "/"
        val html = runCatching { assets.open(TRIMMED_ASSET).bufferedReader().use { it.readText() } }
            .getOrElse { showOffline(); return }
        showingOffline = false
        web.loadDataWithBaseURL(base, html, "text/html", "utf-8", base + TRIMMED_ASSET)
    }

    private fun actionLabel(label: String, onClick: () -> Unit): TextView = TextView(this).apply {
        text = label; setTextColor(ACCENT); textSize = 13.5f; isClickable = true; isFocusable = true
        minHeight = dp(48); gravity = Gravity.CENTER; setPadding(dp(12), dp(10), dp(12), dp(10))
        setOnClickListener { onClick() }; contentDescription = label
    }

    private fun applyEdgeToEdge(root: LinearLayout) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        window.setDecorFitsSystemWindows(false)
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom)); insets
        }
    }

    private fun registerBackHandler() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
    }

    private fun handleBack() { if (web.canGoBack()) web.goBack() else finish() }

    @Deprecated("Deprecated in Java") @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() { if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) handleBack() else super.onBackPressed() }

    // ---- Server configuration --------------------------------------------
    private fun editAddress() {
        val input = EditText(this).apply {
            setText(stockpointBase); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(); setSelection(text.length)
        }
        val wrapper = FrameLayout(this).apply { setPadding(dp(20), dp(4), dp(20), 0); addView(input) }
        AlertDialog.Builder(this)
            .setTitle(R.string.address_title).setMessage(R.string.address_message).setView(wrapper)
            .setPositiveButton(R.string.action_open) { _, _ ->
                val value = input.text.toString().trim()
                if (!isValidBase(value)) { toast(getString(R.string.address_invalid)); return@setPositiveButton }
                prefs.edit().putString(KEY_BASE, value).apply(); loadTrimmed()
            }
            .setNeutralButton(R.string.action_default) { _, _ -> prefs.edit().remove(KEY_BASE).apply(); loadTrimmed() }
            .setNegativeButton(R.string.action_cancel, null).show()
    }

    private fun isValidBase(value: String): Boolean = runCatching {
        val parsed = URL(value)
        when (parsed.protocol.lowercase()) {
            "https" -> true
            "http" -> parsed.host.lowercase() in CLEARTEXT_HOSTS
            else -> false
        }
    }.getOrDefault(false)

    // ---- WebViewClient ----------------------------------------------------
    private inner class SpiClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            val inApp = (uri.scheme == "http" || uri.scheme == "https") &&
                (uri.host.equals(currentHost(), true) || uri.host.equals(STOCKPOINT_HOST, true))
            if (inApp) return false
            openExternal(uri); return true
        }
        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) { showingOffline = false }
        override fun onPageFinished(view: WebView, url: String) { showingOffline = false }
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) { if (request.isForMainFrame) showOffline() }
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (request.isForMainFrame && errorResponse.statusCode >= 400) showOffline()
        }
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            Log.w(TAG, "SSL error ${error.primaryError} ${error.url}"); handler.cancel(); showOffline()
        }
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.w(TAG, "Render process gone didCrash=${detail.didCrash()}")
            (web.parent as? ViewGroup)?.removeView(web); web.destroy(); recreate(); return true
        }
    }

    private inner class SpiChromeClient : WebChromeClient() {
        override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null); fileCallback = filePathCallback
            val intent = runCatching { fileChooserParams.createIntent() }.getOrNull()?.apply { addCategory(Intent.CATEGORY_OPENABLE) }
            return try { if (intent == null) throw ActivityNotFoundException(); @Suppress("DEPRECATION") startActivityForResult(intent, REQ_FILE_CHOOSER); true }
            catch (e: ActivityNotFoundException) { fileCallback = null; false }
        }
    }

    @Deprecated("Deprecated in Java") @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE_CHOOSER) return
        val callback = fileCallback; fileCallback = null
        callback?.onReceiveValue(runCatching { WebChromeClient.FileChooserParams.parseResult(resultCode, data) }.getOrNull() ?: emptyArray())
    }

    // ---- Downloads --------------------------------------------------------
    inner class DownloadBridge {
        @JavascriptInterface fun save(name: String?, mime: String?, base64: String?) {
            val safeName = sanitizeName(name.orEmpty().ifBlank { defaultName(mime) })
            val safeMime = mime?.takeIf { it.isNotBlank() } ?: guessMime(safeName)
            val bytes = runCatching { Base64.decode(base64.orEmpty(), Base64.DEFAULT) }.getOrNull()
            runOnUiThread {
                if (bytes == null || bytes.isEmpty()) toast(getString(R.string.download_failed))
                else runCatching { saveBytes(safeName, safeMime, bytes) }
                    .onSuccess { toast(getString(R.string.download_saved)) }
                    .onFailure { toast(getString(R.string.download_failed)) }
            }
        }
        @JavascriptInterface fun error(name: String?) { runOnUiThread { toast(getString(R.string.download_failed)) } }
        @JavascriptInterface fun retryLoad() { runOnUiThread { loadTrimmed() } }
    }

    private fun handleDownload(url: String?, contentDisposition: String?, mimeType: String?) {
        if (url.isNullOrBlank()) return
        when {
            url.startsWith("blob:") -> startBlobDownload(url, mimeType, suggestedName(url, contentDisposition, mimeType))
            url.startsWith("data:") -> saveDataUrl(url, suggestedName(url, contentDisposition, mimeType))
            url.startsWith("http://") || url.startsWith("https://") -> downloadViaManager(url, contentDisposition, mimeType)
            else -> openExternal(Uri.parse(url))
        }
    }

    private fun startBlobDownload(blobUrl: String, mimeType: String?, fileName: String) {
        val js = """
            (function(){var u=${jsString(blobUrl)};var name=${jsString(fileName)};var mime=${jsString(mimeType ?: "")};
              var xhr=new XMLHttpRequest();xhr.open('GET',u,true);xhr.responseType='blob';
              xhr.onload=function(){var blob=xhr.response;var r=new FileReader();r.onloadend=function(){
                var s=String(r.result);var c=s.indexOf(',');var b64=c>=0?s.substring(c+1):'';
                try{window.DxnDownload.save(name,blob.type||mime,b64);}catch(e){try{window.DxnDownload.error(name);}catch(_){}}};
                r.onerror=function(){try{window.DxnDownload.error(name);}catch(_){}};r.readAsDataURL(blob);};
              xhr.onerror=function(){try{window.DxnDownload.error(name);}catch(_){}};xhr.send();})();
        """.trimIndent()
        web.evaluateJavascript(js, null)
    }

    private fun saveDataUrl(dataUrl: String, fileName: String) {
        try {
            val comma = dataUrl.indexOf(','); if (comma < 0) return
            val meta = dataUrl.substring(5, comma); val payload = dataUrl.substring(comma + 1)
            val mime = meta.substringBefore(';').ifBlank { "application/octet-stream" }
            val bytes = if (meta.endsWith(";base64", true)) Base64.decode(payload, Base64.DEFAULT) else Uri.decode(payload).toByteArray(Charsets.UTF_8)
            saveBytes(sanitizeName(fileName.ifBlank { defaultName(mime) }), mime, bytes); toast(getString(R.string.download_saved))
        } catch (t: Throwable) { toast(getString(R.string.download_failed)) }
    }

    private fun downloadViaManager(url: String, contentDisposition: String?, mimeType: String?) {
        try {
            val name = suggestedName(url, contentDisposition, mimeType)
            val req = DownloadManager.Request(Uri.parse(url)).apply {
                setMimeType(mimeType ?: "application/octet-stream")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED); setTitle(name)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                addRequestHeader("User-Agent", web.settings.userAgentString)
            }
            (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req); toast(getString(R.string.download_started))
        } catch (t: Throwable) { openExternal(Uri.parse(url)) }
    }

    private fun saveBytes(fileName: String, mimeType: String, bytes: ByteArray) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, fileName); put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DXN Stockpoint")
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("insert failed")
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IllegalStateException("stream failed")
        } else {
            val out = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir, fileName); out.outputStream().use { it.write(bytes) }
        }
    }

    private fun suggestedName(url: String, contentDisposition: String?, mimeType: String?): String {
        val guessed = runCatching { URLUtil.guessFileName(url, contentDisposition, mimeType) }.getOrNull()?.takeIf { it.isNotBlank() && it != "downloadfile" }
        return sanitizeName(guessed ?: defaultName(mimeType))
    }
    private fun defaultName(mimeType: String?): String {
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mimeType?.substringBefore(';') ?: "")?.takeIf { it.isNotBlank() } ?: "txt"
        return "dxn-${System.currentTimeMillis()}.$ext"
    }
    private fun sanitizeName(name: String): String = name.substringAfterLast('/').substringAfterLast('\\')
        .replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001F]"), "_").trim().ifBlank { "dxn-download" }.take(120)
    private fun guessMime(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
    private fun jsString(value: String): String {
        val sb = StringBuilder(value.length + 2).append('"')
        for (ch in value) when (ch) {
            '\\' -> sb.append("\\\\"); '"' -> sb.append("\\\""); '\n' -> sb.append("\\n"); '\r' -> sb.append("\\r"); '\t' -> sb.append("\\t")
            '<' -> sb.append("\\u003C"); '>' -> sb.append("\\u003E"); '&' -> sb.append("\\u0026"); else -> sb.append(ch)
        }
        return sb.append('"').toString()
    }

    // ---- Navigation / offline --------------------------------------------
    private fun currentHost(): String? = runCatching { Uri.parse(stockpointBase).host }.getOrNull()

    private fun showOffline() {
        if (showingOffline) return; showingOffline = true
        web.loadDataWithBaseURL(stockpointBase, offlinePage(), "text/html", "utf-8", null)
    }

    private fun offlinePage(): String = """
        <!doctype html><html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>DXN Stockpoint</title>
        <style>:root{color-scheme:dark}html,body{height:100%;margin:0;background:#07120c;color:#f2f5f0;font-family:system-ui,sans-serif}
        main{min-height:100%;display:grid;place-content:center;text-align:center;padding:24px;box-sizing:border-box}
        h1{font-size:22px;margin:0 0 8px}p{color:#9fb2a5;margin:0 0 22px;line-height:1.5;max-width:320px}
        a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:12px 22px;border-radius:999px;background:#e7c56b;color:#16240f;text-decoration:none;font-weight:700}</style></head>
        <body><main><h1>Can't reach Stockpoint</h1><p>Check your connection or shop server, then try again.</p>
        <a href="#" role="button" onclick="try{window.DxnDownload.retryLoad();}catch(e){}return false;">Try again</a></main>
        </body></html>
    """.trimIndent()

    private fun openExternal(uri: Uri) {
        if (uri.scheme?.lowercase() !in EXTERNAL_SCHEMES) return
        try { startActivity(Intent(Intent.ACTION_VIEW, uri).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }) }
        catch (e: ActivityNotFoundException) { toast(getString(R.string.no_app_to_open)) }
    }
    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    private fun dp(value: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    // ---- Lifecycle --------------------------------------------------------
    override fun onSaveInstanceState(outState: Bundle) { web.saveState(outState); super.onSaveInstanceState(outState) }
    override fun onResume() { super.onResume(); web.onResume() }
    override fun onPause() { web.onPause(); CookieManager.getInstance().flush(); super.onPause() }
    override fun onDestroy() {
        fileCallback?.onReceiveValue(null); fileCallback = null
        (web.parent as? ViewGroup)?.removeView(web); web.stopLoading(); web.destroy(); super.onDestroy()
    }

    private companion object {
        const val TAG = "DxnSpi"
        const val PREFS = "dxn-spi"
        const val KEY_BASE = "stockpoint_base"
        const val REQ_FILE_CHOOSER = 0xF11E
        const val TRIMMED_ASSET = "suite-spi.html"
        const val DEFAULT_BASE = "https://deskamarx.github.io/dxn-stockpoint/"
        const val STOCKPOINT_HOST = "deskamarx.github.io"
        val BG = Color.rgb(7, 18, 12); val HEADER = Color.rgb(6, 37, 22); val INK = Color.rgb(242, 245, 240); val ACCENT = Color.rgb(231, 197, 107)
        val CLEARTEXT_HOSTS = setOf("localhost", "127.0.0.1", "::1", "10.0.2.2")
        val EXTERNAL_SCHEMES = setOf("http", "https", "mailto", "tel", "sms", "geo")
    }
}


