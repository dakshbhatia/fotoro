# Verification — September 30, 2026

> **Historical record.** The dated evidence, contracts and task states below are
> preserved from the earlier slice. They do not describe current release status
> or an active work queue. Use [product](../../fotoro/docs/product.md),
> [the only active queue](../../fotoro/docs/product-backlog.md),
> [architecture](../../fotoro/docs/foundation.md) and
> [current evidence](../../fotoro/docs/verification.md). Old unchecked tasks
> and execution instructions require reconciliation with that queue before use.

## Durable account library

- `/library` reuses Ente's account catalog, encrypted uploader, thumbnail cache,
  virtualized grid and original viewer. `/gallery` retains its upstream layout;
  `/intelligence` remains a separate session-only preview.
- Photos: 16 test files, 160 tests pass. The 12 new tests cover visible-view
  metadata search, edited names, malformed dates, refresh failure/retry/offline,
  rejected upload results and optional mobile/desktop grid geometry.
- TypeScript, changed-file ESLint and production static export pass. `build-web`
  exports all 23 pages using `.next-fotoro-build`, leaving dev output intact.
- A throwaway **local** Museum account was seeded through normal email
  verification and encrypted key attributes with the server's KDF requirements.
  Browser sign-in used normal forms; no authentication or catalog was injected
  into browser storage. No personal photos or paid AI calls were used.
- Uploaded the repository's `singapore.jpg`, `man.jpeg` and `people.jpeg` through
  the real uploader. All three return after refresh. Metadata search for `man`
  displays the corresponding photo.
- Signed in from `127.0.0.1:4300`, a fresh origin with separate browser storage
  from `localhost:4300`. The same three photos restore from Museum and object
  storage; this origin logs no browser errors or warnings. This is a browser
  restore test on one computer, not a physical second-device test.
- Downloaded `singapore.jpg` from the account viewer after refresh. The browser
  saved it to Downloads even though the CUA download-event wait timed out.
  Its fresh file timestamp, size (613,520 bytes) and SHA-256 match the source:
  `cfc5b98ec69a65f04b0e4bb7c06009ad6d43362773a5b546c19a48e467a8bf95`.
- Reimporting the same photo skips the duplicate. A zero-byte JPEG remains
  `Upload needs attention` after catalog reconciliation and progress dismissal.
  Review opens item details directly and identifies `Empty file`.
- A malformed JPEG is preserved with Ente's static thumbnail fallback and is
  correctly unavailable for preview; it was moved to recoverable trash after QA.
  Trash was not emptied.
- Mobile 390×844: three columns, readable controls, glass dock and no horizontal
  overflow. Desktop 1280×720: six-column geometry with three fixture photos.
  Proof: parent-workspace `outputs/fotoro-account-library-mobile.jpg`.
- Browser QA caught and fixed two integration bugs: account search started
  before authentication, and the gallery's collection URL effect forced the
  Fotoro route back to `/gallery`. The clean-origin flow verifies both repairs.

Production hosting, signed iPhone/Safari interoperability, primary passkey
unlock, new recipient grants and synced Gemini/OCR descriptions remain unverified
or unimplemented. Browser cache eviction and unfinished-upload recovery still
need their acceptance flows; this slice does not add a persistent web upload queue.

## Earlier intelligence preview and native setup

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
new preview index is session-only; its encrypted-index sync, semantic embeddings, primary
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

## Simplified authentication — October 1, 2026

- Replaced only the Photos authentication shell with a flat Fotoro canvas and
  one form. Removed the promotional illustration, brand panel, decorative
  framing and entrance animations. Existing password, recovery, validation,
  autofill and backend identity controls remain.
- Privacy details expand with the keyboard and disclose pre-upload encryption,
  the Fotoro source repository and Ente attribution. The disclosure has no
  network effect. Password visibility toggles both ways; autocomplete remains
  `current-password`.
- Verified the existing synthetic account through normal password unlock. It
  reaches `/library` and restores the three public fixture photos. Recovery
  navigation opens the recovery-key form and returns to credentials; no
  recovery key was entered and no credential was changed.
- Checked dark and light origins, 390×844 mobile, 1280×800 desktop and 390×500
  compact layout. Mobile has no horizontal overflow; compact layout scrolls
  with an expanded disclosure. Temporary viewport overrides were reset.
- Fresh-origin authentication and recovery had no browser warnings or errors.
  The existing dev tab retained two earlier i18next Fast Refresh warnings;
  neither recurred in the fresh tab. No physical-device keyboard or password
  manager integration is claimed.
- All 160 photo tests, Photos TypeScript, changed-file ESLint, Prettier and
  production export (23 pages) pass. Screenshot evidence is in the parent
  workspace: `outputs/fotoro-unlock-before.jpg`,
  `outputs/fotoro-unlock-mobile.jpg`, `outputs/fotoro-unlock-desktop.jpg` and
  `outputs/fotoro-unlock-simple.jpg`.
- This is an authentication presentation change. The proposed pick/send/receive
  exchange and primary passkey unlock remain separate implementation work.

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
