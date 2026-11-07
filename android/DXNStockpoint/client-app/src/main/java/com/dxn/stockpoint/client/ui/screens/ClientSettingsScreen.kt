@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.dxn.stockpoint.client.ui.screens

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dxn.stockpoint.client.BuildConfig
import com.dxn.stockpoint.ui.theme.DarkText
import com.dxn.stockpoint.ui.theme.EmeraldGreen
import com.dxn.stockpoint.ui.theme.ForestGreen
import com.dxn.stockpoint.ui.theme.LightGreen

@Composable
fun ClientSettingsScreen(
    currentServerUrl: String,
    onBack: () -> Unit,
    onSaveServerUrl: (String) -> Unit
) {
    var serverUrl by remember(currentServerUrl) { mutableStateOf(currentServerUrl) }
    var saved by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings", fontWeight = FontWeight.Bold) },
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
            item {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = Color.White),
                    elevation = CardDefaults.cardElevation(2.dp)
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text("Server", fontWeight = FontWeight.Bold, fontSize = 16.sp, color = DarkText)
                        Text(
                            "The shop's HTTPS API. Changing it signs you out and clears the local cache.",
                            fontSize = 12.sp,
                            color = Color.Gray
                        )
                        OutlinedTextField(
                            value = serverUrl,
                            onValueChange = { serverUrl = it; saved = false },
                            label = { Text("Base URL") },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(12.dp),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = EmeraldGreen)
                        )
                        Button(
                            onClick = {
                                onSaveServerUrl(serverUrl)
                                saved = true
                            },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = ForestGreen),
                            shape = RoundedCornerShape(12.dp)
                        ) {
                            Icon(Icons.Default.Save, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Save & reconnect")
                        }
                        if (saved) {
                            Text("Saved. Reloading the catalogue…", color = EmeraldGreen, fontSize = 12.sp)
                        }
                    }
                }
            }

            item {
                Card(
                    shape = RoundedCornerShape(16.dp),
                    colors = CardDefaults.cardColors(containerColor = LightGreen)
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(18.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Text(
                            "DXN Shop",
                            fontWeight = FontWeight.ExtraBold,
                            color = ForestGreen,
                            fontSize = 18.sp
                        )
                        Text("Customer app", fontSize = 12.sp, color = Color.Gray)
                        Text(
                            "Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                            fontSize = 12.sp,
                            color = Color.Gray
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            "Authentic DXN products from Mohammadpur Stock Point. " +
                                "Browse offline, place orders securely over HTTPS, and track delivery.",
                            fontSize = 12.sp,
                            color = DarkText.copy(alpha = 0.75f),
                            textAlign = TextAlign.Center
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Text(
                            "Payments are arranged with the shop after the order is confirmed. " +
                                "No card details are stored on this device.",
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
