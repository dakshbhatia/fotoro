# Fotoro native app

The full app serves Sync, Search and Share. See [product](../../docs/product.md),
[foundation](../../docs/foundation.md) and the sole active
[product backlog](../../docs/product-backlog.md). Current build/distribution
status belongs in [deployment](../../docs/deployment.md); test and device evidence
belongs in [verification](../../docs/verification.md).

Open `Fotoro.xcodeproj`, scheme `Fotoro`. Xcode27/iOS26+; SwiftPM pins Sodium0.11.0, GRDB7.11.1 and Nuke12.9.0. `python3 generate_project.py` regenerates the checked-in project after adding source files.

The app starts in a local Photos canvas. Open Photos requests access, then opens the permitted library. Picks is a separate choice for recent highlights from the last 10 days using small local previews. Photos and Search preserve access to every permitted original. Native bottom Search and a compact scope/Sync toolbar keep the grid prominent; Settings stays in the scope menu. Photo viewers open full screen and return through Done. Received photos use a thumbnail grid and explicit Save in the viewer; owned Saved photos expose Save to Photos beside Share, with Info under More. Another-device access puts Copy password first and confirms the copy. Existing Photos permission restores the gallery on launch. HEIC and Live Photo still previews use Apple's decoder. Search reads date/favorite/screenshot/location metadata and local Vision OCR, alongside unlocked owned saved records. Full-app visual search runs pinned TinyCLIP Core ML models locally on bounded previews and keeps vectors local. Public model downloads are hash checked; they contain no personal photo data. Inferred scenes are distinct from supplied labels, and scene publication remains disabled for reader compatibility. Share explicitly exports original resources to a protected temporary folder and presents the system share sheet. Restoring an existing account maintains the backup status; opening local Photos never opts the library into uploads.

Sync opens the encrypted account catalog. Current account entry uses one locally generated Fotoro password, saved securely on the device and used to open the same account elsewhere. Existing accounts can optionally add a passkey under another-device access and choose Use a passkey at sign-in. A compatible PRF credential wraps the existing keys; a fresh device may require two system assertions to discover the account and unlock it. Unsupported PRF retains password recovery. Device approval remains available; Apple ID login is not delivered. Its endpoint defaults to `https://fotoro.cloud`; developer connection and public fixture controls are under Advanced in DEBUG. Real local Worker testing uses `http://127.0.0.1:8787`, fixtures8790. Release excludes fixture actions and fixture unlock. Physical passkeys require signing, HTTPS and associated domains.

The encrypted catalog opens from GRDB after Keychain/password recovery/PRF/device unlock. Imports preserve JPEG, PNG and HEIC originals byte for byte, plus supported MP4/MOV videos and complete Live Photo still/motion containers. Each complete original must fit within 50 MiB; unsupported or larger originals remain in Photos and appear as partial/skipped work. Originals are unchanged; browsing copies are JPEG thumbnails at 320 px and previews at 1600 px, quality 0.82. Ciphertext is staged under protected Application Support/Pending.

Opening local Photos does not opt into uploads. After private account unlock and Photos permission, explicit one-time automatic Sync consent scans permitted photos and videos while Fotoro is open and unlocked. Its preference is scoped to the account catalog and endpoint origin. Changes to Photos trigger a new scan; account, vault, origin, permission and source revision fences prevent stale work. Manual Sync remains available. Each account-scoped asset identifier receives a durable photo ID; its checkpoint, catalog photo and transfer journal insertion commit atomically. Existing pending work stays resumable. Retry reconciles the same reservation/commit operation; repeated scans and owned original digests reuse an existing photo. Photos edits do not replace the unmodified original.

An excluded changed Photos revision remains incomplete even when an earlier
revision was saved. That earlier original stays available; resource admission
can recover and retry without another asset revision change. Replacing synced
OCR with absent or incompatible OCR restores the local index's existing OCR
text, confidence and status instead of retaining obsolete remote text.

Backgrounding or vault lock stops new Photos preparation at durable boundaries. iOS may finish already scheduled ciphertext staging uploads using bounded, expiring capabilities, without account credentials or plaintext in the background daemon. Commit and catalog publication require foreground authenticated reconciliation. Pause/disable/sign-out and account/origin changes cancel or fence work; this is not a promise that a closed app imports new Photos. Public fixture mode and the two seeded public account IDs cannot sync device Photos, including when authenticated by recovery. Safari can read the same account’s committed encrypted changes; camera-media negotiation preserves older-reader compatibility. Production allowance is 10 GiB of reserved/stored ciphertext; the client’s saved-original summary counts logical original bytes.

