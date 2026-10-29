# Windows companion

The Windows companion ports the macOS source in `macos/` and `core/` to an Electron desktop shell and Node device services. It embeds the same `web/` bundle as Android and macOS. A website or development server is not needed for the packaged app.

## Run and build

Development requires Windows 10/11 x64 and Node.js 24 x64. Packaged apps include their runtimes; users do not need Node, Swift, or Android Studio.

From the repository root in PowerShell:

```powershell
.\scripts\build-windows.ps1
```

Output: `build/windows/HouseControl-Windows-1.0.0-x64.exe`. The extracted app is also in `build/windows/win-unpacked/`. This development build is unsigned.

To run from source:

```powershell
cd web
npm.cmd ci
cd ..\windows
npm.cmd ci
node node_modules/electron/install.js
npm.cmd start
```

`npm.cmd test` runs backend tests. `npm.cmd run pack` creates an unpacked app; `npm.cmd run dist` creates the portable executable. Builds regenerate the shared UI. Packaging currently targets x64.

## Edit your home and connect Android

1. Open House Control. Use gear menu → **Edit home…**, **Ctrl+E**, or tray icon → **Edit Home…**.
2. Edit rooms, furniture, lights, ACs, scenes, and real-device links. **Save & apply** stores the custom plan and pushes it to connected phones.
3. On Windows, select **Pair Android / iPhone…** from the gear or tray menu.
4. On Android, open **Settings → Pair with computer → Scan pairing QR code** and scan the Windows code. Older APKs label this **Pair with Mac** but use the same protocol. Pasting the link also works.
5. Keep both devices on the same local network. Windows shows the connected device name; Android shows **Connected · up to date**.

If Windows asks about firewall access, allow House Control and its bundled Node worker on your **private** network. Discovery uses multicast DNS UDP5353 and sync uses a dynamically assigned TCP port. Guest Wi-Fi, VPN isolation, and access point client isolation may prevent discovery. Pairing is not an internet relay.

The QR contains a credential. **Reset pairing** requires every phone to scan again. **Disable sync** removes the pairing and stops listening.

Home Assistant addresses/tokens and Hue keys/certificate pins travel over the authenticated channel so Android can control the linked devices directly. Smart Life sends the account's User Code; each device completes its own sign-in. Android can ask Windows to display its Smart Life login QR.

## Feature mapping

| macOS function | Windows implementation |
|---|---|
| Menu bar panel/status | System tray menu, tooltip, resizable home window |
| 3D home, scenes, light/AC sheets | Existing shared web interface |
| Edit, import/export, save | Native file dialogs, shared editor, persisted custom plan |
| Notch island | Optional transparent island at the primary display's top; hover to expand |
| Phone sync | Bonjour, same pairing links, TLS1.2 PSK, plan/revision framing |
| Smart Life / Tuya | QR sign-in, developer credentials, signed/encrypted APIs, IR recovery |
| Home Assistant | REST connection/control/catalog and authenticated WebSocket updates |
| Philips Hue | Discovery/button pairing, pinned CLIP v2 and SSE updates |
| AI Access | Secret-link REST/MCP, existing tools, permissions, activity, undo, auto-stop |
| Internet AI Access | Optional official cloudflared quick tunnel; download verifies asset SHA256 |
| Apple Home | Direct HomeKit unavailable on Windows/Android; relink through Home Assistant/Hue |

Closing the main window keeps the companion in the tray. **Quit House Control** stops it, its worker, and its AI tunnel. The island's transparent area passes clicks through.

## Storage and protocol

Default data directory: `%APPDATA%\house-control-windows`. `HOUSE_DATA_DIR` selects an isolated folder for tests. Plans/settings use atomic writes. Credentials and pairing keys use `*.protected` files encrypted by Electron `safeStorage` with Windows DPAPI. There is no plaintext fallback.

Renderers are sandboxed with context isolation, no Node integration, restricted local assets, and a narrow IPC bridge. Device networking stays native. A bundled standard Node runtime serves sync because Chromium TLS does not guarantee Android's PSK cipher. Keys travel over private child IPC, never command lines; the worker stops if its parent disconnects.

Sync preserves the source protocol's `mac` field for compatibility, carrying the Windows name. Revisions are the first 8 SHA256 bytes as 16 hex characters. Frames are UTF-8 JSON with a 4-byte big-endian length, limited to 8 MiB. TLS uses HMAC-SHA256(pairing key, `HouseControl sync v1`) and only TLS1.2 `TLS_PSK_WITH_AES_128_GCM_SHA256`.

## Verification and limits

Tests cover actual TLS handshakes with Android's BouncyCastle 1.83, wrong-key rejection, framing, revisions, plan persistence, device mappings/signatures, loopback HTTP/WebSocket/SSE, Hue rejection before sending credentials, and the authenticated AI gateway. Desktop smoke verification exercises the actual editor Save button, DPAPI, sync worker, pairing advertisement, and shared AI tools.

Verified locally: 40 Windows backend tests, packaged Windows home/editor/pairing checks, 19 Android JVM tests, six Android device tests, and a live Android emulator `SyncClient` transfer from the Windows app. The latter imported the plan and confirmed an unchanged revision was not downloaded again. Android lint passes.

Optional Android `WindowsCompanionTest` exercises its actual `SyncClient`, imports a Windows plan, and checks matching-revision responses. Supply `companionHost`, `companionPort`, and `companionLink` instrumentation arguments. Emulator transport uses host `10.0.2.2`; physical Wi-Fi discovery still needs a real-network check.

Cloud accounts and physical accessories require validation with your hardware. Cloudflared installation is tested with mocked release data; live internet tunneling is not part of local verification. Existing limitations for unusual Tuya scales remain. There is no direct HomeKit support or device-command relay through the computer.
