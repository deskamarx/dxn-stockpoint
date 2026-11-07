package com.dxn.stockpoint.client

import android.app.Application
import com.dxn.stockpoint.core.AppRole
import com.dxn.stockpoint.core.StockpointCore

class ClientApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        StockpointCore.init(this, AppRole.CUSTOMER, BuildConfig.API_BASE_URL)
    }
}
