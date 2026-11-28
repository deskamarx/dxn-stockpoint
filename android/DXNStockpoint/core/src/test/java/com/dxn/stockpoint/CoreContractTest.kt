package com.dxn.stockpoint

import com.dxn.stockpoint.data.api.RetrofitClient
import com.dxn.stockpoint.data.model.SyncResponse
import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** JVM-only contract checks: no emulator required. */
class CoreContractTest {

    @Test
    fun baseUrlNormalisationAcceptsPastedUrls() {
        assertEquals("https://shop.example.com/", RetrofitClient.normalize("shop.example.com"))
        assertEquals(
            "https://shop.example.com/",
            RetrofitClient.normalize("https://shop.example.com/api/v1/products"),
        )
        assertEquals(
            "http://192.168.1.7:8099/",
            RetrofitClient.normalize("http://192.168.1.7:8099/index.php"),
        )
    }

    @Test
    fun paginatedSyncCarriesTheResumeCursor() {
        val page = Gson().fromJson(
            """{"success":true,"server_rev":940,"since":12,"next_since":511,"truncated":true}""",
            SyncResponse::class.java,
        )
        assertTrue(page.success)
        assertTrue(page.truncated)
        assertEquals(511, page.nextSince)
        assertEquals(940, page.serverRev)

        val last = Gson().fromJson(
            """{"success":true,"server_rev":940,"since":511,"truncated":false}""",
            SyncResponse::class.java,
        )
        assertFalse(last.truncated)
        assertEquals(null, last.nextSince)
    }
}
