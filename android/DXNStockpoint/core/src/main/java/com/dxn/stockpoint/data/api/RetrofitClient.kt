package com.dxn.stockpoint.data.api

import android.content.Context
import com.google.gson.GsonBuilder
import com.google.gson.TypeAdapter
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import com.google.gson.stream.JsonWriter
import com.dxn.stockpoint.core.BuildConfig
import com.dxn.stockpoint.core.CoreConfig
import com.dxn.stockpoint.data.local.Prefs
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

/**
 * One Retrofit instance per server URL. The bearer token is injected per
 * request by an interceptor, so signing in or out never needs a rebuild.
 */
object RetrofitClient {

    @Volatile private var baseUrl: String = CoreConfig.defaultBaseUrl

    @Volatile var token: String? = null
        private set

    fun init(context: Context) {
        Prefs.init(context)
        baseUrl = normalize(Prefs.baseUrl)
        token = Prefs.token
        retrofit = buildRetrofit()
    }

    private val loggingInterceptor = HttpLoggingInterceptor().apply {
        // Never leak request/response bodies (or tokens) in release builds.
        level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BASIC
        else HttpLoggingInterceptor.Level.NONE
    }

    private val authInterceptor = okhttp3.Interceptor { chain ->
        val builder = chain.request().newBuilder()
            .header("Accept", "application/json")
        token?.let { builder.header("Authorization", "Bearer $it") }
        chain.proceed(builder.build())
    }

    private val okHttpClient: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(authInterceptor)
        .addInterceptor(loggingInterceptor)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .writeTimeout(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /**
     * The PHP API and the Node API both ship boolean-like fields, but one uses
     * 1/0 and the other uses true/false. Gson's default Boolean adapter only
     * accepts the latter, which made the whole catalog fail to parse against a
     * live Node server. Accept either representation (and "1"/"true") so the
     * same APK works with both backends and with older cached rows.
     */
    private val lenientBoolean = object : TypeAdapter<Boolean>() {
        override fun write(out: JsonWriter, value: Boolean?) {
            if (value == null) out.nullValue() else out.value(value)
        }

        override fun read(input: JsonReader): Boolean? = when (input.peek()) {
            JsonToken.BOOLEAN -> input.nextBoolean()
            JsonToken.NUMBER -> input.nextDouble() != 0.0
            JsonToken.STRING -> {
                val text = input.nextString()
                text.equals("true", ignoreCase = true) || text == "1"
            }
            JsonToken.NULL -> {
                input.nextNull()
                null
            }
            else -> {
                input.skipValue()
                false
            }
        }
    }

    internal val gson = GsonBuilder()
        .registerTypeAdapter(Boolean::class.java, lenientBoolean)
        .registerTypeAdapter(java.lang.Boolean::class.java, lenientBoolean)
        .create()

    @Volatile private var retrofit: Retrofit = buildRetrofit()

    private fun buildRetrofit(): Retrofit = Retrofit.Builder()
        .baseUrl(baseUrl)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create(gson))
        .build()

    val apiService: ApiService get() = retrofit.create(ApiService::class.java)

    /**
     * Accepts anything a shopkeeper might paste: the bare domain, a URL that
     * still carries `/api/v1`, or the installer URL. Only the origin survives.
     */
    fun normalize(raw: String): String {
        var value = raw.trim()
        if (value.isEmpty()) return CoreConfig.defaultBaseUrl
        if (!value.contains("://")) value = "https://$value"
        value = value.replace(Regex("^http://", RegexOption.IGNORE_CASE), "http://")
            .replace(Regex("^https://", RegexOption.IGNORE_CASE), "https://")

        // Drop everything from the API path onwards, then normalise the tail.
        val cut = listOf("/api/v1", "/api", "/index.php")
            .map { value.lowercase().indexOf(it) }
            .filter { it > 8 }
            .minOrNull()
        if (cut != null) value = value.substring(0, cut)

        value = value.trimEnd('/')
        return if (value.endsWith("/")) value else "$value/"
    }

    /** Call this when the user saves a new server URL in Settings. */
    fun setBaseUrl(url: String) {
        val normalized = normalize(url)
        baseUrl = normalized
        Prefs.baseUrl = normalized
        retrofit = buildRetrofit()
    }

    fun getBaseUrl(): String = baseUrl

    fun setToken(value: String?) {
        token = value
        Prefs.token = value
    }

    fun clearToken() {
        token = null
        Prefs.clearSession()
    }

    fun hasToken(): Boolean = !token.isNullOrBlank()
}
