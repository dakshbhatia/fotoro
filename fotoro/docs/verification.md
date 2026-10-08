# Verification — October 8, 2026

This is the current evidence record. [The backlog](product-backlog.md) owns next
work; [product](product.md) owns the intended experience. Earlier measurements and
release checkpoints are preserved in the [historical appendix](history/verification-through-pr38.md).
No speed, accuracy, cost or adoption claim is inferred from a passing smoke test.

Current distribution is PR 55 in production and TestFlight 49, independently
verified `VALID` and `IN_BETA_TESTING`; see [Deployment](deployment.md). The dated
follow-ups below preserve their qualification state at the time of testing.

## October 8 first-use and invitation recovery — locally qualified

iPhone Photos now defaults to the last 30 days at the PhotoKit metadata fetch and
merged timeline. All dates is explicit; historical Search stays unrestricted.
Failed merged Search offers Try again with raw errors under Details and uses the
existing bounded action diagnostics. A changed owner identity reaches explicit
review; signed-definition checks precede trust writes, verified albums survive
an invalid invitation, and reviewed Join preserves existing contact names.

Browser account correction and same-account expiry retain the exact incoming
album. Actual local UI checks cover wrong account → switch → invited account →
review → original album, expiry → sign in → original album, and explicit Close
clearing the link. Console warnings/errors are empty. Fixtures are disposable
local accounts and public NASA media. The existing-code regressions failed before
the fixes. Full native passes 499 with two skips; preview passes 139 with two
skips. Web passes 580 with one pre-build startup skip, all three fresh-build startup
checks pass, and API passes 116. Core checks and production web build pass.

The connected physical phone reports installed build 47. Its bounded diagnostic
ring is readable (160 events, no failed actions); this does not qualify a family
journey or install build 49. Current distribution remains the checkpoint above
until new source passes hosted checks and release qualification.

## October 8 live family search follow-up — locally qualified

Live albums add optional contributor-authenticated encrypted photo details, with
explicit reviewed-name and location sharing, clearing, revision conflicts and
current-account/access fences. Private OCR and other annotations stay excluded.
People Any/Everyone, shared place, natural capture-date queries and date controls
filter each actual copy before exact-original grouping. All contributed copies
remain accessible. Names are contributor-scoped text snapshots; this does not
establish automatic family attendance or shared face identity across contributors.
The additive `0009_album_photo_facts.sql` migration is required before deployment.

Actual local browser QA uses three isolated accounts and public images with
synthetic reviewed facts. A first-contact Join album succeeds; Choose → Continue
→ Add changes the invited album from zero to one photo, independently read back
by its owner. Three contributions appear as two exact originals. Re-adding the
same owned photo reports Already in this album and preserves the count. Every
duplicate copy is reachable. Combined person/place/month queries, Everyone,
import-date exclusion and same-tab invitation switching pass. Clearing and
republishing shared details reach revisions two and three in another member's
authenticated readback, without private OCR. Browser original download is
byte-identical (613,520 bytes). The 390×844 layout has no horizontal overflow and
no console warnings/errors.

Local full native tests pass 484 with two simulator skips; the isolated preview
passes 136 with two skips. All 32 native album regressions pass. The app builds
and launches; simulator input automation cannot establish its touch connection,
so the native family UI journey is not claimed as rendered acceptance. Physical
installation, real passkey ceremonies, personal-library face quality and family
acceptance remain open. Final workspace checks pass, including 567 browser tests,
116 API tests, 57 core tests, five isolated encrypted exchanges and the pinned
public-image inference smoke case. All three startup checks pass at 442,102 bytes
across nine chunks. Independent protocol/client review finds no blockers. Hosted
checks, production and TestFlight qualification are recorded separately after
they complete; production and TestFlight 47 remain the prior release here.

## October 8 account and album recovery follow-up — locally qualified

Native trusted account cards are now scoped to the active owner. Renewal keeps
that owner's reviewed contacts; switching accounts or signing out removes them
from the active session. A failed session replacement leaves the prior identity
and trust intact. Legacy unscoped storage can supply only the owner's verification
card for independently verified local unlock. Legacy contacts require explicit
review again; contact names remain in their encrypted account catalog. Contact
cards are still local and do not synchronize across devices.

