# Android home scan (ARCore): plan

Status: **plan only, nothing built** (written 2026-11-14, on top of commit `13f5cca`).
This is the reference for any session that picks the work up. Read it before touching code.

The iPhone app scans a home with LiDAR (1.5.0, `ios/Sources/Scan/`, `core/Sources/HouseCore/RoomScan.swift`).
Android phones mostly have no LiDAR and ARCore has no equivalent of Apple's RoomPlan, so the
scan cannot be ported one to one. This document says what can be reused, what has to be new,
and in what order to build it.

## 1. Summary of the recommendation

1. Keep the iPhone's data seam: a scan is a `RoomScan` (walls, openings, objects, tagged devices as plain
   numbers in metres) and `ScanLayout` turns it into a plan. Only **one 90-line file** is Apple-specific
   (`ios/Sources/Scan/RoomPlanScan.swift`). Everything after it is pure geometry.
2. On Android, **capture by tapping** (corner by corner, MagicPlan style) with ARCore giving world
   coordinates, because ARCore does not detect walls, doors, windows or furniture. Use the Depth API
   only as an optional later accuracy aid.
3. **Port `ScanLayout` to JavaScript in `web/`**, tested against golden vectors from the Swift tests, so
   Android, Windows and the browser share one implementation.
4. **Prerequisite (done 2026-11-14):** Android now hosts the shared editor (see section 4), so the review step can
   end in **Save and fine-tune** as on the iPhone.
5. Windows has no depth sensor, so it gets no capture. It benefits from the JS layout (import a scan file)
   and from receiving scans from a phone over the existing pairing sync.

Rough size: 3 to 5 weeks of focused work, most of it needing a physical ARCore phone (section 9).

## 2. What the iPhone does (the reference behaviour)

Source: `docs/floor-plan.md`, `CHANGELOG.md` 1.5.0, and the files below.

- Walk through the home with the LiDAR camera; **Next room** in the doorway starts the next room, all rooms
  land in one plan. An L-shaped room becomes two rooms open to each other; two rooms scanned apart meet in
  the middle of the wall between them.
- **Pin lamps and ACs while scanning:** point a circle at one and tap +; a pin stays on it; a list beside the
  camera offers the matching devices of Smart Life, Home Assistant, Hue and Apple Home, or "link later".
  A lamp on the ceiling becomes a ceiling lamp, one at shoulder height a floor lamp; an AC goes on its wall.
- **Review before saving:** the plan from above, rooms to rename, pins to drop, and whether it becomes the
  home or another floor of the home you have. **Save and fine-tune** opens the editor on it.
- Keeps the screen awake, finishes itself if the phone gets too warm.

| Piece | File | Lines | Platform |
| --- | --- | --- | --- |
| Capture session, Next room, pins, thermal | `ios/Sources/Scan/ScanController.swift` | 556 | iOS only (RoomPlan, ARKit) |
| Capture UI | `ios/Sources/Scan/ScanScreen.swift` | 537 | iOS only (SwiftUI) |
| Review UI | `ios/Sources/Scan/ScanReviewView.swift` | 365 | iOS only (SwiftUI) |
| RoomPlan result to `RoomScan` | `ios/Sources/Scan/RoomPlanScan.swift` | 91 | iOS only (RoomPlan) |
| Save as home / new floor | `ios/Sources/Scan/AppModel+Scan.swift` | 52 | iOS only |
| **`RoomScan` model + `ScanLayout`** | `core/Sources/HouseCore/RoomScan.swift` | 904 | **Pure Swift, no Apple frameworks** |
| Tests and sample scan | `core/Tests/HouseCoreTests/RoomScanTests.swift` | 200 | Pure Swift |

## 3. The seam we reuse: `RoomScan` and `ScanLayout`

`RoomScan` is documented as "kept free of RoomPlan so it can be saved, tested and rebuilt anywhere". Its shape:

