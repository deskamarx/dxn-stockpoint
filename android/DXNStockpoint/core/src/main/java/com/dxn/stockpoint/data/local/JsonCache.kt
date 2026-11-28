package com.dxn.stockpoint.data.local

import android.content.Context
import com.dxn.stockpoint.data.model.Order
import com.dxn.stockpoint.data.model.PlaceOrderRequest
import com.dxn.stockpoint.data.model.Product
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import java.io.File

/**
 * Offline-first cache API backed by [StockpointDb].
 *
 * Older releases kept these two JSON files on disk. On first launch after an
 * upgrade the files are imported transactionally and renamed to `.migrated`
 * (never deleted), so no sale disappears during the SQLite migration.
 */
data class CachedState(
    val rev: Int = 0,
    val savedAt: Long = 0L,
    val products: List<Product> = emptyList(),
    val orders: List<Order> = emptyList(),
)

data class OutboxEntry(
    val id: String = "",
    val payload: PlaceOrderRequest? = null,
    val createdAt: Long = 0L,
    val attempts: Int = 0,
    /** queued | sending | failed */
    val status: String = "queued",
    val error: String? = null,
) {
    val isFailed: Boolean get() = status == "failed"
}

object JsonCache {

    private const val DIR = "dxn-cache"
    private const val STATE_FILE = "state.json"
    private const val OUTBOX_FILE = "outbox.json"

    private val gson = Gson()
    private val lock = Any()
    private var database: StockpointDb? = null

    fun init(context: Context) = synchronized(lock) {
        if (database == null) {
            database = StockpointDb(context)
            migrateLegacyFiles(context.applicationContext)
        }
    }

    internal fun db(): StockpointDb =
        database ?: throw IllegalStateException("JsonCache.init(context) must be called first")

    private fun migrateLegacyFiles(context: Context) {
        val legacyDir = File(context.filesDir, DIR)
        if (!legacyDir.exists()) return
        val stateFile = File(legacyDir, STATE_FILE)
        val outboxFile = File(legacyDir, OUTBOX_FILE)
        runCatching {
            if (stateFile.exists() && db().readState() == CachedState()) {
                gson.fromJson(stateFile.readText(), CachedState::class.java)
                    ?.let { db().writeState(it) }
            }
            if (outboxFile.exists() && db().readOutbox().isEmpty()) {
                val type = object : TypeToken<List<OutboxEntry>>() {}.type
                gson.fromJson<List<OutboxEntry>>(outboxFile.readText(), type)
                    ?.let { db().replaceOutbox(it) }
            }
            // Keep the originals as forensic copies instead of deleting them.
            if (stateFile.exists()) stateFile.renameTo(File(legacyDir, "$STATE_FILE.migrated"))
            if (outboxFile.exists()) outboxFile.renameTo(File(legacyDir, "$OUTBOX_FILE.migrated"))
        }
    }

    // ── Cached dataset ──────────────────────────────────────────────────────

    fun loadState(): CachedState = synchronized(lock) {
        runCatching { db().readState() }.getOrDefault(CachedState())
    }

    fun saveState(state: CachedState) = synchronized(lock) {
        runCatching {
            db().writeState(state.copy(savedAt = System.currentTimeMillis()))
        }
        Unit
    }

    // ── Order outbox ────────────────────────────────────────────────────────

    fun loadOutbox(): List<OutboxEntry> = synchronized(lock) {
        runCatching { db().readOutbox() }.getOrDefault(emptyList())
    }

    fun saveOutbox(entries: List<OutboxEntry>): List<OutboxEntry> = synchronized(lock) {
        runCatching { db().replaceOutbox(entries) }
        entries
    }

    fun appendOutbox(entry: OutboxEntry): List<OutboxEntry> = synchronized(lock) {
        runCatching { db().insertOutbox(entry) }
        loadOutbox()
    }

    fun removeOutbox(id: String): List<OutboxEntry> = synchronized(lock) {
        runCatching { db().deleteOutbox(id) }
        loadOutbox()
    }

    fun updateOutbox(id: String, transform: (OutboxEntry) -> OutboxEntry): List<OutboxEntry> =
        synchronized(lock) {
            val next = loadOutbox().map { if (it.id == id) transform(it) else it }
            runCatching { db().replaceOutbox(next) }
            next
        }

    /** Clears live state and outbox only; snapshots and conflicts are preserved. */
    fun clear() = synchronized(lock) {
        runCatching {
            db().writeState(CachedState())
            db().replaceOutbox(emptyList())
        }
        Unit
    }

    // ── Durability helpers ──────────────────────────────────────────────────

    fun takeSnapshot(label: String = "manual") = synchronized(lock) {
        runCatching { db().takeSnapshot(label) }.getOrNull()
    }

    fun snapshots() = synchronized(lock) { runCatching { db().listSnapshots() }.getOrDefault(emptyList()) }

    fun rollback(name: String) = synchronized(lock) { runCatching { db().rollback(name) }.getOrNull() }
}

/** Conflict journal shared by the sync worker and Settings. */
object ConflictLog {
    fun record(kind: String, entityId: String, local: String, remote: String) {
        runCatching { JsonCache.db().recordConflict(kind, entityId, local, remote) }
    }

    fun list(): List<ConflictEntry> =
        runCatching { JsonCache.db().listConflicts() }.getOrNull().orEmpty()

    fun pending(): List<ConflictEntry> = list().filter { it.isPending }

    fun resolve(id: Long, resolution: String) {
        runCatching { JsonCache.db().resolveConflict(id, resolution) }
    }
}