Native Saved sync filters peer-signed contribution records before contact lookup
or object reads. Owned records still require authentic signatures and matching
manifest identity. Filtered pages advance their cursor. A fresh owner can restore
their own photos without trusting every peer in a historical contribution feed;
shared access retains explicit contact/invitation checks. The regression reproduces
the missing-card failure before the guard and passes afterward, together with the
real authenticated second-device annotation/OCR restoration case.

Browser live-album entry offers Try again after capability or inbox failure,
preserving the exact incoming invitation. Retry repeats availability, inbox and
owner verification without accepting membership, pinning a contact or contributing
photos. Cancellation, account replacement and owner substitution remain fenced.
Actual desktop and 390-pixel mobile UI QA forces the first capability request to
503, then recovers the same invitation for explicit acceptance with no console
warnings/errors. The rendered owner was already trusted; first-contact review is
covered by signed/encrypted protocol regressions.

Local qualification passes 472 full native tests with two skips, 136 isolated
preview tests with two skips, 557 browser tests, 111 API tests, the remaining
workspace checks and five isolated encrypted exchange cases. All three startup
checks pass at 442,116 bytes across nine static chunks. Independent review finds
no actionable defects. These fixes are local at this checkpoint; production and
internal TestFlight 47 remain the prior release. Physical installation, real
passkey ceremonies, contact convergence and large-library acceptance stay open.

## October 8 bounded foundation follow-up — PR 51 production / TestFlight 47

Qualified PR 51 head `63e51fbf0d1c6244bf266d484a8b6a7c716ca2b3` completed all
23 checks: seven success and 16 intentional skips. Guarded merge
`bbf15c60a7afc6222eda30e6ced422be6539edde` has the identical tree. The first
hosted native attempt failed with a loopback recovery-options connection reset
and no matching Worker log entry; the unchanged rerun passes 468 full native tests
with six skips and 138 isolated preview tests with five skips, without failures.
No recovery retry or assertion was weakened. An existing API album-capacity test
now seeds its same 1,000 records in bounded D1 batches; its assertions and default
timeout remain unchanged.

Production Worker `fc961e24-fc94-4b9a-a4b9-fdbecedbe01b` is at 100%, deployment
`0323ca3a-13a3-4181-be90-2e4c61a12ba3`. All 46 non-HTML assets and root/Photos/Saved
HTML match the fresh fixture-free merged build. Seven auth/route/association
checks, the service check and all three startup checks pass. All eight bindings
and runtime are unchanged; no migrations or provider activation occurred.
Production Photos and Saved entry render without console warnings/errors.
Keep PR 50's `a4f88a21-b35f-4def-a07e-5c57543b8464` for rollback.

Build 47's full encrypted archive and Organizer distribution IPA pass audit. All
154 native inputs and three release tools match the frozen qualified merged
source through export and accepted upload. The existing cloud-managed identity
signed it. Apple accepted the same pinned ONNX resource-stub symbol warning as
46; main binary/static runtime and matching dSYM pass audit. The 54,182,911-byte
IPA has SHA-256 `334e8a173d8ce6b9a404ee979f5c3fc5e4a6a713dc8c56590a8399ea4de1506c`.
Independent Apple readback reports `VALID` and `IN_BETA_TESTING`. The same existing
internal group auto-linked 47 with the same one tester; no membership or access
changed. What to Test notes and exact build linkage match independent readback.
The unchanged approved standard-encryption/France-exclusion basis qualifies the
metadata documentation exemption; the binary encryption declaration is unchanged
and no new declaration was created. App Store Connect visibly shows 0.1.0 (47) Testing in Fotoro Internal.
The physical phone remains disconnected, so availability does not prove installation
or installed-device acceptance.

Browser Saved now opens a 100-record hydrated window and retrieves bounded change
pages, with explicit Load more Saved photos. Coverage identifies unloaded cached
records and unfinished remote change pages. Date, Search and People filters cover
only the loaded records; a partial catalog cannot claim complete no-match coverage.
Annotations and selection continue to use current account/vault/source bindings.

The native album picker reads explicit 200-record local Saved pages, retains
selection across them and no longer silently stops at the first 1,000 records.
The album itself still caps contributions at 1,000 photos and a chosen append at
100. Native Saved People choices likewise load local catalog and annotation data
in explicit 200-record pages, display partial coverage and invalidate after
account, vault, catalog, source or reviewed-name changes. This does not upload
People facts to albums or establish family attendance across separate photos.

