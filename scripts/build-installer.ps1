# Builds release\SessionManagerPro-Setup-<version>.exe: the UI, the launcher, the stage, then
# Inno Setup. Nothing is downloaded; see scripts/stage.ps1 for what the stage holds.
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$iscc = @(
    $env:ISCC,
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw "ISCC.exe not found: install Inno Setup 6.6 or newer, or set ISCC to its path." }

$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
Write-Host "SessionManagerPro $version"

Push-Location $root
try {
    & npm run build:ui
    if ($LASTEXITCODE -ne 0) { throw "npm run build:ui failed ($LASTEXITCODE)" }
    & npm run build:exe
    if ($LASTEXITCODE -ne 0) { throw "npm run build:exe failed ($LASTEXITCODE)" }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "stage.ps1")
    if ($LASTEXITCODE -ne 0) { throw "stage.ps1 failed ($LASTEXITCODE)" }

    # The wizard images are committed; draw them only when missing.
    if (-not (Get-ChildItem (Join-Path $root "installer") -Filter "WizardImage-*.png" -ErrorAction SilentlyContinue)) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "installer\make-assets.ps1")
        if ($LASTEXITCODE -ne 0) { throw "make-assets.ps1 failed ($LASTEXITCODE)" }
    }

    & $iscc /Q "/DAppVersion=$version" (Join-Path $root "installer\SessionManagerPro.iss")
    if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }
} finally { Pop-Location }

$setup = Get-Item (Join-Path $root "release\SessionManagerPro-Setup-$version.exe")
Write-Host ("{0}  {1:N1} MB" -f $setup.FullName, ($setup.Length / 1MB)) -ForegroundColor Green
