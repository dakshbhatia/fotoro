# Core photo acceptance

The product loop is open photos → browse → find → review names/screenshots or
cleanup → explicitly Save → see reviewed changes on another device. Original
files stay unchanged. Cleanup affects Fotoro only and supports Restore.

This pass keeps existing source, account, permission and revision fences. It
adds no model, provider, permission or upload consent. Heavy automatic analysis
still starts with the latest ten calendar days.

## Ten core checks

| Flow | Code and verification in this pass |
| --- | --- |
| Correct photo identity | Device and Saved interactions are revision-scoped; source replacement cancels web touch sessions. Existing bounded presentation checks remain. |
| Smooth photo work | Native per-frame zoom/pan observation belongs to the image, with a separate mode boundary for toolbar updates; 1,000 drag samples do not notify parent mode observation. This is structural evidence, not a frame-rate measurement. |
| Fast search | A disposed index now invalidates both populated and empty async results; stale results cannot stay current after index replacement. |
| Complete indexing/status | Web Photos and Saved expose loaded-scope OCR coverage, readable-text counts, unavailable evidence and existing visual-search progress. Unchecked does not mean queued. Existing Latest 10 days admission and Saved continuation remain. |
| Screenshots | Web cleanup groups known screenshots by existing tags or current readable text, with explicit individual review. No dimensions or filename guesses classify screenshots. Changing source text preserves a newer account screenshot correction. |
| Consistent filenames | Web, native Saved and native Device Photos selection support preview, collision-safe Apply and guarded name-only Undo. Device naming requires current indexed metadata and permission/source bindings. Without naming evidence, the original filename is retained. Native reservation scans read 200 records at a time; originals stay unchanged and reviewed device names reach exported copies. |
| Recoverable cleanup | Native Saved and eligible web reviews keep encrypted, revision-bound checkpoints on this device and continue in explicit batches of 200 over the loaded snapshot. Pause preserves completed work; current verified Trash removals do not discard remaining progress. Counts distinguish scanned, remaining and unassessed photos; no unloaded-library coverage is claimed. Trash stays Fotoro-only with Restore. |
| Cross-device convergence | Supplied text, organization, People and observation categories merge independently into the latest account facts; unchanged stale categories cannot replace them. |
| Interrupted/offline edits | After a successful online installation, the web shell can cold-start offline at Photos and Saved entry routes. Only public built JS/CSS and static shell HTML are cached here, never API replies or photo data. Existing encrypted data/offline-edit rules remain. |
| Truthful status | Local diagnostics summarize successful logical-action median/p95 timings, failures and cancellation over the retained sample. This is not production aggregation or frame-rate measurement. No log records private photo text, query text or coordinates. |

Native Places can explicitly keep a looked-up approximate area name on an owned
Saved photo. The reviewed label follows existing encrypted annotation sync;
coordinates, source and accuracy remain unchanged. Existing names are preserved.

## Ten gesture checks

| Interaction | Implementation and proof boundary |
| --- | --- |
| Horizontal paging | Native system pager remains; web direction lock pages only horizontally and clamps endpoints. |
| Pull down to close | Native fitted still photos follow a direction-locked vertical pull; web closes details before dismissing the viewer. |
| Swipe up for info | Uses existing native sheets and browser details, without introducing an independent metadata pipeline. |
| Pinch zoom | Native scale is finite and bounded; pinch cancels dismissal. Browser preserves native pinch zoom and cancels its navigation session on multitouch. |
| Double-tap zoom | Native zoom preserves the tapped point within fitted-image bounds; web double-click applies only to the image. |
| Pan a zoomed photo | Pan owns movement while zoomed; actual decoded or PhotoKit dimensions prevent panning letterboxed images into blank space. |
| Drag selection | Native horizontal drags in Select mode paint visible tiles once, selecting or deselecting from the starting tile. Vertical drags remain with scrolling. Active selection near viewport edges scrolls at a bounded speed. Hit geometry follows scroll offsets, recycled tokens are rejected, and source/account/filter changes cancel the stroke. Work stays proportional to visible tiles. Host policy checks and SDK compilation do not establish physical gesture feel. |
| Press feedback | Native device/Saved tiles use bounded opacity/scale feedback without changing layout or hit rectangles. |
| Cancel and return | Axis locks, source replacement, pinch, zoom, VoiceOver and gesture cancellation reject pending dismissal. Pulls settle back; paging resets zoom. Existing grid presentation remains mounted behind the viewer. |
| Accessible motion/feedback | Native Reduce Motion removes added animation/press scaling, VoiceOver retains explicit controls, and haptics occur on settled page changes. Web keyboard navigation excludes text editing and zoom, and viewer CSS respects reduced motion. |

