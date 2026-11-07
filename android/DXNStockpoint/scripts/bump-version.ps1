<#
.SYNOPSIS
Bumps the shared version for both apps.

.EXAMPLE
.\scripts\bump-version.ps1
.\scripts\bump-version.ps1 -VersionName 3.2.0
#>
param(
    [string]$VersionName
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$File = Join-Path $Root "gradle.properties"
if (-not (Test-Path $File)) { throw "Missing $File" }

$lines = Get-Content $File
$codeLine = $lines | Where-Object { $_ -match '^dxn\.versionCode=' } | Select-Object -First 1
$nameLine = $lines | Where-Object { $_ -match '^dxn\.versionName=' } | Select-Object -First 1
$code = [int]($codeLine -replace '^dxn\.versionCode=', '')
$name = ($nameLine -replace '^dxn\.versionName=', '').Trim()

if (-not $VersionName) {
    $parts = $name.Split(".")
    while ($parts.Count -lt 3) { $parts += "0" }
    $parts[2] = [string]([int]$parts[2] + 1)
    $VersionName = $parts -join "."
}

$newLines = $lines | ForEach-Object {
    if ($_ -match '^dxn\.versionCode=') { "dxn.versionCode=$($code + 1)" }
    elseif ($_ -match '^dxn\.versionName=') { "dxn.versionName=$VersionName" }
    else { $_ }
}
Set-Content -Path $File -Value $newLines -Encoding UTF8

Write-Host "Version: $name ($code) -> $VersionName ($($code + 1))"
