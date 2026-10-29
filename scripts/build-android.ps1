param(
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Debug',
    [switch]$SkipInstall,
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $projectRoot 'web')
try {
    if (-not $SkipInstall) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    }
} finally { Pop-Location }
Push-Location (Join-Path $projectRoot 'android')
try {
    & .\gradlew.bat "assemble$Configuration"
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed' }
    $variant = $Configuration.ToLowerInvariant()
    $apkName = if ($Configuration -eq 'Release') { 'app-release-unsigned.apk' } else { 'app-debug.apk' }
    $apkPath = Join-Path $PWD "app\build\outputs\apk\$variant\$apkName"
    Write-Host "APK: $apkPath"
    if ($Install) {
        if ($Configuration -eq 'Release') { throw 'Sign the release APK before installing. Use -Configuration Debug -Install for local testing.' }
        $adbPath = if ($env:ANDROID_HOME) { Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' } else { 'adb' }
        & $adbPath install -r $apkPath
        if ($LASTEXITCODE -ne 0) { throw 'adb install failed' }
    }
} finally { Pop-Location }
