@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.dxn.stockpoint.client.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Paid
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dxn.stockpoint.data.model.CustomerProfile
import com.dxn.stockpoint.ui.components.StatCard
import com.dxn.stockpoint.ui.theme.DarkText
import com.dxn.stockpoint.ui.theme.EmeraldGreen
import com.dxn.stockpoint.ui.theme.ForestGreen
import com.dxn.stockpoint.ui.theme.LightGreen

@Composable
fun AccountScreen(
    profile: CustomerProfile?,
    loggedIn: Boolean,
    busy: Boolean,
    error: String?,
    onLogin: (String, String) -> Unit,
    onRegister: (String, String, String, String) -> Unit,
    onLogout: () -> Unit,
    onRefresh: () -> Unit,
    onOrders: () -> Unit,
    onTrack: () -> Unit,
    onSettings: () -> Unit,
    onClearError: () -> Unit
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("My Account", fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = Color.White)
                    }
                    IconButton(onClick = onSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Color.White)
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
        if (loggedIn && profile != null) {
            ProfileContent(
                profile = profile,
                modifier = Modifier.padding(padding),
                onLogout = onLogout,
                onRefresh = onRefresh,
                onOrders = onOrders,
                onTrack = onTrack,
                onSettings = onSettings
            )
        } else {
            AuthContent(
                busy = busy,
                error = error,
                modifier = Modifier.padding(padding),
                onLogin = onLogin,
                onRegister = onRegister,
                onClearError = onClearError
            )
        }
    }
}

@Composable
private fun ProfileContent(
    profile: CustomerProfile,
    modifier: Modifier,
    onLogout: () -> Unit,
    onRefresh: () -> Unit,
    onOrders: () -> Unit,
    onTrack: () -> Unit,
    onSettings: () -> Unit
) {
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Card(
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = Color.White),
                elevation = CardDefaults.cardElevation(2.dp)
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Box(
                        modifier = Modifier
                            .size(72.dp)
                            .background(LightGreen, CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            profile.name.firstOrNull()?.uppercase() ?: "?",
                            fontSize = 30.sp,
                            fontWeight = FontWeight.ExtraBold,
                            color = ForestGreen
                        )
                    }
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(
                        profile.name.ifBlank { "DXN Customer" },
                        fontSize = 20.sp,
                        fontWeight = FontWeight.ExtraBold,
                        color = DarkText,
                        textAlign = TextAlign.Center
                    )
                    profile.phone?.let {
                        Text(it, fontSize = 13.sp, color = Color.Gray)
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Surface(
                        color = if (profile.isDxnMember) EmeraldGreen else Color(0xFFE0E0E0),
                        shape = RoundedCornerShape(20.dp)
                    ) {
                        Text(
                            if (profile.isDxnMember) "DXN MEMBER" else "RETAIL CUSTOMER",
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                            fontSize = 10.sp,
                            fontWeight = FontWeight.ExtraBold,
                            color = if (profile.isDxnMember) Color.White else Color.DarkGray
                        )
                    }
                    profile.dxnMemberId?.takeIf { it.isNotBlank() }?.let {
                        Spacer(modifier = Modifier.height(6.dp))
                        Text("Member ID: $it", fontSize = 12.sp, color = Color.Gray)
                    }
                }
            }
        }

        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                StatCard(
                    title = "Orders",
                    value = "${profile.totalOrders}",
                    icon = Icons.Default.ReceiptLong,
                    modifier = Modifier.weight(1f)
                )
                StatCard(
                    title = "Spent",
                    value = "৳${"%.0f".format(profile.totalSpent)}",
                    icon = Icons.Default.Paid,
                    modifier = Modifier.weight(1f)
                )
                StatCard(
                    title = "PV",
                    value = "${"%.1f".format(profile.totalPv)}",
                    icon = Icons.Default.Star,
                    modifier = Modifier.weight(1f)
                )
            }
        }

        item {
            AccountAction("My Orders", "Track every order you placed", Icons.Default.ReceiptLong, onOrders)
        }
        item {
            AccountAction("Track an Order", "Look up any order with its number and phone", Icons.Default.Search, onTrack)
        }
        item {
            AccountAction("Settings", "Server address and app information", Icons.Default.Settings, onSettings)
        }
        item {
            AccountAction("Refresh Profile", "Pull the latest totals from the server", Icons.Default.Refresh, onRefresh)
        }
        item {
            Spacer(modifier = Modifier.height(4.dp))
            OutlinedButton(
                onClick = onLogout,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                contentPadding = PaddingValues(14.dp),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFD32F2F))
            ) {
                Icon(Icons.Default.Logout, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("Sign out", fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun AccountAction(
    title: String,
    subtitle: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit
) {
    Card(
        onClick = onClick,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = Color.White),
        elevation = CardDefaults.cardElevation(1.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(icon, contentDescription = null, tint = ForestGreen)
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.Bold, color = DarkText)
                Text(subtitle, fontSize = 11.sp, color = Color.Gray)
            }
        }
    }
}

