# Import the .xls timetable into a flat UTF-8 CSV of cells.
#
# ASCII-ONLY source, including comments: Windows PowerShell 5.1 reads a BOM-less .ps1
# as ANSI/GBK, so any raw Chinese byte pair can corrupt the tokenizer. Every Chinese
# literal is written as a \uXXXX escape and the output file is written as UTF-8.
#
# Sheet1 layout (verified with probe.ps1): 1435 class blocks x 10 rows each
#   rel 0    : "ZhongNanDaXue <class> ban-ji-ke-biao"
#   rel 1    : "xue-nian-xue-qi:... ban-ji-ren-shu:NN"
#   rel 2    : c1..c5 = Monday..Friday
#   rel 3..8 : c0 = period label (1-2 ... 11-12), c1..c5 = cell text
#   rel 9    : "bei-zhu: ..."
#
# Output columns: class,classSize,weekday,period,cell   (newlines collapsed, CSV quoted)
param(
  [string]$Path = 'tools\_in\timetable.xls',
  [string]$Out  = 'tools\_in\timetable-cells.csv'
)

$ErrorActionPreference = 'Stop'
$full = (Resolve-Path $Path).Path

# --- regex building blocks (all escapes, no raw CJK) ---------------------------------
$U_TITLE   = '\u73ed\u7ea7\u8bfe\u8868'                        # class + timetable
$U_MON     = '\u661f\u671f\u4e00'                              # Monday
$U_TUE     = '^\u661f\u671f\u4e8c$'
$U_WED     = '^\u661f\u671f\u4e09$'
$U_THU     = '^\u661f\u671f\u56db$'
$U_FRI     = '^\u661f\u671f\u4e94$'
$U_CLASSES = '\u73ed\u7ea7\u4eba\u6570\s*[:\uFF1A]\s*(\d+)'    # class size: NN
# -replace / -match take a comma argument list, so a concatenated pattern must be
# materialised into a variable first; an inline 'a' + $b, '' fails to parse.
$RE_TITLE_TAIL = '\s*' + $U_TITLE + '\s*$'
$RE_MON_EXACT  = '^' + $U_MON + '$'
$RE_PERIOD     = '^(\d{1,2})\s*[\uFF0D\u2013\u2014\-]\s*(\d{1,2})$'
$RE_WS         = '[\r\n\t]+'
$RE_LEAD_WORD  = '^\s*\S+\s+'

function Q([string]$s) { '"' + ($s -replace '"', '""') + '"' }

$cn = New-Object System.Data.OleDb.OleDbConnection("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$full;Extended Properties=""Excel 8.0;HDR=NO;IMEX=1"";")
$cn.Open()
$cmd = $cn.CreateCommand()
$cmd.CommandText = 'SELECT * FROM [Sheet1$]'
$rd = $cmd.ExecuteReader()

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('class,classSize,weekday,period,cell')

$stats = [ordered]@{ blocks = 0; rows = 0; cells = 0; classes = 0; withSize = 0; periodsUnknown = 0 }
$unknownPeriods = New-Object System.Collections.Generic.List[string]

function Flush-Block($rows) {
  if ($rows.Count -lt 9) { return }
  $cls = $null; $size = $null; $weekdayMap = $null
  foreach ($r in $rows) {
    if (-not $cls -and $r[0] -match $U_TITLE) {
      $t = $r[0] -replace $RE_TITLE_TAIL, ''
      $t = $t -replace $RE_LEAD_WORD, ''
      $cls = $t.Trim()
    }
    if ($null -eq $size) {
      foreach ($c in $r) { if ($c -match $U_CLASSES) { $size = $Matches[1]; break } }
    }
    if (-not $weekdayMap) {
      $m = @{}
      for ($i = 0; $i -lt $r.Count; $i++) {
        if     ($r[$i] -match $RE_MON_EXACT) { $m[$i] = 1 }
        elseif ($r[$i] -match $U_TUE)        { $m[$i] = 2 }
        elseif ($r[$i] -match $U_WED)        { $m[$i] = 3 }
        elseif ($r[$i] -match $U_THU)        { $m[$i] = 4 }
        elseif ($r[$i] -match $U_FRI)        { $m[$i] = 5 }
      }
      if ($m.Count -ge 5) { $weekdayMap = $m }
    }
  }
  if (-not $cls -or -not $weekdayMap) { return }
  $script:stats.classes++
  if ($size) { $script:stats.withSize++ }

  foreach ($r in $rows) {
    $p = $r[0]
    if ($p -notmatch $RE_PERIOD) { continue }
    $pStart = [int]$Matches[1]
    $pEnd = [int]$Matches[2]
    if ($pStart -gt 12 -or $pEnd -gt 12 -or $pStart -gt $pEnd) { continue }
    $touched = $false
    foreach ($col in $weekdayMap.Keys) {
      if ($col -ge $r.Count) { continue }
      $cell = $r[$col]
      if (-not $cell) { continue }
      $touched = $true
      $wd = $weekdayMap[$col]
      [void]$sb.AppendLine((Q $cls) + ',' + (Q ([string]$size)) + ',' + $wd + ',' + $pStart + '-' + $pEnd + ',' + (Q $cell))
      $script:stats.cells++
    }
    # Only count an out-of-range period when the row is actually used.
    if ($touched -and $pStart -gt 10) {
      $script:stats.periodsUnknown++
      if ($unknownPeriods.Count -lt 5) { $unknownPeriods.Add($cls + ' ' + $p) }
    }
  }
}

$block = @()
while ($rd.Read()) {
  $row = @()
  for ($i = 0; $i -lt $rd.FieldCount; $i++) {
    $v = ''
    if (-not $rd.IsDBNull($i)) {
      $v = [string]$rd.GetValue($i)
      $v = $v -replace $RE_WS, ' '
    }
    $row += $v.Trim()
  }
  $stats.rows++
  if ($row[0] -match $U_TITLE) {
    if ($block.Count) { Flush-Block $block }
    $block = @()
    $stats.blocks++
  }
  if ($block.Count -lt 10) { $block += , $row }
}
if ($block.Count) { Flush-Block $block }
$rd.Close()
$cn.Close()

$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $Out), $sb.ToString(), $enc)

$report = New-Object System.Collections.Generic.List[string]
$report.Add('source rows read   = ' + $stats.rows)
$report.Add('class blocks       = ' + $stats.blocks)
$report.Add('classes parsed     = ' + $stats.classes)
$report.Add('classes with size  = ' + $stats.withSize)
$report.Add('non-empty cells    = ' + $stats.cells)
$report.Add('periods > 10       = ' + $stats.periodsUnknown)
foreach ($u in $unknownPeriods) { $report.Add('    ' + $u) }
$report.Add('csv                = ' + $Out)
[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'tools\_in\import.txt'), ($report -join "`r`n"), $enc)
Write-Output ('cells written to ' + $Out)
