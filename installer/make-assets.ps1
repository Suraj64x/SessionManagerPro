# Draws the wizard images from the shapes in assets/logo.svg: the large side panel at every
# DPI size Inno Setup picks from (100% .. 264%) and the small corner face. Output: PNGs beside
# this script, listed by wildcard in SessionManagerPro.iss. Re-run after changing the logo.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$out = $PSScriptRoot
$green = [System.Drawing.ColorTranslator]::FromHtml("#34d399")
$ink = [System.Drawing.ColorTranslator]::FromHtml("#1c1a24")
$top = [System.Drawing.ColorTranslator]::FromHtml("#111216")
$bottom = [System.Drawing.ColorTranslator]::FromHtml("#0a3a2b")   # deep emerald

# SVG quadratic (p0, q, p2) as the cubic GDI+ draws.
function Add-Quad($path, [float]$x0, [float]$y0, [float]$qx, [float]$qy, [float]$x2, [float]$y2) {
    $path.AddBezier($x0, $y0, ($x0 + 2 * ($qx - $x0) / 3), ($y0 + 2 * ($qy - $y0) / 3),
        ($x2 + 2 * ($qx - $x2) / 3), ($y2 + 2 * ($qy - $y2) / 3), $x2, $y2)
}

# The logo in its own 36x36 units, drawn at (x, y) with diameter d.
function Draw-Face($g, [float]$x, [float]$y, [float]$d) {
    $state = $g.Save()
    $g.TranslateTransform($x, $y)
    $g.ScaleTransform($d / 36, $d / 36)
    $b = New-Object System.Drawing.SolidBrush $green
    $g.FillEllipse($b, 0, 0, 36, 36)
    # transform="translate(0 1) rotate(-6 18 18)"
    $g.TranslateTransform(0, 1)
    $g.TranslateTransform(18, 18); $g.RotateTransform(-6); $g.TranslateTransform(-18, -18)
    $pen = New-Object System.Drawing.Pen $ink, 1.8
    $pen.StartCap = $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    foreach ($ox in 10.8, 20.8) {
        $brow = New-Object System.Drawing.Drawing2D.GraphicsPath
        Add-Quad $brow $ox 16.2 ($ox + 2.2) 13 ($ox + 4.4) 16.2
        $g.DrawPath($pen, $brow)
    }
    # M12.6 20.6 h10.8 q-.6 6.2 -5.4 6.2 t-5.4 -6.2 z
    $mouth = New-Object System.Drawing.Drawing2D.GraphicsPath
    $mouth.AddLine(12.6, 20.6, 23.4, 20.6)
    Add-Quad $mouth 23.4 20.6 22.8 26.8 18 26.8
    Add-Quad $mouth 18 26.8 13.2 26.8 12.6 20.6
    $mouth.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush $ink), $mouth)
    $g.Restore($state)
}

function New-Canvas([int]$w, [int]$h) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    return $bmp, $g
}

Get-ChildItem $out -Filter "Wizard*.png" | Remove-Item -Force

# Large panel: 164x314 at 100% in Inno's units; these are the sizes it chooses between.
$large = @(@(202, 386), @(269, 515), @(336, 643), @(403, 772), @(430, 824), @(498, 953), @(534, 1022))
foreach ($s in $large) {
    $w, $h = $s
    $bmp, $g = New-Canvas $w $h
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $top, $bottom, 90.0
    $blend = New-Object System.Drawing.Drawing2D.Blend
    $blend.Positions = [float[]](0, 0.45, 1)
    $blend.Factors = [float[]](0, 0.15, 1)
    $grad.Blend = $blend
    $g.FillRectangle($grad, $rect)

    $d = [float]($w * 0.42)
    $cy = [float]($h * 0.36)
    Draw-Face $g (($w - $d) / 2) ($cy - $d / 2) $d

    # The wordmark at the largest size that fits 84% of the width.
    $size = [float]($w * 0.1)
    do {
        $font = New-Object System.Drawing.Font "Segoe UI Semibold", $size, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
        $m = $g.MeasureString("SessionManagerPro", $font)
        $size -= 0.5
    } while ($m.Width -gt $w * 0.84)
    $tx = ($w - $m.Width) / 2
    $ty = $cy + $d / 2 + $h * 0.06
    $g.DrawString("SessionManagerPro", $font, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(240, 244, 246, 248))), $tx, $ty)

    $bmp.Save((Join-Path $out ("WizardImage-{0}x{1}.png" -f $w, $h)), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

# Small face, transparent, so it sits on the light and the dark wizard alike.
foreach ($n in 58, 77, 97, 116, 124, 143, 159) {
    $bmp, $g = New-Canvas $n $n
    $pad = [float]($n * 0.06)
    Draw-Face $g $pad $pad ([float]($n - 2 * $pad))
    $bmp.Save((Join-Path $out ("WizardSmallImage-{0}.png" -f $n)), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

Get-ChildItem $out -Filter "Wizard*.png" | ForEach-Object { "{0,-32} {1,7:N0} bytes" -f $_.Name, $_.Length }
