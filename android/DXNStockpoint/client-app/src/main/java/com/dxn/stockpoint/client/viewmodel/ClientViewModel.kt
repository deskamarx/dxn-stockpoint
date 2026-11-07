package com.dxn.stockpoint.client.viewmodel

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.dxn.stockpoint.core.SyncState
import com.dxn.stockpoint.core.UiState
import com.dxn.stockpoint.data.api.RetrofitClient
import com.dxn.stockpoint.data.local.Prefs
import com.dxn.stockpoint.data.model.CartItem
import com.dxn.stockpoint.data.model.CustomerLoginRequest
import com.dxn.stockpoint.data.model.CustomerProfile
import com.dxn.stockpoint.data.model.Order
import com.dxn.stockpoint.data.model.OrderLineRequest
import com.dxn.stockpoint.data.model.PlaceOrderRequest
import com.dxn.stockpoint.data.model.PlaceOrderResponse
import com.dxn.stockpoint.data.model.Product
import com.dxn.stockpoint.data.model.RegisterRequest
import com.dxn.stockpoint.data.repository.Result
import com.dxn.stockpoint.data.repository.StockpointRepository
import com.dxn.stockpoint.data.repository.newClientUuid
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Customer-side state. Uses the same offline-first repository as the owner app,
 * but a bearer token here always belongs to a customer account.
 */
class ClientViewModel(app: Application) : AndroidViewModel(app) {

    private val repository = StockpointRepository()
    private val gson = Gson()

    // ── Catalogue & cart ─────────────────────────────────────────────────────
    private val _products = MutableStateFlow(UiState<List<Product>>(isLoading = true))
    val products: StateFlow<UiState<List<Product>>> = _products.asStateFlow()

    private val _cart = MutableStateFlow<List<CartItem>>(emptyList())
    val cart: StateFlow<List<CartItem>> = _cart.asStateFlow()

    val cartItemCount: Int get() = _cart.value.sumOf { it.quantity }

    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()

    private val _selectedCategory = MutableStateFlow("All")
    val selectedCategory: StateFlow<String> = _selectedCategory.asStateFlow()

    // ── Checkout ─────────────────────────────────────────────────────────────
    private val _orderResult = MutableStateFlow<UiState<PlaceOrderResponse>?>(null)
    val orderResult: StateFlow<UiState<PlaceOrderResponse>?> = _orderResult.asStateFlow()

    // ── Account ──────────────────────────────────────────────────────────────
    private val _profile = MutableStateFlow<CustomerProfile?>(null)
    val profile: StateFlow<CustomerProfile?> = _profile.asStateFlow()

    private val _loggedIn = MutableStateFlow(Prefs.token != null)
    val loggedIn: StateFlow<Boolean> = _loggedIn.asStateFlow()

    private val _authBusy = MutableStateFlow(false)
    val authBusy: StateFlow<Boolean> = _authBusy.asStateFlow()

    private val _authError = MutableStateFlow<String?>(null)
    val authError: StateFlow<String?> = _authError.asStateFlow()

    private val _orders = MutableStateFlow(UiState<List<Order>>())
    val orders: StateFlow<UiState<List<Order>>> = _orders.asStateFlow()

    private val _track = MutableStateFlow<UiState<Order>?>(null)
    val track: StateFlow<UiState<Order>?> = _track.asStateFlow()

    // ── Sync & settings ──────────────────────────────────────────────────────
    private val _sync = MutableStateFlow(SyncState())
    val syncState: StateFlow<SyncState> = _sync.asStateFlow()

    private val _serverUrl = MutableStateFlow(RetrofitClient.getBaseUrl())
    val serverUrl: StateFlow<String> = _serverUrl.asStateFlow()

    init {
        val cached = repository.cachedProducts()
        if (cached.isNotEmpty()) _products.value = UiState(data = cached)

        restoreCart()
        _sync.value = SyncState(
            lastSyncAt = Prefs.lastRev.takeIf { it > 0 }?.let { System.currentTimeMillis() } ?: 0L,
            pending = repository.pendingCount(),
            serverRev = repository.currentRev()
        )

        loadProducts()
        startSyncLoop()
        if (Prefs.token != null) refreshProfile()
    }

    // ── Catalogue ────────────────────────────────────────────────────────────

    fun loadProducts() {
        viewModelScope.launch {
            val cached = repository.cachedProducts()
            _products.value = UiState(data = cached.takeIf { it.isNotEmpty() }, isLoading = true)
            when (val r = repository.getProducts()) {
                is Result.Success -> _products.value = UiState(data = r.data)
                is Result.Error -> _products.value = UiState(
                    data = cached.takeIf { it.isNotEmpty() },
                    error = if (cached.isEmpty()) r.message else null
                )
            }
        }
    }

    fun setSearch(query: String) { _searchQuery.value = query }

    fun setCategory(cat: String) { _selectedCategory.value = cat }