## Verification

`pnpm check` qualifies browser, API, contract and release checks. Both generic
iOS SDK targets compile. `pnpm test:ios:host` covers existing host scenarios and
the added actual-production gesture policy/zoom observation checks. The new
runner compiles the production zoom declaration and gesture policy directly.

Browser acceptance uses the actual LocalViewer and LocalResources with public
Singapore fixture pixels. Synthetic DOM touch probes exercise next photo, info,
details-first dismissal and final dismissal; rendered checks verify the intended
photo, editable keyboard exclusion, zoom navigation exclusion and clean console.
Desktop and mobile viewport screenshots are saved outside the repository.
The browser does not support native CDP touch dispatch; synthetic touch probes
do not establish browser gesture-engine arbitration or native physical feel.

No phone or Simulator was used, as requested. Native frame pacing, thermal/battery
behavior and physical gesture recognition remain unmeasured. These checks also
do not establish held-out human search relevance or a new authenticated
production cross-device journey.

October 17 browser acceptance exercised selected-photo Preview → Apply → Undo,
an explicitly tagged/corrected screenshot review group, and a cold reload plus
Saved entry with the local preview server stopped. The installed worker served
the app with a clean warning/error console. Public fixture data and screenshots
remain outside Git. A first visit while already offline cannot install the shell.

The follow-up browser acceptance retained the public Singapore fixture with
Remember enabled, completed cleanup, reloaded the page, and restored the completed
review with no unassessed previews or warning/error console entries. Review
checkpoints stay encrypted and bounded to the loaded scope, account/origin and
source revisions. Eligible local persistence requires existing Remember consent;
unretained or mixed scopes remain session-only. Explicit Pause preserves the
completed cursor; verified Fotoro Trash removals can resume the remaining sources.
This is not library-wide cleanup history or a cross-device review journal.
Native Saved cleanup uses the existing account catalog and vault wrapping for
the bounded journal, with Pause/Done checkpoints and host restoration tests.

## Public search baseline

`pnpm test:search:relevance -- --require-baseline` runs real OCR and visual inference
against a small public, developer-judged corpus. Its initial measured result is
25/25 lexical/filter cases, and 6/10 exact combined visual-search result sets:
9 true positives, 6 false positives, no false negatives. All seven positive
combined queries rank their expected result first. Printed document layouts are
still confused by visual candidate admission. `--require-exact` deliberately
fails on those known errors; the regression gate permits only the explicitly
recorded false positives and retains the full report in CI.

These are development cases, not held-out relevance evidence. The corpus is too
small to justify changing the global visual threshold. Native Device Photos
naming and edge selection have source/host/SDK evidence; their latest source
changes are not included in the previously uploaded build 89. Physical
performance acceptance remains open, and TestFlight setup remains deferred.

Interaction reference: [Apple's continuous animation guidance](https://developer.apple.com/videos/play/wwdc2024/10145/).

October 17 full browser acceptance used a disposable local account and the real
local D1/R2 API. A public receipt was imported, encrypted and saved, renamed,
searched, moved to Fotoro Trash, saved, and restored. A separate browser origin
with independent local storage recovered the account and verified the saved
name, hidden Trash state, Restore, and searchable OCR invoice number 4826.
A fresh boarding-pass OCR batch immediately showed Searching photos during
metadata refresh and then matched BOSTON. Both browser warning/error consoles
were clean. This establishes a local cross-origin backend journey, not physical
device performance or a signed-in production cross-device journey.

Annotation Save now fails visibly if conflicts or retry contention leave edits
queued. Upload 401 responses expire only their captured vault session and retain
structured request diagnostics. Removing a naming override during Undo restores
intrinsic filenames even when originals share that name; explicit restored names
still require collision checks. Ordinary pending edits say Changes to Save.
Metadata refresh keeps account searches pending; cache revision receipts also
withdraw obsolete empty results. No new test files or assertions were added.

The saved original downloaded with the reviewed filename Seattle receipt.png;
its SHA-256 matched the imported public fixture exactly. A follow-up batch audit
found that filtering unchanged photo objects into a new array could cancel OCR
after its first write. Saved text scopes now preserve array identity only for
identical photo objects in identical order. Source, membership, order, explicit
scope, account, consent, and Pause/visibility changes retain cancellation.
