# Privacy Policy

**Effective date: August 19, 2026**

RefractMC ("Refract", "we", "us", or "our") respects your privacy. This Privacy Policy explains what information Refract may access, store, or transmit when you use the Refract Minecraft launcher.

Refract is an open-source, third-party launcher and is not affiliated with, endorsed by, or approved by Mojang or Microsoft.

## 1. Information Refract Handles

### Microsoft and Minecraft Account Information

When you sign in with a Microsoft account, Refract communicates directly with Microsoft, Xbox Live, and Minecraft Services to authenticate your account and verify access to Minecraft.

Refract may store limited account information locally on your device, including your:

* Minecraft username
* Minecraft UUID
* Xbox User ID (XUID)
* Account type
* Authentication expiration information

Microsoft access tokens, Minecraft access tokens, and refresh tokens are not stored in the launcher UI configuration. Authentication tokens are stored locally using protected credential storage and an encrypted Stronghold vault backed by your operating system's credential/keyring facilities.

Your Microsoft account password is not collected or stored by Refract.

### Offline Accounts

If you create an offline account, information such as the username you select is stored locally on your device. Offline accounts do not authenticate with Microsoft.

### Custom Authentication Servers

Refract supports custom Yggdrasil-compatible authentication services.

If you choose to use one, authentication information you provide is transmitted to the authentication server you configure. Refract does not control these third-party authentication servers, and their own privacy policies and practices apply.

You should only use authentication servers that you trust.

## 2. Analytics

Refract may use Google Analytics to understand general launcher usage and improve the application.

Analytics are currently enabled by default and can be disabled through Refract's settings.

When analytics are enabled, Refract may send limited events such as:

* Application opened
* Page viewed
* Minecraft instance launched
* Application error events

Analytics events may also contain information such as the Refract version, operating system, session identifier, and a randomly generated client identifier.

The random analytics client identifier is stored locally in Refract's application data directory. It is not your Microsoft account ID, Minecraft UUID, username, or email address.

Refract does not intentionally send Microsoft authentication tokens, Minecraft authentication tokens, passwords, or other account credentials to Google Analytics.

As part of normal internet communication, Google may process technical information such as IP addresses and approximate geographic information according to Google's own privacy practices.

You can disable future Refract analytics collection at any time in the launcher settings.

Disabling analytics does not automatically delete information that may previously have been processed by Google Analytics.

## 3. Locally Stored Information

Refract stores most launcher information locally on your computer.

Depending on the features you use, this may include launcher settings, accounts and account metadata, Minecraft instances, mod configurations, worlds, screenshots, resource packs, shaders, datapacks, Java runtime information, custom Java paths, server lists, local logs, crash reports, backups, themes, and other launcher configuration.

Refract does not operate a cloud storage service for your Minecraft worlds or launcher instances unless a feature explicitly tells you otherwise.

Launcher logs and locally detected Minecraft crash reports are stored on your device. They are not automatically uploaded to RefractMC by the normal logging and crash-report viewing features.

## 4. Third-Party Services

Refract communicates with third-party services when required to provide launcher functionality.

These services may include Microsoft, Xbox Live, and Minecraft Services for authentication and Minecraft account functionality; Google Analytics for optional usage analytics; Modrinth, CurseForge, and FTB for discovering and downloading game content; GitHub for application releases and updates; custom authentication providers that you configure; and Discord when Discord Rich Presence is enabled.

When Refract connects to these services, the service may receive standard network information such as your IP address and information about the resource being requested.

Your use of those services is also subject to their respective privacy policies and terms.

Refract does not control how independent third-party services process information they receive.

## 5. Discord Rich Presence

Refract may integrate with Discord Rich Presence.

When enabled, Refract communicates activity information to the Discord client installed on your computer. Discord may process or display this information according to your Discord settings and Discord's own privacy policy.

Discord Rich Presence can be disabled in Refract's settings.

## 6. Downloads and External Content

When you browse or download Minecraft versions, mods, modpacks, shaders, resource packs, datapacks, Java runtimes, or other content, Refract may make requests to the service hosting that content.

Those providers may receive information normally included in an internet request, including your IP address.

Refract may also communicate with Minecraft servers when you request server status information or launch a multiplayer server.

## 7. How We Use Information

Information handled by Refract is used to provide launcher functionality, authenticate Minecraft accounts, launch Minecraft, manage Minecraft installations and content, provide update functionality, diagnose errors, maintain application security, and understand general application usage when analytics are enabled.

We do not sell your personal information.

We do not use Microsoft or Minecraft authentication credentials for advertising.

## 8. Data Security

Refract is designed to keep sensitive authentication credentials outside the web-based renderer portion of the application.

Authentication tokens are handled by Refract's native Rust backend and stored using encrypted/protected local credential storage.

Network requests involving authentication are required to use encrypted HTTPS connections, except where a user explicitly configures a localhost authentication service for local development or testing.

No software can guarantee absolute security. Users are responsible for maintaining the security of their computer, operating system, Microsoft account, and any third-party authentication services they choose to use.

## 9. Your Choices and Controls

You can disable analytics through Refract's settings.

You can remove accounts from Refract, disable Discord Rich Presence, remove Minecraft instances and other launcher-managed content, clear launcher logs, and uninstall Refract.

You may also delete Refract's application data from your computer to remove locally stored configuration and other launcher data.

Deleting the locally stored analytics identifier removes that identifier from your device. If analytics remain enabled and Refract is started again, a new random identifier may be generated.

Removing local information does not automatically remove information that has already been processed by third-party services.

## 10. Data Retention

Information stored locally by Refract generally remains on your device until it is removed by you, removed through a Refract feature, or deleted when you remove the relevant application data.

Authentication credentials may expire and be refreshed as necessary to maintain your signed-in session.

Analytics information transmitted to Google Analytics is retained and processed according to the configuration of Refract's Google Analytics property and Google's applicable policies.

Third-party services retain information according to their own policies.

## 11. International Data Processing

Third-party services used by Refract may process information in countries different from the country in which you live.

Their processing practices and international data-transfer mechanisms are governed by their respective privacy policies and applicable laws.

## 12. Changes to This Privacy Policy

We may update this Privacy Policy when Refract's features, integrations, or data practices change.

When significant changes are made, the effective date at the top of this document will be updated.

Because Refract is open source, its source code and changes to this Privacy Policy can be reviewed through the official RefractMC GitHub repository.

## 13. Contact

For questions, requests, or concerns regarding this Privacy Policy or Refract's handling of information, contact the RefractMC project through the official GitHub repository:

**RefractMC / Refract_MC**

Please do not post passwords, access tokens, refresh tokens, API keys, or other sensitive credentials in public GitHub issues.

---

Refract is an independent third-party project. Minecraft is a trademark of Microsoft Corporation. Refract is not affiliated with, endorsed by, or approved by Mojang or Microsoft.