    fun filteredProducts(): List<Product> {
        val all = _products.value.data ?: return emptyList()
        val q = _searchQuery.value.trim().lowercase()
        val cat = _selectedCategory.value
        return all.asSequence()
            .filter { it.isActive }
            .filter { cat == "All" || it.category.equals(cat, ignoreCase = true) }
            .filter {
                q.isEmpty() ||
                    it.name.lowercase().contains(q) ||
                    it.category.lowercase().contains(q) ||
                    it.sku.lowercase().contains(q)
            }
            .sortedWith(compareBy({ it.isOutOfStock }, { it.name }))
            .toList()
    }

    fun categories(): List<String> =
        listOf("All") + (_products.value.data ?: emptyList())
            .filter { it.isActive }
            .map { it.category }
            .distinct()
            .sorted()

    // ── Cart ─────────────────────────────────────────────────────────────────

    fun addToCart(product: Product) {
        val current = _cart.value.toMutableList()
        val existing = current.find { it.product.id == product.id }
        if (existing != null) {
            if (existing.quantity >= product.stockQty) return
            current[current.indexOf(existing)] = CartItem(product, existing.quantity + 1)
        } else {
            if (product.stockQty <= 0) return
            current.add(CartItem(product, 1))
        }
        setCart(current)
    }

    fun removeFromCart(product: Product) {
        val current = _cart.value.toMutableList()
        val existing = current.find { it.product.id == product.id } ?: return
        if (existing.quantity > 1) {
            current[current.indexOf(existing)] = CartItem(product, existing.quantity - 1)
        } else {
            current.remove(existing)
        }
        setCart(current)
    }

    fun deleteFromCart(product: Product) {
        setCart(_cart.value.filterNot { it.product.id == product.id })
    }

    fun clearCart() = setCart(emptyList())

    private fun setCart(items: List<CartItem>) {
        _cart.value = items
        runCatching { Prefs.cartSnapshot = gson.toJson(items) }
    }

    private fun restoreCart() {
        runCatching {
            val type = object : TypeToken<List<CartItem>>() {}.type
            val restored: List<CartItem>? = gson.fromJson(Prefs.cartSnapshot, type)
            if (!restored.isNullOrEmpty()) _cart.value = restored
        }
    }

    // ── Checkout ─────────────────────────────────────────────────────────────

    fun placeOrder(
        customerName: String,
        customerPhone: String?,
        isMember: Boolean,
        memberId: String?
    ) {
        val items = _cart.value
        if (items.isEmpty()) {
            _orderResult.value = UiState(error = "Your cart is empty")
            return
        }
        val phone = customerPhone?.trim().orEmpty()
        if (phone.isBlank()) {
            _orderResult.value = UiState(error = "Enter your phone number")
            return
        }
        viewModelScope.launch {
            _orderResult.value = UiState(isLoading = true)
            val request = PlaceOrderRequest(
                clientUuid = newClientUuid(),
                customerName = customerName.trim(),
                customerPhone = phone,
                dxnMemberId = memberId?.trim()?.takeIf { it.isNotEmpty() },
                isMember = isMember,
                source = "android-client",
                items = items.map { OrderLineRequest(it.product.id, it.quantity) }
            )
            when (val r = repository.placeOrder(request)) {
                is Result.Success -> {
                    _orderResult.value = UiState(data = r.data)
                    decreaseLocalStock(items)
                    clearCart()
                    _sync.update { it.copy(pending = repository.pendingCount()) }
                    if (!r.data.queued) {
                        refreshProfile()
                        loadOrders()
                    }
                }
                is Result.Error -> _orderResult.value = UiState(error = r.message)
            }
        }
    }

    fun clearOrderResult() { _orderResult.value = null }

    private fun decreaseLocalStock(items: List<CartItem>) {
        val current = _products.value.data ?: return
        val sold = items.associate { it.product.id to it.quantity }
        val next = current.map { product ->
            val qty = sold[product.id] ?: return@map product
            product.copy(stockQty = (product.stockQty - qty).coerceAtLeast(0))
        }
        _products.value = _products.value.copy(data = next)
        runCatching { repository.saveProducts(next, repository.currentRev()) }
    }

    // ── Account ──────────────────────────────────────────────────────────────

    fun login(phone: String, password: String, onDone: (Boolean, String?) -> Unit = { _, _ -> }) {
        if (phone.isBlank() || password.isBlank()) {
            _authError.value = "Enter your phone number and password"
            onDone(false, _authError.value)
            return
        }
        _authBusy.value = true
        _authError.value = null
        viewModelScope.launch {
            when (val r = repository.customerLogin(CustomerLoginRequest(phone.trim(), password))) {
                is Result.Success -> {
                    _authBusy.value = false
                    _loggedIn.value = true
                    refreshProfile()
                    loadOrders()
                    onDone(true, null)
                }
                is Result.Error -> {
                    _authBusy.value = false
                    _authError.value = r.message
                    onDone(false, r.message)
                }
            }
        }
    }

