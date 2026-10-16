# Verification — October 15, 2026

This is the current evidence record. [The backlog](product-backlog.md) owns next
work; [product](product.md) owns the intended experience. Earlier measurements and
release checkpoints are preserved in the [historical appendix](history/verification-through-pr38.md).
No speed, accuracy, cost or adoption claim is inferred from a passing smoke test.

## October 15 photo interaction and scrolling follow-up

PR 110 merged as `df91a4fc77a265ec1bf83a2b63115329f92de0a5` with the
qualified source tree unchanged and all 23 hosted contexts complete (seven
successes, 16 intentional skips). Worker
`093177d2-d5cf-4596-b041-1b644849d0df` serves 100% of production traffic;
all 43 emitted non-HTML assets and three entry routes match. Build 82 passed
retained archive and distribution IPA audits, Apple processing and the approved
encryption/no-France declaration. Fresh App Store Connect readback confirms the
existing internal group with one tester. Connected-device app metadata confirms
build 82; the owner reports incorrect photo taps and laggy scrolling.

The next patch constrains cropped photo-button interaction bounds across grids,
search, albums and Places, and constrains still-viewer gestures to the current
page and viewport. Missing interaction shapes are a code-level explanation for
cropped images claiming neighboring touches; coordinate routing remains a
physical acceptance gate. Simulator accessibility activation could not provide
a reliable coordinate-touch regression in a temporary test-host window. That
temporary harness was removed; no new skip masks this limitation.

Thumbnail request admission and degraded/final image callbacks now validate
current Photos source revisions in actor-coalesced slices of at most 200, rather
than synchronously fetching metadata for each callback. Two regressions failed
before repair. A 200-callback/100-source burst uses one fresh metadata read;
1,000 unique requests use five bounded slices. Later bursts revalidate edited or
removed sources. Visibility, permission and generation are checked before each
publication; a prior completion can withdraw later work. This is a reduction in
metadata-read amplification, not a measured whole-app speedup.

Saved still previews use decode-time ImageIO thumbnailing through the existing
Nuke pipeline, capped at 1600 pixels. Tests decode actual oversized landscape and
portrait JPEGs and preserve their source bytes. Original files are no longer a
fallback for ordinary preview display; missing derivatives show an unavailable
state. Fallback thumbnails require matching photo ID, metadata and manifest.

Both clients expose All, Photos and Screenshots choices. The existing default
still includes every non-Trash item; the explicit Photos choice excludes current
screenshot evidence and respects owner corrections and digest bindings. Missing
capture metadata does not establish camera origin. Native filename drafts also
survive incoming names, reappearance and unrelated Screenshot changes; explicit
successful name apply/reset resolves the draft. Local metadata edits recheck the
displayed source revision and Photos permission, and tag actions merge against
current labels rather than an old editor snapshot.

The affected native suite passes 108 tests with no failures or skips. The full
workspace check passes, including 821 browser and 129 API tests. Full native,
hosted and release qualification are separate pending gates for this patch.
A physical Animation Hitches recording attached and reached its time limit but
did not finalize into a readable trace; it supplies no frame-pacing evidence.


## October 15 core follow-through

PR 109 merged as `2d83b292e03da46cada3011673139962fde95757`, with the same
tree as qualified head `00e5b6c2dfeb940fd5793cf5392b15570208201a`.
All 23 hosted contexts completed (seven successes, 16 intentional skips).
Worker `040fcd9e-b309-4a99-b797-0c725d9aa705` serves production at 100%;
all 43 non-HTML assets match the merged build. Build 81 passed archive and IPA
audits, Apple processing and assignment to the existing internal group with one
tester. Physical installation remains unverified; phone usage remains paused.

The next source patch fixes four reproduced gaps:

- Native OCR commits, publishes Find coverage and queues its derived annotation
  before optional scene classification. A held-classifier regression verifies
  that completed OCR remains searchable and syncable; cancellation resumes only
  the unfinished visual stage. This does not establish device inference speed.
- Both clients retain the immutable original filename as search evidence after
  renaming, while removing superseded custom names. Current filenames rank before
  original aliases; explicit pins and source/date/People/Trash fences still apply.
  Native Saved search and the local index both cover this path. Existing renamed
  index rows backfill once in 200-record read pages with transactional rollback.
- Browser refresh owners share the serialized catalog cursor and verified cache,
  while retaining independent cancellation and decrypted result keys. A cancelled
  or withdrawn owner cannot capture a fresh refresh or wipe another owner's result.
- An incoming name preserves an edited filename draft and offers Use saved name.
  Successful explicit Apply/Use original name resolves the draft; failed or
  withdrawn operations preserve it.

Controlled regressions failed before repair. Final workspace checks pass,
including 820 browser and 129 API tests. The full native run passed 765 with
three existing skips; three fixture-service connection failures were resolved
by starting the missing local fixture service. The final ConsumerCore, Exchange
and Transfer run passes all 98 tests, including those three cases and the final
Saved-alias fix. The complete isolated-preview suite passes 203 with three
existing platform/opt-in skips. Independent local browser origins backed by the
actual Worker/D1/R2 verify concurrent rename/draft retention, original-filename
lookup after rename and explicit name reset using a public fixture. Hosted
qualification and release of this next patch remain separate gates. Broader
personal retrieval quality, physical latency and background behavior remain open.

## October 14 released search, sync and Favorites; Saved search follow-up

