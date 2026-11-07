package com.dxn.stockpoint.suite

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.CookieManager
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
import java.net.URL

class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var prefs: SharedPreferences
    private var showingOffline = false

    private val suiteUrl: String
        get() = prefs.getString(KEY_URL, null)?.takeIf { it.isNotBlank() } ?: BuildConfig.SUITE_URL

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(dp(16), 0, dp(4), 0)
            setBackgroundColor(HEADER)
        }
        header.addView(
            TextView(this).apply {
                text = "DXN Suite"
                setTextColor(INK)
                textSize = 16f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                letterSpacing = 0.02f
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        header.addView(actionLabel("Reload") { web.reload() })
        header.addView(actionLabel("Address") { editAddress() })

        web = WebView(this).apply {
            setBackgroundColor(BG)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                loadWithOverviewMode = true
                useWideViewPort = true
                builtInZoomControls = true
                displayZoomControls = false
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = false
                allowContentAccess = false
                allowFileAccessFromFileURLs = false
                allowUniversalAccessFromFileURLs = false
                setSupportMultipleWindows(false)
                cacheMode = WebSettings.LOAD_DEFAULT
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                userAgentString = "$userAgentString DXNSuite/${BuildConfig.VERSION_NAME}"
            }
            val webView = this
            CookieManager.getInstance().apply {
                setAcceptCookie(true)
                setAcceptThirdPartyCookies(webView, false)
            }
            webViewClient = SuiteClient()
            webChromeClient = WebChromeClient()
            setDownloadListener { url, _, _, _, _ -> openExternal(Uri.parse(url)) }
        }

        root.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)))
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        applyEdgeToEdge(root)

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState)
        } else {
            web.loadUrl(suiteUrl)
        }
    }

    private fun actionLabel(label: String, onClick: () -> Unit): TextView =
        TextView(this).apply {
            text = label
            setTextColor(ACCENT)
            textSize = 13.5f
            isClickable = true
            isFocusable = true
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setOnClickListener { onClick() }
        }

    private fun applyEdgeToEdge(root: LinearLayout) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        window.setDecorFitsSystemWindows(false)
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
            )
            val ime = insets.getInsets(WindowInsets.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
    }

    private fun editAddress() {
        val input = EditText(this).apply {
            setText(suiteUrl)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine()
            setSelection(text.length)
        }
        val wrapper = FrameLayout(this).apply {
            setPadding(dp(20), dp(4), dp(20), 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle("Suite address")
            .setMessage("Use the suite served by your shop server, for example https://shop.example.com/suite.html")
            .setView(wrapper)
            .setPositiveButton("Open") { _, _ ->
                val value = input.text.toString().trim()
                val valid = runCatching {
                    val parsed = URL(value)
                    parsed.protocol == "http" || parsed.protocol == "https"
                }.getOrDefault(false)
                if (!valid) {
                    toast("Enter a full http:// or https:// address")
                    return@setPositiveButton
                }
                prefs.edit().putString(KEY_URL, value).apply()
                web.loadUrl(value)
            }
            .setNeutralButton("Use default") { _, _ ->
                prefs.edit().remove(KEY_URL).apply()
                web.loadUrl(BuildConfig.SUITE_URL)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private inner class SuiteClient : WebViewClient() {

        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest
        ): Boolean {
            val uri = request.url
            val inApp = (uri.scheme == "http" || uri.scheme == "https") &&
                uri.host.equals(currentHost(), ignoreCase = true)
            if (inApp) return false
            openExternal(uri)
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            showingOffline = false
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError
        ) {
            if (request.isForMainFrame) showOffline()
        }

        override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            errorResponse: WebResourceResponse
        ) {
            if (request.isForMainFrame && errorResponse.statusCode >= 400) showOffline()
        }
    }

    private fun currentHost(): String? = runCatching { Uri.parse(suiteUrl).host }.getOrNull()

    private fun showOffline() {
        if (showingOffline) return
        showingOffline = true
        web.loadDataWithBaseURL(suiteUrl, offlinePage(), "text/html", "utf-8", null)
    }

    private fun offlinePage(): String {
        val retry = escapeHtml(suiteUrl)
        return """
            <!doctype html>
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
              html,body{height:100%;margin:0;background:#07120c;color:#f2f5f0;
                font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
              main{height:100%;display:grid;place-content:center;text-align:center;padding:24px}
              h1{font-size:22px;margin:0 0 8px}
              p{color:#9fb2a5;margin:0 0 22px;line-height:1.5;max-width:320px}
              a{display:inline-block;padding:12px 22px;border-radius:999px;
                background:#e7c56b;color:#16240f;text-decoration:none;font-weight:700}
            </style></head>
            <body><main>
              <h1>Suite is unreachable</h1>
              <p>Check the shop server address or your connection, then try again.</p>
              <a href="$retry">Try again</a>
            </main></body></html>
        """.trimIndent()
    }

    private fun escapeHtml(value: String): String = value
        .replace("&", "&amp;")
        .replace("\"", "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")

    private fun openExternal(uri: Uri) {
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https" && scheme != "mailto" && scheme != "tel") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (error: ActivityNotFoundException) {
            toast("No app can open that link")
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            resources.displayMetrics
        ).toInt()

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        web.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
        super.onDestroy()
    }

    private companion object {
        const val PREFS = "dxn-suite"
        const val KEY_URL = "suite_url"
        val BG: Int = Color.rgb(7, 18, 12)
        val HEADER: Int = Color.rgb(6, 37, 22)
        val INK: Int = Color.rgb(242, 245, 240)
        val ACCENT: Int = Color.rgb(231, 197, 107)
    }
}
