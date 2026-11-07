package com.dxn.stockpoint.client

import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dxn.stockpoint.client.ui.screens.AccountScreen
import com.dxn.stockpoint.client.ui.screens.ClientOrdersScreen
import com.dxn.stockpoint.client.ui.screens.ClientSettingsScreen
import com.dxn.stockpoint.client.ui.screens.TrackScreen
import com.dxn.stockpoint.client.viewmodel.ClientViewModel
import com.dxn.stockpoint.ui.components.SyncStrip
import com.dxn.stockpoint.ui.screens.CartScreen
import com.dxn.stockpoint.ui.screens.CatalogScreen
import com.dxn.stockpoint.ui.theme.DXNStockpointTheme
import com.dxn.stockpoint.ui.theme.EmeraldGreen
import com.dxn.stockpoint.ui.theme.ForestGreen

private enum class ClientTab(val title: String, val icon: ImageVector) {
    SHOP("Shop", Icons.Default.Storefront),
    CART("Cart", Icons.Default.ShoppingCart),
    ORDERS("Orders", Icons.Default.ReceiptLong),
    ACCOUNT("Account", Icons.Default.Person)
}

private enum class ClientOverlay { SETTINGS, TRACK }

class MainActivity : ComponentActivity() {

    private val viewModel: ClientViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            DXNStockpointTheme {
                DXNShopApp(viewModel)
            }
        }
    }
}

