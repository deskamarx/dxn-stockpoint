<#
.SYNOPSIS
Generates the customer app signing key. Does not touch the owner key.

.EXAMPLE
.\scripts\new-client-keystore.ps1
.\scripts\new-client-keystore.ps1 -Alias my-alias
#>
param(
    [string]$Alias = "dxn-client"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Keystore = Join-Path $Root "client-release.keystore"
$EnvFile = Join-Path $Root ".tooling\client-keystore.env"

$keytool = Get-Command keytool -ErrorAction SilentlyContinue
if (-not $keytool) {
    throw "keytool was not found. Install a JDK 17+ or run this inside Android Studio."
}
if (Test-Path $Keystore) {
    throw "Refusing to overwrite $Keystore. Back it up first; rotate only deliberately."
}

$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password = ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '')
if ($password.Length -gt 32) { $password = $password.Substring(0, 32) }

New-Item -ItemType Directory -Force -Path (Join-Path $Root ".tooling") | Out-Null

& keytool -genkeypair `
    -keystore $Keystore `
    -alias $Alias `
    -keyalg RSA `
    -keysize 4096 `
    -validity 10000 `
    -storepass $password `
    -keypass $password `
    -dname "CN=DXN Shop, OU=Mobile, O=Mohammadpur Stock Point, L=Dhaka, C=BD"

if ($LASTEXITCODE -ne 0) { throw "keytool failed" }

@"
# Customer app signing credentials - generated $(Get-Date -Format o)
# Keep this file and $Keystore private. Both are gitignored.
`$env:DXN_CLIENT_KEYSTORE="$Keystore"
`$env:DXN_CLIENT_KEYSTORE_PASSWORD="$password"
`$env:DXN_CLIENT_KEY_ALIAS="$Alias"
`$env:DXN_CLIENT_KEY_PASSWORD="$password"
"@ | Set-Content -Path $EnvFile -Encoding UTF8

Write-Host "Created $Keystore"
Write-Host "Wrote   $EnvFile"
Write-Host ""
Write-Host "Back up BOTH files somewhere safe. Losing them means the customer app"
Write-Host "can never be updated under the same package id."
