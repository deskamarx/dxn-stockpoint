package com.dxn.stockpoint.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dxn.stockpoint.core.SyncState
import com.dxn.stockpoint.ui.theme.AccentGold
import com.dxn.stockpoint.ui.theme.DarkText
import com.dxn.stockpoint.ui.theme.EmeraldGreen

/**
 * One-line truth about the connection: is this device talking to the server,
 * how many sales are still queued, and which revision it holds.
 */
@Composable
fun SyncStrip(
    state: SyncState,
    accountUnlocked: Boolean,
    onSync: () -> Unit,
    onAccount: () -> Unit,
    accountDescription: String = if (accountUnlocked) "Sign out" else "Sign in"
) {
    val dotColor = when {
        state.syncing -> AccentGold
        !state.online -> Color(0xFFD32F2F)
        state.pending > 0 -> AccentGold
        else -> EmeraldGreen
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.White)
            .clickable { onSync() }
            .padding(start = 14.dp, end = 6.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            Modifier
                .size(7.dp)
                .background(dotColor, CircleShape)
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = state.label,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = DarkText,
            modifier = Modifier.weight(1f)
        )
        if (state.serverRev > 0) {
            Text("rev ${state.serverRev}", fontSize = 10.sp, color = Color.Gray)
            Spacer(modifier = Modifier.width(6.dp))
        }
        IconButton(onClick = onSync, modifier = Modifier.size(28.dp)) {
            Icon(
                imageVector = if (state.syncing) Icons.Default.Sync else Icons.Default.Refresh,
                contentDescription = "Sync now",
                tint = EmeraldGreen,
                modifier = Modifier.size(16.dp)
            )
        }
        IconButton(onClick = onAccount, modifier = Modifier.size(28.dp)) {
            Icon(
                imageVector = if (accountUnlocked) Icons.Default.LockOpen else Icons.Default.Lock,
                contentDescription = accountDescription,
                tint = if (accountUnlocked) EmeraldGreen else Color.Gray,
                modifier = Modifier.size(15.dp)
            )
        }
    }
}
