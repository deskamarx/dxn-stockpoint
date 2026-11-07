<#
.SYNOPSIS
Builds the owner, customer and suite Android apps.

.EXAMPLE
.\scripts\build-apps.ps1
.\scripts\build-apps.ps1 -Variant release -Aab
.\scripts\build-apps.ps1 -Variant debug -ClientOnly
.\scripts\build-apps.ps1 -Variant release -SuiteOnly
.\scripts\build-apps.ps1 -Variant release -ApiUrl https://api.example.com/ -VersionCode 11 -VersionName 3.2.0

Signing credentials are read from the environment, or from
.tooling\keystore.env / .tooling\client-keystore.env / .tooling\suite-keystore.env
when present.
#>
param(
    [ValidateSet("debug", "release", "both")]
    [string]$Variant = "both",
    [switch]$Aab,
    [switch]$Clean,
    [switch]$OwnerOnly,
    [switch]$ClientOnly,
    [switch]$SuiteOnly,
    [switch]$NoSuite,
    [switch]$AllowPlaceholder,
    [string]$ApiUrl,
    [string]$VersionCode,
    [string]$VersionName
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    foreach ($line in Get-Content $Path) {
        $line = $line.TrimEnd("`r")
        if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $name = $matches[1]
            $value = $matches[2].Trim().Trim('"').Trim("'")
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}

Import-DotEnv (Join-Path $Root "..\..\.tooling\keystore.env")
Import-DotEnv (Join-Path $Root ".tooling\keystore.env")
Import-DotEnv (Join-Path $Root "..\..\.tooling\client-keystore.env")
Import-DotEnv (Join-Path $Root ".tooling\client-keystore.env")
Import-DotEnv (Join-Path $Root "..\..\.tooling\suite-keystore.env")
Import-DotEnv (Join-Path $Root ".tooling\suite-keystore.env")

if ($env:DXN_KEYSTORE -and $env:DXN_KEYSTORE_PASSWORD -and (Test-Path $env:DXN_KEYSTORE)) {
    $alias = if ($env:DXN_KEY_ALIAS) { $env:DXN_KEY_ALIAS } else { "dxn" }
    & keytool -list -keystore $env:DXN_KEYSTORE -storepass:env DXN_KEYSTORE_PASSWORD -alias $alias *> $null
    if ($LASTEXITCODE -ne 0 -and (Test-Path "$($env:DXN_KEYSTORE).bak")) {
        & keytool -list -keystore "$($env:DXN_KEYSTORE).bak" -storepass:env DXN_KEYSTORE_PASSWORD -alias $alias *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Warning "Password does not match $($env:DXN_KEYSTORE); using $($env:DXN_KEYSTORE).bak"
            $env:DXN_KEYSTORE = "$($env:DXN_KEYSTORE).bak"
        }
    }
}

$gradleProps = Get-Content (Join-Path $Root "gradle.properties")
$defaultCode = ($gradleProps | Where-Object { $_ -match '^dxn\.versionCode=' } | Select-Object -First 1) -replace '^dxn\.versionCode=', ''
$defaultName = ($gradleProps | Where-Object { $_ -match '^dxn\.versionName=' } | Select-Object -First 1) -replace '^dxn\.versionName=', ''
if (-not $VersionCode) { $VersionCode = $defaultCode.Trim() }
if (-not $VersionName) { $VersionName = $defaultName.Trim() }

$owner = -not $ClientOnly -and -not $SuiteOnly
$client = -not $OwnerOnly -and -not $SuiteOnly
$suite = -not $NoSuite -and -not $OwnerOnly -and -not $ClientOnly
if ($SuiteOnly) { $suite = $true }