From `fotoro/`, prepare the public local accounts with `pnpm seed:local`, run `pnpm dev:fixtures` on 8790, and run `pnpm --filter @fotoro/api dev:native-test` on 8787. The latter runs the real bundled Worker directly against local D1/R2 without the development proxy. Run `pnpm test:ios`; the helper discovers an available iOS 26+ iPhone Simulator. Optionally set `FOTORO_SIMULATOR_ID=<discovered-UDID>` to choose one. For a direct invocation from `fotoro/apps/ios/`:

```sh
xcodebuild -project Fotoro.xcodeproj -scheme Fotoro \
  -destination 'platform=iOS Simulator,id=<discovered-UDID>' \
  -derivedDataPath /tmp/fotoro-native-derived \
  test CODE_SIGN_IDENTITY=-
```

Leave Simulator ad-hoc signing enabled. `CODE_SIGNING_ALLOWED=NO` makes Keychain tests fail with missing entitlement access.

Tests cover frozen JS/libsodium vectors; native signature equality; wrong binding/key/signature/version, reordered/truncated/trailing media; original byte retention; edited/iCloud read faults; GRDB journal restart and ambiguous commit; receive/save/contribute and retention after grant removal; lost save receipt after revocation; real Worker recovery-session authentication and signed device enrollment/replay rejection. The crypto test writes `Documents/native-interop.json` in the Simulator app container for reverse JavaScript decryption.

Physical passkey/PRF ceremonies, real iCloud conditions, Photos edits, large-library performance and OS background completion require their own device evidence; Simulator tests do not establish them. See the canonical verification record for what actually ran. Device approval transfers explicit JSON through ShareLink/paste; camera QR scanning remains open. Exporting received cloud photos into Photos remains open.

Full builds record bounded runtime diagnostics in OSLog (`cloud.fotoro.Fotoro`, category `runtime`) and protected `Library/Application Support/FotoroDiagnostics/runtime.jsonl`. Launch, pick-analysis duration, Photos consent, sync state changes and API outcomes use fixed categories, counts, status/network codes and UUID request references. The file keeps at most 160 events and 64 KiB, writes on a utility queue and is excluded from device backup. It excludes photo contents, filenames, paths, account/photo identifiers, queries, keys, recovery codes and raw error descriptions. The separate local-preview target does not compile this account diagnostics implementation.

For TestFlight, use `FOTORO_DEVELOPMENT_TEAM=<your-team> node tools/build-testflight.mjs <build-number> --upload` from `fotoro/`. The helper archives and uploads with the signed-in Xcode account, or all three optional `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID` variables. It keeps artifacts and private logs under the system temporary directory. Verify processing and complete Apple's encryption questionnaire before distribution; this app uses third-party end-to-end encryption and must not blindly declare that it contains no encryption.

Full-app upload requires both archive and exported-IPA audits: requested build,
signed app identity, production associations, matching arm64 binary/dSYM UUIDs
and ten defined static crypto symbols. These checks run before upload and their
orchestration regressions are included in `pnpm check`. Passing them does not
establish distribution signing availability, Apple processing or a phone install.

For the separate local-only preview target, select scheme `FotoroLocalPreview`. This separate app target compiles only the shared PhotoKit canvas, local search, Vision text processing, local labels and original sharing; GRDB is its only package product. Account, backup, transfer and third-party cryptography code/resources are excluded. Its `FotoroLocalPreviewSearch` index is separate from the full app index. Both apps use the same bundle identifier; installing one replaces the other while keeping their stored indexes separate. The full scheme and encrypted formats are unchanged.

Run `node tools/test-ios.mjs --local-preview` from `fotoro/` to test this target in its own build directory. Release with `FOTORO_DEVELOPMENT_TEAM=<your-team> node tools/build-testflight.mjs <build-number> --local-preview --upload`. The helper checks the archive and a distribution-signed IPA, matching dSYM symbols and link map before upload. Only this audited Apple-OS-only target declares `ITSAppUsesNonExemptEncryption = false`. Each build still requires actual App Store Connect processing and tester assignment before it is available.