Native welcome directly exposes New Fotoro, Continue with a passkey and Use Fotoro
password. Both passkey entry points reuse the existing sign-in/unlock completion
path and chosen-action callback. Remembered access and password recovery remain.
Fresh-device discovery may still require a second PRF assertion; Sign in with
Apple and a consumer device-approval interface are not implemented. Actual native
UI QA verifies all three distinct welcome choices. This establishes reachability,
not a physical passkey/PRF ceremony or a completed cross-device unlock.

iOS Places offers an explicit optional Apple Maps area-name lookup for at most
eight unnamed marker coordinates per action. Names are current-view labels,
cleared when their map/source scope changes; they do not write photo annotations,
restore missing GPS, identify landmarks or prove travel attendance. Controlled
lookups test limits and cancellation. Actual native UI QA resolves public synthetic
Singapore/London coordinates through Apple Maps and verifies that choosing the
London area zooms the street map. This does not establish personal-photo landmark
accuracy or physical-device map performance.

Optional inference remains disabled. Current API source adds required daily
account/global micro-USD reservations atomically with request counts in the existing
ledger, before its single provider request. Full published model token ceilings,
including thinking, reserve 1,032,192 micro-USD for Flash or 478,413 for Lite per
admitted attempt. Failures retain the estimate; rejected work changes no counters.
Reviewed pricing expires at January 1, 2027 UTC and stale pricing fails closed.
These are conservative estimated upper bounds, not measured spend or a provider
billing cap. No paid calls, activation, schema migration or storage deletion occurred.
Unused upload leases already refund on expiry; started/ambiguous writes remain
charged because a late-write race prevents a safe automatic refund.

Local full native qualification reported 468 tests: 466 pass and two skip.
The isolated preview reports 138 tests: 136 pass and two skip. Actual browser QA
opens the first 100 Saved records, loads the remaining page and preserves the
chosen item without console errors. Photos search retains its 72 chosen items as
Load more expands 72 matches to 105. This synthetic metadata/selection fixture
contains an oversized preview that the existing dimension guard rejects, so that
fixture qualifies only metadata/selection. A separate fresh encrypted public
fixture, loaded through Settings → Refresh saved photos, opens a 1,600 × 1,000
preview in the Saved viewer. Share → Download original restores 613,520 bytes
with SHA-256 identical to the public original and no console warnings/errors.
Original recovery also passes the separate five isolated encrypted-exchange cases.
API qualification passes 111 tests across 20 files and TypeScript; the final focused
inference suite passes 13. Full API output includes the existing deliberately
injected upload-disconnect/network-loss warnings and exits successfully. The final full browser suite passes 553 tests, the focused paging/selection suite
passes 112, and TypeScript/production build pass. All three startup checks pass
at 442,116 bytes across nine static chunks. The pinned public visual-inference
smoke case passes. All ten foundations retain their physical quality,
performance and cross-device restore gates in the backlog.

## October 8 family-loop reliability qualification

Browser Choose photos preserves the exact incoming live-album destination through
Saved selection and reopening. Choosing from a different active album completes
the original invitation so it cannot redirect the next opening. Explicit Close
still completes the incoming intent;
lock, expiry and account replacement retain their existing fences. Native album
invitations no longer resolve unrelated selected Saved photos before opening.
Native People choices include source-bound reviewed names from owned Saved photos,
so Any/Everyone works without local Photos permission. Corrections that change
reviewed People facts invalidate an open Saved-name snapshot.

Native transfer reconciliation stages bytes only after `UPLOAD_INCOMPLETE`.
Transient commit failures preserve the original error and pending journal for Retry.
Cancelled catalog requests use the same cancellation classification as diagnostics,
so a cancelled URLSession read does not create a false needs-attention state. Real
network and HTTP failures still require Retry. The controlled catalog regression
fails before this guard and passes after it, without catalog/cursor/journal writes.
Two fault-injected regressions promote actual ciphertext, remove staged files, then
recover after a 503 or offline response without another reserve/PUT, extra allocation
or duplicate catalog change. Removing the guard reproduces both failures. Removing
the People correction invalidation reproduces the stale-choice regression.

Final local full native qualification executes 457 tests: 455 pass, two opt-in/Vision
cases skip and none fail. Isolated preview executes 134: 132 pass and two skip.
Browser qualification passes 548 tests, TypeScript and the production build; API
passes 108 and core/release checks pass. Startup remains 440,288 bytes across nine
static chunks. All five isolated encrypted-exchange cases and the pinned public
visual-inference smoke pass; neither establishes personal-library retrieval quality.