if (-not $ApiUrl) { $ApiUrl = $env:DXN_API_URL }
if (-not $ApiUrl) {
    $ApiUrl = ($gradleProps | Where-Object { $_ -match '^dxn\.apiBaseUrl=' } | Select-Object -First 1) -replace '^dxn\.apiBaseUrl=', ''
}
$ApiUrl = $ApiUrl.Trim()
if ($Variant -ne "debug" -and ($owner -or $client) -and (-not $ApiUrl -or $ApiUrl -match 'shop\.example\.com')) {
    if (-not $AllowPlaceholder) {
        throw "Set the production API with -ApiUrl https://your-domain/ (or DXN_API_URL). Refusing to build a release against the placeholder domain."
    }
    Write-Warning "Building a release against the placeholder API $ApiUrl"
}
$tasks = New-Object System.Collections.Generic.List[string]
$gradleArgs = New-Object System.Collections.Generic.List[string]
$gradleArgs.Add("--console=plain")
if ($Clean) { $gradleArgs.Add("clean") }
if ($ApiUrl) { $gradleArgs.Add("-Pdxn.apiBaseUrl=$ApiUrl") }
if ($VersionCode) { $gradleArgs.Add("-Pdxn.versionCode=$VersionCode") }
if ($VersionName) { $gradleArgs.Add("-Pdxn.versionName=$VersionName") }

if ($Variant -in @("debug", "both")) {
    if ($owner) { $tasks.Add(":owner-app:assembleDebug") }
    if ($client) { $tasks.Add(":client-app:assembleDebug") }
    if ($suite) { $tasks.Add(":suite-app:assembleDebug") }
}
if ($Variant -in @("release", "both")) {
    if ($owner) { $tasks.Add(":owner-app:assembleRelease") }
    if ($client) { $tasks.Add(":client-app:assembleRelease") }
    if ($suite) { $tasks.Add(":suite-app:assembleRelease") }
    if ($Aab) {
        if ($owner) { $tasks.Add(":owner-app:bundleRelease") }
        if ($client) { $tasks.Add(":client-app:bundleRelease") }
        if ($suite) { $tasks.Add(":suite-app:bundleRelease") }
    }
}

Write-Host "==> Building: $($tasks -join ' ')"
if ($Aab -or $Variant -ne "debug") {
    # Dedicated temp dir: Windows AV/indexers can corrupt Gradle ZipBuilder
    # temp files in %TEMP% and fail AAB packaging.
    $javaTmp = Join-Path $Root "build\tmp-java"
    New-Item -ItemType Directory -Force -Path $javaTmp | Out-Null
    # GRADLE_OPTS is word-split by gradlew.bat, so use the 8.3 short path when
    # the project lives under a directory with spaces (e.g. "0 DXN").
    try {
        $javaTmp = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($javaTmp).ShortPath
    } catch { }
    $env:GRADLE_OPTS = "$env:GRADLE_OPTS -Djava.io.tmpdir=$javaTmp"
}
Push-Location $Root
try {
    & (Join-Path $Root "gradlew.bat") @tasks @gradleArgs
    if ($LASTEXITCODE -ne 0) { throw "Gradle failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$dist = Join-Path $Root "..\..\dist\android"
New-Item -ItemType Directory -Force -Path $dist | Out-Null

function Copy-App([string]$App, [string]$Label) {
    if ($Variant -in @("debug", "both")) {
        $src = Join-Path $Root "$App\build\outputs\apk\debug\$App-debug.apk"
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $dist "dxn-$Label-$VersionName-$VersionCode-debug.apk") -Force
        }
    }
    if ($Variant -in @("release", "both")) {
        $src = Join-Path $Root "$App\build\outputs\apk\release\$App-release.apk"
        if (Test-Path $src) {
            Copy-Item $src (Join-Path $dist "dxn-$Label-$VersionName-$VersionCode.apk") -Force
        }
        if ($Aab) {
            $bundle = Join-Path $Root "$App\build\outputs\bundle\release\$App-release.aab"
            if (Test-Path $bundle) {
                Copy-Item $bundle (Join-Path $dist "dxn-$Label-$VersionName-$VersionCode.aab") -Force
            }
        }
    }
}

if ($owner) { Copy-App "owner-app" "owner" }
if ($client) { Copy-App "client-app" "client" }
if ($suite) { Copy-App "suite-app" "suite" }

Write-Host ""
Write-Host "==> Artifacts in $dist"
Get-ChildItem $dist | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    "{0,-58} {1,12}" -f $_.Name, $_.Length
    "  SHA256 $hash"
}