- `rooms[]`, each with `walls[]` and `openings[]` (both `Surface`), `objects[]`, `sections[]` (room labels), `floor[]` (corner points).
- `Surface`: `kind` (wall / door / window / opening), `center` (x, y, z), `axisX`/`axisZ` (the horizontal direction its
  width runs along), `width`, `height`. An upright rectangle.
- `Object`: `category`, optional `kind`, `center`, `axisX`/`axisZ`, `width`, `height`, `depth`.
- `tags[]`: a lamp or AC the user pointed at: `kind` ("light" or "ac"), `name`, `position`, optional `device`
  (`service`, `id`, `name`, `capabilities`, `min`, `max`, as `DeviceHub.allDevices` lists them).
- Coordinates: the AR session's world space, **metres, y up**. ARCore's world space is the same convention
  (metres, y up), so capture output maps directly.

`ScanLayout.plan(from:name:)` returns the plan JSON (the format of `web/src/config.js`), or nil if nothing is big
enough to draw. `ScanLayout.adding(_:asFloor:to:)` puts a scanned plan on a new floor of an existing home.

What the layout does (so a port can be checked stage by stage): finds the dominant wall angle (folded to a quarter turn,
weighted by length) and turns the scan square; takes the floor height as the median wall bottom and wall height as the
median wall height (2.2 to 4 m, to 5 cm); cuts each room's wall grid into as few rectangles as walls allow;
closes the gaps a wall's thickness leaves between rooms; drops rooms under 0.5 m a side or 0.8 m²; moves the home to
(0, 0) in whole centimetres; names rooms from RoomPlan `sections` (or guesses); places openings on room edges
(`sill`/`head` from the surface's bottom and height, relative to the floor); places furniture with its back to the wall;
places tags in the room they stand in (a light above `height - 0.45` is a ceiling lamp, above `max(1.8, height - 1.2)` a
pendant, above 1.05 m a floor lamp; ACs go to the nearest wall).

Things the Android capture can leave out safely: `sections` (rooms get guessed names, the user renames in review),
`objects` (furniture is optional; the editor can add it), `floor[]` (only a fallback when there are too few walls).

### Tests to reuse as golden vectors

`RoomScanTests.swift` defines `SampleScan.scan`: three rooms drawn square, turned 17 degrees and moved, floor 1.3 m
under the origin, with doors, a window, furniture and three tagged devices. It asserts room rectangles, openings,
furniture and device placement. The env var `ROOM_SCAN_SAMPLE=<file> swift test --filter RoomScanTests` already writes
the sample scan as JSON.

**Gap:** nothing writes the expected *plan* JSON. On a Mac, add a test that writes `ScanLayout.plan(from: SampleScan.scan)`
to `core/Tests/Fixtures/` (or similar) and commit both JSON files. The JS port then asserts it produces the same plan
(within a centimetre) for the same scan. Swift cannot be run on Windows, so this step needs the Mac. Until it exists a
JS port can still assert the Swift test's own expectations (copy the numbers from `RoomScanTests.swift`).

## 4. Android prerequisite: there is no editor on Android

> **Resolved 2026-11-14:** option A below was built. `MainActivity.kt` opens `?mode=editor` in a second WebView and
> answers `savePlan`, `importPlan`, `exportPlan` and the service calls. The text below is kept as the original finding.

Verified in `android/app/src/main/java/com/housecontrol/MainActivity.kt`: the WebView always loads `?mode=panel`, and the
bridge handles only `ready`, `command`, `haptic`, `openSettings` and `selectPlan`. There is no `openEditor`,
`savePlan`, `exportPlan` or `importPlan`. Homes reach Android from the Mac or PC (sync) or a file import in
Settings. `docs/windows.md` says the home is edited on the computer.

Consequences:
- Every editor feature in `web/` (floor tabs, split, duplicate, "Trace a picture", the add bar) is **not reachable on
  Android** today, even though the code ships in the bundle. Earlier notes that said these "work on Android" were wrong.
- The Android file chooser added in `MainActivity.kt` (`onShowFileChooser`, `PICK_PICTURE`) only matters once an editor exists.
- A scan needs a review/fine-tune step. Two choices:
  - **A (recommended): add an editor host to Android.** Load `?mode=editor` in a second WebView or activity and handle
    the editor's bridge calls: `ready`, `close`, `savePlan` (via `PlanStore.save`), `exportPlan`, `importPlan`, and the connection
    calls (`tuya.devices`, `tuya.save`, `smartlife.begin`, `smartlife.poll`, `smartlife.signOut`, `openConnection`). The device
    services already exist in `android/.../devices/`. This also unlocks everything else in the editor.
  - **B:** a native Kotlin review screen like `ScanReviewView.swift`. More code, and still no way to fine-tune.

## 5. What ARCore gives us (and does not)

Verified against Google's ARCore documentation (Context7: `/google-ar/arcore-android-sdk`, `/websites/developers_google_ar`):

- **Plane detection:** `Config.PlaneFindingMode` is `DISABLED`, `HORIZONTAL`, `VERTICAL` or `HORIZONTAL_AND_VERTICAL`.
- **Hit tests and anchors:** a frame hit test returns hits on planes and other trackables; `hit.createAnchor()` keeps a point
  fixed in the world as tracking improves. Anchors are only valid while `Camera.getTrackingState() == TRACKING`.
- **Depth API:** off by default. Check `session.isDepthModeSupported(Config.DepthMode.AUTOMATIC)`, then
  `session.configure(config)`. `frame.acquireRawDepthImage16Bits()` returns an unfiltered depth image (range to 65 m);
  it can throw `NotYetAvailableException` (too few frames, poor light, occlusion, too little motion), `NotTrackingException`,
  `IllegalStateException` (depth mode not enabled). Not every ARCore device supports depth.
- **Availability:** `ArCoreApk.getInstance().checkAvailability(context)`; if not `SUPPORTED_INSTALLED`, `requestInstall(...)`
  returns `INSTALL_REQUESTED` or `INSTALLED`.
- **Dependency and SDK level (from Google's sample):** `com.google.ar:core:1.57.0`; sample uses compileSdk and targetSdk 37;
  AR Required apps need minSdk 24 (ours is 26). The project's compileSdk is 36: **check whether core 1.57 builds
  against 36, or pin an older core release**, before starting.

Not in ARCore (the reason this is not a straight port):
- There is **no wall, door, window or furniture detection and no room mesh**. RoomPlan's `CapturedRoom` has no counterpart.
- ARCore has no rendering. A camera preview needs an OpenGL renderer of the camera texture (Google's sample has a
  `BackgroundRenderer`), or a library that wraps it (SceneView `io.github.sceneview:arsceneview`). **Not evaluated:**
  check that library's maintenance, licence, size and minSdk before choosing it.

Believed, from general knowledge and **not verified this session** (test on the target phone before relying on it):
- Vertical plane detection is unreliable on plain, textureless walls, so auto-detected walls would be patchy.
- Depth quality varies by phone; a few have a time-of-flight sensor, most compute depth from motion and are weaker
  on blank walls and in low light.
- The Android emulator can run ARCore against a virtual scene, which would allow early UI work without a phone.
- ARCore tracking drift grows with distance, so a whole-house walk may not close the loop.

## 6. Capture options compared

| Option | Idea | Pros | Cons | Verdict |
| --- | --- | --- | --- | --- |
| **A. Tap the corners** | Walk the room and tap each floor corner at the wall base, in order; then ceiling height; then tap openings | Works on every ARCore phone; needs only floor plane + hit test; walls come out straight; small code | Manual; furniture and clutter hide wall bases; accuracy is a few centimetres | **Build this first** |
| B. Depth-assisted taps | As A, but snap each tap to the nearest wall edge found in raw depth | Better accuracy, fewer retaps | Needs a depth-capable phone; real algorithm work | Later, optional |
| C. Detect vertical planes as walls | Let ARCore find walls, fit rectangles | Hands-free if it worked | Patchy on blank walls; no doors or windows; hard to tune | Reject as the main path |
| D. Import another app's scan | Read USDZ / JSON exports of Polycam, Canvas, RoomPlan | No capture code | Needs a parser per format; exports vary | Possible later, via a `RoomScan` converter |
| E. Scan on an iPhone, sync | Use the existing pairing sync | Already works | Needs an iPhone | Already available |

## 7. Proposed design (option A)

### Data
Capture produces `RoomScan.Room` values in ARCore world metres:
- **Walls:** for consecutive corners P1..Pn (closed loop), one `Surface(kind: wall)` per edge: `center` is the midpoint at
  `y = floorY + height/2`, `axisX/axisZ` is the unit direction of the edge, `width` its length, `height` the ceiling height.
- **Ceiling height:** default 2.6 m; optionally tap the ceiling at one corner (hit test on the ceiling or the wall top) or type it.
- **Openings:** the user taps two points at the bottom of a door or window on a wall (or taps the middle and sets the width);
  window sill and head from two more taps or sliders. Emit `Surface(kind: door|window)` with `center.y = bottom + height/2`
  (the layout converts to `sill`/`head` relative to the floor; windows default to sill 0.85 and head 2.1 in `web/src/config.js`).
- **Floor level:** use the floor plane's y (or the lowest tapped corner) as `floorY`.
- **Tags (device pins):** tap a lamp or AC; hit test gives a world position; `y` decides ceiling, pendant, floor lamp or AC as in
  `placeTags`. The device list is `DeviceHub.allDevices()`, which already exists on Android (`devices/DeviceHub.kt`).

### Rooms in one plan
All rooms must share a coordinate frame. iOS keeps one AR session across rooms (**Next room**). ARCore tracking is
continuous while the session runs and the phone is not covered, so:
- Keep one `Session` for the whole scan; **Next room** just starts a new corner list.
- If tracking is lost, the next room has a new frame. Fallback: ask the user to tap the shared doorway from both sides and
  align the rooms by it. Mark this as **risk 1** (section 10).

### Layout (shared JS)
- New `web/src/scan/layout.js` exporting `planFromScan(scan, name)` and `addAsFloor(scanned, floorName, home)`, ported from
  `ScanLayout`; plus `web/test/scan.test.js` (`node --test`, the project's existing convention in `web/package.json`).
- Why JS and not Kotlin: Windows and the browser can reuse it (import a scan file); the plan is JSON; one copy to keep in
  sync with Swift instead of two.
- Cost: two implementations (Swift and JS) must stay in step. The golden fixtures in section 3 are the guard. A comment at
  the top of both files should point to the other.

### Android code
- New package `com.housecontrol.scan`: `ScanActivity` (or fragment) hosting the camera view and overlay;
  `ArScanSession` (ARCore session, plane/depth config, frame loop); `CameraRenderer` (GL camera background) or the library
  chosen in section 5; `ScanModel` (corners, openings, tags to `RoomScan` JSON).
- Entry: Settings → **Scan your home** (mirrors the iPhone), shown only when `ArCoreApk.checkAvailability` is supported or
  installable. Manifest: `<uses-feature android:name="android.hardware.camera.ar" android:required="false"/>` and
  `<meta-data android:name="com.google.ar.core" android:value="optional"/>` so the app still installs on phones without ARCore
  (not verified against current docs; check when implementing). Camera permission already exists.
- The scan JSON goes to the WebView (or a small headless WebView) to run `planFromScan`, then `PlanStore.save` /
  `addAsFloor` (earlier homes are kept automatically since commit `254faf2`).
- Review and fine-tune: the editor (section 4, option A) opened on the new plan.
- Keep the screen awake while scanning; watch `PowerManager` thermal status like `thermalChanged()` in `ScanController.swift`.

## 8. Windows and the web

- No capture on Windows (no depth sensor; a webcam scan is not practical).
- The JS layout lets Windows add **Import scan…** (a `RoomScan` JSON from a phone or another tool) cheaply.
- The editor's **Trace a picture** (commit `9511d1c`, hidden on Mac and iPhone by `13f5cca`) is the manual alternative on
  Windows today. Details in `CHANGELOG.md` (Unreleased).
- Phones already push homes to a paired PC (`sync`), so an Android or iPhone scan appears on Windows without extra work.

## 9. Phases, estimates, acceptance

Estimates are rough working days for one developer and exclude review and release. P2 onward needs a physical ARCore phone.

| Phase | Work | Days | Done when |
| --- | --- | --- | --- |
| P0 | Android editor host (section 4, option A) | 3 to 5 | Settings → Edit home opens the editor; saving updates `PlanStore`; trace picture opens a picture |
| P1 | JS `ScanLayout` port + golden tests (needs the Mac step in section 3 for exact fixtures) | 3 to 4 | `npm test` passes on the sample scan; plan validates in `config.js normalize()` |
| P2 | Corner-tap capture MVP: one room to a saved home | 4 to 6 | A real room of known size comes out within 5 cm per wall |
| P3 | Doors and windows, ceiling height, Next room with shared frame, tracking-loss fallback | 3 to 5 | A 3-room flat scanned once becomes one plan, doors in the right walls |
| P4 | Device pins and picker, ceiling/floor/AC classification | 2 to 3 | A pinned lamp lands in the right room, linked to a real device |
| P5 | Review polish, save as home or floor, thermal and keep-awake, errors, strings | 2 to 3 | Matches the iPhone flow in section 2 |
| P6 (optional) | Depth-assisted snapping (option B) | 3 to 5 | Measured accuracy better than P2 on depth-capable phones |
| Docs | Update `docs/android.md`, `docs/floor-plan.md`, `CHANGELOG.md`, this file | 1 | All checked in |

## 10. Risks and open questions

1. **Shared coordinate frame across rooms** if tracking is lost. Mitigation: doorway alignment fallback; test on a real flat.
2. **Accuracy of corner taps** where furniture hides the wall base. Mitigation: allow tapping a corner on the wall higher up
   and projecting down; show the live plan outline so errors are visible.
3. **ARCore device coverage.** Phones without ARCore get no scan (the app still works). Decide whether to show a disabled entry
   with an explanation or hide it.
4. **SDK level:** ARCore 1.57's compileSdk 37 vs this project's 36 (section 5).
5. **Rendering choice:** own GL renderer vs SceneView (not evaluated).
6. **Two layout implementations** (Swift, JS) can drift. Guard with fixtures.
7. **Open product question:** is Android scan wanted at all before the Android editor, or should the editor (P0) ship first on its own?
8. **Furniture:** the iPhone scan includes furniture from RoomPlan. Option A has none. Accept (add in the editor) or add a quick
   "tap to place a bed / sofa / table" step later.

## 11. How to test

- **Unit:** `cd web && npm test` (JS layout, golden vectors); Android `./gradlew testDebugUnitTest` for the scan-to-JSON mapping
  (corners to walls, openings, tags). No phone needed.
- **UI without a phone:** an Android emulator with ARCore's virtual scene (believed supported, verify).
- **Accuracy:** a real room with a tape-measured width, depth and door; compare wall lengths and opening positions.
- **Multi-room:** a flat with at least three rooms and two doors; check rooms meet, doors line up, floor count is right.
- **Devices:** pin a Hue or Home Assistant lamp and an AC; check they link and land in the right room.

## 12. Read this first in a new session

1. This file, then `docs/floor-plan.md` and `CHANGELOG.md` (1.5.0 to 1.5.2, Unreleased).
2. `core/Sources/HouseCore/RoomScan.swift` (model and layout) and `core/Tests/HouseCoreTests/RoomScanTests.swift` (the sample).
3. `ios/Sources/Scan/ScanController.swift` and `RoomPlanScan.swift` (what capture must produce).
4. `android/app/src/main/java/com/housecontrol/MainActivity.kt` (bridge handlers, Settings, `PlanStore` use) and `PlanStore.kt`.
5. `web/src/config.js` (plan format, levels, openings), `web/src/editor/editor.js` (what review/fine-tune needs from the host).
6. Current state of commits: `254faf2` (earlier homes, house demo, IR scenes), `9511d1c` and `13f5cca` (trace picture, Windows and Android only).
