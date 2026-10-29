# Android app

The Android app uses the repository's shared Vite/Three.js interface inside an
Android WebView, with Kotlin implementations of the native bridge and services.
It works offline with the bundled demo homes. Android 8.0 (API 26) or newer and
an up-to-date Android System WebView are required.

## Build

Install Node.js 22+, JDK 17+, Android SDK platform 36 and SDK build tools 35.0.0.
Set `ANDROID_HOME` to the SDK directory (or configure Android Studio's SDK path).
The project pins Gradle 8.14.3, Android Gradle Plugin 8.13.0 and Kotlin 2.2.10.
On Windows, from the repository root:

```powershell
.\scripts\build-android.ps1
# Rebuild without reinstalling npm dependencies; optionally install on a device:
.\scripts\build-android.ps1 -SkipInstall -Install
```

On macOS/Linux:

```sh
cd web && npm ci
cd ../android
bash gradlew assembleDebug lintDebug
```

The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`. Android
Studio can open `android/` directly after installing web dependencies. Gradle
builds the web UI and copies `web/dist/` into the APK; a development server is
not required. The Android workflow builds and lints a debug APK on GitHub.

`assembleRelease` produces an unsigned APK. Configure your own release signing
before distributing it; no signing credentials are included in this repository.
App data and credentials are excluded from Android cloud backups. Sensitive
connection data is encrypted using the Android Keystore.

## Feature coverage and validation

This is an Android implementation based on the available iOS and shared Swift
source. No iOS binary was supplied or decompiled. Implementation coverage does
not establish device-tested parity; live cloud accounts, an actual companion
Mac and physical accessories must be used to validate their respective paths.

| iOS capability | Android implementation | Required validation |
| --- | --- | --- |
| 3D home, device sheets, brightness, colour, AC controls and scenes | Same bundled web UI and native message bridge | Phone/tablet touch, graphics and WebView compatibility |
| Apartment and Studio demo homes | Bundled plans with simulated devices | Offline launch and scene/control interactions |
| Import/select/remove custom floor plan | Android document picker and private app storage | Import a real exported plan and restart app |
| Mac QR pairing and pasted pairing payload | Camera QR scanner and text entry | Pair with a running Mac on the same LAN |
| Foreground Mac synchronization, plan/device updates and QR forwarding | DNS-SD discovery and TLS-PSK companion protocol | End-to-end pairing, reconnection and credential/plan updates |
| Smart Life QR account login and sign-out | Kotlin cloud adapter and QR display/share | Real account login, token refresh and commands |
| Tuya developer project | Kotlin signed cloud adapter | Real regional cloud credentials and accessory types |
| Home Assistant | Kotlin REST adapter and WebSocket state notifications | Local instance authentication, lights, climate and scenes |
| Philips Hue | Kotlin bridge adapter, pinned TLS and SSE notifications | Real bridge pairing credentials and lights |
| Haptics | Android vibration bridge | Physical Android phone |
| Apple Home / HomeKit | Android has no equivalent Apple HomeKit framework; use Home Assistant or another supported integration for compatible devices | Direct Apple Home pairing/control is unavailable |

Mac-only features such as the menu bar, notch island, desktop editor workflow,
AI/MCP server and release DMG are outside the iPhone-to-Android scope.

## Local network behavior

The companion Mac and local Home Assistant/Hue services must be reachable from
the Android device. The app declares internet/network, multicast discovery and
optional camera permissions. Camera permission is requested when scanning.
Local HTTP is enabled for integrations that expose an HTTP LAN endpoint; Mac
sync uses the paired TLS pre-shared key. No background foreground-service or
continuous background polling is configured: connections resume while the app
is active.

## Checks completed in this workspace

The debug APK was built and installed on the API 36 phone emulator. Automated
validation passes 19 JVM tests and 6 Android integration tests:

- Pairing URL compatibility, HMAC derivation, framed messages and a TLS-PSK
  handshake using the Mac's exact cipher; a wrong pairing key is rejected.
- Swift device-mapping vectors, infrared deferred/replayed commands, and
  encrypted Smart Life envelopes with tamper detection.
- Plan persistence, exact sync revision hashes, rejected invalid imports,
  Android Keystore encryption and account-bound ciphertext.
- Native hub reads and commands against a local Home Assistant HTTP fixture.
- Actual geometry rendered by the bundled WebView, checked from pixel data.

Android disables HDR render-target multisampling to avoid a black canvas on
WebView drivers that fail that resolve path; HDR lighting and bloom remain.
The Apple renderer keeps its existing sampling settings. The geometry test
covers this regression on the emulator.

Emulator interaction checks also covered AC target changes and persistence,
light brightness/colour sheets, scenes, system Back, switching demo homes,
pairing deep links, encrypted pairing persistence and unpairing. Lint passes
with warnings for deprecated APIs and dependency updates. These checks do not
replace validation with a physical phone, companion Mac, cloud account and
real accessories.

Windows companion support is described in [windows.md](windows.md). The rebuilt
Android app labels pairing as **Pair with computer** for either desktop platform.
The live emulator Windows test passed encrypted plan transfer and matching-revision
handling using Android's actual `SyncClient`; physical Wi-Fi discovery still needs
validation on the target network.

```powershell
cd android
.\gradlew.bat assembleDebug testDebugUnitTest lintDebug
# Start an emulator or attach a device first:
.\gradlew.bat connectedDebugAndroidTest
```
