package com.dxn.stockpoint.data.local

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.dxn.stockpoint.data.model.Order
import com.dxn.stockpoint.data.model.PlaceOrderRequest
import com.dxn.stockpoint.data.model.Product
import com.google.gson.Gson
import com.google.gson.JsonObject

/** Keep this in step with [MIGRATIONS] below and with the web build's IndexedDB version. */
const val STOCKPOINT_DB_VERSION = 4
const val SNAPSHOT_LIMIT = 4

data class DbSnapshot(
    val name: String,
    val version: Int,
    val label: String,
    val createdAt: Long,
)

data class ConflictEntry(
    val id: Long = 0L,
    val kind: String = "",
    val entityId: String = "",
    val local: String = "",
    val remote: String = "",
    val createdAt: Long = 0L,
    val resolution: String = "",
) {
    val isPending: Boolean get() = resolution.isBlank()
}

/**
 * The on-device store of record. Every schema change is ordered and additive;
 * a pre-migration snapshot is written automatically so Settings can roll back
 * without deleting a single order.
 */
class StockpointDb(context: Context) : SQLiteOpenHelper(
    context.applicationContext,
    "dxn_stockpoint.db",
    null,
    STOCKPOINT_DB_VERSION,
) {

    private val gson = Gson()

    override fun onCreate(db: SQLiteDatabase) = createSchema(db)

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // The snapshots table comes first so the pre-migration copy survives.
        createSchema(db)
        snapshotInternal(db, "db.v$oldVersion.snapshot.json", "automatic upgrade from v$oldVersion")
    }

    override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Never drop a table on downgrade. Copy the current data and let the app
        // keep using the additive schema.
        createSchema(db)
        snapshotInternal(db, "db.v$oldVersion.snapshot.json", "downgrade from v$oldVersion")
    }

    private fun createSchema(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                rev INTEGER NOT NULL DEFAULT 0,
                saved_at INTEGER NOT NULL DEFAULT 0,
                products TEXT NOT NULL DEFAULT '[]',
                orders TEXT NOT NULL DEFAULT '[]'
            )""",
        )
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS outbox (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'queued',
                error TEXT
            )""",
        )
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                version INTEGER NOT NULL,
                label TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                payload TEXT NOT NULL
            )""",
        )
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS conflicts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                local TEXT NOT NULL,
                remote TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                resolution TEXT NOT NULL DEFAULT ''
            )""",
        )
        db.execSQL(
            """CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )""",
        )
        db.execSQL("INSERT OR IGNORE INTO state (id) VALUES (1)")
    }

    // ── State ────────────────────────────────────────────────────────────────

    fun readState(): CachedState = synchronized(this) {
        val db = readableDatabase
        val cursor = db.rawQuery(
            "SELECT rev, saved_at, products, orders FROM state WHERE id = 1", null,
        )
        cursor.use {
            if (!it.moveToFirst()) return CachedState()
            return CachedState(
                rev = it.getInt(0),
                savedAt = it.getLong(1),
                products = gson.fromJson(it.getString(2), Array<Product>::class.java)?.toList() ?: emptyList(),
                orders = gson.fromJson(it.getString(3), Array<Order>::class.java)?.toList() ?: emptyList(),
            )
        }
    }

    fun writeState(state: CachedState) = synchronized(this) {
        writableDatabase.execSQL(
            """INSERT INTO state (id, rev, saved_at, products, orders) VALUES (1, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 rev = excluded.rev, saved_at = excluded.saved_at,
                 products = excluded.products, orders = excluded.orders""",
            arrayOf<Any?>(
                state.rev,
                state.savedAt,
                gson.toJson(state.products),
                gson.toJson(state.orders),
            ),
        )
    }

    // ── Outbox ───────────────────────────────────────────────────────────────

    fun readOutbox(): List<OutboxEntry> = synchronized(this) {
        readableDatabase.rawQuery(
            "SELECT id, payload, created_at, attempts, status, error FROM outbox ORDER BY created_at, id",
            null,
        ).use { cursor ->
            val rows = mutableListOf<OutboxEntry>()
            while (cursor.moveToNext()) {
                rows += OutboxEntry(
                    id = cursor.getString(0),
                    payload = gson.fromJson(cursor.getString(1), PlaceOrderRequest::class.java),
                    createdAt = cursor.getLong(2),
                    attempts = cursor.getInt(3),
                    status = cursor.getString(4),
                    error = cursor.getString(5),
                )
            }
            rows
        }
    }

    fun replaceOutbox(entries: List<OutboxEntry>) = synchronized(this) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.execSQL("DELETE FROM outbox")
            entries.forEach { insertOutbox(db, it) }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun insertOutbox(entry: OutboxEntry) = synchronized(this) {
        writableDatabase.beginTransaction()
        try {
            insertOutbox(writableDatabase, entry)
            writableDatabase.setTransactionSuccessful()
        } finally {
            writableDatabase.endTransaction()
        }
    }

    private fun insertOutbox(db: SQLiteDatabase, entry: OutboxEntry) {
        db.execSQL(
            """INSERT OR REPLACE INTO outbox (id, payload, created_at, attempts, status, error)
               VALUES (?, ?, ?, ?, ?, ?)""",
            arrayOf<Any?>(
                entry.id, gson.toJson(entry.payload), entry.createdAt,
                entry.attempts, entry.status, entry.error,
            ),
        )
    }

    fun deleteOutbox(id: String) = synchronized(this) {
        writableDatabase.delete("outbox", "id = ?", arrayOf(id))
    }

    // ── Snapshots & rollback ─────────────────────────────────────────────────

    fun takeSnapshot(label: String = "manual"): DbSnapshot? = synchronized(this) {
        snapshotInternal(writableDatabase, snapshotName(label), label)
    }

    private fun snapshotName(label: String): String {
        val stamp = System.currentTimeMillis()
        val safe = label.replace(Regex("[^A-Za-z0-9._-]"), "-").take(40).trim('-')
        return "snapshot-$stamp-${safe.ifBlank { "manual" }}.json"
    }

    private fun snapshotInternal(db: SQLiteDatabase, name: String, label: String): DbSnapshot? {
        if (!tableExists(db, "snapshots")) return null
        val stateRow = db.rawQuery("SELECT rev, saved_at, products, orders FROM state WHERE id = 1", null)
        val outboxRows = db.rawQuery(
            "SELECT id, payload, created_at, attempts, status, error FROM outbox", null,
        )
        val envelope = JsonObject()
        stateRow.use { row ->
            if (row.moveToFirst()) {
                val state = JsonObject().apply {
                    addProperty("rev", row.getInt(0))
                    addProperty("saved_at", row.getLong(1))
                    addProperty("products", row.getString(2))
                    addProperty("orders", row.getString(3))
                }
                envelope.add("state", state)
            }
        }
        outboxRows.use { row ->
            val rows = com.google.gson.JsonArray()
            while (row.moveToNext()) {
                rows.add(JsonObject().apply {
                    addProperty("id", row.getString(0))
                    addProperty("payload", row.getString(1))
                    addProperty("created_at", row.getLong(2))
                    addProperty("attempts", row.getInt(3))
                    addProperty("status", row.getString(4))
                    addProperty("error", row.getString(5))
                })
            }
            envelope.add("outbox", rows)
        }
        val now = System.currentTimeMillis()
        db.execSQL(
            """INSERT OR REPLACE INTO snapshots (name, version, label, created_at, payload)
               VALUES (?, ?, ?, ?, ?)""",
            arrayOf<Any?>(name, STOCKPOINT_DB_VERSION, label, now, envelope.toString()),
        )
        // Keep the four most recent snapshots; named migration snapshots are
        // preserved so a versioned rollback path always remains available.
        db.execSQL(
            """DELETE FROM snapshots WHERE id NOT IN (
                 SELECT id FROM snapshots ORDER BY created_at DESC LIMIT $SNAPSHOT_LIMIT
               ) AND name NOT LIKE 'db.v%.snapshot.json'""",
        )
        return DbSnapshot(name, STOCKPOINT_DB_VERSION, label, now)
    }

    fun listSnapshots(): List<DbSnapshot> = synchronized(this) {
        readableDatabase.rawQuery(
            "SELECT name, version, label, created_at FROM snapshots ORDER BY created_at DESC", null,
        ).use { cursor ->
            val rows = mutableListOf<DbSnapshot>()
            while (cursor.moveToNext()) {
                rows += DbSnapshot(
                    cursor.getString(0), cursor.getInt(1), cursor.getString(2), cursor.getLong(3),
                )
            }
            rows
        }
    }

    fun rollback(name: String): DbSnapshot? = synchronized(this) {
        val db = writableDatabase
        val cursor = db.rawQuery("SELECT payload FROM snapshots WHERE name = ?", arrayOf(name))
        val payload = cursor.use { if (it.moveToFirst()) it.getString(0) else null } ?: return null
        val envelope = runCatching { gson.fromJson(payload, JsonObject::class.java) }.getOrNull()
            ?: return null
        db.beginTransaction()
        try {
            envelope.getAsJsonObject("state")?.let { state ->
                db.execSQL(
                    """UPDATE state SET rev = ?, saved_at = ?, products = ?, orders = ? WHERE id = 1""",
                    arrayOf<Any?>(
                        state.get("rev")?.asInt ?: 0,
                        state.get("saved_at")?.asLong ?: 0L,
                        state.get("products")?.asString ?: "[]",
                        state.get("orders")?.asString ?: "[]",
                    ),
                )
            }
            db.execSQL("DELETE FROM outbox")
            envelope.getAsJsonArray("outbox")?.forEach { element ->
                val row = element.asJsonObject
                db.execSQL(
                    """INSERT INTO outbox (id, payload, created_at, attempts, status, error)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    arrayOf<Any?>(
                        row.get("id")?.asString ?: return@forEach,
                        row.get("payload")?.asString ?: "",
                        row.get("created_at")?.asLong ?: 0L,
                        row.get("attempts")?.asInt ?: 0,
                        row.get("status")?.asString ?: "queued",
                        row.get("error")?.asString ?: row.get("remote")?.asString,
                    ),
                )
            }
            db.execSQL(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('last_rollback', ?)",
                arrayOf<Any?>(name),
            )
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        listSnapshots().firstOrNull { it.name == name }
    }

    private fun tableExists(db: SQLiteDatabase, name: String): Boolean {
        val cursor = db.rawQuery(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", arrayOf(name),
        )
        return cursor.use { it.moveToFirst() }
    }

    // ── Conflict journal ─────────────────────────────────────────────────────

    fun recordConflict(kind: String, entityId: String, local: String, remote: String) =
        synchronized(this) {
            writableDatabase.execSQL(
                """INSERT INTO conflicts (kind, entity_id, local, remote, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                arrayOf<Any?>(kind, entityId, local, remote, System.currentTimeMillis()),
            )
        }

    fun listConflicts(): List<ConflictEntry> = synchronized(this) {
        readableDatabase.rawQuery(
            "SELECT id, kind, entity_id, local, remote, created_at, resolution FROM conflicts ORDER BY created_at DESC",
            null,
        ).use { cursor ->
            val rows = mutableListOf<ConflictEntry>()
            while (cursor.moveToNext()) {
                rows += ConflictEntry(
                    cursor.getLong(0), cursor.getString(1), cursor.getString(2),
                    cursor.getString(3), cursor.getString(4), cursor.getLong(5), cursor.getString(6),
                )
            }
            rows
        }
    }

    fun resolveConflict(id: Long, resolution: String) = synchronized(this) {
        writableDatabase.execSQL(
            "UPDATE conflicts SET resolution = ? WHERE id = ?",
            arrayOf<Any?>(resolution, id),
        )
    }
}
