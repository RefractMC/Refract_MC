# MSIX packaging

Tauri currently produces NSIS and MSI Windows installers; it does not emit an
MSIX bundle directly. `build-msix.ps1` packages the compiled Tauri executable
with `makeappx.exe` and signs it with `signtool.exe` from the Windows SDK.

MSIX requires a trusted certificate whose subject exactly matches the manifest
`Publisher` value. Do not publish an unsigned package: Windows will reject it
unless the signing certificate is explicitly installed as trusted. The manual
workflow is intentionally gated on the MSIX certificate secrets and does not
change the existing NSIS/MSI release or updater paths.

The package is a full-trust desktop app and retains the existing Tauri runtime
behavior. Test installation, upgrade, uninstall, WebView2 availability, and
instance/config access on a clean Windows 10/11 machine before publishing.
