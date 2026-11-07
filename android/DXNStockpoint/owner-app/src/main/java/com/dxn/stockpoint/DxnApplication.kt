package com.dxn.stockpoint

import android.app.Application
import com.dxn.stockpoint.core.AppRole
import com.dxn.stockpoint.core.StockpointCore

/**
 * Initialises the shared data layer before the first ViewModel or background
 * sync reaches for it.
 */
class DxnApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        StockpointCore.init(this, AppRole.OWNER, BuildConfig.API_BASE_URL)
    }
}
