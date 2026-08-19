$ErrorActionPreference = 'Stop'

$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Refract\uninstall.exe'),
  (Join-Path $env:ProgramFiles 'Refract\uninstall.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Refract\uninstall.exe')
)

$uninstaller = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $uninstaller) {
  Write-Warning 'Refract uninstaller was not found in the standard NSIS install locations.'
  return
}

$process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) {
  throw "Refract uninstaller exited with code $($process.ExitCode)."
}
