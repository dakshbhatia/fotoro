# Verification — October 2, 2026

The web app and API are live at [fotoro.cloud](https://fotoro.cloud). The separate
local Photos preview 0.1.0 (3) is uploaded and in internal TestFlight. Its matching
development build was installed and launched on the physical iPhone;
personal Photos access remains uninspected. Full encrypted build 10 is installed,
its exact version is read back, and its running process and protected diagnostic
file are verified on the unlocked physical iPhone. The owner's screenshots show
local Photos and a signed-out Sync screen. Build 10's protected account-state event
independently reports signed out; real-account authentication remains unverified.
Apple has processed full build 4; its
TestFlight access awaits an export-compliance declaration. Independent reviews reproduced
retrieval, permission, cancellation, persistence and navigation defects; fixes
include permanent regressions and were re-reviewed.

The preceding release tree is merged in
[PR 2](https://github.com/dakshbhatia/fotoro/pull/2). Both the
[main CI run](https://github.com/dakshbhatia/fotoro/actions/runs/36960016617)
and [PR CI run](https://github.com/dakshbhatia/fotoro/actions/runs/36958905612)
passed. A reused individual Apple API key verifies Fotoro's app/build records,
but cannot provision signing certificates. These earlier credential checks
preceded the authorized Wrangler login and production deployment documented in
[release setup](deployment.md).

[PR 4](https://github.com/dakshbhatia/fotoro/pull/4) is merged at `59d66f8506`
after every exact-head native, web/API and repository check passed. That local
check passed 12 core, 28 API, 133 web and 28 release-metadata tests, typechecks
and the production web build. Actual 390×844 and 320×568 browser checks cover
search, Sync/Back query preservation, dark-mode input contrast and 44 px controls.
The temporary forced dark-mode activation was restored to the automatic media
query before the final check; this does not claim an observed OS appearance
switch. Node and workerd privacy checks confirm unknown HTTP methods cannot
enter diagnostic logs verbatim.

The authorized Cloudflare account has separate Fotoro production D1/R2 resources,
with bucket public access disabled. All five migrations are applied; the custom
domain serves the Worker. A fresh October 2 check passes the unauthenticated API
response and the exact `A7TGPQ27JF.cloud.fotoro.Fotoro` passkey association.
Real-account phone-to-Safari acceptance remains open.

| Check | Evidence |
| --- | --- |
| Contracts, crypto and loopback fixtures | 15 tests pass: schema boundaries, bounded annotations, signatures, media binding, preservation, closed diagnostic-method vocabulary and bounded public-fixture readiness retries |
| Worker/D1/R2 API | 51 tests pass, including nonce-bound password signup, challenge replay/conflicts and unchanged legacy login; upload/storage, authentication/exchange/annotation and diagnostic privacy checks pass |
| Web | 176 tests pass, including one-password entry, same-account setup retry, cancellation/account/storage fences, sharing and existing search/viewer/retention/annotation checks |
| Web production build | TypeScript/Vite pass. Account/crypto loads after Sync photos; the large encrypted-media chunk warning remains |
| Native | Latest full app 184 tests and local preview 50 tests pass locally with Xcode 27, zero failures or skips. One-password entry and signup, compact/legacy credential parity, protected storage failures, late auth cancellation, manual saving and existing crypto/journal/background/search checks are included |
| TestFlight metadata | 28 tests pass for team/individual authentication, exact app/build ownership, sparse Apple responses, notes readback and credential-safe errors. A live build 2 update preserved every existing test-note character and verified its build relationship; its processing state is VALID and beta states remain MISSING_EXPORT_COMPLIANCE. Build 3 is VALID / IN_BETA_TESTING with encryption metadata false and verified local-preview test notes |
| Distribution IPA | Actual build 3 archive and distribution IPA pass the strict preview audit. Xcode Organizer used its existing cloud-managed certificate; the copied IPA matches the unchanged archive/dSYM/link map. Apple validation and exact-IPA upload both exit 0 with success markers |
| Internal tester access | App Store Connect shows the existing internal group with one tester and one build; iOS 0.1.0 (3) is Testing and the requested sole owner tester is Invited. Association was automatic; no new tester/role/invitation mutation was needed. Inbox delivery and installation remain unverified |
| Shared retrieval fixtures | Both platforms find all 20 predeclared supported tasks; five unsupported visual tasks and five absent terms remain empty. These are development fixtures, not held-out user accuracy |
| Cross-language media | Swift decrypts frozen TypeScript vectors; TypeScript decrypts checked-in Swift ciphertext and rejects altered binding |
| Real local HTTP exchange | Three isolated tests cover fresh migrations, recovery sessions, bidirectional contribution/save, revocation, restore, byte-preserved HEIC, background ciphertext staging, encrypted labels/OCR in a fresh account session, cross-account denial and idempotent revision conflicts |
| Native local lifecycle | All-age permitted enumeration, limited/denied startup, permission purge, ten-day browse, changed revisions, cancellation rollback and refresh stability are exercised |
| Browser local lifecycle | Session-only default; retained labels/text/previews; lazy preview hydration; unavailable preview preservation; digest reselection; pending/cross-instance clear fences |

## October 2 one-password account entry

The primary iPhone and web flow uses one generated Fotoro password. It identifies
the account and unlocks its encrypted bundle locally; no username, passkey ceremony
or recovery-code acknowledgement is required. New Fotoro shows Copy/Save/Continue.
The iPhone saves the credential in protected Keychain after authenticated unlock;
Account can explicitly reveal it later. Sign out removes that local credential.
Existing recovery codes work in the same password field, and existing passkeys
remain a secondary choice.

Signup uses signed account enrollment and a separate signed, nonce-bound challenge
proof. The server receives neither the password nor unwrapped account keys. Account,
wrapper and one-use challenge commit atomically. A lost signup response or local
storage failure keeps the same displayed credential; Continue restores that account
or finishes local storage, rather than creating another account. Cancellation and
account changes fence late responses and cache writes. Native and web tests share
the compact credential byte-order vector and verify legacy compatibility.

The final local suites pass 184 native, 50 preview, 176 web and 51 API tests, with
typechecks, production web build and three isolated real D1/R2 exchange tests.
An initial cancellation test failed because its fixture sent the wrong request;
exact-path routing corrected it and the complete native suite passed afterward.
Public Simulator UI verifies the single password field, New Fotoro, signed-out
identity and an actual invalid-password tap's inline error. The live web screen
shows the same single password entry and collapsed secondary choices.

Worker `4fe935ab-892b-43e3-b8ee-8b586196c3cc` is active at 100%. The production
setup-options endpoint, authenticated API boundary and exact Apple association
checks pass. The setup probe creates no account. Signed full Release 0.1.0 (10)
passes signature and exact production-entitlement checks, is installed without
uninstalling the owner's app, and its version and running process are read back.
The bounded protected diagnostic file reports build 10 as signedOut; it contains
no credential, account reference or token. Owner authentication, photo save/restore
and browser password-manager autofill remain unverified.

## Earlier October 2 manual account and sign-in simplification

Account replaces the misleading Sync status entry. It explicitly shows signed-in
state and a stable account reference; the locked state still shows its identity
and Unlock photos. Sign-in completion activates the local account immediately,
without waiting for a catalog refresh or starting photo uploads. Recovery state
survives process restoration without depending on an in-memory message.

Native passkey assertions now honor the server's allowed credentials. Session
restoration validates identity and expiry; session acceptance persists before
changing active identity. Protected Keychain updates preserve prior values on
failure. Account switches discard the previous unlocked bundle while preserving
its enrolled keys, and late auth/card responses respect account and vault fences.
Optional PRF wrapper failure does not repeat completed account enrollment.

Automatic sync is off. Legacy automatic intent is neutralized; foreground and
process restoration read only local data. Save picks starts one current batch;
Continue saving resumes only staged encrypted files. New photos wait for another
Save picks tap. Editing labels or recognized text keeps drafts local. Explicit
Refresh saved photos performs GET-only catalog work; explicit Save or Sync changes
can send queued encrypted annotations. Already scheduled encrypted OS uploads
can finish. Pausing an incomplete selection reports unprepared picks truthfully.

Final local verification passes all 175 full-app and 50 preview tests. Public
Simulator UI verifies Account routing, visible signed-in identity, locked account
identity/Unlock photos, and the signed-out Sign in/Create account controls. Tapping
Sign in reaches the real credential ceremony and renders its expected Simulator
passkey failure inline. This does not establish an owner-phone passkey success.

Signed Release 0.1.0 (9) builds and passes signature, exact application identity
and both production associated-domain checks. It is installed over the existing
phone app without uninstalling, its version is independently read back, and its
new executable is running. The bounded protected diagnostic file reports only
account-state enums, with no account reference, token, credential or key. Its first
build-9 state is signedOut, and no owner-phone authentication attempt is recorded.
Direct and Apple CDN association probes agree on the signed application identifier.

## October 2 iPhone sign-in and refresh correction

Release always uses the production API, ignoring persisted development overrides.
Sign-in begins visibly, rejects overlapping attempts, and reports errors inside
Sync. Apple passkey cancellation/failure messages explain how to retry. An accepted
session with missing local vault keys stays in recovery; it cannot activate or
request the encrypted catalog. Successful recovery clears stale guidance so a
later Lock account still offers ordinary local unlock.

Foreground refresh keeps valid photo viewers, immutable selections and original
Share exports. Fresh permission and source revisions still withdraw edited,
removed or revoked photos. A delayed preview download cannot restore a deleted
catalog row or overwrite newer metadata, manifests or cache fields. Failed OCR
retries once on explicit/foreground refresh. Gallery thumbnails account for display
scale and reject degraded callbacks after a final image. Settings shows build and
encrypted/local-preview flavor.

The final full suite passes 160 tests; the shared local-preview suite passes 50,
both with zero failures or skips. The 24 preview-artifact verifier tests also pass.
Actual public Simulator QA keeps the viewer and original system Share sheet
across Home → foreground with the same running process, and confirms Settings
shows `Encrypted sync · 0.1.0 (8)`.

Signed Release build 8 compiles, passes signature, exact application identity and
Associated Domains checks, and carries no local-preview encryption exemption.
CoreDevice independently verifies installation, successful launch and protected
build-8 runtime events on the physical iPhone. Installation preserves the app
container. Auth/API logs now include request starts, rejected preflight outcomes
and numeric Apple authorization codes, while retaining the existing bounded,
fixed schema without URLs, payloads or credentials. The owner reports opening
Sync status; no physical auth/API attempt is recorded yet, so real-account sign-in,
personal upload and restore remain unverified.

## October 2 smoothness and diagnostics

First-use Sync can request Photos access inline without enabling uploads; already
queued encrypted work remains resumable. Recovery acknowledgement belongs to the
exact displayed code. Busy account actions cannot overlap. Exchange errors stay
visible inside the active sheet instead of dismissing it behind a parent alert.

Hidden browser galleries retain their measurements and scroll anchor. Rendered
public-fixture QA at 390×420 verifies scroll offset 169 survives Sync → Back;
keyboard focus moves into Sync and returns to its opener. Search and the selected
subset also survive. At 390×844, six public photos render with one picked original
and usable search/Add controls. Share becomes disabled while its native request
is pending. Native destination sharing and personal Safari acceptance remain open.
No browser console warnings or errors were observed. The same six public originals
also render on the deployed `fotoro.cloud` app at 390×844; Photos → Sync → Back
preserves the subset and restores focus there.

Full native builds now write fixed-schema launch, pick timing, consent, sync-state
and API outcomes to OSLog and a protected 160-event/64-KiB local file excluded from
device backup. Privacy, numeric bounds, UUID correlation, rotation and cancellation
classification have permanent regressions. Production enables stored Worker logs
with invocation logs disabled; console failures use allowlisted phase/class fields.

Worker `dc276b07-ef33-4d12-b8ae-d053bf3b692b`, tagged
`smooth-diagnostics-20261002`, is read back as the 100% deployment. Canonical API,
exact signed association and byte-identical production HTML checks pass. Signed
Release 0.1.0 (6) passes signature and Associated Domains checks and is installed
on the physical iPhone. After unlock, CoreDevice revealed that the installed app
had been replaced by local-preview build 3. Reinstalling full build 6 without
uninstalling restored the correct executable and version. Successful launch and
bounded launch/pick events were read back from the protected diagnostic file;
no photo contents or credentials were copied. Personal sign-in, sync and restore
remain unverified.

The final local checks pass 43 API, 164 web, 139 full-native, 49 preview and three
isolated HTTP exchange tests. Main CI run `37037972537` failed one earlier native
case when Wrangler's local ProxyWorker lost a recovery-verification connection;
the final native suite passes that case locally. CI now requires exact service
readiness and performs a loopback public-fixture recovery preflight with fresh
challenges and three bounded proxy-only attempts. Application JSON errors fail
immediately. Three regressions and actual local preflight pass; the low-level
proxy disconnect cause is unconfirmed. This is distinct from a Hono response,
which carries a request reference. The exact PR 12 head subsequently passes every
required check in [run 37041989323](https://github.com/dakshbhatia/fotoro/actions/runs/37041989323):
137 full-native and 47 preview tests pass, with the same two public Simulator
Photos permission/initialization cases skipped in each suite. Those cases pass
locally. [PR 12](https://github.com/dakshbhatia/fotoro/pull/12) is merged at
`f3e9b8e247db3dff43733d634997735308bfc582`. The inherited Ente documentation
deployment jobs are now restricted to their upstream repository.

## October 2 preceding consumer finish

Recovered the native automatic-picks work and PR 10's compact browser controls.
Native home defaults to suggestions, keeps All Photos available and adds only
current picked revisions to new sync work. Previously queued uploads remain
resumable. Unavailable previews retry on foreground and explicit Sync. Stable
viewer presentations, cumulative pinch zoom, search refresh/error fencing and
preview failure feedback complete this pass.

The final `pnpm check` passes core/release checks, 36 API tests, 160 web tests and
the production build. Three isolated HTTP tests verify encrypted exchange,
annotations and unchanged HEIC restore. Final native full/preview suites pass
131/49 with zero failures or skips. Independent review's incomplete-preview
finding is fixed and covered by a store regression. Public Simulator QA verifies
Picked for you, All Photos, the visible original and its system Share sheet.
The implementation at `2ca5aecc78` also passes native, preview, web/API and
repository CI in [run 37034528513](https://github.com/dakshbhatia/fotoro/actions/runs/37034528513).

Browser QA on `127.0.0.1:4310` at 1280×720, 390×844 and 320×568 verifies compact
controls, Settings selection editing, digest reselection enabling Share, keyboard
recovery submission, deleting the last matching label without an inert gallery,
and Photos → Sync → Back. No relevant console warnings/errors were observed;
the existing build-time sodium chunk-size warning remains. These checks use the
in-app browser and public fixtures; personal physical Safari acceptance is open.

Production Worker `82df2ca2-b808-42f8-a38c-ac26779ac157`, tagged
`consumer-finish-20261002`, serves the new web/API build at `fotoro.cloud`.
Release iPhoneOS build 0.1.0 (5) compiles and passes signature, bundle/version and
exact Associated Domains checks. CoreDevice verifies physical installation as 0.1.0 (5) and successful launch.
Personal sync and original restore remain separate from automated checks and
the unchanged TestFlight compliance gate.

## Earlier app checks — October 1–2, 2026

The consumer update was rendered at an actual 689×797 browser viewport. A neutral
receipt is found by recognized text; opening Sync and returning preserves its
query. Navigation now clears the floating toolbar. Reopened retained previews
cannot share absent originals: different bytes with the same filename leave Share
disabled, and reselecting the exact original digest enables Share. This browser
session exposed Share rather than Download; its native share destination was not
inspected. An IAB 390×844 override did not alter the actual dimensions, so this
update does not add a phone-size Safari rendering claim.

On October 1, the full consumer checkpoint installed on the connected owner's
iPhone with Associated Domains intact; a subsequent launch was refused while
the phone was locked. On October 2, the matching development-signed local preview
0.1.0 (3) installed and launched successfully. CoreDevice independently verifies
its installed version/build and running process. Personal Photos access and
usability have not been inspected. Simulator public samples
exercise restored ten-day browsing,
all-age receipt search, owned saved catalog search and both original system Share
sheets. Final native consumer fixes pass all 103 tests. Review reproduced a fast
Continue no-op behind settling workers and share URLs being evicted by subsequent
downloads. Continue now waits, respects newer Pause/account/cancellation intent,
and resumes only the previously authorized scope. Originals use protected
share-owned copies with completion/dismissal/failure/cancellation/lock cleanup.
Actual held-worker and filesystem regressions fail before and pass after fixes.
The full test's real PhotoKit interaction now uses its own database and waits for
metadata/label readiness; it keeps its inserted older-asset and label-query checks
without waiting for unrelated OCR of all accumulated public samples.

The following earlier rendered evidence describes the preceding search iteration.

In the in-app browser, public receipt and photo samples exercised one leading
result, evidence, ambiguous meanings, verbatim diacritic labels, all three matching
photos, navigation away from a pinned representative, and replacing that choice
from the viewer. Desktop 1265×864 and phone 390×844 checks put the controls above
the toolbar; at 320×568, scrolling reveals the complete row. Local English OCR found
`INVOICE 4826` in a neutral-filename receipt. Its recognized text, labels and
bounded previews survived a controlled reload after Saved locally reported 3/3.

After reload, original download was disabled. Selecting the identical SHA-256
original enabled sharing. Selecting different bytes with the same filename kept
the receipt's original disabled. Turning retention off followed by reload returned
to the empty canvas. Clear during OCR startup returned to the empty canvas. Worker
initialization, active recognition, rotated text, blank text and cancellation are
also covered by the OCR harness and protocol tests.

Simulator checks exercised the genuine Photos permission prompt, local grid,
ambiguous Ro completion, an explicitly chosen meaning surviving prefix extension,
label persistence after relaunch, an older January 2020 asset outside the 30-day
canvas, and Clear returning to recent browsing. All screenshots use public samples.
Native tests also recognize the neutral receipt and rotated boarding-pass fixtures.

Search evidence: [retained browser result](../apps/web/Evidence/local-search-retained.png),
[phone-size browser result](../apps/web/Evidence/local-search-mobile.png),
[rotated browser OCR](../apps/web/Evidence/local-ocr-rotated.png),
[native ambiguity](../apps/ios/Evidence/search-ambiguous-prefix.png),
[native chosen meaning](../apps/ios/Evidence/search-selected-prefix.png),
[native older photo](../apps/ios/Evidence/search-older-photo-details.png),
[native clear](../apps/ios/Evidence/search-clear-recent.png).

Prior sync/exchange checks exercised real local Worker recovery, interrupted
browser import, native durable journals, restored media after sandbox relocation,
public-account upload guards, and explicit account setup preserving selected files.
The HTTP and Simulator checks do not establish a physical iPhone-to-Safari run.

Consumer sync now carries owner-only encrypted labels, supported OCR text and
other annotations separately from immutable originals. Independent review found
and re-reviewed fixes for explicit lock persistence, stale catalog pages, older
search-result edits, cancellation and same-field conflicts. Resolving a label
conflict preserves unrelated remote OCR. Personal search history and pinned
choices stay local; shared recipients do not receive these private annotations.

The browser's simple Sync photos entry preserves the selected local collection.
Create account, Sign in and Use a recovery code are the three initial choices.
Rendered public-sample checks confirmed Settings, that entry, return to local
photos and an `invoice` search finding the neutral receipt through recognized
text. Evidence: [sync onboarding](../apps/web/Evidence/consumer-sync-onboarding.png),
[receipt search](../apps/web/Evidence/consumer-receipt-search.png),
[native local gallery](../apps/ios/Evidence/consumer-photos.jpg),
[native receipt search](../apps/ios/Evidence/consumer-search.jpg),
[native sync status](../apps/ios/Evidence/consumer-sync-status.jpg).
Public seeded accounts deliberately disable private uploads; their status screen
is not evidence of personal account sync. The native integration test separately
used a synthetic real local account and restored encrypted annotations in a fresh
AppServices instance.

Explicit native Pause now persists separately from Photos backup opt-in. It
preserves queued media and annotation edits across foreground/process restoration;
Start/Continue releases the fence. Existing manual Files imports still work before
Photos opt-in. Three controlled regressions fail before the fix and pass afterward;
the complete local native suite passes 88 tests. Independent review found no
actionable P1/P2. Controlled commit probes bypass real staging PUTs; these tests
prove dispatch/persistence guards, not physical background transfer. Prior iOS 26
CI passed 85 tests with one expected permission skip. Earlier loopback connection
losses remain unexplained; failure service diagnostics are retained in CI.

## Measurements and limits

The frozen fixture SHA-256 is
`e28fb36c55da9b0979665537c2d68e3aedf96ae09b5ace1aadeb75b01413280e`.
The native resource copy matches it. Retrieval fixtures use supplied synthetic
metadata/OCR; actual OCR quality is checked separately with public images.

On this Mac with Node 22.23.3, a pure browser index of 10,000 synthetic records
built in 20.94 ms; 200 warm lookups had p50 4.83 ms and p95 5.33 ms. On iPhone 18
Pro Simulator with Xcode 27, the native 10,000-record metadata index built in
5,732.83 ms; 60 warm lookups had p95 12.47 ms. Simulator process footprint rose
from 119,966,264 to 129,862,200 bytes in that run. These different synthetic corpora
are not a platform comparison. Neither benchmark includes PhotoKit/image decoding,
preview delivery, rendering, OCR throughput, physical-device battery or memory.

A later 10,000-record corpus with 296 OCR characters per photo exposed repeated
date/history parsing inside browser ranking. Precomputing rank keys once per
eligible photo preserved 1,440 generated full-result comparisons and all existing
search regressions. Twelve warm Node samples on this Mac measured receipt lookup
p95 172.00→16.65 ms; this is a synthetic engine comparison under concurrent load,
not Safari/iPhone frame latency. Full OCR dictionary rebuild after feedback still
costs roughly 197–357 ms in that synthetic experiment and remains separate work.

Browser previews hydrate lazily and are retained up to 100 MiB. Generated raster
caches are bounded to 48 MiB; this does not bound decoder or total process memory.
Full OCR text currently hydrates with encrypted photo metadata, and the in-memory
index is rebuilt from it. Separate persisted postings/detail-text hydration and
large-library memory scaling remain unverified requirements.

Browser OCR uses pinned Tesseract.js/core 7.0.0 and English data 1.0.0. The generated
worker/core/language package is 47,797,598 bytes; a worker fetches its selected core
and English data. Asset preparation records SHA-256 provenance before dev/build.
All configured runtime paths use this origin; no inference service receives photo
bytes, queries or recognized text. A recognition quality gate and rotation retries
are engineering rules, not calibrated accuracy or intent confidence. Physical
Safari performance and a larger OCR quality corpus remain unverified.

Native search includes all permitted non-hidden still photos, while browsing stays
at ten days. Native OCR uses network-disabled local previews, so iCloud-only assets
can have incomplete text coverage. Local labels/history are excluded from device
backup. Labels and supported OCR for photos explicitly synced to an account now
travel as encrypted annotations. History and pinned choices stay device-local.
Browser search covers explicitly selected/retained records and verified account
records; it cannot enumerate an iPhone photo library automatically.

## Remaining release gates

- Full encrypted TestFlight access: build 4 is `VALID` but remains
  `MISSING_EXPORT_COMPLIANCE`. Its actual encryption declaration and France
  distribution answer are open. Local Photos preview build 3 is separately
  `VALID / IN_BETA_TESTING`; personal TestFlight installation remains unverified.
  Signed full build 5 is installed and launched directly on the physical iPhone.
  Production HTTPS, API routing and the signed passkey association now pass.
  Universal-link handling remains unimplemented.
- Physical passkey/PRF and non-PRF flows, original PhotoKit/iCloud resources and a
  complete iPhone-to-Safari restore. See [release setup](deployment.md).
- Physical background continuation, file protection, daemon reconnection and
  termination/relaunch checks. Background URLSession can continue an already
  scheduled encrypted file; reservation, additional PhotoKit preparation, signing
  and final commit wait for the foreground unlocked app. The durable journal
  currently schedules representations serially. Pause/logout cancel transfers;
  explicit lock lets the scheduled ciphertext finish while clearing plaintext.
- Older supported iPhone and Safari measurements using 10,000 items and 1,000
  distinct thumbnails: frame pacing, query-to-visible preview, memory and battery.
- Final-object garbage collection and deletion/retention races. Final ciphertext
  is retained conservatively; abandoned objects can consume storage.
- Native camera QR scanning and credential-management UI.

Native cloud imports preserve JPEG/PNG/HEIC originals up to 50 MiB. Copies are
320/1600 px JPEG at quality 82%; they never replace originals. Live Photo stills
render locally, but backup skips motion pairs and videos. Browser import accepts
JPEG/PNG and skips unknown dimensions, including current HEIC metadata, before decode.

Semantic search, inferred face groups, cleanup, video intelligence and nearby
transfer remain planned. Production auth rejects fixture headers; production web
builds disable fixture mode. Public fixture accounts block private uploads.

## Local Photos preview validation — October 1, 2026

The approved `FotoroLocalPreview` target compiles nine allowlisted shared sources
and links GRDB only. It excludes Fotoro account, encrypted backup, transfer,
Sodium and saved-account views. The full target retains its packages and signed
Associated Domains capability. The shared Info.plist uses an explicit build-mode
macro; only the preview target declares no non-exempt encryption. Artifact
validation, rather than source flags alone, is required before uploading it.

The actual default-root isolation regression failed five assertions before the
namespace change and passed after it: preview records/pins/use history neither
read nor alter the full app's index, including the same permitted asset. The
complete preview suite passed31/31; the full app protection suite passed104/104,
with zero failures or skips. The older public PhotoKit asset and local Vision
recognition cases passed. The isolated artifact-verifier harness covers unexpected
binaries, dSYM mismatch, excluded cryptography code, tool failure, forbidden
resources/entitlements and unsafe ZIP entries; its actual archive/IPA checks are
retained separately in private release output.

Public Simulator UI acceptance verified the ten-day gallery, explicit local-beta
scope, receipt OCR including an older photo, local label persistence after reopen,
and the original PNG in the system share sheet. Dismissing the sheet removed its
share-owned temporary copy. These checks do not establish personal Photos, iCloud
network, physical share destinations or hosted backup acceptance.

Source3462930f01 also passed both remote CI jobs in run36947146042. The
artifact harness passed24/24; native full104 and preview31 executed with zero
failures and one Photos-permission interaction skip in each remote suite. That
older public PhotoKit test passed in both permitted local suites. The final
preview rebuild after the toolbar sizing fix also passed its rendered check.
On October 2, build 3's actual distribution IPA passed the unchanged archive/IPA
audit, Apple validation and exact-IPA upload. The API now reports VALID and
IN_BETA_TESTING with verified local-preview notes. Personal installation remains
unverified. See [release setup](deployment.md).