Actual desktop browser QA against isolated local D1/R2 and disposable public NASA
fixtures verifies invitation review/acceptance, Choose photos, Saved selection,
reopening the same album with an explicit Add button, contribution and persisted
readback after reopening. Explicit Close removes the incoming URL intent. Console
warnings/errors are empty. The attempted viewport override did not change the
reported desktop dimensions, so this run adds no mobile-layout qualification.
Physical family acceptance, large-catalog hydration/performance and the native
album picker's first-1,000 Saved-photo limit remain open. A second public desktop
flow verifies incoming A → All albums → B → Choose photos clears A, preserves
the chosen set, and contributes to B only after explicit Add. A fresh sign-in
reads the contribution back; console warnings/errors are empty.

Qualified PR 50 head `7dfe96d90830f3adee5533b6aea19e2d1be5ff96` completed all 23
checks: seven success and 16 intentional skips. Guarded merge
`ef4d85d91f974904d50759057859b57474328da9` has the same tree. Hosted full native
executes 457: 451 pass and six permission/explicit metadata-QA cases skip.
Preview executes 134: 129 pass and five such cases skip. Hosted web executes 548:
547 pass and the pre-build startup budget skips; the fresh production build then
passes all three startup cases. API passes 108 and isolated exchange five. All
seven new native family/cancellation regressions pass in the hosted log.

Production Worker `a4f88a21-b35f-4def-a07e-5c57543b8464` serves 100%, deployment
`26db1d26-de0a-4e28-b882-905684a1295f`. All 46 assets and root/Photos/Saved HTML
match the fixture-free build. Seven route/auth/AASA checks, the service check,
startup and production Photos/Saved entry pass without console warnings/errors.
Bindings/runtime/auth are unchanged; no migration or optional inference activation
was needed. PR 49 remains available for rollback.

Build 46 has full encrypted archive and Organizer distribution IPA audits, with
all 154 native inputs and three release tools matching the frozen merged source
through upload. Apple accepted the same pinned ONNX resource-stub dSYM warning as
45; the main binary/static runtime and matching dSYM pass the audit. Apple
independently reports `VALID` and `IN_BETA_TESTING`. Exact testing notes/build linkage
and the unchanged one-group/one-tester membership are verified. The same approved
encryption/France-exclusion basis qualifies the documentation-exemption metadata;
binary encryption is unchanged and no declaration was created. Physical installation
and installed-device acceptance remain open.

## October 8 action diagnostics qualification

Local full native qualification executes 448 tests: 446 pass, two opt-in/Vision
cases skip and none fail. The isolated preview passes 132, with two such skips.
New regressions verify concurrent trace separation, cancellation, malformed 200
decoding, backwards-compatible bounded exports and header-first support references.
API qualification passes 108 tests and TypeScript, including early authorization,
CORS, independent request references, duration, redaction and byte-intact streamed
ciphertext. Browser qualification passes 543 tests and the production build/typecheck;
startup passes all three checks at 440,288 bytes across nine static chunks.
Five offline-reader tests cover correlated failures, redaction, truncated windows,
CLI envelopes and malformed records that must never synthesize success. Core checks
and release-artifact regressions pass.

Qualified PR 49 head `072cfa99d0f864c87cb8ed4132623efcd4274398` completed all 23
checks: eight success and 15 intentional skips. Guarded merge
`601bd3fab6cc964996c4ee3b0db427e04361044f` has the same tree. Hosted full native
executes 448 tests: 442 pass and six permission/explicit PhotoKit opt-in cases skip.
Preview executes 134: 129 pass and five such cases skip. Hosted web executes 543:
542 pass and the pre-build startup budget skips; the fresh production build then
passes all three startup cases. API passes 108, reader five and isolated exchange
five; public visual inference, TypeScript and builds pass.

Production Worker `850dabd0-5603-49a0-9330-28c98fede807` serves 100%, deployment
`02649e71-2bbf-4fdc-8c48-27746ea9ee3f`. All 46 assets and root/Photos/Saved HTML
match the fixture-free build. Seven route/auth/AASA checks, service checks,
header/body request-reference agreement and trace CORS pass. A live read-only 401
probe matches exactly one final server event by both IDs. Earlier live-tail attempts
missed their probe; the successful capture matched the second of two fresh probes.
Those misses have no established cause. Bindings/runtime/auth are unchanged, no
migration was applied and optional inference stays disabled. PR 48 remains available
for rollback. Production Copy diagnostics reports success; Saved account entry and
local desktop/mobile layouts render without console errors. Clipboard bridge content
readback and the native menu handoff are not independently qualified.

