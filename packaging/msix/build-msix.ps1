[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Publisher,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$CertificatePath,
  [string]$CertificatePassword,
  [string]$RepositoryRoot = (Join-Path $PSScriptRoot '../..')
)

$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
  throw "MSIX version must be four numeric components, for example 1.3.4.0."
}
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Tauri executable was not found: $Executable"
}
if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
  throw "MSIX signing certificate was not found: $CertificatePath"
}

$makeAppx = Get-Command makeappx.exe -ErrorAction SilentlyContinue
$signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
if (-not $makeAppx) { throw 'Windows SDK makeappx.exe is required.' }
if (-not $signtool) { throw 'Windows SDK signtool.exe is required.' }

$manifestTemplate = Join-Path $PSScriptRoot 'AppxManifest.xml'
$stage = Join-Path ([IO.Path]::GetTempPath()) ("refract-msix-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $stage | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'Assets') | Out-Null
try {
  $manifest = Get-Content -LiteralPath $manifestTemplate -Raw
  $manifest = $manifest.Replace('__PUBLISHER__', $Publisher).Replace('__VERSION__', $Version)
  [IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $manifest, (New-Object Text.UTF8Encoding($false)))

  Copy-Item -LiteralPath $Executable -Destination (Join-Path $stage 'Refract.exe')
  foreach ($asset in @('StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png')) {
    $source = Join-Path $RepositoryRoot ("apps/tauri/src-tauri/icons/$asset")
    if (-not (Test-Path -LiteralPath $source)) { throw "MSIX logo asset missing: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stage "Assets/$asset")
  }

  $output = [IO.Path]::GetFullPath($OutputPath)
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($output)) | Out-Null
  if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
  & $makeAppx.Source pack /d $stage /p $output /o
  if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE." }

  $signArgs = @('sign', '/fd', 'SHA256', '/f', $CertificatePath)
  if ($CertificatePassword) { $signArgs += @('/p', $CertificatePassword) }
  $signArgs += $output
  & $signtool.Source @signArgs
  if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE." }

  & $signtool.Source verify /pa /all /v $output
  if ($LASTEXITCODE -ne 0) { throw "signtool verification failed with exit code $LASTEXITCODE." }
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
