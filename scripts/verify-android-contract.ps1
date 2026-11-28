# Verifies that the live API speaks exactly the contract the Android client is
# bound to (snake_case fields, revision sync, split payments, returns, RBAC,
# audit and versioned snapshots).
#
#   powershell -ExecutionPolicy Bypass -File scripts/verify-android-contract.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/verify-android-contract.ps1 -Base http://127.0.0.1:8099 -Pin 2468
#
param(
    [string]$Base = 'http://127.0.0.1:8099',
    [string]$Pin  = '2468'
)

$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) {
        $script:pass++
        Write-Host ("  ok   {0}" -f $name) -ForegroundColor DarkGreen
    } else {
        $script:fail++
        Write-Host ("  FAIL {0} {1}" -f $name, $detail) -ForegroundColor Red
    }
}

function Read-Json([string]$path, [hashtable]$headers, [string]$method = 'GET', $body = $null) {
    try {
        $request = @{ Uri = "$Base$path"; Method = $method; Headers = $headers; TimeoutSec = 15; UseBasicParsing = $true }
        if ($null -ne $body) { $request['ContentType'] = 'application/json'; $request['Body'] = ($body | ConvertTo-Json -Depth 8 -Compress) }
        $response = Invoke-WebRequest @request
        if ([string]::IsNullOrWhiteSpace($response.Content)) { return $null }
        return ($response.Content | ConvertFrom-Json)
    } catch {
        # Windows PowerShell 5.1 exposes HttpWebResponse; PowerShell 7 exposes
        # HttpResponseMessage. Read the error body from either shape.
        $response = $_.Exception.Response
        if ($null -eq $response) { return $null }
        $content = $null
        try {
            $stream = $response.GetResponseStream()
            if ($stream.CanSeek) { $stream.Position = 0 }
            $content = [IO.StreamReader]::new($stream).ReadToEnd()
        } catch {
            try { $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() } catch { return $null }
        }
        if ([string]::IsNullOrWhiteSpace($content)) { return $null }
        return ($content | ConvertFrom-Json)
    }
}

function Get-Json([string]$path, [string]$token = '') {
    $headers = @{}
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    return Read-Json $path $headers
}

function Post-Json([string]$path, $body, [string]$token = '', [string]$method = 'POST') {
    $headers = @{ 'Content-Type' = 'application/json' }
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    return Read-Json $path $headers $method $body
}

Write-Host "`nMohammadpur Stock Point — Android v3.3.0 contract check against $Base`n"

# ── 1. Health and service metadata ───────────────────────────────────────────
$health = Get-Json '/api/v1/health'
Check 'health returns success' ($health.status -eq 'ok')
Check 'health reports version 3.3.0' ($health.version -eq '3.3.0') "got '$($health.version)'"
Check 'health exposes server_rev' ($null -ne $health.server_rev)
Check 'health exposes database counts' ($null -ne $health.database.counts.payments)
$root = Get-Json '/api/v1'
Check 'API root reports version 3.3.0' ($root.version -eq '3.3.0')
Check 'API root advertises payment routes' ($root.endpoints -contains '/payments' -and $root.endpoints -contains '/returns')

# ── 2. Public sync (anonymous catalogue pull) ────────────────────────────────
$sync = Get-Json '/api/v1/sync?since=0'
Check 'public sync succeeds' ($sync.success -eq $true)
Check 'public sync hides orders' (@($sync.orders).Count -eq 0)
Check 'public sync hides settings' ($null -eq $sync.settings)
Check 'public sync hides audit and payments' (@($sync.audit).Count -eq 0 -and $null -eq $sync.payments)
Check 'public sync has products' (@($sync.products).Count -ge 12) "got $(@($sync.products).Count)"

$p = @($sync.products)[0]
foreach ($field in 'id','sku','name','category','retail_price','member_price','pv_points','stock_qty','low_stock_at','is_active','rev') {
    Check "product serialises '$field'" ($null -ne $p.$field)
}

# ── 3. Shop PIN login (HMAC bearer) ──────────────────────────────────────────
$login = Post-Json '/api/v1/auth/login' @{ pin = $Pin }
Check 'PIN login returns a token' (-not [string]::IsNullOrWhiteSpace($login.token))
Check 'PIN login returns expiry' (-not [string]::IsNullOrWhiteSpace($login.expires_at))
$token = $login.token

$me = Get-Json '/api/v1/auth/me' $token
Check 'token identifies an admin' ($me.role -eq 'admin')
Check 'token reports the admin scope' ($me.scope -eq 'admin')

$badLogin = Post-Json '/api/v1/auth/login' @{ pin = 'definitely-wrong' }
Check 'wrong PIN is rejected' ($badLogin.success -eq $false)

# ── 4. Admin sync ────────────────────────────────────────────────────────────
$adminSync = Get-Json '/api/v1/sync?since=0' $token
Check 'admin sync reports admin scope' ($adminSync.scope -eq 'admin')
Check 'admin sync includes settings' ($null -ne $adminSync.settings)
Check 'admin sync exposes paginator fields' ($null -ne $adminSync.truncated -and $null -ne $adminSync.next_since)
Check 'admin sync includes staff and audit ledgers' ($null -ne $adminSync.staff -and @($adminSync.audit).Count -ge 1)