PR 100 merge `155b54aa5b52deb8583c1767eea04d2cffceacac` was released at
fotoro.cloud on Worker `ec22e7f4-ceda-4291-a810-d3aa885c8495` at 100%.
All 49 non-HTML emitted assets match the merged build. Live public-fixture
receipt, missing-number, Favorites and scene searches pass without console errors.
The isolated second-browser recovery and original download match source bytes.
Local qualification passed 771 web tests and 716 native tests with two platform
skips; all required final-head hosted checks succeeded or intentionally skipped.

Native 0.1.0 (75) passed archive and distribution IPA audits and Apple upload and
processing. Its declaration preserves the owner-approved France exclusion and
standard encryption outside Apple's OS. App Store Connect confirms the existing
Fotoro Internal group includes build 75 with one tester. Physical installation of
75 remains unverified. Apple accepted the upload with a missing vendor ONNX Runtime
framework dSYM warning; app symbols and release audits passed.

A follow-up native regression reproduced unnecessary visual-index construction and
image preparation during exact identifier and filename queries. Identifier search
now stops before constructing the visual catalog; filename evidence stops before
image preparation/query encoding. Recognized date-scene queries remain eligible.
Catalog and visual query results recheck origin, account access and metadata
snapshot, including an unavailable model response. Parent cancellation reaches
lexical and semantic workers. The three initial regressions failed before the fix;
126 affected native search, annotation and consumer tests now pass. Hosted
web/API, full native and isolated Photos preview qualification passed at
`0408fba9f32303ec8f19d186c859b983562afe84`; PR 101 merged as
`201551bb7a7c462662659b57142526f6d3a9af3a` with the same source tree. Build 76
passed archive and distribution IPA audits and uploaded successfully. Apple
processing and availability in Fotoro Internal with one tester are confirmed.
Physical installation remains unverified.
This source evidence does not establish physical frame pacing or broad retrieval
quality.

## October 14 reselected originals retain Saved Favorites — released

Reopening an original on the web could hide its Saved favorite because an absent
local choice replaced verified Saved metadata. Only explicit local true/false
choices now override Saved state. The displayed original inherits Favorite status
only for its exact current file/digest and account; withdrawal removes that overlay.
Unloaded favorite metadata can admit a reselected original for bounded hydration.

Both new regressions failed before repair. All 773 web tests and the full local
check pass. An isolated real-browser account journey verified Saved Favorite →
reopen original → Favorites returns one copy → Unfavorite removes it → Favorite
restores it, with no console errors. PR 102 merged as
`8db2b152c86011ff26d1ad29320683578b7b9324`; all 23 hosted contexts completed
with seven successes and 16 intentional skips. Worker
`38d20b59-92f2-4f2a-a3a2-702d334aad62` serves 100% of production traffic,
and all 49 non-HTML emitted assets match the merged build. Live receipt,
identifier and Favorites browser checks pass without console errors. Native
runtime source is unchanged from build 76.

## October 15 reselected Saved labels — local qualification

The browser's local original could hide the Saved copy's labels. Adding a label
from that view could consequently replace existing labels. The exact current
file/digest/account overlay now shows Saved labels only when no explicit local
label edit exists. An explicit empty list still means the user removed labels.
Import and encrypted local retention preserve that distinction; the retained
array stays readable by older browser builds and legacy empty lists remain explicit.
Account-derived overlays do not enter local retention merely by being displayed.

Three regressions reproduced missing label inheritance and the import/retention
conversion of an absent choice into an empty list. The 42 affected tests pass;
the full check passes, including 776 browser tests and 129 API tests. Hosted and
release qualification remain pending. A disposable local account browser journey
verified labeled original → encrypted Save → open original before recovery on
another origin → existing label visible → append a label → Save changes → refresh
the first browser → both Saved labels recovered, with no console errors. Native
runtime source is unchanged.

## October 11 durable native retries — awaiting hosted qualification

The next native patch stores stage retry deadlines in the existing search SQLite
store, separate from successful OCR/classification/vector completion. Automatic
startup honors deadlines; explicit scoped retry bypasses them. One admitted
wakeup includes deadlines elapsed during later batches and resets the transient
cursor. Model readiness releases only model-deferred vectors. Revision,
processor and generation checks protect result/retry transactions.

Added permission-independent regressions exercise close/reopen, due and overdue
selection, per-stage eligibility, atomic rollback, withdrawal, model readiness
and account-overlay removal. Backup regressions check indexed source point reads
among 10,000 unrelated checkpoints and one selection write across repeated
status updates, with rollback and queued/committed exceptions preserved.
Source review found and corrected the overdue-retry starvation case. Local core
checks pass; hosted compilation caught two missing test `try` markers, corrected
before rerunning. Hosted native tests and physical-device acceptance remain
separate gates. No local Xcode, device installation or browser cutover is part
of this native-only patch.

## October 11 indexing and sync isolation — source reviewed

Recent-photo analysis continues bounded batches independently of Search/People
queries. Each completed attempt checkpoints its cursor and unavailable state;
scroll cancellation retains the unfinished source. OCR/classification publish
without awaiting a cold semantic model download. Readiness starts one missing-
vector pass; warm inference reuses the derivative. Explicit historical analysis
retains its own scope/preview through a cancellable wait. Cancelling a model
consumer leaves shared installation intact.
A cancellation-aware utility worker enumerates sync metadata and returns only
value facts, followed by current account/trust/vault/endpoint/Photos checks.
Acknowledging an own annotation payload updates sync status without republishing
all browsing overlays. Transfer phase/message updates preserve timeline identity;
verified-copy, digest and revision changes still update deduplication.

