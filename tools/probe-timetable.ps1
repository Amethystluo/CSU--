# Probe the .xls timetable geometry. ASCII-ONLY source (no Chinese literals) so that
# Windows PowerShell 5.1 cannot mangle it. Chinese matching uses \uXXXX escapes.
# Results are written as a UTF-8 report file for the caller to read.
param(
  [string]$Path = 'tools\_in\timetable.xls',
  [string]$Out = 'tools\_in\probe.txt'
)

$ErrorActionPreference = 'Stop'
$full = (Resolve-Path $Path).Path
$lines = New-Object System.Collections.Generic.List[string]

$cn = New-Object System.Data.OleDb.OleDbConnection("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$full;Extended Properties=""Excel 8.0;HDR=NO;IMEX=1"";")
$cn.Open()
$cmd = $cn.CreateCommand()

$cmd.CommandText = "SELECT COUNT(*) FROM [Sheet1`$]"
$lines.Add("Sheet1 rows = " + $cmd.ExecuteScalar())

# Full (untruncated) first rows, with column indices
$cmd.CommandText = "SELECT TOP 14 * FROM [Sheet1`$]"
$rd = $cmd.ExecuteReader()
$rowNo = 0
while ($rd.Read()) {
  $rowNo++
  $parts = @()
  for ($i = 0; $i -lt $rd.FieldCount; $i++) {
    if ($rd.IsDBNull($i)) { continue }
    $v = ([string]$rd.GetValue($i)).Trim()
    if ($v -ne '') { $parts += ("c{0}=[{1}]" -f $i, $v) }
  }
  $lines.Add("ROW $rowNo nonEmpty=$($parts.Count)")
  foreach ($p in $parts) { $lines.Add("    " + $p) }
}
$rd.Close()

# Locate class-title rows and weekday header rows
$cmd.CommandText = "SELECT * FROM [Sheet1`$]"
$rd = $cmd.ExecuteReader()
$titles = New-Object System.Collections.Generic.List[object]
$weekdayRows = New-Object System.Collections.Generic.List[object]
$n = 0
while ($rd.Read()) {
  $n++
  for ($i = 0; $i -lt [Math]::Min($rd.FieldCount, 30); $i++) {
    if ($rd.IsDBNull($i)) { continue }
    $v = ([string]$rd.GetValue($i)).Trim()
    if ($v -eq '') { continue }
    if ($v -match '\u73ed\u7ea7\u8bfe\u8868') {
      $titles.Add([pscustomobject]@{ Row = $n; Col = $i; Text = $v })
      break
    }
    if ($v -match '\u661f\u671f\u4e00') {
      $weekdayRows.Add([pscustomobject]@{ Row = $n; Col = $i; Text = $v })
      break
    }
  }
  if ($n -ge 40000) { break }
}
$rd.Close()
$cn.Close()

$lines.Add("scanned rows = $n")
$lines.Add("class title rows = " + $titles.Count)
$lines.Add("weekday-header rows = " + $weekdayRows.Count)
foreach ($t in ($titles | Select-Object -First 6)) { $lines.Add("  TITLE row=$($t.Row) col=$($t.Col) text=[$($t.Text)]") }
foreach ($t in ($weekdayRows | Select-Object -First 6)) { $lines.Add("  WEEKROW row=$($t.Row) col=$($t.Col) text=[$($t.Text)]") }
if ($titles.Count -gt 1) {
  $d = @()
  for ($k = 1; $k -lt [Math]::Min($titles.Count, 40); $k++) { $d += ($titles[$k].Row - $titles[$k-1].Row) }
  $lines.Add("title row gaps = " + ($d -join ','))
}

$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $Out), ($lines -join "`r`n"), $enc)
Write-Output ("wrote " + $Out)
