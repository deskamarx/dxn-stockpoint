@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.dxn.stockpoint.client.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.LocalShipping
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dxn.stockpoint.core.UiState
import com.dxn.stockpoint.data.model.Order
import com.dxn.stockpoint.ui.theme.DarkText
import com.dxn.stockpoint.ui.theme.EmeraldGreen
import com.dxn.stockpoint.ui.theme.ForestGreen

@Composable
fun TrackScreen(
    initialOrderNumber: String,
    initialPhone: String,
    state: UiState<Order>?,
    onBack: () -> Unit,
    onTrack: (String, String) -> Unit
) {
    var orderNumber by remember(initialOrderNumber) { mutableStateOf(initialOrderNumber) }
    var phone by remember(initialPhone) { mutableStateOf(initialPhone) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Track Order", fontWeight = FontWeight.Bold) },
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
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                Card(
                    shape = RoundedCornerShape(18.dp),
                    colors = CardDefaults.cardColors(containerColor = Color.White)
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Default.LocalShipping, contentDescription = null, tint = ForestGreen)
                            Spacer(modifier = Modifier.width(8.dp))
                            Text("Where is my order?", fontWeight = FontWeight.Bold, color = DarkText)
                        }
                        Text(
                            "Enter the order number from your receipt and the phone number used at checkout.",
                            fontSize = 12.sp,
                            color = Color.Gray
                        )
                        OutlinedTextField(
                            value = orderNumber,
                            onValueChange = { orderNumber = it },
                            label = { Text("Order number") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            shape = RoundedCornerShape(12.dp)
                        )
                        OutlinedTextField(
                            value = phone,
                            onValueChange = { phone = it.filter { c -> c.isDigit() || c == '+' } },
                            label = { Text("Phone number") },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                            shape = RoundedCornerShape(12.dp)
                        )
                        Button(
                            onClick = { onTrack(orderNumber, phone) },
                            modifier = Modifier.fillMaxWidth(),
                            enabled = orderNumber.isNotBlank() && phone.isNotBlank() && state?.isLoading != true,
                            shape = RoundedCornerShape(12.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = ForestGreen),
                            contentPadding = PaddingValues(14.dp)
                        ) {
                            if (state?.isLoading == true) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(18.dp),
                                    color = Color.White,
                                    strokeWidth = 2.dp
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                            } else {
                                Icon(Icons.Default.Search, contentDescription = null, modifier = Modifier.size(18.dp))
                                Spacer(modifier = Modifier.width(8.dp))
                            }
                            Text("Find my order", fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }

            state?.error?.let { message ->
                item {
                    Card(
                        shape = RoundedCornerShape(14.dp),
                        colors = CardDefaults.cardColors(containerColor = Color(0xFFFFEBEE))
                    ) {
                        Text(
                            message,
                            modifier = Modifier.padding(14.dp),
                            color = Color(0xFFD32F2F),
                            fontSize = 13.sp
                        )
                    }
                }
            }

            state?.data?.let { order ->
                item { TrackedOrderCard(order) }
            }
        }
    }
}

@Composable
private fun TrackedOrderCard(order: Order) {
    val statusColor = when (order.status.uppercase()) {
        "DELIVERED", "COMPLETED", "CONFIRMED" -> EmeraldGreen
        "CANCELLED", "RETURNED" -> Color(0xFFD32F2F)
        else -> Color(0xFF1976D2)
    }

    Card(
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = Color.White),
        elevation = CardDefaults.cardElevation(2.dp)
    ) {
        Column(modifier = Modifier.padding(18.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text("Order ${order.orderNumber}", fontWeight = FontWeight.ExtraBold, fontSize = 16.sp, color = DarkText)
                    Text(order.createdAt.take(10), fontSize = 11.sp, color = Color.Gray)
                }
                Surface(color = statusColor, shape = RoundedCornerShape(20.dp)) {
                    Text(
                        order.status.ifBlank { "PENDING" },
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        color = Color.White,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            Spacer(modifier = Modifier.height(12.dp))
            InfoRow("Customer", order.customerName.ifBlank { "—" })
            InfoRow("Total", "৳${"%.2f".format(order.totalAmount)}")
            InfoRow("PV", "%.2f".format(order.totalPV))
            InfoRow("Payment", order.paymentMethod)
            order.courierTrackingCode?.takeIf { it.isNotBlank() }?.let {
                InfoRow("Courier tracking", it)
            }
            order.courierStatus?.takeIf { it.isNotBlank() }?.let {
                InfoRow("Courier status", it)
            }

            if (order.items.isNotEmpty()) {
                Spacer(modifier = Modifier.height(12.dp))
                HorizontalDivider(color = Color.LightGray.copy(alpha = 0.5f))
                Spacer(modifier = Modifier.height(8.dp))
                Text("Items", fontWeight = FontWeight.Bold, fontSize = 13.sp, color = DarkText)
                order.items.forEach { line ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            "${line.quantity} × ${line.name.ifBlank { line.sku }}",
                            fontSize = 12.sp,
                            color = Color.DarkGray,
                            modifier = Modifier.weight(1f)
                        )
                        Text("৳${"%.2f".format(line.lineTotal)}", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, fontSize = 12.sp, color = Color.Gray)
        Text(value, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = DarkText)
    }
}