@Composable
private fun DXNShopApp(viewModel: ClientViewModel) {
    val context = LocalContext.current
    var tab by remember { mutableStateOf(ClientTab.SHOP) }
    var overlay by remember { mutableStateOf<ClientOverlay?>(null) }
    var trackInitialNumber by remember { mutableStateOf("") }

    val productsState by viewModel.products.collectAsState()
    val cart by viewModel.cart.collectAsState()
    val orderResult by viewModel.orderResult.collectAsState()
    val searchQuery by viewModel.searchQuery.collectAsState()
    val selectedCategory by viewModel.selectedCategory.collectAsState()
    val syncState by viewModel.syncState.collectAsState()
    val serverUrl by viewModel.serverUrl.collectAsState()

    val profile by viewModel.profile.collectAsState()
    val loggedIn by viewModel.loggedIn.collectAsState()
    val authBusy by viewModel.authBusy.collectAsState()
    val authError by viewModel.authError.collectAsState()
    val ordersState by viewModel.orders.collectAsState()
    val trackState by viewModel.track.collectAsState()

    val cartCount = viewModel.cartItemCount
    val previewProducts = viewModel.filteredProducts()

    LaunchedEffect(orderResult) {
        orderResult?.data?.let { result ->
            val message = if (result.queued) {
                "Saved offline — it will sync automatically"
            } else {
                "Order ${result.orderNumber} placed successfully"
            }
            Toast.makeText(context, message, Toast.LENGTH_LONG).show()
            viewModel.clearOrderResult()
            if (loggedIn) {
                viewModel.loadOrders()
                tab = ClientTab.ORDERS
            }
        }
    }

    when (overlay) {
        ClientOverlay.SETTINGS -> {
            ClientSettingsScreen(
                currentServerUrl = serverUrl,
                onBack = { overlay = null },
                onSaveServerUrl = viewModel::saveServerUrl
            )
            return
        }
        ClientOverlay.TRACK -> {
            TrackScreen(
                initialOrderNumber = trackInitialNumber,
                initialPhone = profile?.phone.orEmpty(),
                state = trackState,
                onBack = {
                    overlay = null
                    viewModel.clearTrack()
                },
                onTrack = viewModel::trackOrder
            )
            return
        }
        null -> Unit
    }

    Scaffold(
        bottomBar = {
            Column {
                SyncStrip(
                    state = syncState,
                    accountUnlocked = loggedIn,
                    onSync = { viewModel.syncNow() },
                    onAccount = { tab = ClientTab.ACCOUNT },
                    accountDescription = if (loggedIn) "My account" else "Sign in"
                )
                NavigationBar(containerColor = Color.White, tonalElevation = 8.dp) {
                    ClientTab.entries.forEach { item ->
                        val selected = tab == item
                        NavigationBarItem(
                            selected = selected,
                            onClick = { tab = item },
                            icon = {
                                Box {
                                    Icon(
                                        imageVector = item.icon,
                                        contentDescription = item.title,
                                        tint = if (selected) ForestGreen else Color.Gray
                                    )
                                    if (item == ClientTab.CART && cartCount > 0) {
                                        Badge(
                                            modifier = Modifier
                                                .align(Alignment.TopEnd)
                                                .offset(x = 10.dp, y = (-4).dp),
                                            containerColor = Color(0xFFD32F2F)
                                        ) {
                                            Text(
                                                if (cartCount > 99) "99+" else "$cartCount",
                                                color = Color.White,
                                                fontSize = 9.sp,
                                                fontWeight = FontWeight.Bold
                                            )
                                        }
                                    }
                                }
                            },
                            label = {
                                Text(
                                    item.title,
                                    fontSize = 11.sp,
                                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                                    color = if (selected) ForestGreen else Color.Gray
                                )
                            },
                            colors = NavigationBarItemDefaults.colors(
                                indicatorColor = EmeraldGreen.copy(alpha = 0.15f)
                            )
                        )
                    }
                }
            }
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (tab) {
                ClientTab.SHOP -> CatalogScreen(
                    uiState = productsState.copy(data = previewProducts),
                    cartItemCount = cartCount,
                    searchQuery = searchQuery,
                    selectedCategory = selectedCategory,
                    onSearchChanged = viewModel::setSearch,
                    onCategorySelected = viewModel::setCategory,
                    onAddToCart = { product ->
                        viewModel.addToCart(product)
                        Toast.makeText(context, "Added ${product.name}", Toast.LENGTH_SHORT).show()
                    },
                    onCartClick = { tab = ClientTab.CART },
                    onRefresh = viewModel::loadProducts,
                    onSettingsClick = { overlay = ClientOverlay.SETTINGS },
                    onAdminClick = null,
                    onAccountClick = { tab = ClientTab.ACCOUNT },
                    accountIcon = Icons.Default.Person,
                    accountDescription = if (loggedIn) "My account" else "Sign in",
                    title = "DXN Shop",
                    subtitle = "Authentic DXN products",
                    categories = viewModel.categories()
                )

                ClientTab.CART -> CartScreen(
                    cartItems = cart,
                    waPhoneNumber = "",
                    isOrderLoading = orderResult?.isLoading == true,
                    orderError = orderResult?.error,
                    onBack = { tab = ClientTab.SHOP },
                    onIncrease = { viewModel.addToCart(it.product) },
                    onDecrease = { viewModel.removeFromCart(it.product) },
                    onDelete = { viewModel.deleteFromCart(it.product) },
                    onPlaceOrder = { name, phone, isMember, memberId ->
                        viewModel.placeOrder(name, phone, isMember, memberId)
                    },
                    onOrderErrorDismiss = viewModel::clearOrderResult,
                    initialIsMember = profile?.isDxnMember == true,
                    initialMemberId = profile?.dxnMemberId.orEmpty(),
                    lockMemberPricing = loggedIn && profile != null,
                    requirePhone = true,
                    showWhatsApp = false,
                    checkoutLabel = "Place Order"
                )

                ClientTab.ORDERS -> ClientOrdersScreen(
                    state = ordersState,
                    loggedIn = loggedIn,
                    onRefresh = viewModel::loadOrders,
                    onSignIn = { tab = ClientTab.ACCOUNT },
                    onTrack = { order ->
                        trackInitialNumber = order.orderNumber
                        overlay = ClientOverlay.TRACK
                    }
                )

                ClientTab.ACCOUNT -> AccountScreen(
                    profile = profile,
                    loggedIn = loggedIn,
                    busy = authBusy,
                    error = authError,
                    onLogin = { phone, password -> viewModel.login(phone, password) },
                    onRegister = { name, phone, password, email ->
                        viewModel.register(name, phone, password, email)
                    },
                    onLogout = {
                        viewModel.logout()
                        tab = ClientTab.SHOP
                        Toast.makeText(context, "Signed out", Toast.LENGTH_SHORT).show()
                    },
                    onRefresh = {
                        viewModel.refreshProfile()
                        viewModel.loadOrders()
                    },
                    onOrders = {
                        viewModel.loadOrders()
                        tab = ClientTab.ORDERS
                    },
                    onTrack = {
                        trackInitialNumber = ""
                        overlay = ClientOverlay.TRACK
                    },
                    onSettings = { overlay = ClientOverlay.SETTINGS },
                    onClearError = viewModel::clearAuthError
                )
            }
        }
    }
}