Browser metadata discovery advances serialized four-page foreground slices
independently of gallery limits and releases the owner between slices for queued
saves. Verified cached metadata scans reuse unchanged source receipts; builds
and broad queries yield outside rendering. Matching hydration retains selection,
rechecks exact receipts and wipes withdrawn keys. Continuous appends do not cancel
the whole index; changed sources withdraw individually. Cached metadata/search
budgets and the 200-result cap remain explicit. Public regressions find a target
beyond the first 100 rows and fresh server photo 225 without fetching originals,
and stop a held 425-row continuation before later rows/pages.

The 115 affected browser tests and TypeScript/Vite build pass. A reproducible
20,000-record synthetic Node/Mac benchmark measured yielding index construction
at 548 ms total / 8 ms longest timer gap (synchronous 301 / 301 ms), and a broad
query at 67 / 6.3 ms (synchronous 46 / 46 ms). These measure desktop event-loop
blocking, not browser/iPhone frame pacing, inference throughput or photo quality.

The full core/API/browser check passes, including 129 API and 745 browser tests;
the pinned public visual-inference smoke passes. Existing native suites add
partial-batch continuation, cold preparation/cancellation, historical scope,
status-only grouping, overlapping acknowledgment/newer-edit and off-main
metadata admission regressions. Native compilation/tests are pending hosted CI;
no local Xcode or device installation was performed. Physical frame pacing,
large-inventory actor filtering/reconciliation and durable browser inference
remain open. The supplied diagnostics contain builds 50/60; their repeated
pending-transfer/context cancellations are historical evidence, not measurements
of this source or the currently installed app.

## October 11 family Trip recovery — deployed

PR 85 merge `be4b9f57810e0c3d68d24b5610c5765a18e1c294` is deployed:
Worker `cf144db8-c338-4661-a5aa-5ab9566726a3` at 100%, deployment
`cd4549db-985b-4a58-b3e2-113066e34fd9`. All 47 non-HTML assets and 10 routes
match the qualified merged tree; all 23 hosted contexts passed or intentionally
skipped. Bindings, API script/runtime and schema are unchanged.

Browser invitations survive switching apps to verify the sender. Private work and
copied keys stop immediately; returning reloads the same public invitation in the
same vault and origin, with fresh verification and explicit Join. Rapid background
transitions force a new panel lifetime. An old panel cannot complete a replacement
invitation. Explicit Close, page navigation, lock and account/origin changes retain
their withdrawal behavior.

An append-only `409 VERSION_CONFLICT` from concurrent family contributions retains
the exact already-Saved choice and signed request for explicit retry. Other access,
identity, manifest and integrity failures still dispose access and retained keys.
Both original defects were reproduced by regressions before their fixes. The final
web build and 729 browser tests pass; the 35 focused invitation and action cases
also pass. The full core/API/browser check and pinned visual inference smoke pass;
independent source review found no remaining blocker. Physical Safari and the
complete two-account family journey remain open.

## October 10 People links — deployed and installed

PR 82 is deployed at fotoro.cloud: Worker version
`7ef7e9a3-2d28-47d6-bd33-ad2174cb3631` at 100%, deployment
`84762eae-6ef9-42ee-bfa0-b604191091c0`. Migration 0011 is applied; all
47 emitted assets and 10 routes match the qualified merged tree. All 23 hosted
checks passed or intentionally skipped. Local qualification passed 653 native,
167 preview, 722 browser and 129 API tests; native and preview each have two
platform skips. Reviewed contributor names can be explicitly linked in an
encrypted same-account ledger, with current membership/evidence fences and
conflict review. This does not publish a family-wide identity to other accounts.

Build 71 passed archive audit and was directly installed on the paired iPhone;
device inventory confirms build 71. Automatic launch was blocked by the locked
phone. Its distribution export failed with No Accounts and a missing iOS
Distribution signing certificate/private key; no TestFlight upload completed.
PR 81's Saved-page preservation and browser resize/return fixes are included.
Physical frame pacing and a complete two-account family Trip journey remain open.

## October 10 sync priority — merged and directly installed

PR 83 merge `cd085742538ba6dcaf4ff04ad2296a51d56969f6` matches the
qualified source tree; all 23 hosted checks passed or intentionally skipped.
Build 72 passed archive audit and direct installation; device inventory confirms
72. Launch remains blocked by the locked phone. A fresh export retry still reports
No Accounts and a missing iOS Distribution certificate/private key; no build 72
TestFlight upload completed. The cloud remains on the PR 82 version above.

Current queued sources retry staged ciphertext before Photos discovery. Every
asynchronous journal boundary rechecks account, trust, vault, API URL, permission,
pause, source revision, owned live photo and digest. A recoverable transfer failure
retains its retry and allows discovery to continue. Recent discovery queries the
persisted date horizon plus tracked sources; new untracked old or undated photos
wait for Include older. Tracked older revisions remain reconcilable. Automatic
Picks waits through account restoration, queued sync, catalog preflight and backup;
explicit Picks remains available and cached completed work survives resumption.

The full native simulator suite passes 661 with two platform skips and no failures.
The isolated preview suite passes 169 with two platform skips and no failures.
Focused sync/Picks and media/reconciliation suites pass 63 and 96 respectively.
The full core/API/browser check passes, including 722 browser and 129 API tests.
Physical build 70 diagnostics recorded 37 seconds with a cancelled discovery scan,
overlapping Picks and no upload POST. That trace motivates this change; it does not
measure frame pacing or prove the new pipeline on the physical iPhone.