# ── 5. Idempotent order create (what CartScreen pushes) ──────────────────────
$product = @($sync.products | Where-Object { $_.stock_qty -gt 0 })[0]
$uuid = [guid]::NewGuid().ToString()
$orderBody = @{
    client_uuid   = $uuid
    customer_name = 'Android Contract Check'
    customer_phone = '01700000000'
    dxn_member_id = 'DXN-TEST-01'
    is_member     = $true
    payment_method = 'CASH'
    source        = 'android'
    items         = @(@{ product_id = $product.id; quantity = 1 })
}

$created = Post-Json '/api/v1/orders' $orderBody
Check 'order create succeeds' ($created.success -eq $true)
Check 'order has a number' (-not [string]::IsNullOrWhiteSpace($created.order.order_number)) "got '$($created.order.order_number)'"
Check 'order is priced by the server' ([double]$created.order.total_amount -gt 0)
Check 'order line keeps snake_case fields' ($null -ne $created.order.items[0].line_total)
Check 'order echoes the client_uuid' ($created.order.client_uuid -eq $uuid)
Check 'member pricing applied' ([double]$created.order.items[0].unit_price -eq [double]$product.member_price)
Check 'new order starts with a payment ledger' ($null -ne $created.order.payments)

$replay = Post-Json '/api/v1/orders' $orderBody
Check 'replay is de-duplicated' ($replay.duplicate -eq $true)
Check 'replay returns the same order' ($replay.order.order_number -eq $created.order.order_number)

