# Assembles build\stage: exactly what the installer ships, with its own Node and Python.
# Nothing is downloaded: the runtimes come from this machine (the Python behind .venv and
# the node.exe on PATH). User data, the engine and developer files never land here.
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$stage = Join-Path $root "build\stage"

# robocopy exit codes 0-7 are success (8+ is a failure).
function Copy-Tree([string]$from, [string]$to, [string[]]$extra = @()) {
    & robocopy $from $to /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 @extra | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $from -> $to" }
    $global:LASTEXITCODE = 0
}
function Copy-Files([string]$from, [string]$to, [string[]]$files) {
    & robocopy $from $to @files /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $from -> $to" }
    $global:LASTEXITCODE = 0
}
function Get-Size([string]$path) {
    $sum = (Get-ChildItem $path -Recurse -File -Force | Measure-Object Length -Sum).Sum
    "{0,8:N1} MB" -f ($sum / 1MB)
}

# --- preconditions --------------------------------------------------------------------
$dist = Join-Path $root "frontend\dist\index.html"
if (-not (Test-Path $dist)) { throw "frontend\dist is missing: run npm run build:ui first." }
$exe = Join-Path $root "SessionManagerPro.exe"
if (-not (Test-Path $exe)) { throw "SessionManagerPro.exe is missing: run npm run build:exe first." }
# The dashboard window (WebView2); build-exe.ps1 puts them beside the exe.
$webview2 = @("Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll")
foreach ($f in $webview2) {
    if (-not (Test-Path (Join-Path $root $f))) { throw "$f is missing: run npm run build:exe first." }
}

$venv = Join-Path $root ".venv"
$cfg = Join-Path $venv "pyvenv.cfg"
if (-not (Test-Path $cfg)) { throw ".venv is missing: create it and pip install -r requirements.txt." }
# The venv is not relocatable; its base install is the runtime we copy.
$pyHome = ((Get-Content $cfg | Where-Object { $_ -match '^\s*home\s*=' }) -replace '^\s*home\s*=\s*', '').Trim()
$pyVer = ((Get-Content $cfg | Where-Object { $_ -match '^\s*version\s*=' }) -replace '^\s*version\s*=\s*', '').Trim()
if (-not (Test-Path (Join-Path $pyHome "python311.dll"))) { throw "Expected CPython 3.11 at $pyHome (pyvenv.cfg home)." }

# The real binary, not whatever is first on PATH: Scoop, Chocolatey and Volta put small shims there.
$node = (& (Get-Command node -ErrorAction Stop).Source -p "process.execPath").Trim()
if ((Get-Item $node).Length -lt 20MB) { throw "$node is not a full Node.js binary (a shim?); set PATH to a real Node install." }
$nodeDir = Split-Path (Get-Item $node).FullName
$nodeVer = & $node -p "process.version + ' ' + process.arch"

Write-Host "Staging into $stage"
Write-Host "  Python $pyVer from $pyHome"
Write-Host "  Node $nodeVer from $node"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

# --- app --------------------------------------------------------------------------------
Copy-Files $root $stage (@("SessionManagerPro.exe", "package.json") + $webview2)
Copy-Files (Join-Path $root "assets") (Join-Path $stage "assets") @("SessionManagerPro.ico")
Copy-Tree (Join-Path $root "frontend\dist") (Join-Path $stage "frontend\dist")
Copy-Tree (Join-Path $root "backend\src") (Join-Path $stage "backend\src") @("/XD", "__pycache__", "/XF", "*.pyc", "*.tmp")
Copy-Files (Join-Path $root "backend") (Join-Path $stage "backend") @("package.json", "package-lock.json")

# Production dependencies only, from the local tree: prune works offline, npm ci would not.
Write-Host "Pruning backend\node_modules to production dependencies"
Copy-Tree (Join-Path $root "backend\node_modules") (Join-Path $stage "backend\node_modules")
Push-Location (Join-Path $stage "backend")
try {
    & npm prune --omit=dev --offline --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm prune failed ($LASTEXITCODE)" }
} finally { Pop-Location }
Remove-Item (Join-Path $stage "backend\package-lock.json") -Force -ErrorAction SilentlyContinue

# --- runtime\node ---------------------------------------------------------------------------
$rtNode = Join-Path $stage "runtime\node"
Copy-Files $nodeDir $rtNode @("node.exe", "LICENSE")

# --- runtime\python -------------------------------------------------------------------------
$rtPy = Join-Path $stage "runtime\python"
Copy-Files $pyHome $rtPy @("python.exe", "pythonw.exe", "python3.dll", "python311.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt")
Copy-Tree (Join-Path $pyHome "DLLs") (Join-Path $rtPy "DLLs") @(
    "/XF", "_tkinter.pyd", "tcl86t.dll", "tk86t.dll", "_test*.pyd", "_ctypes_test.pyd", "_msi.pyd", "winsound.pyd", "*.ico")
$lib = Join-Path $pyHome "Lib"
Copy-Tree $lib (Join-Path $rtPy "Lib") @(
    "/XD", "__pycache__",
    (Join-Path $lib "site-packages"), (Join-Path $lib "test"), (Join-Path $lib "idlelib"), (Join-Path $lib "tkinter"),
    (Join-Path $lib "turtledemo"), (Join-Path $lib "ensurepip"), (Join-Path $lib "lib2to3"), (Join-Path $lib "pydoc_data"),
    (Join-Path $lib "venv"), (Join-Path $lib "distutils"),
    "/XF", "turtle.py")
# The venv's packages, never the global site-packages. Every other *.dist-info stays:
# invisible_playwright checks its dependencies' metadata at import.
$site = Join-Path $venv "Lib\site-packages"
Copy-Tree $site (Join-Path $rtPy "Lib\site-packages") @(
    "/XD", "__pycache__",
    (Join-Path $site "pip"), (Join-Path $site "setuptools"), (Join-Path $site "pkg_resources"),
    (Join-Path $site "_distutils_hack"), (Join-Path $site "greenlet\tests"),
    (Get-ChildItem $site -Directory -Filter "pip-*.dist-info").FullName,
    (Get-ChildItem $site -Directory -Filter "setuptools-*.dist-info").FullName,
    "/XF", "distutils-precedence.pth")

Write-Host "Compiling Python bytecode"
$py = Join-Path $rtPy "python.exe"
& $py -I -m compileall -q -j 0 (Join-Path $rtPy "Lib") | Out-Null
if ($LASTEXITCODE -ne 0) { throw "compileall failed ($LASTEXITCODE)" }

# The runtime must import the engine on its own, with no trace of the venv.
& $py -I -c "import invisible_playwright, invisible_core, nodriver; print('  engine import ok')"
if ($LASTEXITCODE -ne 0) { throw "the staged Python cannot import the engine" }

# --- sizes --------------------------------------------------------------------------------
Write-Host ""
Write-Host "Staged:"
foreach ($part in @("runtime\python", "runtime\node", "backend\node_modules", "backend\src", "frontend\dist")) {
    Write-Host ("  {0} {1}" -f (Get-Size (Join-Path $stage $part)), $part)
}
Write-Host ("  {0} total  ({1})" -f (Get-Size $stage), $stage)