@Composable
private fun AuthContent(
    busy: Boolean,
    error: String?,
    modifier: Modifier,
    onLogin: (String, String) -> Unit,
    onRegister: (String, String, String, String) -> Unit,
    onClearError: () -> Unit
) {
    var mode by remember { mutableIntStateOf(0) }
    var phone by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }

    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    Icons.Default.Person,
                    contentDescription = null,
                    tint = ForestGreen,
                    modifier = Modifier.size(56.dp)
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    if (mode == 0) "Welcome back" else "Create your account",
                    fontSize = 22.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = DarkText
                )
                Text(
                    "Sign in to see your orders, PV and member pricing.",
                    fontSize = 12.sp,
                    color = Color.Gray,
                    textAlign = TextAlign.Center
                )
            }
        }

        item {
            Card(
                shape = RoundedCornerShape(18.dp),
                colors = CardDefaults.cardColors(containerColor = Color.White)
            ) {
                Column {
                    TabRow(selectedTabIndex = mode, containerColor = Color.White) {
                        Tab(
                            selected = mode == 0,
                            onClick = { mode = 0; onClearError() },
                            text = { Text("Sign in", fontWeight = FontWeight.Bold) }
                        )
                        Tab(
                            selected = mode == 1,
                            onClick = { mode = 1; onClearError() },
                            text = { Text("Register", fontWeight = FontWeight.Bold) }
                        )
                    }
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        if (mode == 1) {
                            OutlinedTextField(
                                value = name,
                                onValueChange = { name = it; onClearError() },
                                label = { Text("Full name") },
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = true,
                                shape = RoundedCornerShape(12.dp)
                            )
                        }
                        OutlinedTextField(
                            value = phone,
                            onValueChange = { phone = it.filter { c -> c.isDigit() || c == '+' }; onClearError() },
                            label = { Text("Phone number") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                            shape = RoundedCornerShape(12.dp)
                        )
                        if (mode == 1) {
                            OutlinedTextField(
                                value = email,
                                onValueChange = { email = it; onClearError() },
                                label = { Text("Email (optional)") },
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                                shape = RoundedCornerShape(12.dp)
                            )
                        }
                        OutlinedTextField(
                            value = password,
                            onValueChange = { password = it; onClearError() },
                            label = { Text(if (mode == 0) "Password" else "Password (min 6 characters)") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                            shape = RoundedCornerShape(12.dp)
                        )

                        error?.let {
                            Text(it, color = Color(0xFFD32F2F), fontSize = 12.sp)
                        }

                        Button(
                            onClick = {
                                if (mode == 0) onLogin(phone, password)
                                else onRegister(name, phone, password, email)
                            },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = !busy,
                            shape = RoundedCornerShape(12.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = ForestGreen),
                            contentPadding = PaddingValues(14.dp)
                        ) {
                            if (busy) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(18.dp),
                                    color = Color.White,
                                    strokeWidth = 2.dp
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                            }
                            Text(
                                if (mode == 0) "Sign in" else "Create account",
                                fontWeight = FontWeight.Bold
                            )
                        }
                    }
                }
            }
        }

        item {
            Text(
                "Your account is optional — you can always browse and check out as a guest.",
                fontSize = 11.sp,
                color = Color.Gray,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}