# ── 6. Stock decremented exactly once ────────────────────────────────────────
$after = Get-Json "/api/v1/products/$($product.id)"
Check 'stock moved by exactly one unit' (([int]$product.stock_qty - [int]$after.product.stock_qty) -eq 1) `
    "was $($product.stock_qty), now $($after.product.stock_qty)"

# ── 7. Oversell is refused with 409 ──────────────────────────────────────────
$oversell = Post-Json '/api/v1/orders' @{
    client_uuid = [guid]::NewGuid().ToString()
    customer_name = 'Oversell Check'
    source = 'android'
    items = @(@{ product_id = $product.id; quantity = 999999 })
}
Check 'oversell returns an error' ($oversell.success -eq $false)
Check 'oversell names the code' ($oversell.error.code -eq 'insufficient_stock') "got '$($oversell.error.code)'"

# ── 8. Split payments, ledger and timeline ───────────────────────────────────
$creditOrder = Post-Json '/api/v1/orders' @{
    client_uuid = [guid]::NewGuid().ToString()
    customer_name = 'Split Payment Check'
    customer_phone = '01711111111'
    payment_method = 'CREDIT'
    source = 'android'
    items = @(@{ product_id = $product.id; quantity = 2 })
}
$creditId = $creditOrder.order.id
$total = [double]$creditOrder.order.total_amount
Check 'credit order starts unpaid' ($creditOrder.order.payment_status -eq 'UNPAID')
$payUuid = [guid]::NewGuid().ToString()
$half = [math]::Round($total / 2, 2)
$pay1 = Post-Json "/api/v1/orders/$creditId/payments" @{ client_uuid = $payUuid; amount = $half; method = 'BKASH'; reference = 'CTR-1' } $token
Check 'partial payment recorded' ($pay1.order.payment_status -eq 'PARTIALLY_PAID')
$payReplay = Post-Json "/api/v1/orders/$creditId/payments" @{ client_uuid = $payUuid; amount = $half; method = 'BKASH'; reference = 'CTR-1' } $token
Check 'payment replay is de-duplicated' ($payReplay.duplicate -eq $true)
$pay2 = Post-Json "/api/v1/orders/$creditId/payments" @{ amount = [math]::Round($total - $half, 2); method = 'CASH' } $token
Check 'final payment settles the order' ($pay2.order.payment_status -eq 'PAID' -and $pay2.order.due_amount -eq 0)
$timeline = Get-Json "/api/v1/orders/$creditId/timeline" $token
Check 'timeline records both payments' (@($timeline.timeline | Where-Object { $_.kind -eq 'payment' }).Count -ge 2)
$ledger = Get-Json '/api/v1/payments' $token
Check 'payment ledger exposes per-method totals' ($null -ne $ledger.by_method.BKASH -and $null -ne $ledger.by_method.CASH)

# ── 9. Returns restore stock and never over-refund ───────────────────────────
$stockBeforeReturn = [int](Get-Json "/api/v1/products/$($product.id)").product.stock_qty
$return = Post-Json "/api/v1/orders/$creditId/returns" @{
    client_uuid = [guid]::NewGuid().ToString()
    items = @(@{ product_id = $product.id; quantity = 1 })
    reason = 'Contract check'
    refund_method = 'BKASH'
} $token
Check 'return is a linked negative order' ($return.order.type -eq 'RETURN' -and [int]$return.order.original_order_id -eq [int]$creditId)
$stockAfterReturn = [int](Get-Json "/api/v1/products/$($product.id)").product.stock_qty
Check 'return restores one unit of stock' ($stockAfterReturn -eq ($stockBeforeReturn + 1))
$returnsLedger = Get-Json '/api/v1/returns' $token
Check 'returns ledger shows the reversal' (@($returnsLedger.returns).Count -ge 1)

# ── 10. Dashboard keys match the Kotlin model ────────────────────────────────
$dash = Get-Json '/api/v1/dashboard' $token
foreach ($field in 'total_orders','total_revenue','total_pv','today_orders','today_revenue','total_products','stock_units','stock_value','low_stock_count','low_stock_products','top_products','recent_orders','sales_by_day') {
    Check "dashboard serialises '$field'" ($null -ne $dash.data.$field)
}

# ── 11. Order status and stock adjust ────────────────────────────────────────
$status = Post-Json "/api/v1/orders/$($created.order.id)/status" @{ status = 'PACKED' } $token
Check 'order status updates' ($status.order.status -eq 'PACKED')
$stockBeforeAdjust = [int](Get-Json "/api/v1/products/$($product.id)").product.stock_qty
$adjust = Post-Json '/api/v1/stock/adjust' @{ productId = $product.id; delta = 2; reason = 'contract-check' } $token
Check 'stock adjust succeeds' ($adjust.success -eq $true)
Check 'stock adjust returns the new count' ($adjust.stock_qty -eq ($stockBeforeAdjust + 2))

# ── 12. Expenses, staff RBAC, audit and snapshots ────────────────────────────
$expenseUuid = [guid]::NewGuid().ToString()
$expense = Post-Json '/api/v1/expenses' @{ client_uuid = $expenseUuid; category = 'Transport'; amount = 120.5; note = 'contract check' } $token
Check 'expense recorded' ($expense.expense.client_uuid -eq $expenseUuid)
$expenseReplay = Post-Json '/api/v1/expenses' @{ client_uuid = $expenseUuid; category = 'Transport'; amount = 120.5 } $token
Check 'expense replay is de-duplicated' ($expenseReplay.duplicate -eq $true)

$cashierPin = [string](10000 + (Get-Random -Maximum 89999))
$cashier = Post-Json '/api/v1/staff' @{ name = "Contract Cashier $cashierPin"; pin = $cashierPin; role = 'CASHIER' } $token
Check 'staff member created' ($cashier.staff.role -eq 'CASHIER')
Check 'staff response never returns a PIN hash' ($null -eq $cashier.staff.pin_hash -and $null -eq $cashier.staff.salt)
$cashierToken = (Post-Json '/api/v1/auth/login' @{ pin = $cashierPin }).token
Check 'staff PIN login works' (-not [string]::IsNullOrWhiteSpace($cashierToken))
$cashierCreatesStaff = Post-Json '/api/v1/staff' @{ name = 'Blocked'; pin = '9999'; role = 'ADMIN' } $cashierToken
Check 'cashier cannot create staff' ($cashierCreatesStaff.error.code -eq 'forbidden')
$cashierSnapshots = Get-Json '/api/v1/database/snapshots' $cashierToken
Check 'cashier cannot list database snapshots' ($null -eq $cashierSnapshots -or $cashierSnapshots.success -eq $false)
$audit = Get-Json '/api/v1/audit?limit=200' $token
Check 'audit log is exposed to staff' (@($audit.entries).Count -ge 1)
$actions = @($audit.entries | ForEach-Object { $_.action })
Check 'audit captures payment and return writes' ($actions -contains 'payment_recorded' -and $actions -contains 'return_created')
$snapshots = Get-Json '/api/v1/database/snapshots' $token
Check 'snapshots are administrator-only' ($snapshots.success -eq $true -and $null -ne $snapshots.snapshots)

# ── 13. Settings readable by both clients ────────────────────────────────────
$settings = Get-Json '/api/v1/settings' $token
Check 'settings expose branch_name' (-not [string]::IsNullOrWhiteSpace($settings.settings.branch_name))
$publicSettings = Get-Json '/api/v1/settings'
Check 'settings are readable without a token' ($publicSettings.success -eq $true)
Check 'anonymous settings hide the PIN hash' ($null -eq $publicSettings.settings.admin_pin_hash)

# ── 14. Logout invalidates the bearer immediately ────────────────────────────
$loggedOut = Post-Json '/api/v1/auth/logout' @{} $cashierToken
Check 'logout succeeds' ($loggedOut.success -eq $true)
$afterLogout = Get-Json '/api/v1/auth/me' $cashierToken
Check 'token is rejected after logout' ($null -eq $afterLogout -or $afterLogout.success -eq $false)

Write-Host ""
if ($script:fail -eq 0) {
    Write-Host ("PASS  {0} checks" -f $script:pass) -ForegroundColor Green
    exit 0
} else {
    Write-Host ("FAILED  {0} passed, {1} failed" -f $script:pass, $script:fail) -ForegroundColor Red
    exit 1
}
