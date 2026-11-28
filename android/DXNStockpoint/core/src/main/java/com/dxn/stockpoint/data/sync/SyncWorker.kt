package com.dxn.stockpoint.data.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.dxn.stockpoint.data.local.ConflictLog
import com.dxn.stockpoint.data.local.OutboxEntry
import com.dxn.stockpoint.data.repository.Result as RepoResult
import com.dxn.stockpoint.data.repository.StockpointRepository
import com.google.gson.Gson
import java.util.concurrent.TimeUnit

/**
 * Background synchronisation: replay the durable outbox first, then pull every
 * incremental page. Conflicts become journal entries instead of being silently
 * overwritten, so the owner can decide which version wins from Settings.
 */
class SyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    private val gson = Gson()

    override suspend fun doWork(): androidx.work.ListenableWorker.Result = try {
        val repo = StockpointRepository()
        repo.flushOutbox()
        journalConflicts(repo)

        var since = repo.currentRev()
        val maxPages = 40
        repeat(maxPages) {
            when (val pulled = repo.sync(since)) {
                is RepoResult.Success -> {
                    if (!pulled.data.truncated) return androidx.work.ListenableWorker.Result.success()
                    val next = pulled.data.nextSince ?: pulled.data.serverRev
                    if (next <= since) return androidx.work.ListenableWorker.Result.success()
                    since = next
                }
                is RepoResult.Error -> {
                    if (pulled.isNetwork) return androidx.work.ListenableWorker.Result.retry()
                    return androidx.work.ListenableWorker.Result.failure()
                }
            }
        }
        // More than 40 pages in one run: keep the cursor and continue next time.
        androidx.work.ListenableWorker.Result.success()
    } catch (error: Throwable) {
        if (error is java.io.IOException) androidx.work.ListenableWorker.Result.retry()
        else androidx.work.ListenableWorker.Result.failure()
    }

    private fun journalConflicts(repo: StockpointRepository) {
        val pending = ConflictLog.pending().map { "${it.kind}:${it.entityId}" }.toSet()
        for (entry in repo.outbox().filter { it.status == "failed" }) {
            val key = "order:${entry.id}"
            if (key in pending) continue
            ConflictLog.record(
                kind = "order",
                entityId = entry.id,
                local = gson.toJson(entry.payload ?: OutboxEntry(id = entry.id)),
                remote = entry.error ?: "The server rejected this order",
            )
        }
    }

    companion object {
        private const val UNIQUE_WORK = "dxn_stockpoint_sync"

        fun enqueue(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun enqueueNow(context: Context) {
            val request = androidx.work.OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context.applicationContext).enqueue(request)
        }
    }
}