The follow-up status fix shows Preparing immediately when automatic work is queued,
then yields to actual catalog checking or upload activity. Completion and withdrawal
restore the durable queue status without notifying an unchanged photo tile. The
new preflight regression fails against the previous source; 108 consumer/manual
backup and 26 automatic-sync simulator tests pass with the fix. This evidence
does not establish physical frame pacing or TestFlight delivery.

### Earlier PR 77 checkpoint

PR 77 was verified in production, Worker
`dd6a9562-8888-4440-844a-4c98ee1c6d96` at 100%. All 23 hosted contexts passed;
merge `e61e474bedd2700e16bcea93d36be6f1fb2bcf3a` has the qualified tree.
Native 0.1.0 (65) passed archive and distribution IPA audits and uploaded through
Xcode on October 10. Apple last reported processing; its TestFlight installability
has not been read back. Migration 0010 is applied. The paired physical iPhone
still has build 61 installed. Its bounded diagnostic ring ends October 10 at
04:52 UTC, before the latest fixes; it does not qualify builds 65 or later.

## October 10 core usability — locally qualified

New trip can open the existing reviewed contact flow and return to the same
name, invitee choices and photo selection. The nested Contacts mode omits unrelated
photo-sharing controls and inbox requests. New contacts still require an explicit
member choice; identity review and the fixed signed roster remain unchanged.
Browser invitations remain selectable when clipboard access is unavailable.

Saved search matches all query words across evidence belonging to the same photo,
so a reviewed name and place can combine with a trusted capture-date query.
Ownership, source digest and explicit People filters still gate results. Select
results adds eligible photos without erasing earlier choices or toggling already
selected Saved photos off. Existing export validation rejects changed sources.

Browser challenge and approval-receipt validators remain exact, but load through
the existing deferred vault runtime. A fresh build measures 450,547 bytes across
eight static startup chunks, within the unchanged 500 KiB budget. The full check
builds the browser before its tests so the emitted budget cannot inspect an older
build. Local core/API/browser checks pass: 691 browser and 122 API tests, zero
failures. The full native simulator suite passes 638 with two skips and no failures.
These checks do not establish physical scroll frame pacing, real Safari passkeys,
cross-device original restoration or a family's complete Trip journey.

## October 9 chosen photos to Trip — locally qualified

An explicit Add to trip action carries the exact local and Saved selection through
account access, saving and metadata hydration, then opens the Trip chooser.
Contribution still requires choosing a Trip and confirming Add. Interrupted saves
or hydration preserve the request for explicit Retry; Back, account changes and
hidden-page cancellation cannot publish a late chooser. Choices are bounded to
100 originals and checked by owner, manifest and digest, including committed
sources not yet present in the browse catalog. Local Photos startup stays separate
from account crypto.

Browser original download is one explicit action in the photo viewer. Current
preview, access and original verification still gate publication. Temporary Trip
refresh failures preserve the opened reader; confirmed access or integrity failures
clear it. The native Add picker retains selection and source revisions after
failure, supports explicit retry and cancellation, and closes only after a
successful addition in the current account and Trip. A failed membership check or
inbox refresh preserves that verified context only for temporary failures; every
retry rechecks current membership. Confirmed access loss closes the picker, and
early cancellation releases the busy state.

The full core/API/browser check passes. Browser tests pass 679 with one emitted
startup-budget check deferred until build; all three startup checks then pass
against the production build. Native qualification covers 556 passing cases and
two simulator skips after correcting the temporary-failure expectation and
rerunning that case and a fixture-server interruption. Actual simulator QA proves
failure and cancellation preserve selection and successful retry closes the picker.
Actual local browser QA selected a public test original, signed in
to a disposable account, saved it, opened the chooser, explicitly contributed it,
and downloaded a byte-identical original in one click. The viewer fits a 390×844
viewport; browser warning/error logs are empty. This evidence does not establish
physical-device frame pacing, Safari downloads or family-wide acceptance.

## October 9 direct Trip contribution and scoped Picks — locally qualified

Native and browser Trips now offer direct device photo selection. Existing Save
pipelines commit the chosen sources before contribution. Failed, cancelled or
changed sources cannot contribute an incomplete set; completed private saves
remain in Saved. Contributions use only the chosen, current owned sources and
omit exact duplicates. Browser hydration reads the selected committed manifests
explicitly when browsing metadata has not caught up. Native invitation entry
preserves the intended Trip and still requires explicit acceptance for an invite.

Trip best shots uses existing local quality and diversity rules on at most 200
matching unique loaded images, using small derivatives without original fallback.
Suggestions show reasons and incomplete coverage; originals remain untouched.
Capture grouping uses verified capture dates rather than import dates. Work and
cached results remain bound to current account, access and signed source revision.
Provider understanding remains disabled.

Saved day grouping and favorite filtering now reuse an invalidated projection.
Favorite corrections invalidate that projection. Native Trip thumbnail/preview
files reuse verified data with current membership checks and revision-specific
paths; temporary membership failures preserve an opened Trip, while confirmed
revocation clears it.

Local qualification passes 629 browser tests, 122 API tests, 544 native tests and
142 isolated preview tests. Native and preview each have two simulator skips and
no failures. Production browser build and startup checks pass. Actual browser
file-picker QA chooses three public fixture files including an exact duplicate;
two photos reach the Trip, Picks produces a suggestion, and the downloaded ZIP
contains the two byte-identical chosen originals. Browser warning/error logs are
empty. These checks do not establish physical-device frame pacing, cross-device
restore, shared face identity, Safari large-ZIP acceptance or recoverable deletion.

