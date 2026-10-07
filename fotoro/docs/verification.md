# Verification — October 6, 2026

This is the current evidence record. [The backlog](product-backlog.md) owns next
work; [product](product.md) owns the intended experience. Earlier measurements and
release checkpoints are preserved in the [historical appendix](history/verification-through-pr38.md).
No speed, accuracy, cost or adoption claim is inferred from a passing smoke test.

## October 6 foundation implementation checks

The follow-up foundation pass makes optional passkeys reachable from existing
account access on iOS and web. Enrollment preserves the same account keys and
verified password recovery. PRF-enabled credentials that cannot evaluate during
creation use a selected-credential assertion before wrapping keys. Browser
discovery leaves per-credential PRF inputs out of its unbounded request and then
evaluates the selected credential; native discovery also omits cached PRF inputs,
then uses remembered local keys or a selected assertion for the same account.
Fresh native access follows the same account
and credential binding. Unsupported PRF keeps the password path. Back, lock,
account/origin replacement and native task cancellation fence publication. Native
ceremony cancellation releases the controller and ignores late callbacks from
older operations. These checks use simulated credential responses and real local
cryptography, not qualified physical passkeys.

Search distinguishes missing previews, unavailable inference, partial visual
coverage and unfinished/failed OCR from a completed empty result. Saved OCR
retains its source revision while adapting its display photo ID. Reopened source
files can retry OCR, and Picks rechecks per-photo access through ranking. Search
details distinguish reviewed People and kept machine observations from supplied
text. Mounted Search/viewer/thumbnail leases survive cache eviction and release
on cleanup; Saved browsing requires derivatives rather than silently fetching an
original. Saved thumbnails restart on page return. Native previews expose retry
after terminal PhotoKit errors, still viewers support bounded zoom/pan, accessible
navigation remains available, and offscreen motion loading/playback stops.

