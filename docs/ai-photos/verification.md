# Verification — September 30, 2026

Verified the development slice on `codex/ai-photos`:

- Photos workspace: 14 test files, 148 tests passed, including 9 new intelligence
  behavior tests. Opt-in and missing-key guards issue no requests; fake transport
  verifies the 3.8 payload, schema boundary, error handling, and token accounting.
- Photos TypeScript check and ESLint for the three changed TSX files: passed.
  Prettier for changed frontend files, Node wrapper syntax and Git whitespace: passed.
- Both prelogin and photos Rust/WASM packages: built successfully.
- Local Museum `/ping` and source web `/intelligence`: HTTP 200.
- Developer doctor: Node 22.23.3, Flutter 3.47.2, Rust 1.98.1, Go 1.26.6,
  Xcode 27.0, Docker 29.4.0, Compose 5.1.2.
- Mobile dependency/Rive/FRB setup: completed after installing rustfmt. Generated
  bindings leave no tracked changes. CocoaPods 1.17.0 is now installed with Ruby 4.0.7; the unsigned iOS debug
  device build passes and produces `mobile/apps/photos/build/ios/iphoneos/Runner.app`.
  The Simulator build also passes at `mobile/apps/photos/build/ios/iphonesimulator/Runner.app`.
  Flutter analysis after upgrading `home_widget` to 0.10.0: no issues.
  Signing and physical-device flows remain unverified.
- CUA in-app browser: meaningful page, no framework overlay. Synthetic JPEG
  import shows three photos; the second byte-identical image is the one duplicate
  copy; searching blue returns one photo. Developer setup is accessed through the explicit setup URL. Consent/key
  gating and the latest carousel interactions are described below.
- Glass layout: checked at the default panel, 1280×900 desktop, and a 390×844 mobile
  viewport. Mobile document width equals viewport width; no horizontal overflow.
- Earlier console warning about MUI's removed `flexWrap` prop was corrected;
  no new relevant app warnings appeared after the correction.
- Fresh review found overlapping imports and a stale viewer object. Added a
  synchronous import guard, disabled the empty-state add action during work, and
  derived viewer contents from the current photo by ID. TypeScript and the full
  photos suite pass after those repairs.

Live Gemini requests were not made: no paid key was supplied. Provider quality,
latency, browser CORS, and real billing still require a live smoke test. The
new preview index is session-only; account sync, semantic embeddings, primary
passkey unlock, and nearby trusted sharing are roadmap work in `architecture.md`.

The existing Ente app's broader encrypted sync and storage flows were inherited;
they were not newly verified end-to-end against a signed iOS build in this slice.

## Photo-first redesign

- Image Gen library and viewer references were created before this redesign.
  UI uses code-native controls and actual repository sample images, never a
  flattened mockup or invented personal library.
- Mobile logical viewport: 390 × 844. White library, three-column mosaic,
  3px gutters, 4px corners, and 358 × 58px search/import control. Original photo
  stays uncropped in the black full-screen viewer. Default desktop panel also
  checked; mobile document width equals viewport width.
- Browser carousel: direct horizontal pointer drag advances Singapore to the
  next image; Next/Previous and arrow keys navigate the current result set.
  Details disclose real filename/dimensions, close on advance, and Escape/close
  dismiss. The background becomes inert only while the viewer is open.
- Original-sharing control is shown because the browser advertises file-sharing
  support. No file was sent to a recipient. Multi-touch pinch, physical iPhone
  gesture feel, and passkey/sync flows remain unverified.
- CSS supplies reduced-motion, reduced-transparency and missing-backdrop
  fallbacks. Preference settings were not changed on the user's computer.
- Fidelity comparison: heading hierarchy, white/black canvas colors, photo crop
  in grid versus uncropped viewer, outline symbols, target sizing, glass edges,
  control spacing and logical mobile layout were inspected against references.
  QA library has four repository sample photos, rather than eighteen generated
  examples. The disabled previous control marks the first item; a duplicate
  badge identifies the actual copy. Those differences depend on real data.
- The reference raster is 853 × 1846, representing the brief's 390 × 844 logical
  phone viewport. Browser QA checks that logical size; the in-app viewport API
  does not expose a device pixel ratio override.