## October 8 Trips and encrypted contacts — locally qualified

Trips use the existing live album membership: invited people can add chosen Saved
photos over time. Download trip independently traverses the full bounded inventory,
verifies originals and current access, and creates one ZIP. Exact original copies
and renamed identical Live Photo bundles are omitted from the export; contributed
copies remain in the Trip. Complete Live pairs keep their resources together.
Cancellation, incomplete paging, late contributions, revoked access and output
failures discard the incomplete archive. Browser backing files remain available
until Done downloading or Trip cleanup; the Trip must stay open during download.

Reviewed contacts and names now synchronize as an encrypted, signed owner journal,
independently of photo Pause. Explicit conflict review preserves concurrent edits
and requires review for changed identity keys. Migration 0010 adds only the contact
table; contact names and cards stay inside the encrypted payload.

Local checks pass 618 browser tests, 122 API tests, 538 native tests and 142 isolated
preview tests. Native and preview each have two simulator skips and no failures.
The final filename portability change passes all 13 export/lease regressions,
typecheck and browser build. All three startup checks pass at 442,350 bytes across
nine static chunks. Actual browser QA uses two disposable loopback accounts and
public fixtures: four contributions export three byte-identical originals, with
one exact duplicate omitted; a filtered view still exports the whole Trip.
Published-file cleanup and an empty browser warning/error log are verified.
These checks do not establish physical-device, Safari large-ZIP, family face
identity, real passkey or large-library acceptance. Release qualification remains
the distribution checkpoint above until hosted checks and deployment complete.

## October 8 family-loop release — PR 58 / build 52

Qualified head `ae0aa55c83e19df950318469dd4de8538584801c` passed all 23 hosted
contexts (seven success, 16 intentional skips). Merge
`4092bd9e6797c21cfbd0844dac485330a03697da` has the same tree. Production Worker
`cec37239-cc1a-4d0b-b1c5-3b8843bc3829` serves the exact 46 built assets;
bindings, API script and runtime were unchanged. TestFlight build 52 was uploaded
and read back as `VALID` / `IN_BETA_TESTING` for the existing internal group.

Album entry can explicitly review an owner on a fresh browser, subsequent
contributions can choose more photos, failed native page hydration retains its
retry checkpoint, and return restores the same album and filters. Local
qualification passed 585 browser tests, 116 API tests, 515 native tests and 140
isolated preview tests; the native and preview runs each had two skips. Actual
local browser/mobile and simulator journeys used public synthetic data. They do
not establish physical-device restore, face quality or frame pacing.

## October 8 native photo delivery — released as build 51

Grid thumbnails reuse a bounded 32 MiB/80-entry cache keyed by source revision,
requested size and network policy. Photos permission changes and library refresh
invalidate cached access and late callbacks. Native scrolling owns its offset;
filter/date transitions explicitly reset it. Timeline grouping and photo lookup
reuse metadata, and an empty Saved continuation no longer republishes the catalog.
Sync shows actual transfer phases, distinguishes cancellation from completion,
and treats an expected incomplete-commit recovery probe separately from failures.

Local native tests pass 507 with two skips; isolated preview tests pass 140 with
two skips. Hosted checks pass, and the archive and actual distribution IPA pass
release audits. Simulator forward/reverse scrolling and date/filter transitions
were checked. This is not a physical frame-pacing or battery measurement. The
paired phone now reports build 50; its bounded diagnostic window contains builds
49/50 and no album/search events. Build 51 installation and real family acceptance
remain unverified.

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
# Finding, organizing and sync qualification — 2026-10-14