    fun register(
        name: String,
        phone: String,
        password: String,
        email: String,
        onDone: (Boolean, String?) -> Unit = { _, _ -> }
    ) {
        if (name.isBlank() || phone.isBlank() || password.length < 6) {
            _authError.value = "Name, phone and a password of at least 6 characters are required"
            onDone(false, _authError.value)
            return
        }
        _authBusy.value = true
        _authError.value = null
        viewModelScope.launch {
            val request = RegisterRequest(
                phone = phone.trim(),
                password = password,
                name = name.trim(),
                email = email.trim().ifBlank { null }
            )
            when (val r = repository.registerCustomer(request)) {
                is Result.Success -> {
                    if (r.data.token.isNotBlank()) {
                        _authBusy.value = false
                        _loggedIn.value = true
                        refreshProfile()
                        loadOrders()
                        onDone(true, null)
                    } else {
                        // Some installs require an explicit login after registration.
                        login(phone, password, onDone)
                    }
                }
                is Result.Error -> {
                    _authBusy.value = false
                    _authError.value = r.message
                    onDone(false, r.message)
                }
            }
        }
    }

    fun refreshProfile() {
        if (Prefs.token == null) {
            _profile.value = null
            _loggedIn.value = false
            return
        }
        viewModelScope.launch {
            when (val r = repository.customerProfile()) {
                is Result.Success -> {
                    val customer = r.data.customer
                    _profile.value = customer
                    _loggedIn.value = customer != null
                }
                is Result.Error -> {
                    if (r.code == "http_401" || r.code == "http_403") {
                        RetrofitClient.clearToken()
                        _profile.value = null
                        _loggedIn.value = false
                    }
                }
            }
        }
    }

    fun logout() {
        RetrofitClient.clearToken()
        _profile.value = null
        _loggedIn.value = false
        _orders.value = UiState()
        _authError.value = null
    }

    fun clearAuthError() { _authError.value = null }

    fun loadOrders() {
        viewModelScope.launch {
            if (!_loggedIn.value) {
                _orders.value = UiState(error = "Sign in to see your orders")
                return@launch
            }
            _orders.value = _orders.value.copy(isLoading = true, error = null)
            when (val r = repository.customerOrders()) {
                is Result.Success -> _orders.value = UiState(
                    data = r.data.orders.sortedByDescending { it.id }
                )
                is Result.Error -> _orders.value = _orders.value.copy(
                    isLoading = false,
                    error = r.message
                )
            }
        }
    }

    fun trackOrder(orderNumber: String, phone: String) {
        if (orderNumber.isBlank() || phone.isBlank()) {
            _track.value = UiState(error = "Enter the order number and the phone used to order")
            return
        }
        viewModelScope.launch {
            _track.value = UiState(isLoading = true)
            when (val r = repository.customerTrack(orderNumber.trim(), phone.trim())) {
                is Result.Success -> _track.value = UiState(
                    data = r.data.order,
                    error = if (r.data.order == null) "No order matches those details" else null
                )
                is Result.Error -> _track.value = UiState(error = r.message)
            }
        }
    }

    fun clearTrack() { _track.value = null }

    // ── Sync ─────────────────────────────────────────────────────────────────

    private fun startSyncLoop() {
        viewModelScope.launch {
            var first = true
            while (isActive) {
                delay(if (first) 1_200L else 20_000L)
                first = false
                syncNow(quiet = true)
            }
        }
    }

    fun syncNow(quiet: Boolean = false) {
        if (_sync.value.syncing) return
        viewModelScope.launch {
            _sync.update { it.copy(syncing = true, error = if (quiet) it.error else null) }

            val sent = runCatching { repository.flushOutbox() }.getOrDefault(0)

            var cursor = repository.currentRev()
            var rounds = 0
            var newOrders = false
            var error: String? = null
            var networkDown = false

            while (rounds++ < 12) {
                val before = cursor
                when (val r = repository.sync(cursor)) {
                    is Result.Success -> {
                        val page = r.data
                        newOrders = newOrders || page.orders.isNotEmpty()
                        if (page.products.isNotEmpty()) {
                            _products.value = _products.value.copy(data = repository.cachedProducts())
                        }
                        if (!page.truncated || page.serverRev <= before) {
                            cursor = maxOf(cursor, page.serverRev)
                            break
                        }
                        cursor = page.serverRev
                    }
                    is Result.Error -> {
                        error = r.message
                        networkDown = r.isNetwork
                        break
                    }
                }
            }

            val rev = repository.currentRev()
            if (rev > 0) Prefs.lastRev = rev

            _sync.update {
                it.copy(
                    syncing = false,
                    online = !networkDown,
                    lastSyncAt = if (error == null) System.currentTimeMillis() else it.lastSyncAt,
                    pending = repository.pendingCount(),
                    serverRev = rev,
                    error = error
                )
            }

            if (newOrders && _loggedIn.value) loadOrders()
            if (sent > 0 && (_products.value.data ?: emptyList()).isEmpty()) loadProducts()
        }
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    fun saveServerUrl(url: String) {
        val changed = RetrofitClient.normalize(url) != RetrofitClient.getBaseUrl()
        RetrofitClient.setBaseUrl(url)
        _serverUrl.value = RetrofitClient.getBaseUrl()
        Prefs.lastRev = 0
        if (changed) {
            RetrofitClient.clearToken()
            _profile.value = null
            _loggedIn.value = false
            _orders.value = UiState()
            _authError.value = null
        }
        loadProducts()
        syncNow()
    }
}
