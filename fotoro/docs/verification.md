# Verification — October 5, 2026

This is the current evidence record. [The backlog](product-backlog.md) owns next
work; [product](product.md) owns the intended experience. Earlier measurements and
release checkpoints are preserved in the [historical appendix](history/verification-through-pr38.md).
No speed, accuracy, cost or adoption claim is inferred from a passing smoke test.

## Qualified source and live web

[PR 42](https://github.com/dakshbhatia/fotoro/pull/42) merged as
`8c60066b81c9f7d33a12afdef7016c6707825f0b`. Its exact checked head was
`ca1dab953252f59fd406126ad97a3ea5c2b7ef9f`; all 23 reported checks completed
successfully or were skipped, including successful full/preview iOS and web/API
jobs. [Fotoro run 37380380467](https://github.com/dakshbhatia/fotoro/actions/runs/37380380467)
contains native and web/API validation. The merged tree matches the qualified
head, and all 69 native input hashes match the audited build 37 archive.
Independent review found no remaining material issue.

The active Worker is `e6a09961-6ddb-42c5-9fc0-fabaf195d9b0`, deployment
`49a1d235-3bc4-499f-bc1b-e48955447078`, at 100%. All 35 non-HTML asset digests
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
timestamped web capture. This screen pass changes native inputs, so build 37's
archive does not qualify it for distribution.

## iPhone and distribution

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

Latest release proof is kept outside Git under the protected `core-gaps-build37`
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
