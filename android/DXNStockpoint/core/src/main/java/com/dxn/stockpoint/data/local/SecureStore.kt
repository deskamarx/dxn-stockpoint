package com.dxn.stockpoint.data.local

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small secrets (the API bearer token and the offline unlock PIN) are encrypted
 * with a device-generated AES-256 key that never leaves the Android Keystore.
 * The ciphertext lives in SharedPreferences, so a backup or a rooted file
 * explorer sees random bytes instead of a live session token.
 */
object SecureStore {

    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "dxn_stockpoint_secure_v1"
    private const val FILE = "dxn_secure_prefs_v1"
    private const val LEGACY_TOKEN = "token"

    const val KEY_TOKEN = "api_token"
    const val KEY_LOCAL_PIN = "local_pin_hash"

    private var prefs: SharedPreferences? = null
    private var key: SecretKey? = null

    fun init(context: Context) {
        if (prefs == null) {
            prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        }
        if (key == null) key = loadOrCreateKey()
        migrateLegacyToken(context.applicationContext)
    }

    private fun loadOrCreateKey(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey?.let { return it }
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // Background sync must be able to read the token with the screen off.
            .setUserAuthenticationRequired(false)
            .setRandomizedEncryptionRequired(true)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    /** Older builds kept the bearer token in plain SharedPreferences. */
    private fun migrateLegacyToken(context: Context) {
        val legacy = context.getSharedPreferences("dxn_stockpoint_v2", Context.MODE_PRIVATE)
        val token = legacy.getString(LEGACY_TOKEN, null)
        if (!token.isNullOrBlank() && getString(KEY_TOKEN).isNullOrBlank()) {
            putString(KEY_TOKEN, token)
        }
        if (token != null) legacy.edit().remove(LEGACY_TOKEN).apply()
    }

    fun getString(name: String): String? {
        val stored = store().getString(name, null) ?: return null
        return runCatching {
            val raw = Base64.decode(stored, Base64.NO_WRAP)
            val iv = raw.copyOfRange(0, 12)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, requireKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
        }.getOrNull()
    }

    fun putString(name: String, value: String?) {
        if (value == null) {
            store().edit().remove(name).apply()
            return
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, requireKey())
        val payload = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val sealed = cipher.iv + payload
        store().edit()
            .putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP))
            .apply()
    }

    fun remove(name: String) = store().edit().remove(name).apply()

    fun clearSecrets() = store().edit()
        .remove(KEY_TOKEN)
        .remove(KEY_LOCAL_PIN)
        .apply()

    private fun store(): SharedPreferences =
        prefs ?: throw IllegalStateException("SecureStore.init(context) must be called first")

    private fun requireKey(): SecretKey = key
        ?: throw IllegalStateException("SecureStore.init(context) must be called first")
}
