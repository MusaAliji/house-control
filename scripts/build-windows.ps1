param([switch]$SkipInstall, [switch]$Unpacked)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $projectRoot 'web')
try {
    if (-not $SkipInstall) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'Web dependency installation failed' } }
} finally { Pop-Location }
Push-Location (Join-Path $projectRoot 'windows')
try {
    if (-not $SkipInstall) { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw 'Windows dependency installation failed' } }
    & node node_modules/electron/install.js
    if ($LASTEXITCODE -ne 0) { throw 'Electron runtime installation failed' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Windows tests failed' }
    if ($Unpacked) { & npm.cmd run pack } else { & npm.cmd run dist }
    if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed' }
    Write-Host "Windows app: $(Join-Path $projectRoot 'build\windows')"
} finally { Pop-Location }
