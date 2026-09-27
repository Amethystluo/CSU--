# Compile every WXML / WXSS with the OFFICIAL compilers shipped with WeChat DevTools.
#
#   powershell -File tools\check-wxml-compile.ps1
#
# Why: template/style errors (unclosed tag, wx:elif without wx:if, bad WXSS) never show up in the
# JS test suite -- only DevTools reports them. The compilers are standalone exe files, so we can
# call them directly:
#   <DevTools>\resources\app.asar.unpacked\node_modules\wcc-exec\wcc.exe    (WXML)
#   <DevTools>\resources\app.asar.unpacked\node_modules\wcc-exec\wcsc.exe   (WXSS)
# NOTE: run this from PowerShell, not from Node -- spawning the compiler from Node and capturing
# its output needs a pipe, which restricted environments deny (EPERM).
#
# ASCII-ONLY source on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI/GBK.
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Join-Path (Split-Path -Parent $here) 'miniprogram'
if (-not (Test-Path (Join-Path $root 'app.json'))) {
  $root = Join-Path (Split-Path -Parent $here) 'miniprogram\miniprogram'
}
if (-not (Test-Path (Join-Path $root 'app.json'))) {
  Write-Output 'SKIP: cannot locate mini program root (needs app.json)'
  exit 0
}

$dirs = @()
if ($env:WECHAT_DEVTOOLS_DIR) { $dirs += $env:WECHAT_DEVTOOLS_DIR }
$dirs += 'D:\' + [char]0x5FAE + [char]0x4FE1 + 'web' + [char]0x5F00 + [char]0x53D1 + [char]0x8005 + [char]0x5DE5 + [char]0x5177
$dirs += (Join-Path ${env:ProgramFiles(x86)} 'Tencent\' )
$dirs += (Join-Path $env:ProgramFiles 'Tencent\' )

$wcc = $null
$wcsc = $null
foreach ($d in $dirs) {
  if (-not $d) { continue }
  $base = Join-Path $d 'resources\app.asar.unpacked\node_modules\wcc-exec'
  if ((-not $wcc) -and (Test-Path (Join-Path $base 'wcc.exe'))) { $wcc = Join-Path $base 'wcc.exe' }
  if ((-not $wcsc) -and (Test-Path (Join-Path $base 'wcsc.exe'))) { $wcsc = Join-Path $base 'wcsc.exe' }
}
if ((-not $wcc) -or (-not $wcsc)) {
  Write-Output 'SKIP: wcc.exe / wcsc.exe not found.'
  Write-Output '      Set WECHAT_DEVTOOLS_DIR to the DevTools install dir to enable this check.'
  exit 0
}

# Keep the scratch dir INSIDE the workspace: writing to %TEMP% is outside the sandbox and gets denied.
$tmp = Join-Path $here '_out'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp | Out-Null

$pass = 0
$fail = 0

function Compile-Set($exe, $files, $label, $outExt) {
  Write-Output ''
  Write-Output ("=== " + $label + " ===")
  $i = 0
  foreach ($f in $files) {
    $i++
    $out = Join-Path $script:tmp ($label + '-' + $i + $outExt)
    $rel = $f.Substring($script:root.Length + 1)
    # Use the call operator and PowerShell's own pipeline. Start-Process -RedirectStandard* is
    # denied in restricted environments, and capturing a child's output through a pipe from Node
    # is denied too -- PowerShell pipelines are the one path that works.
    $msg = & $exe -o $out $f 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 0) {
      $script:pass++
      Write-Output ("  OK   " + $rel)
    } else {
      $script:fail++
      Write-Output ("  FAIL " + $rel + "  (exit " + $code + ")")
      $msg | Where-Object { $_ -and ($_ -notmatch '^\s*at ') } | Select-Object -First 4 | ForEach-Object {
        Write-Output ("       " + ([string]$_).Trim())
      }
    }
  }
}

$wxml = Get-ChildItem -Path (Join-Path $root 'pages') -Recurse -Filter *.wxml | ForEach-Object { $_.FullName }
$wxss = Get-ChildItem -Path $root -Recurse -Filter *.wxss | ForEach-Object { $_.FullName }

Compile-Set $wcc $wxml 'WXML' '.js'
Compile-Set $wcsc $wxss 'WXSS' '.wxss'

Write-Output ''
Write-Output ("========== compiled OK " + $pass + " / failed " + $fail + " ==========")
Write-Output 'Uses the same official compilers as WeChat DevTools itself.'
if ($fail -gt 0) { exit 1 }
exit 0