Final web verification passes 488 tests, TypeScript and the production build.
Thirteen browser passkey regressions cover identity/recovery preservation, supported and
unsupported PRF, account selection and cancellation. A fresh built startup check
passes all three cases at 417,908 bytes in one static JavaScript chunk. Earlier
unchanged core/API/release checks pass: 33 core and 80 API tests, search/Picks
fixtures, preview artifact checks and nine release orchestration cases. The
isolated Photos preview passes 112 of 113 tests with its existing Vision skip.
Final full native verification passes 395 of 396 tests with the same existing
Vision skip and no failures, including 46 recovery tests. A native CI compiler
limit in the Saved viewer's lifecycle expression was repaired with an explicitly
typed scene-phase callback and small cleanup helpers.
[CI run 37553744702](https://github.com/dakshbhatia/fotoro/actions/runs/37553744702)
passes on release source `55ec36a5e24e0461d62280e1fee119a1b042d3ac`, including
the final native discovery repair. CI executes 396 full native tests with five
Photos-permission skips and no failures (391 passed), including all 46 recovery
tests; the isolated preview executes 113 with four permission skips and no
failures (109 passed). These CI skips differ from the single local Vision skip.
The read-only live service check also passes authenticated API and signed-app
passkey/universal-link association checks; it does not qualify device behavior.

Build 41 (0.1.0) archives that exact source, with all 143 recorded native input
hashes matched. After the existing Xcode account was refreshed, the same archive
and distribution-signed IPA passed the full release audit and upload succeeded.
Apple completed processing on October 6; compliance declares standard algorithms
outside Apple's OS and preserves the approved France exclusion. App Store Connect
readback shows build 41 `Testing` in Fotoro Internal, with the owner's existing
one-tester account. What to Test notes show `Saved` and the expected instructions.
Private logs, screenshots, audit and source hashes are retained under the ignored
local build 41 distribution directory. This establishes internal availability,
not physical installation or personal-library acceptance. Build 40 is the prior
candidate and does not contain these follow-up fixes. Production web remains at
the earlier checkpoint below.

Rendered checks use the Codex in-app browser at `http://127.0.0.1:4310`, with public
fixtures, at 1280×900 and 320×740. Grid/table Home/End reaches virtualized offscreen
photos; table arrow navigation, sorting, exact two-photo selection, Columns
Escape focus restoration and rapid viewer navigation/close/reopen pass. The
optional passkey button is present on account entry. Page identity, nonblank
content, absence of framework overlays, console health and horizontal overflow
checks pass. Screenshots remain outside the repository. Native gestures,
VoiceOver, physical background/iCloud behavior, cross-device PRF and general
Search/Picks/People quality still need device or held-out evidence. The
[ten-foundation queue](product-backlog.md) records these gates; Sign in with Apple
remains unimplemented and Gemini enablement remains off.

The current local implementation adds durable last-10-days initial Sync intake,
explicit expansion, optional browser photo tables, reviewed local People groups
and optional per-photo Gemini observations. These changes have not yet replaced
the production checkpoint below.

Final local `pnpm check` passes: 33 core, 80 API and 454 web tests, plus 20 search
fixture cases, seven Picks cases, 24 full release artifact cases, 24 preview
artifact cases, release orchestration checks and the web build. A fresh built
startup check measures 412,566 bytes in one static
JavaScript chunk, within the 500 KiB budget. Isolated encrypted exchange passes
all five tests. The pinned TinyCLIP public-image inference smoke passes.

Browser checks at 1280×900 and 320×740 exercise table sorting, extra columns,
selection and the same viewer without page overflow or unexpected errors.
Actual YuNet/SFace inference on a public example finds 16 faces with finite
normalized 128-value templates. People checks exercise explicit naming, merging,
separating and finding the reviewed name. Public weights and runtime requests
carry no authorization or referrer; no photo or template is uploaded. Browser
lifecycle checks cancel work and clear provisional groups.

Saved People checks use disposable accounts, public JPEGs and real local
encrypted D1/R2 storage. Naming 16 groups, separating one face, finding the
reviewed name, explicit Save changes and restoring names in a fresh browser
context pass. Acknowledged annotation edits refresh current sources without
discarding reviewed groups; unrelated source or account changes still invalidate
them. These checks use Chrome, not Safari.

Full native verification passes 377 of 378 tests with the existing Vision skip.
Eight People regressions include actual pinned YuNet/SFace inference, a public
NASA portrait rotation case and PhotoKit naming/search/rejection. The aligned
portrait rotation exceeds 0.99 cosine similarity; this single fixture does not
qualify general identity accuracy. Corrections recheck current per-asset access
and revisions, adjusted-current boxes stay local, and a legal 64-fact GPS
annotation remains hydratable after search-term expansion.

The isolated Photos preview passes 112 of 113 tests with its existing Vision
skip; all 24 preview artifact checks pass. Its generated graph excludes People,
ONNX and face weights. Simulator UI input could not be automated; that is not a
manual native UI or physical-device acceptance result.

A rendered Gemini component check uses a synthetic JPEG and mocked provider
responses. Analyze needs separate preview consent and stages a review without
keeping anything. Keep, Discard and lock clearing pass without page errors.
Encrypted annotation regressions verify current source binding, preservation of
newer supplied/People/location facts, local-to-owned digest rebinding and removal
of obsolete categories. No paid provider call was made. Default cloud enablement
remains off; live provider behavior, personal-library quality, physical phone
performance and complete cross-device acceptance remain unqualified.

Cloud capabilities and inference require the unlocked vault's expected account
to match the authenticated server account. A real shared-cookie regression
rejects an account switch before allocating work or dispatching a provider call.

After the existing Xcode account was restored, build 39 exported through CLI and
Organizer and uploaded successfully. Apple then rejected processing with 90208:
the ONNX framework plist declared iOS 15.1 while Xcode's generated empty binary
required iOS 26.0. The earlier artifact audit missed this metadata mismatch.

Replacement build 40 uses a final full-app archive phase that waits for implicit
framework copying and signing, sets the copied framework minimum OS to the app's
deployment target, and re-signs it before app signing. The real build log confirms
that ordering. Both archive and signed IPA declare iOS 26.0 and pass the full
artifact audit; the strengthened audit rejects the actual build 39 archive.
All nine release orchestration, 31 full artifact and 24 preview artifact cases
pass. Project regeneration is stable. Apple completed build 40's processing on
October 6. App Store Connect readback shows 0.1.0 (40) `Testing` in Fotoro Internal,
with the owner's existing tester account in the group. Encryption answers select
standard algorithms outside Apple's OS and the approved France exclusion. What
to Test notes were saved and read back. Private screenshots and artifact/input
hash evidence are retained under the ignored local distribution-fix directory.
This establishes internal TestFlight availability; physical installation,
device acceptance and production web acceptance remain unverified.

## Qualified source and live web

[PR 43](https://github.com/dakshbhatia/fotoro/pull/43) merged as
`1e1434f2524b2c41fbb8baac8529972e77e5035d`. Its exact checked head was
`9e479913ac51b6f0a6c83a787dd7527e7de75ff7`; all 23 reported checks completed
successfully or were skipped, including successful full/preview iOS and web/API
jobs. [Fotoro run 37384619261](https://github.com/dakshbhatia/fotoro/actions/runs/37384619261)
contains native and web/API validation. The merged tree matches the qualified
head, and all 69 native input hashes match the audited build 38 archive.
Independent review found no remaining material issue.

The active Worker is `2ca15bc9-614b-4b21-a115-f3748c60bbc4`, deployment
`7a474426-4b3b-4d7c-baf7-026bfd36e090`, at 100%. All 35 non-HTML asset digests
match the qualified production build. Photos and Saved HTML routes reference the
expected entry assets. HTTPS service routes and the exact Apple app association
pass readback. Fresh production browser checks pass entry, account focus and Back
at 320×568, 390×844 and 1280×720 without overflow, unexpected JavaScript errors
or API writes. [Deployment](deployment.md) owns release commands.
Documentation-only changes leave this runtime checkpoint unchanged.

## PR 39 verification

The three-S simplification preserves an explicit Turn on sync choice through
account entry, bound to the selected service, account and unlocked catalog.
Opening Sync status alone remains read-only. Healthy Sync omits repeated detail,
provides View synced photos and keeps Pause reachable. Rare disable and sharing
options stay under disclosures. Web search stays visible; Clear retains focus.
A prepared invitation presents Send photos for its fixed recipient and selection;
Choose another person resets the invitation before a new grant.

The consent regression fails when authorization overwrites the service selected
before sign-in, then passes with the origin fence. Local full native verification
passes 364 of 365 tests; preview passes 112 of 113, each with the existing Vision
inference-context skip and no failures. Core/release checks, all 70 API and 397
web tests, typechecks and the production build pass. No backend, account protocol
or model change is introduced by PR 39.

Rendered verification uses Playwright with ephemeral headless Google Chrome.
Two disposable loopback accounts and a public Singapore photo exercise real
encrypted D1/R2 storage. Local and Saved search stay visible and retain focus after
Clear. Saved fits 320×568, 390×844 and 1280×720 without horizontal overflow.
Prepared sharing hides creation controls, retains the recipient, resets deliberately
and creates a new grant only after another explicit Share choice. Send photos
invokes browser sharing with the prepared link. No unexpected page or console
errors occur; completion of the OS share sheet is not asserted.

The browser startup graph measures 392,090 JavaScript bytes across four chunks,
below the 500 KiB budget. Account crypto and visual inference remain deferred.
Pinned-model public-image smoke checks exercise real inference; they do not
establish held-out search quality or physical-device latency, memory or battery use.

## PR 41 verification

The qualified PR 41 source closes these reproduced correctness gaps:

- A changed Photos revision excluded by resource admission now has its own
  incomplete checkpoint. The earlier saved original remains available; admission
  recovery retries even when the current source revision has not changed.
- Replacing synced OCR with absent or incompatible OCR removes obsolete remote
  search text and restores the existing local text, confidence and analysis status.
- Browser session expiration locks the affected current vault. Password reentry
  can preserve a chosen Save, incoming invitation, selected owned originals and
  picked files for the same account. Changed originals, another account and
  later user selection changes cannot revive an obsolete choice.
- Clearing this browser locks and erases its account cache independently of
  server logout. A new sign-in cancels the outstanding logout request.
- The full TestFlight helper now requires archive and exported-IPA audits before
  upload, including signed identity, production associations, matching arm64
  binary/dSYM UUIDs and ten defined static crypto symbols.

Local `pnpm check` passes, including all 411 web and 70 API tests, core/release
checks, typechecks and the production web build. Full native verification
executes 367 tests with one existing Vision inference-context skip and no
failures, including real loopback authentication integration. The pinned-model
visual smoke passes. Preview verification executes 113 tests with the same
known Vision skip and no failures; isolated encrypted exchange passes all five
tests. The browser startup graph measures 393,790 JavaScript bytes across four
chunks, below the 500 KiB budget.

Eight rendered loopback checks use disposable private accounts and real encrypted
storage: chosen-file Save through expiration and explicit retry; selected Saved
originals through reauthentication; Clear during a delayed catalog refresh;
two-person invitation opening and recipient-owned Save; failed and offline logout
with independent local clearing; entry health; and no unexpected browser errors.
These checks use headless Google Chrome, not Safari or a physical iPhone.

PR 41 is merged and deployed. No distribution IPA, TestFlight upload or physical
first-use/restore/share qualification is established by these checks.

## PR 42 browser resilience verification

A connected browser whose API transport is unreachable can reopen the exact
account's cached encrypted photos with its correct Fotoro password. This is local
access, not a new server sign-in or successful Sync check. HTTP rejection, invalid
response data, a wrong password, missing cache, cancellation and account changes
cannot use that fallback.

Visual Search now distinguishes unavailable or partially checked photos from a
successful empty result. Existing lexical matches and successful visual matches
remain visible. Worker crashes during preview loading or between cached batches
also report unavailable; query replacement, lock and cancellation cannot publish
stale feedback. Healthy searches add no status text.

Local full checks pass, including 431 web tests after the final search-race fix,
70 API tests, typechecks and the production web build. The five isolated real
D1/R2 encrypted-exchange tests pass, including HEIC and complete Live originals.
Additional production browser-reader tests cover JPEG, PNG, HEIC, MOV and Live
resources after an interrupted HTTP body, fresh same-account vault unlock and
offline reopen, checking exact bytes, names, types and digests. Those reader tests
use real crypto and fake IndexedDB with HTTP responses mocked; they do not prove
physical-device restoration or a browser-process restart.

Ten rendered loopback checks pass the existing chosen Save, selection,
expiration, private invitation and recipient Save journeys plus cached access
while `navigator.onLine` is true and transport is unreachable. Cached access
reports the unavailable connection accurately; an uncached browser remains at
sign-in. Two additional
rendered checks confirm Photos and Saved show visual-search failure instead of a
false empty result. The latter inject a failing worker boundary and make no
inference-quality claim. Headless Google Chrome is used; Safari and physical
system sharing remain unqualified. No native input or encryption protocol changes
are introduced by this pass. Release evidence is preserved outside Git under
`core-journey-2026-10-05` and its timestamped browser proof.

## Photo canvas screen pass

The native browse screen replaces its stacked custom header with the system
scope/Sync toolbar and persistent bottom Search. Clearing Search retains editing;
photo viewers use full-screen presentation. Account entry keeps a rejected
password error inline without a second blocking Sync alert. Empty selection mode
keeps its grid clear; actions appear after choosing a photo.

The full app compiles and runs on the iOS 27 iPhone 18 Pro Simulator. Rendered
public-fixture checks verify bottom Search visibility, text/date Search, Clear
followed by further typing without refocus, full-screen viewer → Done with query
retained, selection actions above Search, no tray for zero selection, and inline
password failure. The viewer → Share continuation opens the system sheet with the
chosen public PNG; no destination was selected and no send completion is claimed.
Saved-viewer presentation/lifecycle changes have independent code review; a new
physical-device or Safari qualification is not inferred from these checks.

Browser selection controls now wrap only when needed. Headless Google Chrome
checks show the normal phone tray shrinks from 111 to 62 CSS pixels at 320×568
and 390×844, retaining 44-pixel action targets; desktop stays 66 pixels. At 200%
tray text it wraps without overflow. Chosen Save → account entry → Back retains
the exact two-photo selection, Clear remains reachable, and the sharing boundary
receives both unchanged original files. The platform share call is intercepted;
mobile soft-keyboard and OS send completion are not asserted.

Local `pnpm check` passes with 431 web and 70 API tests and the production web
build. Local preview verification executes 113 tests with one existing Vision
inference-context skip and no failures. Protected rendered evidence lives under `screen-audit-2026-10-05` and its
timestamped web capture. Build 38 matches this screen pass; its archive audit
does not qualify a distribution IPA or TestFlight upload.

## Native photo handoff pass

Receiving now uses one native scroll canvas and a three-column thumbnail grid opening the existing viewer
full screen. Save remains explicit inside that viewer. Foreground inbox refresh
and known expiry checks remain active while it covers the receiving screen;
returning does not replay an accepted invitation. Owned Saved photos put Save to
Photos beside Share, with Info under More. Another-device access puts Copy password
first with a copied acknowledgement; Save and the website remain secondary.
Authentication, account storage, original verification and upload consent are
unchanged.

The full app builds on the iOS 27 iPhone 18 Pro Simulator. Local native testing
against freshly seeded loopback services executes 367 tests: 366 pass, one known
Vision inference-context case skips and none fail. Core/release checks pass.
Independent review covers receiving lifecycle, account handoff and original
restoration guards. Rendered public-fixture checks verify the owned toolbar,
Info under More and successful Save to Photos. The recently created simulator
Photos resource matches the public Singapore JPEG bytes and digest exactly.
The named receiving thumbnail opens the full-screen viewer; Done returns to the
same grid. The scroll container keeps that thumbnail's accessible tap target
inside its square bounds.
This does not qualify physical iPhone, video or Live Photo restoration.
Password action ordering and copied state have code review; actual cross-device
password transfer is not qualified by this pass. No web runtime, API, encryption
format, model, migration or production binding changes are introduced.

## iPhone and distribution

Build 38 archives the qualified PR 43 source and passes the full archive audit.
All 69 native input hashes match both the checked head and merged tree. It is
development-signed; no IPA was exported and no TestFlight upload occurred.
Protected `photo-canvas-2026-10-05` evidence records the archive, exact-head CI,
merge, asset digests, production traffic and browser/service checks. CI preview
verification executes 113 tests with four skips and no failures; local preview
executes 113 with one skip. These results do not qualify a physical iPhone.

Build 37 archives the qualified PR 41 source and passes the full archive audit.
All 69 native input hashes remain unchanged across the archive. It is
development-signed; no IPA was exported and no TestFlight upload occurred.
The archive and its proof are preserved outside Git under `core-gaps-build37`.

Build 36 archives with all 42 Swift sources, 69 native inputs, matching arm64 dSYM,
production associations and unchanged full static encryption. The archive source
is `d32e490f2d7f96ca0c47103432609e57c05b4433`; all native inputs match the qualified
PR 39 source. It is development-signed, not a newly uploaded TestFlight build.

Build 25 remains the latest verified internal TestFlight build (`VALID`,
`IN_BETA_TESTING`). Build 21 is the last verified physical-phone launch checkpoint.
The latest distribution preflight reports no available Apple Distribution identity.
Individual API access is verified for build metadata; provisioning/signing and a
fresh TestFlight install remain open. No external TestFlight invitation is qualified.
First App Store publication excludes France, as approved by the owner.

Latest deployed release proof is kept outside Git under the protected `photo-canvas-2026-10-05`
record: source inputs, archive audit, exact-head CI, merge proof, asset digests,
Worker traffic readback and browser/service checks. Credentials and private account
data are excluded from repository documentation.

## Limits and acceptance still open

- Logical originals remain bounded to 50 MiB, including a complete Live Photo pair.
  Camera media within that bound is supported; oversized originals need qualified
  streaming/recovery work before raising it.
- Account allowance is 10 GiB of reserved/stored ciphertext. Client original-byte
  summaries are a different quantity. Final-object cleanup and disaster recovery
  are not fully qualified; do not promise reclaimed space.
- Automatic native Sync requires opt-in and foreground/unlocked preparation. iOS
  can finish scheduled ciphertext PUTs; this is not continuous locked-phone backup.
  Browser uploads stay explicit.
- Search, picks, photo GPS and confirmed Timeline imports operate locally. Named
  people and cross-device contact sync are open. Scene publication remains disabled
  for reader compatibility. Local vectors and raw Timeline imports do not upload.
- Full first-use/returning-account acceptance, two-person sharing completion,
  interruption/relaunch restoration, accessibility and realistic library performance
  still need physical-device evidence. Apple ID login is not delivered.

A public fixture, a synthetic 10,000-item index or a simulator pass does not prove
that Fotoro is ten times better than an alternative. Compare the same real tasks
and libraries using [the comparison protocol](competitive-baseline.md).
