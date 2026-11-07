package com.dxn.stockpoint.core

import android.content.Context
import com.dxn.stockpoint.data.api.RetrofitClient
import com.dxn.stockpoint.data.local.JsonCache
import com.dxn.stockpoint.data.local.Prefs

enum class AppRole { OWNER, CUSTOMER }

/**
 * Runtime identity of the installed app. The shared data layer uses it to
 * decide whether a bearer token belongs to the shop or to a customer account.
 */
object CoreConfig {
    @Volatile var role: AppRole = AppRole.OWNER
    @Volatile var defaultBaseUrl: String = "https://dxn.10001mb.com/"
}

/**
 * Single entry point both app modules call from Application.onCreate(). The
 * data singletons are process-wide, so they must be initialised before the
 * first ViewModel or background sync touches them.
 */
object StockpointCore {
    fun init(context: Context, role: AppRole, defaultBaseUrl: String) {
        CoreConfig.role = role
        CoreConfig.defaultBaseUrl = defaultBaseUrl
        Prefs.init(context)
        JsonCache.init(context)
        RetrofitClient.init(context)
    }
}

data class UiState<T>(
    val data: T? = null,
    val isLoading: Boolean = false,
    val error: String? = null
)

data class SyncState(
    val online: Boolean = true,
    val syncing: Boolean = false,
    val lastSyncAt: Long = 0L,
    val pending: Int = 0,
    val serverRev: Int = 0,
    val error: String? = null
) {
    val label: String
        get() = when {
            syncing -> "Syncing…"
            !online && pending > 0 -> "Offline · $pending queued"
            !online -> "Offline"
            pending > 0 -> "$pending queued"
            lastSyncAt > 0L -> "Live"
            else -> "Not synced yet"
        }
}