- Responsive viewer uses the 1536px derivative at normal scale and offers the
  original through `srcset` for zoom. Viewer blob URLs belong to the viewer and
  are revoked on close. Library blobs are retained for URL regeneration after
  Fast Refresh cleanup, preventing broken images while iterating. URL creation
  stays outside replayable React state updaters. Browser inspection confirms
  the derivative is selected at normal scale and the original at a 1920px zoom.
- Fresh import, cloud-off search, exact-copy review and missing-key Done gating
  were rechecked after the final fixes. No browser errors or warnings were logged.
- A 28-photo fixture library (repeated public repository samples) exercises scroll.
  Disabling inherited flex shrink fixes a black background below the first screen.
  A coordinate tap and close preserve scrollY 470.5 and restore thumbnail focus.
  The browser locator itself centers targets before clicking; this is separate
  from the viewer's scroll behavior. Temporary stress fixtures are removed afterward.

## Fidelity ledger

Concepts and final browser JPEGs were opened with `view_image` in the same QA pass.
The reference and implementation were compared at the logical mobile viewport.

| Comparison | Concept evidence | Render evidence and disposition |
| --- | --- | --- |
| Copy and hierarchy | Photos, Search photos, contextual duplicate Review; Share and Details in viewer | Same control names and hierarchy. Duplicate count comes from files. No added navigation or marketing copy. |
| Layout | Three-column canvas and one bottom pill | Three columns, 3px gutters, 4px corners and 58px pill. Four QA photos instead of 18 generated examples is an intentional data difference. |
| Typography | Large compact heading, restrained system control text | 34px mobile / 44px desktop heading; 16px search and 14–15px viewer controls. No browser-default button typography. |
| Palette and glass | White canvas; black viewer with neutral translucent controls | Same palette, restrained blur and hairline edges. Fixed the canvas shrinking below a long grid. Glass remains clear of the images themselves. |
| Photo treatment | Square thumbnails; uncropped landscape in the viewer | Same actual Singapore photo is uncropped in the viewer; original source becomes available for zoom. No screenshot is used as UI. |
| Icons and states | Thin outlined symbols, circular arrows, pill Details | Code-native outlined symbols match the reference. Previous is disabled at the first photo; duplicate badge and conditional Share follow actual state. |
| Responsive and motion | Phone proportions and thumbnail continuity | Logical 390×844 and desktop 1280×900 checked. 180ms opening/closing; reduced-motion CSS provided. Physical multi-touch and native glass are not claimed. |

Above-the-fold copy comparison has no unexplained additions. All remaining
differences above are data, capability or reference-raster differences. The web
library and viewer were faithfully verified against their visual references.

## Native compatibility

Initial iOS 27 launch failed in UIKit's no-scene-lifecycle check. Manual adoption
of `FlutterImplicitEngineDelegate` and a `FlutterSceneDelegate` moves plugin
registration to engine initialization and the foreground heartbeat to scene
callbacks. Background scheduler registration remains before app launch finishes.
Legacy app_links and receive_sharing_intent URL callbacks are forwarded explicitly;
home_widget uses its own scene callbacks. Share-extension, widget-link and
background-sync behavior still need device-level regression checks.

A longer initial run then exposed an inherited `home_widget` 0.8.0 crash writing
`NSNull` to UserDefaults for `totalMemories`. The fork upgrades only that package
to 0.10.0, including its official fix and scene support. Sources:
[Flutter UIScene migration](https://docs.flutter.dev/release/breaking-changes/uiscenedelegate),
[home_widget changelog](https://pub.dev/packages/home_widget/changelog).

Final unsigned device build and Simulator build both pass. The app remains
running for more than two minutes on iPhone 18 Pro / iOS 27, past the previous
startup-crash window, with onboarding still visible and no recurrence in its
runtime log. Screenshot: `outputs/ios-onboarding-verified.jpg` in the parent
workspace. No account was created or private photo library accessed.

The new glass UI is currently web-only. Simulator onboarding validates native
startup compatibility; it does not validate the planned native AI, passkey,
nearby-sharing or cross-device sync experience.
