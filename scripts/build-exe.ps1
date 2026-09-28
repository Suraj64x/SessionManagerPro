$ErrorActionPreference = "Stop"

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}

if (-not (Test-Path $csc)) {
    Write-Error "Microsoft .NET Framework C# compiler (csc.exe) not found."
    exit 1
}

$rootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$sourceFile = Join-Path $rootDir "launcher\SessionManagerPro.cs"
$outputExe = Join-Path $rootDir "SessionManagerPro.exe"
$icon = Join-Path $rootDir "assets\SessionManagerPro.ico"
# Compiled beside the target first: a failed build must never leave a broken exe behind.
$tempExe = Join-Path $rootDir "SessionManagerPro.new.exe"

# A running copy locks the exe; overwriting would fail half-way.
$running = Get-Process -Name SessionManagerPro -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and ((Resolve-Path $_.Path).Path -eq $outputExe.ToString()) }
if ($running) {
    Write-Error "SessionManagerPro.exe is running (PID $($running.Id -join ', ')). Quit it from the tray first."
    exit 1
}

# The dashboard window is WebView2. The SDK comes from the local NuGet cache (nothing is
# downloaded); set WEBVIEW2_SDK to use another copy of the same package layout.
$sdk = if ($env:WEBVIEW2_SDK) { $env:WEBVIEW2_SDK } else { Join-Path $env:USERPROFILE ".nuget\packages\microsoft.web.webview2\1.0.2903.40" }
$wvCore = Join-Path $sdk "lib\net462\Microsoft.Web.WebView2.Core.dll"
$wvForms = Join-Path $sdk "lib\net462\Microsoft.Web.WebView2.WinForms.dll"
$wvLoader = Join-Path $sdk "runtimes\win-x64\native\WebView2Loader.dll"
foreach ($f in @($wvCore, $wvForms, $wvLoader)) {
    if (-not (Test-Path $f)) {
        Write-Error "WebView2 SDK file missing: $f (restore Microsoft.Web.WebView2 1.0.2903.40 or set WEBVIEW2_SDK)."
        exit 1
    }
}

Write-Host "Compiling native Windows launcher: $outputExe"
# The icon is both the exe's own (Explorer, taskbar) and an embedded resource for the tray.
& $csc /nologo /target:winexe /optimize+ /platform:anycpu /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.dll "/reference:$wvCore" "/reference:$wvForms" "/win32icon:$icon" "/resource:$icon,SessionManagerPro.ico" "/out:$tempExe" "$sourceFile"

# Judge by the compiler's exit code, not by a file that may be left from an earlier build.
if ($LASTEXITCODE -ne 0) {
    Remove-Item $tempExe -Force -ErrorAction SilentlyContinue
    Write-Error "Compilation failed."
    exit 1
}
Move-Item $tempExe $outputExe -Force
# The exe loads these from its own folder (the x64 loader: the launcher runs as a 64-bit process).
Copy-Item $wvCore, $wvForms, $wvLoader $rootDir -Force
$size = (Get-Item $outputExe).Length
Write-Host "SUCCESS: SessionManagerPro.exe built ($size bytes)" -ForegroundColor Green
