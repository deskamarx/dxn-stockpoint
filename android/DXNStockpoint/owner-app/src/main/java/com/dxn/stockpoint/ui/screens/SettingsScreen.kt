@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.dxn.stockpoint.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dxn.stockpoint.BuildConfig
import com.dxn.stockpoint.core.R
import com.dxn.stockpoint.data.repository.StockpointRepository
import com.dxn.stockpoint.ui.theme.*
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    currentServerUrl: String,
    currentWaPhone: String,
    onBack: () -> Unit,
    onSaveServerUrl: (String) -> Unit,
    onSaveWaPhone: (String) -> Unit
) {
    var serverUrl by remember(currentServerUrl) { mutableStateOf(currentServerUrl) }
    var waPhone by remember(currentWaPhone) { mutableStateOf(currentWaPhone) }
    var urlSaved by remember { mutableStateOf(false) }
    var phoneSaved by remember { mutableStateOf(false) }

    val repo = remember { StockpointRepository() }
    val scope = rememberCoroutineScope()
    var snapshots by remember { mutableStateOf(repo.snapshots()) }
    var conflicts by remember { mutableStateOf(repo.conflicts()) }
    var selectedSnapshot by remember { mutableStateOf<String?>(null) }
    var snapshotMenuOpen by remember { mutableStateOf(false) }
    var storageMessage by remember { mutableStateOf("") }

    fun refreshStorage() {
        snapshots = repo.snapshots()
        conflicts = repo.conflicts()
        if (selectedSnapshot == null) selectedSnapshot = snapshots.firstOrNull()?.name
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings ⚙️", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back", tint = Color.White)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = ForestGreen,
                    titleContentColor = Color.White
                )
            )
        },
        containerColor = Color(0xFFF0F4F1)
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {

            // Server URL
            item {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = Color.White),
                    elevation = CardDefaults.cardElevation(2.dp)
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("🌐 Server Configuration", fontWeight = FontWeight.Bold, fontSize = 16.sp, color = DarkText)
                        Text(
                            "Connects to the live shop API by default — change it only if\nyou run your own backend or a tunnel.",
                            fontSize = 12.sp, color = Color.Gray
                        )
                        OutlinedTextField(
                            value = serverUrl,
                            onValueChange = { serverUrl = it; urlSaved = false },
                            label = { Text("Base URL") },
                            placeholder = { Text("https://your-shop.example.com/") },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(12.dp),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = EmeraldGreen)
                        )
                        Button(
                            onClick = {
                                onSaveServerUrl(serverUrl)
                                urlSaved = true
                            },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = ForestGreen),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Icon(Icons.Default.Save, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Save & Reconnect")
                        }
                        if (urlSaved) {
                            Text("✅ URL saved. Reloading catalog…", color = EmeraldGreen, fontSize = 12.sp)
                        }
                        Text(
                            "💡 Tip: the built-in default connects to the shop API baked\n" +
                            "into this build. For local development or a tunnel, change\n" +
                            "the origin here — the path is added automatically.",
                            fontSize = 11.sp, color = Color.Gray
                        )
                    }
                }
            }

            // WhatsApp phone
            item {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = Color.White),
                    elevation = CardDefaults.cardElevation(2.dp)
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("📱 WhatsApp Settings", fontWeight = FontWeight.Bold, fontSize = 16.sp, color = DarkText)
                        Text(
                            "Phone number to receive orders via WhatsApp (with country code, no + or spaces).",
                            fontSize = 12.sp, color = Color.Gray
                        )
                        OutlinedTextField(
                            value = waPhone,
                            onValueChange = { waPhone = it.filter { c -> c.isDigit() }; phoneSaved = false },
                            label = { Text("WhatsApp Number") },
                            placeholder = { Text("8801XXXXXXXXX") },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(12.dp),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = EmeraldGreen)
                        )
                        Button(
                            onClick = {
                                onSaveWaPhone(waPhone)
                                phoneSaved = true
                            },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF25D366)),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Text("Save WhatsApp Number")
                        }
                        if (phoneSaved) {
                            Text("✅ WhatsApp number saved.", color = EmeraldGreen, fontSize = 12.sp)
                        }
                    }
                }
            }

            // Durability: snapshots, rollback and conflicts
            item {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = Color.White),
                    elevation = CardDefaults.cardElevation(2.dp)
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("🗄️ On-device data", fontWeight = FontWeight.Bold, fontSize = 16.sp, color = DarkText)
                        Text(
                            "${repo.pendingCount()} queued · ${conflicts.count { it.isPending }} conflicts · ${snapshots.size} snapshots",
                            fontSize = 12.sp,
                            color = Color.Gray,
                        )
                        Text(
                            "Sales are written to a versioned SQLite store before they are sent. " +
                            "Snapshots are taken before every schema upgrade; restoring one never deletes a newer sale.",
                            fontSize = 12.sp,
                            color = Color.Gray,
                        )
                        Button(
                            onClick = {
                                scope.launch {
                                    repo.snapshot("manual")
                                    refreshStorage()
                                    storageMessage = "Snapshot saved."
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = ForestGreen),
                            shape = RoundedCornerShape(12.dp),
                        ) {
                            Text("Take a snapshot")
                        }
                        Box {
                            TextButton(
                                onClick = { snapshotMenuOpen = true },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Text(
                                    selectedSnapshot?.let { "$it — restore" } ?: "Choose a snapshot",
                                    fontSize = 12.sp,
                                )
                            }
                            DropdownMenu(
                                expanded = snapshotMenuOpen,
                                onDismissRequest = { snapshotMenuOpen = false },
                            ) {
                                snapshots.forEach { snap ->
                                    DropdownMenuItem(
                                        text = { Text("${snap.label} · ${snap.name}") },
                                        onClick = {
                                            selectedSnapshot = snap.name
                                            snapshotMenuOpen = false
                                        },
                                    )
                                }
                            }
                        }
                        Button(
                            onClick = {
                                val name = selectedSnapshot
                                if (name != null) {
                                    scope.launch {
                                        val restored = repo.rollback(name)
                                        refreshStorage()
                                        storageMessage = if (restored != null) {
                                            "Restored $name — data is still intact."
                                        } else {
                                            "That snapshot is no longer available."
                                        }
                                    }
                                }
                            },
                            enabled = selectedSnapshot != null,
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFB45309)),
                            shape = RoundedCornerShape(12.dp),
                        ) {
                            Text("Restore selected snapshot")
                        }
                        conflicts.filter { it.isPending }.take(3).forEach { conflict ->
                            Text(
                                "${conflict.kind} · ${conflict.entityId}: ${conflict.remote}",
                                fontSize = 11.sp,
                                color = Color.Gray,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                TextButton(onClick = {
                                    scope.launch {
                                        repo.resolveConflict(conflict.id, "kept_local")
                                        refreshStorage()
                                    }
                                }) { Text("Keep local") }
                                TextButton(onClick = {
                                    scope.launch {
                                        repo.resolveConflict(conflict.id, "used_server")
                                        refreshStorage()
                                    }
                                }) { Text("Use server") }
                            }
                        }
                        if (storageMessage.isNotBlank()) {
                            Text(storageMessage, fontSize = 12.sp, color = EmeraldGreen)
                        }
                    }
                }
            }

            // About
            item {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = LightGreen),
                    elevation = CardDefaults.cardElevation(0.dp)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Image(
                            painter = painterResource(R.drawable.logo_full),
                            contentDescription = "Mohammadpur Stock Point logo",
                            contentScale = ContentScale.Fit,
                            modifier = Modifier.size(150.dp)
                        )
                        Text(
                            "Mohammadpur Stock Point",
                            fontWeight = FontWeight.ExtraBold,
                            color = ForestGreen,
                            fontSize = 16.sp,
                            textAlign = TextAlign.Center
                        )
                        Text("Independent DXN distributor", fontSize = 12.sp, color = Color.Gray)
                        Text(
                            "H # 1, R # 11, B # A, Chandrima Model Town, Dhaka-1207",
                            fontSize = 12.sp,
                            color = DarkText.copy(alpha = 0.75f),
                            textAlign = TextAlign.Center
                        )
                        Text("Ph. 01939994578", fontSize = 12.sp, color = DarkText.copy(alpha = 0.75f))
                        Spacer(modifier = Modifier.height(6.dp))
                        Text("Version ${BuildConfig.VERSION_NAME}", fontSize = 12.sp, color = Color.Gray)
                        Text(
                            "Offline-first POS, inventory and PV tracking for the shop.",
                            fontSize = 12.sp,
                            color = Color.Gray,
                            textAlign = TextAlign.Center
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            "Stack: Kotlin · Jetpack Compose · Retrofit · PHP 8 · MySQL",
                            fontSize = 11.sp,
                            color = Color.Gray,
                            textAlign = TextAlign.Center
                        )
                    }
                }
            }
        }
    }
}