Apple independently reports build 45 (0.1.0) `VALID` and `IN_BETA_TESTING`. Its exact
testing notes/build linkage and unchanged one-group/one-tester membership are verified.
All 154 native inputs and three release tools match the frozen source before/after
archive, Organizer export and upload. Full encrypted archive and IPA audits pass.
Apple accepted the known pinned resource-stub dSYM warning; main/static runtime and
matching dSYM pass. Documentation-exemption metadata uses the unchanged approved
encryption/France-exclusion facts; the binary declaration is unchanged. This qualifies
availability, not physical installation or the full family journey.

The older Simulator ring captured before qualification reports three upload
conflicts on build 40; it does not describe the installed physical app. The phone connection reset before
diagnostics could be read. Before this release, a live production tail observed an
intentional 401 read-only probe; historical log-query access returned 403. The
pre-release checkpoint was TestFlight 44 and production PR 48. See
[diagnostics](diagnostics.md) for collection,
safe summaries and the limits of this evidence. Real-device family acceptance
remains open.

## October 7 production PR 48 and TestFlight 44 checkpoint

Qualified head `f302ca09f30a2df7d65fe0d7d92e38870277ac20` completed all 23
checks: eight success and 15 intentional skips. Guarded merge
`2d14f8ba456fed053d2a0bd829e646c2172b1abc` has the same tree. Hosted Xcode 26
full native executes 444 tests: 438 pass and six opt-in/Photos-permission cases
skip. Preview executes 134: 129 pass and five such cases skip. Local Xcode 27
with real PhotoKit metadata opt-in passes 443 full tests and 133 preview tests,
with one existing Vision classifier skip in each. Both SDKs compile the metadata
reader; animation observations are omitted where the public SDK symbol is absent.

Worker `ba359106-30ac-4ac2-8f6a-0523c523a95a` serves 100%, deployment
`2f0d0d56-0cce-4d76-83e4-d2aa52f4b9b8`. All 46 non-HTML asset digests and
root/Photos/Saved HTML match the fresh fixture-free build. Seven route/auth/AASA
checks and the service check pass; eight bindings and runtime are unchanged.
Startup passes all three cases at 436,081 bytes across nine chunks. No migration
was needed and optional inference remains disabled. Production Photos and Saved
entry render without console errors. PR 47's preceding Worker is retained for
rollback. Exact-head web/API counts are 534 web passes plus one pre-build startup
skip, 98 API passes, nine contract passes and five isolated exchange passes.

Build 44 (0.1.0) is independently read `VALID` and `IN_BETA_TESTING`. The existing
internal group visibly shows Testing, with the same one tester as 43. The exact
group assignment, membership, testing notes and notes/build linkage are verified.
All 154 native inputs and release tools remain unchanged before/after archive,
distribution export and upload. Full archive and Organizer IPA audits pass;
Apple accepted the pinned resource-stub dSYM warning while main/static-runtime
dSYM pairing passes. The known standard encryption and approved France exclusion
are unchanged; documentation-exemption metadata is read back and no declaration
was created. These checks qualify availability. Physical installation, iCloud,
VoiceOver, background work and family-device acceptance remain open.

## October 7 production PR 47 and TestFlight 43 checkpoint

Qualified head `332891661eb37927a55ff2101ae0cb0668281dd8` passed all 23 checks
or intentional skips. Guarded merge `a76bfa1cab4c7ab4392be8b6a0eddec28ae2e53a`
has the same tree. Worker `5314d5c1-6d9b-4081-9a6b-f27649fd0123` serves 100%,
deployment `910a7e1e-e2f7-4d19-8984-4bbd1bb72985`, with all 45 non-HTML asset
digests and root/Photos/Saved HTML matching a fresh fixture-free build. Seven route,
auth and Apple association checks plus the service check pass. All eight bindings
are preserved, no migration is needed, and inference remains disabled. PR 46's
Worker remains available for rollback. Actual production browser Settings shows
Browse the last 30 days checked; entry has no console errors.