The current repair adds automatic native retries after temporary transport/server
failures, exact-number search fences on iOS/web, and web Favorites filters across
Photos/Saved. [The 10+10 acceptance checklist](competitive-baseline.md#ten-photo-intelligence-expectations-and-ten-platform-checks)
records the finding/organizing scope and remaining measured-quality/device gates.

Local qualification: `pnpm check` passed (771 web tests); the standalone real Swift
retry/background-upload host runner passed 17 tests. Targeted Simulator search,
backup, retry and upload tests passed 79 tests. The full iPhone 18 Pro/iOS 27
Simulator run passed 716 tests, skipped 2, and failed 0. The two existing skips are
the explicit PhotoKit edited-metadata QA gate and unavailable Simulator Vision
classification context; neither is a passed physical-device check.

Numeric identifiers are checked after recognized date constraints are removed.
Present/absent invoice numbers and Unicode digits cannot gain unrelated visual
matches; ordinary scenes and scene/date queries retain semantic matching. This
also avoids initializing the visual model or loading previews for exact-number
queries. Native filename meanings also remain exact, with all 9 semantic tests
passing after that final parity fix. Favorites uses verified annotations and full cached metadata before the
200-result cap and preview hydration. A favorite at row 240 of 250 remains
findable while stale annotation favorites are rejected. A pending local
Unfavorite takes precedence over older Saved metadata for the same original.

Real browser checks use only public fixtures: the receipt is the sole match for
`invoice 4826`; `invoice 4827` gains no fireworks match. Favoriting the receipt and
enabling Favorites leaves only that photo. An OCR failure on the other fixture
remains explicitly incomplete instead of claiming complete search coverage.
The saved Favorite and OCR text survive reload/password recovery and open from a
second browser origin at a 390 × 844 viewport. Diagnostics contain only permitted
operation fields and random request references; fixture text/names are absent.

The recovered receipt downloads with SHA-256
`9118ddb774b564064c3d9ceae48c2127f08f87cf648353b3f9e27a6c76777d2a`,
matching the imported original exactly.

Native distribution still requires an Apple Account and its distribution
certificate/private key in Xcode. Build 73 archived from the prior release but
was not uploaded; these additional native fixes are not on TestFlight yet.
Physical iCloud/background, battery, frame pacing and VoiceOver acceptance remain
open. Hosted checks, merge and deployment are qualified separately below when
completed.


## Photo organization and simpler Info (October 15, 2026)

Implementation adds editable private filenames with evidence-based suggestions,
screenshot correction/filtering, a bounded cleanup review and Fotoro-only Trash
with Restore. Original bytes and user captions remain unchanged. Date/place/tags
are visible; camera dimensions and provenance sit in Technical details.

Local verification: the full workspace check passed, including 129 API tests and
789 browser tests with the emitted build/startup budget present. A subsequent
65-test native run passed annotation, search, Info, place and 10,000-record search
performance coverage. The authenticated native test saves a name, screenshot
flag and Trash on one client, refreshes another client, restores there, and
refreshes back with the name, labels, OCR and original digest retained. The first
native run’s authenticated fixture test failed because this new local database
had not been seeded; after local-only public-fixture seeding, the expanded real
round trip and complete affected suites passed. This is a setup correction, not
an ignored failure.

Further browser walkthrough and release qualification are recorded with the
release artifact. Physical phone installation, measured battery/frame pacing,
full-library cleanup quality and accessibility acceptance remain open. This
cleanup release retains storage and never deletes the device Photos library.

Final organization pass: the final web build and all 789 web tests pass. The 65 affected native tests were rerun after the final filename/export changes and pass with no skips (Xcode result `test_sim_2026-10-15T16-57-11-702Z_pid34826_535a8b74.xcresult`). Browser verification used a disposable account against local D1/R2: upload, explicit BTS tag/name, screenshot classification, cleanup preview, encrypted Save changes, lock/recovery and Fotoro Trash. A delayed main-grid update found during that flow was fixed by overlaying current loaded owner records over the cached metadata projection, with a regression test for immediate Trash and Restore.

The disposable browser flow also verified explicit Restore, encrypted Save changes, a separate Screenshots view showing the BTS-named photo, and exclusion from Places. Cleanup/Trash/Restore screenshots are stored in the local core-simplification artifact directory. Final web suite: 789 passed, zero failed or skipped.

The complete native suite subsequently passed 725 tests with zero failures and the two existing PhotoKit/Vision skips. The lightweight Photos build passed 176 tests with the same two gates. Its shared location test now uses Foundation to parse the public fixture date, since the lightweight target omits the account wire layer; all seven full-app location tests passed again after that test-only correction. No production native inputs changed after build 77’s archive and distribution IPA audit.

## Browser visual-search latency repair (October 15, 2026)

Cached visual ranking previously yielded every 32 photos and copied the growing
score map every eight photos. A 4,096-vector isolated fake-worker run on this Mac
took 255.5 ms and 127 scheduled timer turns. The repaired engine uses 4 ms CPU
slices, publishes the first available score before later images finish, and limits
intermediate progress snapshots to one per 100 ms. The same isolated check took
21.3 ms with four timer turns and two publications. These are engine measurements,
not browser frame times, model inference latency or physical-iPhone evidence.

Up to 16 text embeddings are reused within the existing inference session; they
are never persisted and are zeroed with the image vectors on session clearing.
Only fully cached, source-current queries bypass the 250 ms inference debounce;
new phrases or missing/changed vectors retain the delay to avoid inference churn.
The search UI distinguishes preparation from checking more photos while keeping
lexical matches usable. Regression coverage holds a later image pending to verify
early publication, checks bounded text-cache eviction and session clearing, and
retains cancellation, lock, source-withdrawal, exact-identifier and failure tests.
The actual pinned-model public Singapore smoke case also passes. This change
does not alter native app inputs, account upload consent or sync Pause.

## Native search against the connected phone (October 15, 2026)

A reported text search failed on the installed build 77 despite existing OCR
matches. Authorized diagnostics recorded cancelled searches around 30 seconds.
An all-processes physical-phone capture was symbolicated with build 77's dSYM;
search SQL accounted for most sampled Fotoro CPU. The trace also has device
symbol-overlap warnings, so it does not establish first-paint or launch latency.
Private index copies and recordings remain outside the repository.

The copied library exposed a source-first SQLite plan: every permitted record
was joined against the typed prefix range before evidence grouping. Prefix-first
indexed joins avoid that multiplication without changing eligibility, ranking or
the six-meaning/200-candidate bounds. The live query uses GRDB's cancellable async
read, which interrupts obsolete SQL and resets the connection before subsequent
queries or analysis writes. A controlled running-query cancellation test verifies
that both a successor search and later writes remain usable.

Native presentation publishes existing filename, tag, metadata and OCR matches
before optional visual inference, reuses the completed local response and validates
records in bounded background batches. Visual failure cannot erase a completed
text response. Search shows OCR coverage and distinguishes visual checking.
Automatic local analysis now traverses newest, older and undated permitted photos
in batches of at most 500, retaining idle/foreground/scroll cancellation and durable
retry behavior. Saved automatic visual analysis retains its existing recent scope.

On the authorized 21k-record index copy, final simulator retrieval measured about
41 ms median and 42 ms p90 over ten full-word text queries. Prefix retrieval took
124 ms for one character, 38 ms for two, 27 ms for three and 37 ms for the complete
word. This excludes PhotoKit image loading, UI rendering, first-time inference and
physical-phone performance after the repair. The original join exceeded a 3-second
local SQL timeout for the first character; its replacement completed that isolated
SQL step in about 166 ms. These different checks are not a paired app speedup claim.

Final full-app verification passed 731 tests with zero failures and the two existing
PhotoKit/Vision simulator skips (`test_sim_2026-10-15T19-36-32-365Z_pid34826_b74f2c0a.xcresult`).
The cancelled-query test also verifies later analysis writes. Broad-prefix stress
uses 10,000 synthetic photos across 1,500 meanings without SQLite statistics.
An earlier run exposed an extra cancellation check in the synchronous test path;
it was removed while retaining GRDB cancellation on the live async path, and the
complete suite passed again. Build 78's archive and distribution-signed IPA passed
the production identity, dSYM, static crypto and encryption audits. Upload,
processing, internal availability and a physical-phone rerun are separate gates.

The subsequent cache review reproduced a removed tag reappearing from a completed
response while its replacement query was pending. Reuse now requires the exact
completed query generation; bulk result validation also excludes current Trash
facts. The new failing regression passed after the guard, together with all 168
affected search, date, semantic and consumer tests. Build 78 contains the primary
latency repair; build 79 additionally carries this cache freshness correction.
The original installed phone remained on build 77 at that initial readback.
Subsequent authorized readback confirmed build 78 installed and the owner reported
successful search. Its 48 completed catalog queries measured 46 ms median and
59 ms maximum; 38 completed text-search actions measured 100.5 ms median and
111 ms maximum. These bounded diagnostics exclude query contents and do not
measure first paint, visual inference, scrolling or battery. OCR covered 2,466
of 21,481 device records, leaving 19,015 unchecked. Build 79 was subsequently
processed and linked to the existing internal TestFlight group; physical build 79
acceptance was not performed. All hosted checks for the final PR 106 head passed
or intentionally skipped.

## Parallel foundation, indexing and organizing pass (October 15, 2026)

Three isolated work streams addressed browser return/cross-device reads, native
search/indexing churn, and consistent organizing policy. Browser foreground,
reconnect and Back/Forward restoration events retain one deferred Saved refresh
while another action is busy. A burst during an active read creates at most one
trailing read. These are reads, with no upload intent or change to Pause. Cached
and network snapshots publish inside a checked continuation; withdrawn snapshots
wipe copied metadata keys. A microtask regression covers the publication boundary.

Native OCR, classification and vector completion now share fixed 750 ms search
refresh windows. The first text query can complete while new evidence accumulates;
typing, corrections, permissions and account boundaries remain immediate. A
separate context fence rejects pre-edit answers without treating additive OCR as
an owner edit. Saved/device copy checks read only hit checkpoints in primary-key
batches of at most 400, followed by current local-record validation. Saved lexical
retrieval also uses the existing cancellable SQLite read. This reduces avoidable
work; it does not establish a new physical-device latency or OCR completion rate.

The versioned `moment-highlights-v4` policy retains all assessed eligible favorites
when similar bursts group, and browser Picks excludes nonfavorite screenshots and
Trash before preview work. Native Picks browsing also excludes Trash. Cleanup
reuses preview measurements directly and keeps a favorite representative of exact
duplicates. Suggestions still require review. Filename suggestions consume up to
two distinct useful tags, omit duplicate place words and avoid reserved names;
missing capture dates stay missing. The shared synthetic Find-to-Picks cases pass
9/9; that evidence is functional policy coverage, not real-photo quality scoring.

Native Fotoro screenshot corrections now drive Photos/Picks browse facts,
continuation through sparse screenshot pages, Find Best shots and filename
suggestions. Candidate identities retain the separately observed PhotoKit subtype
for source validation. Source/revision-bound organization facts are cached only
for loaded and recent photos; a separate correction signal invalidates them and
coalesces a hydration batch into one deferred Picks restart. OCR/query publication
does not trigger that restart. Pending Picks also respects screenshot eligibility.
No original or Photos-library metadata is changed.

Final local verification: workspace `pnpm check` passes core/crypto/contracts,
release/preview audits and 129 API tests. The subsequent final web build and all
801 browser tests pass with no skips; static startup JavaScript is 481,720 bytes
across two chunks, below the existing 500 KiB ceiling. The actual pinned TinyCLIP
public-image inference smoke passes. Full-app Simulator verification passes
744 tests with zero failures and three existing/opt-in skips
(`test_sim_2026-10-15T20-25-34-616Z_pid34826_005fe0b3.xcresult`); the isolated
local-preview scheme passes 191 with zero failures and three skips
(`test_sim_2026-10-15T20-27-55-272Z_pid34826_fd75b0f0.xcresult`).
Controlled regressions cover continuous analysis bursts, slow first queries,
owner edits during local validation and Saved reads, and correction changes while
Picks is pending. A real browser using a fresh public encrypted fixture verifies
filename search, a decrypted preview, stale-result clearing and usable Back return
without console warnings/errors. Runtime fixture files and screenshots stay outside
the repository. This does not qualify a new phone build, complete the private OCR
backlog, or measure physical frame pacing, battery, large-library ranking accuracy
or background iCloud behavior. Distribution is a separate gate.

## October 15 index and sync diagnostic status follow-up

The released build 80 has action tracing but lacks a whole-library export-time
coverage report. The last retained physical build-78 catalog has 21,481 Photos
rows, 2,466 OCR-complete and 19,015 unchecked. This is an older local snapshot;
current phone use is paused. Query speed and whole-library retrieval quality are
separate acceptance questions. See [diagnostics](diagnostics.md) for the current
operational limitations and the remaining acceptance order.

This source change adds whole-catalog OCR/visual/semantic coverage to explicit
native diagnostic exports, using one off-main SQL read with source-generation
and permission publication checks. It distinguishes incomplete states, durable
retry/model waits and scheduler activity. Export snapshots do not overwrite the
persisted action ring. Cached Sync state includes its known last-check age and
does not trigger an upload, network refresh or original read. The bounded reader
keeps these snapshots separate from unfinished actions and reports capture age.

Local verification passes 18 reader/privacy regressions, 141 targeted full-app
Simulator tests and 24 targeted isolated-preview tests, with zero failures or
skips. After the final Sync trace-isolation change, all three export/publication
regressions pass again. The static preview artifact audit passes all 24 checks.
All three stage aggregates were also executed read-only on
the retained catalog five times: desktop SQLite median 35.8 ms, maximum 342.9 ms.
This is export-query cost on a Mac, not iPhone latency evidence. Live service/API
and app-association readiness checks pass. This follow-up is not released in
build 80 and does not complete the personal-library or physical-device gates.

A fresh read-only unauthenticated production probe also correlates its client
trace, response/body request reference and exactly one final live server event
(GET, 401, auth class, request phase). The sanitized reader matches one client/
server request pair. Raw tail envelopes stay in private local artifacts and the
tail is stopped. This verifies live correlation,
not historical log access, authenticated photo flows or current phone state.

## October 15 ten-day iteration and batched processing

PR 108 merged as `adbd01b485` after all 23 checks completed (seven success,
16 intentional skips), with the merged tree matching qualified head
`6e9d216600541e5c8692deab02e3f5d8e7256f25`. It is included in this follow-up's
source; the last released native artifact remains build 80 until a later
distribution checkpoint records otherwise.

The requested experiment uses ten calendar days. Native automatic heavy analysis
defaults to Latest 10 days and offers an explicit persisted All photos choice;
original-backup scope and existing indexed metadata/OCR remain independent.
Query-scoped work can preempt automatic analysis, retains its pagination state,
and resumes automatic work afterward. Completed inference stages still commit
before the next inference await. The read-only retained build-78 catalog's
October 6–15 window contains 218 photos, all with completed OCR/classification
and current semantic vectors. This is an older snapshot, not a fresh device read
or recognition-quality qualification. Physical phone use remains paused.

Native annotation hydration reads current records inside batches of up to 200,
skips unchanged writes, preserves local OCR/beforeSync baselines and publishes
search/organization changes once per changed chunk. A fixed 500 ms window groups
derived annotation upload intent, including one trailing window for edits during
a drain; account/vault/catalog/origin/worker/Pause changes withdraw old work.
Explicit owner changes retain the immediate path. SQL posting writes reuse
prepared statements and one serialized date formatter. Already bounded OCR
derivatives avoid a redundant redraw. Ready analysis checkpoint batches have a
32-photo bound and transactional rollback; the foreground photo pipeline retains
its per-stage durability rather than buffering inference across interruptions.

On the same public synthetic ten-day cohort (1,000 records, 100/day), the observed
unchanged hydration comparison was 108.11 ms per-photo versus 14.91 ms in
200-record batches (7.25×). A fresh native metadata index took 192.65 ms.
Earlier repeated samples ranged around 7.3–7.5× for hydration. These are Mac
Simulator SQL/component measurements excluding decryption, PhotoKit, inference,
network and rendering; they are not a 100× whole-app claim. The existing 10k
synthetic regression remains a software scaling check, not a larger personal-photo
experiment. Web `--benchmark` now fixes its cohort to ten days × 100 records and
checks first/warm/batched retrieval plus daily ingestion. All 24 retrieval checks
and ten ingestion checks pass. The fix makes a supplied multiword fact such as
“Backstage rehearsal” searchable by its component word, retaining provenance and
reserved-field exclusions.

Browser diagnostics persist across same-tab reloads with bounded sanitized,
batched session-storage writes, clear/sign-out and late-operation fences; denied
storage remains a memory-only fallback. Native index snapshots now include
whole-catalog/automatic-window coverage and durable per-stage attempt/completion
ages. The reader separates standalone stage events from request-only traces and
flags a long active unfinished run with no recent checkpoint without inventing
a failure or starting retries.

Real Safari clients on independent local origins, backed by the actual local
Worker/D1/R2, pass Save → rename → screenshot correction → sync → Trash → return
refresh → Restore → second-client refresh → reload/unlock/reopen. The downloaded
public fixture is byte-identical (613,520 bytes) to the source. Empty Saved now
opens its existing picker with one click; Cancel stays in Saved, selection waits
for explicit Save, and no picker appears automatically after account recovery.
No private photos/accounts or physical phone were used for these journeys.

Workspace `pnpm check` passes, including 807 browser and 129 API tests. Host sync
regressions pass 20/20 and the bounded diagnostic reader passes 21/21. A full
native Simulator run passes 763 with zero failures and three existing/opt-in skips
(`test_sim_2026-10-15T22-47-31-232Z_pid34826_e457e8b6.xcresult`). Final
pagination/range/search lifecycle checks pass 62/62 after the last manual-priority
changes. The complete isolated-preview suite passes 199 with zero failures and
three existing/opt-in skips
(`test_sim_2026-10-15T22-54-50-225Z_pid34826_7c2563b8.xcresult`).
Hosted checks, merge, web deployment and native distribution remain
separate gates; these results do not establish physical latency, battery, iCloud
background behavior or held-out personal retrieval quality.
