$ErrorActionPreference = 'Stop'

# Tauri's generated Windows bundle is an NSIS installer; /S is NSIS's
# documented silent-install switch. Keep this aligned with tauri-action output.
$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/RefractMC/Refract_MC/releases/download/v1.3.4/Refract-Windows-x64.exe'
  checksum64     = 'e5454c9b9cf3b497a0f879573011116f5ce07d6446450d08aa6ed7a3e170b0be'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
