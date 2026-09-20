package com.example.scannerob

import android.Manifest
import android.annotation.SuppressLint
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var isPipMode = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Solicitar permiso de notificaciones en Android 13+ (TIRAMISU)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }

        // Iniciar Servicio en Primer Plano para mantener CPU y conexiones activas 24/7
        startForegroundTradingService()

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = true
                allowContentAccess = true
                loadsImagesAutomatically = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                cacheMode = WebSettings.LOAD_DEFAULT
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(false)
            }

            // Aceleración por hardware para gráficos fluidos
            setLayerType(View.LAYER_TYPE_HARDWARE, null)

            webChromeClient = object : WebChromeClient() {}

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString() ?: return false
                    if (url.startsWith("file:///android_asset/")) {
                        return false
                    }
                    return false
                }
            }

            // Inyectar puente JavaScript nativo
            addJavascriptInterface(WebAppInterface(), "AndroidBridge")
        }

        setContentView(webView)

        // Cargar aplicación nativa desde assets locales
        webView.loadUrl("file:///android_asset/index.html")

        // Manejo del botón atrás de Android
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    private fun startForegroundTradingService() {
        try {
            val serviceIntent = Intent(this, TradingForegroundService::class.java).apply {
                action = TradingForegroundService.ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun stopForegroundTradingService() {
        try {
            val serviceIntent = Intent(this, TradingForegroundService::class.java).apply {
                action = TradingForegroundService.ACTION_STOP
            }
            startService(serviceIntent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    /**
     * Activa la ventana flotante (Picture-in-Picture)
     */
    fun enterPiP() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val aspectRatio = Rational(9, 16)
                val params = PictureInPictureParams.Builder()
                    .setAspectRatio(aspectRatio)
                    .build()
                enterPictureInPictureMode(params)
            } catch (e: Exception) {
                Toast.makeText(this, "Modo flotante no disponible en este dispositivo", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /**
     * Al pulsar Home o cambiar de app, entra automáticamente en ventana flotante
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            enterPiP()
        }
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        isPipMode = isInPictureInPictureMode
        if (isInPictureInPictureMode) {
            webView.evaluateJavascript("document.body.classList.add('pip-mode');", null)
        } else {
            webView.evaluateJavascript("document.body.classList.remove('pip-mode');", null)
        }
    }

    /**
     * Interfaz para comunicación entre JavaScript y Android Nativo
     */
    inner class WebAppInterface {
        @JavascriptInterface
        fun enterFloatingMode() {
            runOnUiThread {
                enterPiP()
            }
        }

        @JavascriptInterface
        fun startBackgroundService() {
            runOnUiThread {
                startForegroundTradingService()
            }
        }

        @JavascriptInterface
        fun stopBackgroundService() {
            runOnUiThread {
                stopForegroundTradingService()
            }
        }

        @JavascriptInterface
        fun isNativeApp(): Boolean {
            return true
        }

        @JavascriptInterface
        fun showToast(message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }
        }
    }
}