Exact-head CI passes 98 API tests, five isolated encrypted exchanges and the actual
public-image visual inference smoke. Web executes 532 tests: 531 pass and the
built startup budget skips because the CI check runs before the emitted build.
The subsequent fresh built startup check passes all three tests at 430,339 bytes.
Full native executes 419 tests: 414 pass and five Photos-permission-dependent
Simulator interactions skip. Preview executes 114: 110 pass and four such
interactions skip. The local native run below covers those permission-dependent
flows; neither run establishes physical-device acceptance.

Build 43 (0.1.0) is independently read `VALID` and `IN_BETA_TESTING`, with
approved notes and exact build linkage verified. The same existing internal group
auto-linked it; the same one tester remains, with no membership or permission
change. All 147 native inputs and release tools match qualified source and the
immutable archive. The archive and Organizer-exported IPA pass full release audits
before upload. Apple accepted the pinned resource-stub dSYM warning while the main
binary/static runtime and dSYM pairing pass. Documentation-exemption metadata uses
the same known encryption and France-exclusion facts as build 42; the binary is
unchanged and no declaration was created. This establishes availability, not a
physical installation of 43 or installed-device acceptance.

## October 7 iOS capture metadata and Places checks

The full local Simulator suite executes 444 tests: 443 pass and one existing
Vision classifier case skips. New checks cover source-bound capture facts,
original-header parsing, edited Photos dates, automatic derived retry separation,
local metadata surviving remote annotation hydration, Info presentation, detected
face-count evidence and adaptive Places geometry.

The real PhotoKit integration imports three clearly labeled synthetic JPEGs,
then edits Photos dates and changes or removes Photos GPS in a separate
transaction. The selected Info loader reads their local original headers while
keeping current Photos dates/GPS authoritative. Original GPS does not restore a
location removed from Photos. The rendered full app shows the two retained GPS
locations, the 30-day Places scope and the observed Info date/location/dimensions.
The real PhotoKit test requires explicit local QA opt-in and reuses a dedicated
three-photo synthetic album. It does not delete Photos or albums automatically,
which avoids interactive OS prompts in unattended tests. These fixtures are
Simulator-only and are not production sample intake.

Nine geometry cases include 20,000 locations represented in at most 80 markers,
late-indexed sources beyond the first browse page, dateline wrapping, stable
clusters, coincident locations, calendar boundaries and invalid coordinates.
The whole-library index keeps core dimensions, dates and media features. The
extra Photos format/added-date/adjustment fields are read for selected Info and
authorized intake. iOS 27 filename scanning consumes prefetched extended metadata
before a resource fallback; iOS 26 retains the existing fallback.

Map source snapshots and async projection are fenced by current permission,
revision, index generation, account access and scene phase. Opening a map result
constructs one photo page. These policy and Simulator checks do not qualify
physical-device frame pacing, iCloud behavior, VoiceOver or resolved city names.

## October 7 capture-metadata web reader checks

Local checks on the metadata/Places source pass nine contract tests (five existing
wire cases and four capture-reader cases), all 535 web tests, TypeScript and the
web build. The fresh emitted startup check passes all three cases at 436,081
static JavaScript bytes across nine chunks. Distribution audits and Apple
readbacks qualify the PR 48/TestFlight 44 availability checkpoint above.

Capture details use account-private, original-digest-bound `fotoro.capture.v1:`
facts inside the unchanged `PhotoAnnotationsV1` format. A group contains one
source marker and at most 32 typed items, within the existing 64-fact and
240-Unicode-character-per-fact limits. `PhotoMetadataV1`, the wire schema and
generated validators are unchanged. The frozen older annotation validator accepts
the native sorted-key vectors. Installed build 43 can retain these facts, but its
older search can tokenize an unknown capture marker until that reader is updated.

New web Info and search hide raw capture markers, including malformed and future
versions. Only validated camera/lens and media terms enter search; duplicate,
malformed or source-mismatched groups supply no capture evidence. Info keeps
Photos and original-file provenance separate, formats units and known media
types, and does not infer a timezone for an original EXIF time or derive GPS or
People counts. Regression checks exercise encrypted label/favorite edits retaining
native capture facts, unknown future facts and the exact existing caption, without
putting their plaintext in the account cache. These are public-fixture functional
checks, not personal-photo processing, recognition quality or device acceptance.

## October 7 metadata-first processing checks

