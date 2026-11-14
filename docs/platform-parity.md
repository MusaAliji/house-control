# Platform parity tracker

Compares **macOS → Windows** (desktop) and **iOS → Android** (phone). Written 2026-11-14 from reading the source on
commit `cb68520`; nothing here was run on a device, so treat ✅ as "code exists", not "tested".

Legend: ✅ same · 🟡 partial or different on purpose · ❌ missing · ➖ cannot exist on that OS

The 3D home, light/AC sheets, scenes, floors and the AI tool set are one shared `web/` bundle, so they are identical
everywhere and are listed once at the top.

## 0. Shared by all four (web bundle)

| Feature | Status |
| --- | --- |
| 3D home, rotate/pan/zoom, view reset, room zoom, floors and floor buttons | ✅ |
| Light tile: toggle, drag to dim, brightness / white temperature / colour sheet | ✅ |
| AC sheet: power, target, mode, fan, room sensor | ✅ |
| Scenes, including On/off room buttons | ✅ |
| Demo homes: Apartment, Studio, House (two floors) | ✅ (Android lists all three in Settings) |
| Real-device state refresh (HA / Hue push, Smart Life poll) | ✅ |

## 1. macOS → Windows

| # | macOS feature | Windows | Status | Note |
| --- | --- | --- | --- | --- |
| 1 | Menu bar icon + dropdown panel | Tray icon + normal resizable window; click toggles | 🟡 | Window, not a dropdown. Intentional. |
| 2 | Menu bar title `6 · 23°` | Tooltip only | 🟡 | Windows tray cannot show text. |
| 3 | Right-click menu: Settings, Edit Home, Load Floor Plan, Reveal Plan File, Show Island, Open at Login, Pair, AI Access, Reload, Quit | Same items, **no Settings** and **no Open at Login** in the tray menu | 🟡 | Open at Login exists only in the panel's gear menu. |
| 4 | Settings window (⌘,) with tabs: general, plans, Smart Life, HA, Hue, Apple Home, pairing, AI Access, About | None. `openSettings` just opens the pairing window | ❌ | Biggest desktop gap. Connections live in the editor only. |
| 5 | About pane: version, Website, Support, Privacy, Source, developer link | None | ❌ | |
| 6 | Reveal Device Log | None | ❌ | |
| 7 | Floor plan editor (all tools, floors, snapping, split, duplicate, undo) | Same shared editor, Ctrl+E | ✅ | Shortcut labels say ⌘ in places; check. |
| 8 | Import / export / Save & apply, plan JSON on disk | Native dialogs, atomic writes | ✅ | |
| 9 | Earlier Homes (kept before anything replaces the home) | Tray submenu, same behaviour | ✅ | |
| 10 | Trace a floor plan picture | Yes | 🟡 | Windows has it, macOS does not. Windows is **ahead**; decide whether to port back. |
| 11 | Notch island, hover to open | Transparent island at top of primary display | 🟡 | Fake notch size, polls cursor every 75 ms. No multi-monitor handling beyond primary. |
| 12 | Island peeks on remote changes | Shared web code | ✅ | |
| 13 | Pair Phone window (QR, copy link, reset, disable) | Same | ✅ | Windows copy says "Android / iPhone". |
| 14 | Sync server (Bonjour, TLS-PSK, plan revisions, connections share) | Node worker, same protocol | ✅ | Tested against Android's BouncyCastle. |
| 15 | Show Smart Life QR forwarded from phone | Same (`login` window) | ✅ | |
| 15b | Take the phone's Home Assistant / Hue connections (newer side wins) and its Smart Life User Code | Same rules and timestamps as the Mac | ✅ | Before 2026-11-14 Windows ignored them. |
| 16 | Smart Life QR sign-in | Same | ✅ | |
| 17 | Tuya developer project credentials | Same | ✅ | |
| 18 | Smart Life IR lights/ACs via Tap-to-Run scenes | Implemented in `devices.cjs` | ✅ | |
| 19 | Home Assistant: discover, token, REST + WebSocket | Same | ✅ | |
| 20 | Philips Hue: discover, button pair, pinned TLS, SSE | Same | ✅ | |
| 21 | Apple Home (HomeKit) | Not available | ➖ | Relink via HA/Hue. |
| 22 | AI Access (REST + MCP, permissions, activity, undo, auto-stop) | `agent.cjs` | ✅ | |
| 23 | Cloudflare quick tunnel (verified download) | Same, winget hint in UI | ✅ | |
| 24 | Open at Login | `setLoginItemSettings` | ✅ | No "needs approval" state needed. |
| 25 | Credential storage (Keychain) | DPAPI via `safeStorage`, no plaintext fallback | ✅ | |
| 26 | Widgets (desktop widgets, Control Center controls) | `widgets` message is a no-op | ➖/❌ | Windows 11 widgets board is possible but not built. |
| 27 | Single instance, quit stops worker + tunnel | Same | ✅ | |
| 28 | Signed / notarized distribution (DMG, CI release) | Unsigned portable exe, no CI release | ❌ | `scripts/release-mac.sh` has no Windows counterpart. |

