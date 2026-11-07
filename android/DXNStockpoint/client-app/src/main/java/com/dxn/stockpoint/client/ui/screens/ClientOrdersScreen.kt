@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.dxn.stockpoint.client.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dxn.stockpoint.core.UiState
import com.dxn.stockpoint.data.model.Order
import com.dxn.stockpoint.ui.theme.DarkText
import com.dxn.stockpoint.ui.theme.EmeraldGreen
import com.dxn.stockpoint.ui.theme.ForestGreen

@Composable
fun ClientOrdersScreen(
    state: UiState<List<Order>>,
    loggedIn: Boolean,
    onRefresh: () -> Unit,
    onSignIn: () -> Unit,
    onTrack: (Order) -> Unit
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("My Orders", fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh", tint = Color.White)
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
        if (!loggedIn) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        Icons.Default.ReceiptLong,
                        contentDescription = null,
                        tint = ForestGreen.copy(alpha = 0.5f),
                        modifier = Modifier.size(56.dp)
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Text("Sign in to see your orders", fontSize = 16.sp, color = DarkText)
                    Spacer(modifier = Modifier.height(12.dp))
                    Button(
                        onClick = onSignIn,
                        colors = ButtonDefaults.buttonColors(containerColor = ForestGreen)
                    ) { Text("Sign in") }
                }
            }
            return@Scaffold
        }

        val orders = state.data.orEmpty()
        when {
            state.isLoading && orders.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentAlignment = Alignment.Center
                ) { CircularProgressIndicator(color = ForestGreen) }
            }

            state.error != null && orders.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(state.error.orEmpty(), color = Color.Gray, textAlign = TextAlign.Center)
                        Spacer(modifier = Modifier.height(12.dp))
                        Button(
                            onClick = onRefresh,
                            colors = ButtonDefaults.buttonColors(containerColor = ForestGreen)
                        ) { Text("Retry") }
                    }
                }
            }

            orders.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentAlignment = Alignment.Center
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("🛍️", fontSize = 48.sp)
                        Spacer(modifier = Modifier.height(8.dp))
                        Text("No orders yet", fontSize = 16.sp, color = Color.Gray)
                        Text("Your placed orders will appear here.", fontSize = 12.sp, color = Color.LightGray)
                    }
                }
            }

            else -> {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(orders, key = { it.id }) { order ->
                        OrderCard(order = order, onTrack = { onTrack(order) })
                    }
                    item { Spacer(modifier = Modifier.height(24.dp)) }
                }
            }
        }
    }
}

@Composable
private fun OrderCard(order: Order, onTrack: () -> Unit) {
    val statusColor = when (order.status.uppercase()) {
        "CONFIRMED", "DELIVERED", "COMPLETED" -> EmeraldGreen
        "CANCELLED", "RETURNED" -> Color(0xFFD32F2F)
        "PENDING_SYNC" -> Color(0xFFB8860B)
        else -> Color(0xFF1976D2)
    }

    Card(
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = Color.White),
        elevation = CardDefaults.cardElevation(2.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(order.orderNumber.ifBlank { "Order #${order.id}" }, fontWeight = FontWeight.ExtraBold, fontSize = 15.sp, color = DarkText)
                    Text(order.createdAt.take(10), fontSize = 11.sp, color = Color.Gray)
                }
                Surface(color = statusColor, shape = RoundedCornerShape(20.dp)) {
                    Text(
                        order.status.ifBlank { "PENDING" },
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = Color.White
                    )
                }
            }

            Spacer(modifier = Modifier.height(10.dp))
            HorizontalDivider(color = Color.LightGray.copy(alpha = 0.4f))
            Spacer(modifier = Modifier.height(10.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column {
                    Text("Total", fontSize = 11.sp, color = Color.Gray)
                    Text("৳${"%.2f".format(order.totalAmount)}", fontWeight = FontWeight.ExtraBold, color = ForestGreen)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("PV", fontSize = 11.sp, color = Color.Gray)
                    Text("${"%.2f".format(order.totalPV)}", fontWeight = FontWeight.Bold, color = EmeraldGreen)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("Items", fontSize = 11.sp, color = Color.Gray)
                    Text("${order.lineCount}", fontWeight = FontWeight.Bold, color = DarkText)
                }
            }

            if (!order.courierTrackingCode.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    "Courier: ${order.courierTrackingCode} · ${order.courierStatus ?: "in review"}",
                    fontSize = 11.sp,
                    color = Color(0xFF1976D2)
                )
            }

            Spacer(modifier = Modifier.height(6.dp))
            TextButton(onClick = onTrack, contentPadding = PaddingValues(0.dp)) {
                Text("Track this order", fontWeight = FontWeight.Bold, color = ForestGreen, fontSize = 12.sp)
            }
        }
    }
}