Local and Saved browsing now default to the last 30 days. A single chip switches
between recent and all photos, and an explicit date query overrides the recent
window. Capture dates use existing evidence; undated imports remain reachable.
New native Sync intake uses 30 days. Existing persisted 10-day anchors and source
exclusions survive unchanged until the owner explicitly expands them to 30 days.

People, OCR, visual indexing and Picks use current date, source and reviewed-People
metadata before preview decoding or inference. Reviewed names and previously
processed older evidence stay searchable. Native startup publishes cheap metadata
first, then processes at most 500 eligible photos shared across OCR/classification/
visual work. People review also limits each explicit batch to 500, offers the next
batch and retains unavailable sources for an explicit retry. Browser People reuses
current reviewed/session results and puts older-source and reassessment controls
under Options. Changing a scope, permission or source revision stops stale work.

Browser refresh reuses a bounded metadata session cache and verified unchanged
catalog envelopes while fetching current annotations. Changed envelopes verify
again; lock/account changes clear the cache. Account-specific IndexedDB cursors
replace broad catalog scans. The optional 100 MiB ciphertext cache now uses an
atomic persisted size/FIFO ledger instead of reading every ciphertext on insertion.
A blocked cache upgrade asks the owner to close other Fotoro tabs and retry.
The server's existing account/sequence indexes and encrypted protocol are reused.
API error diagnostics add only a bounded operation category, with no photo, account,
URL, query or payload content.

Local verification passes 532 web tests before the final scope-chip adjustment,
then 16 affected UI tests and TypeScript on that adjustment. The final production
build and all three startup-boundary tests pass: 430,339 static JavaScript bytes
across eight chunks. The full API suite passes 98 tests in 19 files. Native executes
419 tests: 418 pass and one existing Vision test skips. The isolated preview
executes 114 tests: 113 pass with the same skip. Scoped public-fixture tests reduce
20,000 metadata records to one current matching photo and measure exactly one
preview/inference for each affected OCR, Picks and face pipeline. Native keyset
tests process 601 candidates as 500 plus 101 without overlap. Cache tests cover
cross-tab byte bounds, reopened ledgers, changed envelopes, account fences and
fresh annotation removals.

Actual isolated browser QA confirms reviewed names reopen without reassessment,
Find more reuses current results, the recent/all chip works in both directions,
and a 2018 query removes the recent filter. A single matching public fixture is
reviewed and named; 320- and 390-pixel views keep one dialog and usable controls.
This does not measure general identity accuracy or first-load performance for a
20,000-photo encrypted catalog. The full catalog still hydrates before client
metadata filtering, and physical iCloud, permissions, background work and memory
acceptance remain open. Production and build 43 qualification are recorded above;
build 42 below is the preceding checkpoint.

## October 7 production and TestFlight 42 checkpoint

PR 46 merged with an exact-head guard after all 23 checks succeeded or skipped.
Qualified head `8311a8639801ad99fe80c42449bab41b1b7f1eab` and merge
`a092848097c07ec304835c3c09ada27c17cdf705` have the same tree. A fresh production
build uses no fixture settings. Worker `8777a26f-ac52-4f7a-95ae-f2bdd94a188e` is
active at 100%; deployment `8bbe9d36-e5ea-43ff-9e8e-f46ac0468526` was read back.
All 45 non-HTML asset SHA-256 digests and the Photos/Saved HTML match the build.
Migrations 0007/0008 have matching schema and ledger entries, with none pending.
Existing production bindings are preserved and cloud inference remains disabled.
Authentication and contact/moment/album Apple associations pass service checks.
Actual production browser entry and passkey-first access render without console
errors. Earlier Worker `2ca15bc9-614b-4b21-a115-f3748c60bbc4` remains available
for rollback.

Build 42 (0.1.0) is processed `VALID` and `IN_BETA_TESTING`, independently read
back with the same existing internal group and one existing tester. Its source
is `d218a02fcb8d9cfb63a7e8865900b60685b6b4e2`; all 147 native/tool input hashes
match the immutable archive and qualified head. Both archive and Organizer-exported
IPA pass the full release audit before upload. The signed main binary/static
runtime dSYM pairing passes; Apple accepted the separate resource-stub dSYM warning.
Approved What to Test notes match independent readback. No tester membership
changed. Standard outside-OS encryption and the approved France exclusion map to
App Store Connect documentation-exemption metadata; the signed binary is unchanged.
This establishes internal availability, not installation of build 42 or physical
passkey, original export, background transfer or installed-link acceptance. The
30-day processing changes after this checkpoint require separate qualification.

