# A Stealth Firefox thread's taskbar icon: the Firefox silhouette (icons/firefox-glyph.png, black
# with alpha), its inside filled white, the thread number in bold on it. Writes a multi-size .ico
# (PNG entries, Vista+). On a dark taskbar the silhouette gets a thin light halo, or black on
# near-black would vanish. Called by thread_icons.js; -Preview writes one PNG instead.
#   powershell -NoProfile -ExecutionPolicy Bypass -File thread_icon.ps1 -Number 3 -Out C:\x\t3.ico [-Dark] [-Preview 256]
param(
  [Parameter(Mandatory)][int]$Number,
  [Parameter(Mandatory)][string]$Out,
  [switch]$Dark,
  [int]$Preview = 0
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$glyph = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot "icons\firefox-glyph.png"))

# The white inside, in the glyph's 512-px space: the largest empty circle in the silhouette is at
# (261,305) r73; this one is drawn over the silhouette, and a little larger, so the number is
# legible at taskbar size (24-32 px). The ring and the flame keep it recognisable.
$DiscX, $DiscY, $DiscR = 262.0, 304.0, 118.0

function Render([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"; $g.InterpolationMode = "HighQualityBicubic"; $g.PixelOffsetMode = "HighQuality"
  $g.TextRenderingHint = "AntiAliasGridFit"
  $k = $s / 512.0
  $r = $DiscR * $k
  # Halo for dark taskbars: the silhouette in white, a little larger, under the black one.
  if ($Dark) {
    $ia = New-Object System.Drawing.Imaging.ImageAttributes
    $cm = New-Object System.Drawing.Imaging.ColorMatrix
    $cm.Matrix00 = 0; $cm.Matrix11 = 0; $cm.Matrix22 = 0; $cm.Matrix40 = 0.92; $cm.Matrix41 = 0.92; $cm.Matrix42 = 0.92
    $ia.SetColorMatrix($cm)
    $d = [Math]::Max(1.0, $s / 48.0)
    foreach ($o in @(@(-$d, 0), @($d, 0), @(0, -$d), @(0, $d))) {
      $g.DrawImage($glyph, (New-Object System.Drawing.Rectangle ([int]$o[0]), ([int]$o[1]), $s, $s), 0, 0, 512, 512, "Pixel", $ia)
    }
  }
  $g.DrawImage($glyph, 0, 0, $s, $s)
  # White inside, over the silhouette: the number always sits on clean white, whatever its width.
  $g.FillEllipse([System.Drawing.Brushes]::White, [single]($DiscX * $k - $r), [single]($DiscY * $k - $r), [single](2 * $r), [single](2 * $r))
  # The number, centred on the inside; smaller as it gets longer.
  $text = [string]$Number
  $h = $r * 2 * @(0, 0.98, 0.76, 0.56)[[Math]::Min(3, $text.Length)]
  # The heaviest face installed: the number is what tells the buttons apart at 24 px.
  $family, $style = "Segoe UI", [System.Drawing.FontStyle]::Bold
  try { [void](New-Object System.Drawing.FontFamily "Segoe UI Black"); $family, $style = "Segoe UI Black", [System.Drawing.FontStyle]::Regular } catch {}
  $font = New-Object System.Drawing.Font $family, ([single]$h), $style, ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = "Center"; $fmt.LineAlignment = "Center"
  $box = New-Object System.Drawing.RectangleF ([single]($DiscX * $k - $r * 1.5)), ([single]($DiscY * $k - $r * 1.5 + $h * 0.04)), ([single](3 * $r)), ([single](3 * $r))
  $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 17, 17, 17))
  $g.DrawString($text, $font, $ink, $box, $fmt)
  $g.Dispose()
  return $bmp
}

if ($Preview) {
  $b = Render $Preview
  $b.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  exit 0
}

# .ico: ICONDIR, one ICONDIRENTRY per size, then the images. 256 px as PNG, the rest as 32-bit
# DIBs (bottom-up BGRA plus an empty AND mask), which every icon reader understands; GDI+ and
# some shell paths misread small PNG entries.
function Dib([System.Drawing.Bitmap]$b) {
  $s = $b.Width
  $lock = $b.LockBits((New-Object System.Drawing.Rectangle 0, 0, $s, $s), "ReadOnly", ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
  $px = New-Object byte[] ($lock.Stride * $s)
  [System.Runtime.InteropServices.Marshal]::Copy($lock.Scan0, $px, 0, $px.Length)
  $b.UnlockBits($lock)
  $maskRow = [int]([Math]::Ceiling($s / 32.0) * 4)
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter $ms
  $bw.Write([uint32]40); $bw.Write([int32]$s); $bw.Write([int32]($s * 2)); $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]0); $bw.Write([uint32]($s * $s * 4 + $maskRow * $s)); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
  for ($y = $s - 1; $y -ge 0; $y--) { $bw.Write($px, $y * $lock.Stride, $s * 4) }
  $bw.Write((New-Object byte[] ($maskRow * $s)))
  $bw.Flush()
  return , $ms.ToArray()
}
$sizes = 16, 20, 24, 32, 40, 48, 64, 256
$pngs = foreach ($s in $sizes) {
  if ($s -ge 256) {
    $ms = New-Object System.IO.MemoryStream
    (Render $s).Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    , $ms.ToArray()
  } else {
    , (Dib (Render $s))
  }
}
$tmp = "$Out.$PID.tmp"
$fs = [System.IO.File]::Create($tmp)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Close()
Move-Item -Force $tmp $Out
