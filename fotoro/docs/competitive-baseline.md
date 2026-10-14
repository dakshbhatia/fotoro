# Fotoro comparison and acceptance

Fotoro’s advantage is a hypothesis: less effort to sync, find and share useful
family photos. Feature count, encryption and native glass do not establish a
better everyday experience. [Product](product.md) defines the audience and loop.

Compare complete tasks on the user’s actual device and current alternative:

| Task | Compare |
| --- | --- |
| First useful photo | Installation, permissions, account interruptions and time to a personal photo. |
| Trust Sync | Enable once, interrupt, resume, open on another device and restore supported originals. |
| Find a specific moment | Same held-out queries/photos, unsuccessful searches, corrections, cold preparation and warm time to the right photo. |
| Send and keep photos | Same selected set, OS handoff or recipient entry, opening and deliberate Save. |
| Return tomorrow | Reopening, remembered access, new supported photos, unfinished work and useful highlights. |

Use the same library, eligibility, network conditions and hardware where possible.
Record alternative version/region/settings at evaluation time. Separate local
browsing, cloud backup and AI preparation; their delays have different causes.

Current local text/visual search, encrypted saving, original recovery, media
support and sharing are recorded in [verification](verification.md). Named People,
cleanup and unrestricted background/library-scale acceptance remain open. The
reference Ente tree does not grant Fotoro Ente’s complete capabilities or audits.

No comparative speed, retrieval quality, battery, adoption or 10× claim has been
earned. Establish a baseline, fix the largest observed failure in the
[active queue](product-backlog.md), then rerun the same task.


## Ten photo intelligence expectations and ten platform checks

Reviewed 2026-10-14. This is a practical acceptance checklist, not a measured
popularity ranking. Apple and Google documentation establish examples of current
product behavior; they do not establish Fotoro quality or adoption.

| # | Photo intelligence expectation | Fotoro status and acceptance boundary |
| --- | --- | --- |
| A1 | Natural language scene search | Local TinyCLIP on web/Core ML on iOS. Real public fireworks inference passes; held-out personal-library quality remains open. |
| A2 | Exact receipt/document search | Local OCR. Numeric identifiers cannot gain unrelated similarity hits; present/absent identifiers and Unicode digits covered on both platforms. |
| A3 | People organization and corrections | Reviewed face grouping/names with merge, separate and reject. General family-library accuracy remains open. |
| A4 | Object and scene discovery | Local visual labels and vectors; evidence/provenance visible. Broad object accuracy needs held-out evaluation. |
| A5 | Duplicate and burst grouping | Digest-identical trip copies and burst children group without deleting originals. Near-duplicate cleanup remains open. |
| A6 | Best-shot selection | Quality/diversity shortlist and Picks reuse existing selection. User approval controls Save/Share. |
| A7 | Useful moment highlights | Diverse Picks and explicit shared Trips; generated memory movies remain open. |
| A8 | Grounded date queries | Verified capture metadata and date scopes. Selected-file timestamps are not invented capture evidence. Date-scene searches retain visual matching. |
| A9 | Place organization | Verified location facts, Places clusters and explicit Timeline import. General location-name accuracy remains open. |
| A10 | Corrections and understandable evidence | Search meanings, supplied/visual/OCR evidence, explicit acceptance/pinning, People corrections and stale-source fences. Exact selected meanings cannot be broadened by similarity. |

| # | iOS, web and cross-device expectation | Fotoro status and acceptance boundary |
| --- | --- | --- |
| P1 | Automatic sync recovers from temporary failure | Single admitted retry with capped 5–300 second backoff, checkpoint reuse, success reset and account/consent fences; Simulator failure injection passes. iOS foreground/unlocked preparation remains required. |
| P2 | Offline/relaunch recovery | Durable encrypted upload journals and local search retention; available cached work can reopen. Physical iCloud/background behavior remains open. |
| P3 | Another device can recover access | Password, passkey and device approval flows; web-to-Simulator synthetic recovery verified. Physical-device passkey acceptance remains open. |
| P4 | Supported media and originals survive | JPEG/PNG/HEIC, video and Live Photo pairs within documented limits; export verifies bytes, rather than replacing originals with previews. |
| P5 | Favorites and filters work everywhere | Native Favorites plus web Photos/Saved filters. Verified cached metadata is filtered before search limits/preview hydration; stale annotations cannot create favorites. |
| P6 | Collaborative trips/invitations | Explicit recipient checks, retained-copy AAD validation, contribution review, duplicate grouping and export. Synthetic two-account journey verified. |
| P7 | Fast, bounded galleries and inference | Bounded metadata heads, lazy previews/models, worker cancellation and cached-vector batches. Physical frame pacing/battery acceptance remains open. |
| P8 | Selections survive navigation and filters | Existing selection retention/fences, deliberate original sharing and exact chosen-set export. Filter changes do not silently widen selection. |
| P9 | Responsive and accessible controls | Keyboard tables, focus-managed dialogs and labeled controls; mobile viewport checks. Full VoiceOver/Dynamic Type acceptance on physical hardware remains open. |
| P10 | Privacy, diagnostics and safe storage | Encrypted originals/metadata, redacted bounded diagnostics, explicit local retention and storage limits. Complete deletion/undo and safe garbage collection remain open. |

The requested scope is finding and organizing; enhancement, background removal
and object erasing are excluded.

Primary references: [Apple photo search](https://support.apple.com/en-ie/guide/iphone/iph392d77d5f/ios),
[Apple filtering](https://support.apple.com/en-ie/guide/iphone/iph2e66e2f2c/ios),
[Google photo stacks](https://support.google.com/photos/answer/14169846?hl=en-TD),
[Google backup and cross-device access](https://support.google.com/photos/answer/6193313?co=GENIE.Platform%3DDesktop&hl=en).
These examples motivate the checklist; they are not a comparative benchmark.

Current repair targets A2, P1 and P5. Evidence lives in
`SemanticSearchTests`, `AutomaticPhotoSyncRetryTests`, `PhotosBackupTests`,
`semantic-find.test.ts` and `cloud-search.test.ts`. Full released-state evidence
and remaining device/signing gates live in [verification](verification.md).
