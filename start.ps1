$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodePath = (Get-Command node.exe).Source
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.json'))) {
  & $nodePath (Join-Path $PSScriptRoot 'setup.cjs')
  if ($LASTEXITCODE -ne 0) {
    Read-Host '请确认 DeepSeek Harness 已启动，然后按回车关闭'
    exit 1
  }
}
try {
  $null = Invoke-WebRequest -Uri 'http://127.0.0.1:18741/state' -TimeoutSec 2 -ErrorAction Stop
} catch {
  if (-not $_.Exception.Response) {
    $null = Start-Process -FilePath $nodePath -ArgumentList @(('"' + (Join-Path $PSScriptRoot 'room.cjs') + '"'), 'serve') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 1200
  }
}
& $nodePath (Join-Path $PSScriptRoot 'room.cjs') open
