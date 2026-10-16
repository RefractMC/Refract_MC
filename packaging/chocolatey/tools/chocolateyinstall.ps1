$ErrorActionPreference = 'Stop'

# Tauri's generated Windows bundle is an NSIS installer; /S is NSIS's
# documented silent-install switch. Keep this aligned with tauri-action output.
$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/RefractMC/Refract_MC/releases/download/v1.5.0/Refract-Windows-x64.exe'
  checksum64     = 'c814c53d98e5fe037801373c7c4d8d695857621b574ff6e7dda9e81ba9da3080'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