## October 7 family, album and returning-account implementation checks

Current source combines reviewed, source-bound People IDs with the search query.
Any includes separate photos containing at least one chosen person; Everyone
requires all chosen people in the same photo. Filtering precedes lexical limits
and constrains visual inputs. Select results replaces selection with the current
eligible result IDs. These rules do not infer travel attendance or identify a
landmark across trips. Public fixtures establish functional behavior, not general
identity or retrieval accuracy.

Live albums use an immutable signed definition, a fresh random album key sealed
to a fixed roster and an encrypted title. Invited members explicitly accept;
accepted members add chosen owned Saved originals, preserving their existing
signed manifest bytes. No private annotation or People-name overlay is shared.
Album search is currently filename/date only; native filtering applies to loaded
pages, with explicit Load more for the remaining photos. Private People, OCR and
location queries remain in the account finder. Shared originals retain embedded metadata.
The bounds are 12 roster members including the owner, 1,000 photos per album,
100-photo append/pages, 100 inbox results and 50 accepted active albums per
account. Pending invitations do not consume accepted quota. The owner ends
access for everyone; previously downloaded files cannot be recalled.

Sixteen core album tests and TypeScript pass with real public-fixture crypto,
including three members opening the same key, contributions by each member,
signature/context tampering, strict invitation parsing and unchanged legacy
manifest bytes. Twelve focused Worker album tests and API TypeScript pass with
local D1/R2: acceptance and object authorization, pagination/capacity, concurrent
creation/append/end, operation retry identity, atomic acceptance quota, malformed
or oversized requests and revocation during an R2 read. Captured vault-account
expectations reject a changed authenticated account before any object read.

Returning-browser PRF inputs are restricted to the cached account's fresh
server-authorized credential list. One matching assertion can sign in and unlock;
fresh-browser discovery retains a second selected-credential assertion. Tests
fence credential/account/public-key/salt changes, stale output and cancellation.
Password recovery remains available; Sign in with Apple is not implemented.
These simulated ceremonies do not qualify physical passkeys or promise one
shared session across Safari and native apps.

Client review verifies membership and account fences around media reads, disposal
of open previews on lifecycle changes, original component export and exact
signed-manifest contribution retries. Final local verification passes 516 web
tests, 92 API tests, core checks, five isolated encrypted-exchange cases and the
real pinned-model visual smoke case. Full native verification executes 415 tests:
414 pass and one existing Vision test is skipped. The isolated Photos preview
executes 113 tests: 112 pass with the same skip. Native album tests pass 14/14.

Actual browser QA against isolated local D1/R2 uses three disposable public-test
accounts and a public NASA fixture. It verifies owner review, explicit invitation
acceptance, three members' contributions, duplicate suppression, filename search,
new album creation, explicit owner end and large-photo navigation. Photo-first
album screens use compact contributor/date tags, with account details under More.
Responsive checks cover 320×568, 390×844 and 1280×720; the 320-pixel page has no
horizontal overflow, one dialog and 44-pixel primary controls. These observations
do not establish full accessibility conformance. Actual Safari original preparation
and a fresh Download original click save 329,611 bytes matching the checked-in
public NASA original's SHA-256. The embedded browser's download event remains
unavailable; physical iOS original export still needs acceptance. No UI
download-success claim is made before a browser actually saves the file.

The production and build 42 checkpoint above supersedes the earlier release
status below. These implementation checks do not establish physical-device
acceptance or enabled cloud inference.

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
- Search, picks, photo GPS, reviewed People and confirmed Timeline imports operate
  locally. General identity/retrieval quality and cross-device contact convergence
  remain open. Private evidence stays in the account finder. Scene publication
  remains disabled for reader compatibility.
  Local vectors and raw Timeline imports do not upload.
- Full first-use/returning-account acceptance, two-person sharing completion,
  interruption/relaunch restoration, accessibility and realistic library performance
  still need physical-device evidence. Apple ID login is not delivered.

A public fixture, a synthetic 10,000-item index or a simulator pass does not prove
that Fotoro is ten times better than an alternative. Compare the same real tasks
and libraries using [the comparison protocol](competitive-baseline.md).