## 2. iOS → Android

| # | iOS feature | Android | Status | Note |
| --- | --- | --- | --- | --- |
| 1 | Welcome: Set up my home / Pair / Explore demo | Same three choices | ✅ | |
| 2 | **Floor plan editor** (touch layout, add, items, 3D, save) | Shared phone editor in a second WebView: Settings → Edit floor plan | ✅ | Opens, sheets and back checked on the emulator. Save, import and export not yet run on a device. |
| 3 | New home (blank, Studio, Apartment) | Settings → New home…: one room, Studio, Apartment or House | ✅ | No scan option (see #4). |
| 4 | LiDAR room scan with device pins and review | None (ARCore plan only) | ❌ | Plan written, nothing built. |
| 5 | Devices screen: link a lamp/AC to a real device, "Add devices to a room" | Linking works inside the editor (Real device on a lamp or AC); no separate Devices screen or bulk add | 🟡 | |
| 6 | Settings screen (native, sectioned) | Settings as a stack of AlertDialogs | 🟡 | Works, but much plainer. |
| 7 | Import plan file | Document picker, 8 MiB cap | ✅ | |
| 8 | Export plan file | The editor's Export, through the system Save dialog | ✅ | |
| 9 | Remove custom home | "Remove imported home" | ✅ | |
| 10 | Earlier homes | Yes | ✅ | |
| 11 | Pair with Mac or PC (camera QR + paste link) | Yes | ✅ | |
| 12 | Sync now / Unpair / last-synced / status text | Yes | ✅ | |
| 13 | **Sync conflict prompt** ("which plan to keep") | Same rules as iOS (`syncedPlanRevision`, "Which home do you keep?") | ✅ | Not yet run against a real computer. |
| 14 | Send phone-edited plan to computer | `SyncClient.sendPlan`; Windows now accepts it too | ✅ | Windows needed a `plan` handler (tested). |
| 15 | Home Assistant: auto-find on Wi-Fi + token | Manual URL + token | 🟡 | No discovery. |
| 16 | Hue: auto-find on Wi-Fi + button pair | Manual bridge address | 🟡 | No discovery (Windows has it). |
| 17 | Smart Life QR sign-in, User Code prefill from computer | Yes | ✅ | |
| 18 | Smart Life: save code to Photos / Share code | Share code image; Show on computer | ✅ | |
| 19 | Tuya developer project | In the editor's Smart Life section | ✅ | |
| 20 | Smart Life IR via Tap-to-Run | Yes (`CloudServices.kt`) | ✅ | |
| 21 | Apple Home | Info dialog only | ➖ | |
| 22 | Haptics (tick, medium, heavy, success, error) | `performHapticFeedback`; heavy/success not mapped separately | 🟡 | |
| 23 | Widgets (Home 3D, Scenes, Light, Room, Climate, Lock Screen) | None | ❌ | Android App Widgets not started. |
| 24 | Controls (Control Center / Action button) | None | ➖/❌ | Quick Settings tiles are the nearest equivalent. |
| 25 | Quick actions on the app icon, chosen in Settings | None | ❌ | Android static/dynamic shortcuts would do it. |
| 26 | iPhone Duo / foldable layout | None specific | ❌ | Android foldables not handled. |
| 27 | Trace a floor plan picture | In the editor | ✅ | Button visible on the emulator; picking a picture not yet tried. |
| 28 | Credentials in Keychain | Android Keystore | ✅ | |
| 29 | App Store vs Smart Life editions | Single build with Smart Life | 🟡 | Decide the Play Store policy. |
| 30 | About / Privacy / Support links | Version text only | ❌ | |
| 31 | Offline demo, device command bridge | Yes | ✅ | |

## 3. Suggested order (user value over effort)

1. ~~Android: open the shared editor~~ and ~~the sync conflict prompt~~: done (2026-11-14).
2. ~~Windows: accept the phone's `connections` message~~: done (2026-11-14), with the Mac's timestamps.
   Android still neither sends its connections nor keeps timestamps; it replaces its own with the computer's.
3. **Windows: Settings window and About** (rows 4 to 6).
4. Android: Home Assistant and Hue discovery, Tuya developer UI.
5. Android widgets and shortcuts; the ARCore scan last.

## 4. Doc errors found along the way

- `README.md` says the iPhone app pairs with the Windows app at a separate repo URL, while Windows now lives in this repo.
