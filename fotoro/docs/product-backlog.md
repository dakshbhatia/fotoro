# Fotoro product and roadmap

Fotoro is for enjoying your photos, finding the shot you mean, and sharing a
chosen moment. Photos shows this device’s library. Picks suggests highlights;
Saved holds originals kept in Fotoro across devices, through chosen Save or
opted-in automatic photo sync. Find reaches the photo the user means.
The viewer makes it easy to enjoy the original. Choosing Save keeps that photo
available on another device; choosing Share sends a deliberate set to a person.
Account handling supports that journey. Automatic photo sync starts after one
explicit Turn on sync choice and remembers Pause. Browser uploads stay explicit.

The product is one loop: install, allow Photos, scroll and find a photo, turn on
sync once, then open the same Fotoro on another device or share chosen photos.
One password opens the saved library on iPhone and web. Picks are suggestions;
they never replace the full Photos library. Saved is the other-device library,
not a second selection to manage.

The core still-photo journey is implemented and has public-fixture acceptance
evidence. Web/API are live. Full build 25 is uploaded and Apple reports `VALID`,
but `MISSING_EXPORT_COMPLIANCE` still prevents TestFlight access. The remaining
owner input is France availability for the encryption declaration. Build 21 is
the last verified physical installation; build 25 has not been installed on the
phone. Personal-library acceptance and physical performance remain open.

## Active queue

| Priority | Work | Complete when |
| --- | --- | --- |
| 1 | Finish the existing journey — implemented and verified on public fixtures | Older filtered Photos remain reachable; shared photos withdraw when verified access ends; browser HEIC dates use real capture metadata where available. Regression checks preserve selection, originals and independently saved copies. Physical qualification belongs to priority 2. |
| 2 | Deliver the full app | Submit the accurate Apple declaration after the France answer, verify TestFlight access, then run one fresh phone-to-Safari and two-person journey with owner authorization. |
| 3 | Make Find and Picks smarter | Evaluate one local visual representation against held-out queries and useful-shot examples. Add correctable People only with naming, merge/split and source-permission fences. Browsing must stay usable while indexing. |
| 4 | Complete media backup | Save and restore the complete Live Photo pair and videos, including playback and an interrupted transfer. Larger-media recovery follows the same queue. |
| 5 | Add safe cleanup | Recoverable trash, undo and cross-device convergence come before deletion or freeing phone storage. Verify a full original restore before offering storage removal. |

Automatic preparation runs while the iPhone app is open and unlocked; iOS can
finish ciphertext uploads already scheduled. Browser uploads remain explicit.
The current 50 MiB still-photo limit and skipped video/Live Photo motion are
visible limitations. Broader semantic search, People and cleanup are roadmap
work, not current product claims. This file owns the queue; the inventory below
records the detailed scope.

## Core journey acceptance

| Order | Deliverable | Reuse and simplify | Done when |
| --- | --- | --- | --- |
| 1 | Photo-first home | Keep PhotoKit browsing, picks and saved catalog. Put picks, all photos, capture-time groups and Saved within one clear browsing structure. Account controls belong in Settings or the first Save. | Photos are reachable immediately after permission, without waiting for intelligence or account setup. |
| 2 | Selection that stays put | Keep reviewed source/revision snapshots and existing selection models. Use the same count, Clear, Save and Share behavior in grids and search results. | Changing scope, opening a viewer and completing sign-in preserve the exact chosen sources; withdrawn sources are removed visibly. |
| 3 | One viewer experience | Give local, saved and received photos consistent paging, zoom, close, Info and Share behavior while retaining their different access rules. | The user returns to the same photo and scroll position; controls and originals remain usable during refresh. |
| 4 | One Find experience | Keep the protected local index, verified cloud records, dates, labels and OCR. Use one query interaction with clear results and alternative meanings. | Supported queries find the right eligible photo without duplicate local/cloud results, stale matches or a blocking analysis screen. |
| 5 | Picks and moments worth opening | Tune existing quality, burst and capture-time policies against a fixed public corpus and owner-selected examples. Keep All Photos reachable. | Picks favor useful variety and suppress junk; each moment uses real capture evidence and keeps every original accessible. |
| 6 | Quiet identity | Keep the existing password protocol, protected remembered password and renewal. Remove competing consumer setup paths and technical credential terminology. | First Save offers one password entry or New Fotoro; returning users continue their action without retyping a remembered password. |
| 7 | Simple photo sync and chosen Save | Keep one durable queue. One explicit Turn on sync choice covers permitted supported photos, while manual Save retains the exact chosen sources. Show progress and persistent Pause/Resume. | Reopening respects account, service, Photos access and Pause; repeated taps never duplicate copies or bypass consent. |
| 8 | Dependable other-device library | Keep signed catalog verification, encrypted previews and unchanged originals. Make Saved understandable on native and web, with direct /saved entry and the same password on each device. | A fresh device opens the same account, sees the chosen photos and retrieves identical JPEG/PNG/HEIC originals. |
| 9 | Share a chosen moment | Keep accepted contacts, selected grants, canonical invitations and recipient-owned Save. Present one recipient picker and the selected set. | A two-person journey sends the intended set, opens it and saves an independent copy without resuming unrelated uploads. |
| 10 | Simple receiving and adding back | Keep explicit identity acceptance, access-ended states and contribution checks. Show the sender, photos and one next action. | A valid invitation survives sign-in and returning to the app; the recipient can view, Save and add selected owned photos back. |
| 11 | Useful corrections | Keep favorites, user-authored labels and the signed encrypted annotation outbox. Put corrections in photo details. | An explicit save of changes reaches the other device; concurrent edits preserve unrelated fields and require a choice for real conflicts. |
| 12 | Calm incomplete states | Consolidate duplicate banners, overlays and alerts into feature-owned states. Keep detailed diagnostics behind the consumer surface. | Loading, offline, limited Photos access, lock, paused Save and ended sharing each show one accurate state and one useful action. |
| 13 | Measured smoothness | Keep native image caching, virtualized browser rows and bounded serial intelligence work. Profile actual supported phones and Safari. | Photos appear before analysis completes; scrolling, warm Find and viewer gestures pass recorded frame, memory and latency budgets on the chosen device baseline. |
| 14 | Complete release journey | Use existing contract, cryptographic, lifecycle and integration checks. Add missing interaction regressions rather than tests that merely repeat the code. | Fresh and returning users complete browse → Find → view → Save → other-device restore → Share, including one interruption/retry, with VoiceOver and larger text checks. |
| 15 | Ship the full app | Keep the same verified native/web/API source. Complete the actual Apple declaration and verify physical installation/links. | The full encrypted build is installable through the intended release channel and the published product matches the verified journey. |

These are acceptance criteria for the existing journey. The active queue above
sets the order of new work; separate green components do not prove that journey.

## Keep the foundations simple

- PhotoKit is the source of truth for permitted iPhone originals. The signed
  account catalog is the source of truth for saved photos. Intelligence is a
  rebuildable index, bound to source revision and permission.
- Reuse the current account, catalog, transfer queue and sharing protocols.
  Presentation can be shared across local/saved/received sources; authorization
  and ownership boundaries remain explicit.
- Manual uploads require an explicit Save/Continue. Opted-in, unpaused native
  photo sync can prepare new supported photos while the app is open. Opening
  Saved and refreshing its catalog remain read-only.
- UI state belongs to its feature. Use existing services for durable work;
  avoid parallel status flags, a second queue, a second search index or a new
  global state framework.
- Read and write each persisted format through the same owner. Keep legacy
  decoding and migrations where existing accounts or durable jobs require them.
- Keep SwiftUI, React/Vite and the current Cloudflare service. Add a dependency
  only for a measured missing capability; this release needs no platform rewrite.
- Work in `fotoro/`. The upstream reference tree is separate from the shipped
  product and should not become another active implementation.

## Remove the noise as the replacement lands

- Retire obsolete consumer Sync/setup routes, duplicate account prompts and
  technical protocol vocabulary from the normal photo journey.
- Merge repeated viewer chrome, selection actions and error presentation where
  the behavior is the same. Keep different privacy rules in source adapters.
- Remove superseded production components and abandoned paths after checking
  references and release artifacts. Keep development fixtures outside release
  surfaces and preserve supported data compatibility.
- Use this plan as the product queue and `verification.md` as the evidence record.
  Update their current summaries instead of adding another status document.

## Next capabilities after the core journey closes

Find a moment → Best shots → review → choose Save or Share is now implemented.
Best shots recomputes suggestions within the current matches, shows measured
reasons and keeps All matches available without changing selection. Native
review uses the first 200 matches and cached device/Saved previews; unavailable
previews and incomplete coverage are explicit. Browser review uses the existing
bounded local and owned Saved match sets. Seven fixed synthetic composition
checks run in CI; human preference and physical performance remain open.
Current Picks uses clarity, exposure, favorites and
similarity rules; native recent Picks covers the last 10 days while browser
Picks covers photos opened there. Current Find uses verified dates, supplied
labels, text and bounded native visual categories. Broader visual meaning and
People require the evaluations below before product claims change.

| Capability | Complete scope before exposing it |
| --- | --- |
| Visual meaning search | Choose and measure one local image-representation approach. Bind results to current permitted sources, combine them with date/text evidence and evaluate retrieval on a fixed corpus. |
| Correctable People | On-device grouping, explicit naming, merge/split corrections and permission/deletion fences; never infer a named identity from a text mention. |
| Similar-photo review | Show a group, recommend a representative and let the user choose. Preserve every original until explicit deletion exists. |
| Live Photos and video | Treat complete media resources as one saved item; implement preparation, preview/playback, interrupted transfer and complete original restore together. |
| Trash and storage cleanup | Recoverable signed deletion, undo, multi-device convergence, quota/collection behavior and restore proof before offering phone-storage removal. |

Share extension, saved URLs, nearby handoff, stories and optional cloud AI stay in
the reference inventory. They become active only with a specific complete user
journey, bounded implementation and an owner. Cloud AI also requires explicit
opt-in and a spending limit.

## Reference inventory

“Implemented” below describes checked source and public local-service behavior.
Personal iPhone/Safari acceptance, physical performance, and Apple release gates
are separate checks. “Partial” identifies a concrete remaining capability.

| # | Work | Current state and remaining work |
| --- | --- | --- |
| 1 | One-password sign-in | Implemented on native/web; wrong-password, interrupted enrollment and retry regressions pass. Failed remembered sign-in offers another password without deleting pending work. Owner acceptance remains open. |
| 2 | Remember the current user | Protected session/password persistence, account reference and expired-session renewal are implemented. Initial restoration respects manual lock; explicit Open retries a failed renewal. |
| 3 | Install the current full build | Full build 25 passes App Store distribution-signature, identity, production association and matching-dSYM checks. Its exact validated IPA uploaded and Apple reports VALID. TestFlight compliance and physical installation remain open; build 21 is the last verified installed/launched build. |
| 4 | Save chosen photos through sign-in | Immutable reviewed sources and one-shot authenticated Save are implemented. Fresh native signup → selected PNG Save and fresh-browser password restore pass against isolated D1/R2. |
| 5 | Restore identical originals in Safari | Isolated D1/R2 tests verify JPEG/PNG/HEIC bytes in a fresh session. Production saves and restores a public PNG byte for byte in a fresh browser. Native Saved rechecks on return and supports pull-to-refresh, preserving paused uploads and local edits. Personal phone-to-Safari acceptance remains open. |
| 6 | Manual Save progress and Pause/Continue | Implemented. Continue uses the durable queue; it does not scan for new photos. |
| 7 | Offline/background/relaunch recovery | Fixed cold launch after a chosen Save: persisted selection now reads its own encoding. Regression and rendered Simulator reopening pass without scanning or uploading. Physical daemon/relaunch acceptance remains open. |
| 8 | Retry without losing selection | Implemented for authentication, manual Save and sharing; incomplete work preserves exact sources for explicit Retry, and concurrent recipient Saves reuse one durable request. |
| 9 | Green release checks | Core/API/web/native checks are required on each exact PR head. |
| 10 | Full TestFlight release | Full build 25 is VALID / MISSING_EXPORT_COMPLIANCE. The prepared factual declaration awaits the owner's France availability answer. Preview build 3 is a separate binary. |
| 11 | Sharp thumbnails | System-sized native thumbnails and late degraded-image rejection are implemented; browser gallery thumbnails use 512 px with bounded decoded caches. |
| 12 | Large-library responsiveness | 10,000 synthetic indexed records are tested; browser saved rows are virtualized. Physical frame/memory/battery measurements remain open. |
| 13 | Swipe/zoom/quiet viewer controls | Local, saved and received native viewers support paging, zoom and Info; browser viewer supports zoom and paging. |
| 14 | Preserve navigation context | Query, source snapshots and reviewed selection survive account navigation. Physical long-scroll acceptance remains open. |
| 15 | Simple filters | Native Photos: favorites/screenshots/location facts, including older matches beyond sparse metadata pages; paging stops in background and on permission/filter changes. Saved library: favorites. Date search is implemented. Named-place inference is not implemented. |
| 16 | Photo moments | Native capture-time groups and browser evidence-backed day groups are implemented. Unknown capture time is explicit; no invented outing titles. |
| 17 | Contextual Share | Saved selection and viewer Share in Fotoro are implemented on native/web. System original sharing remains available. |
| 18 | Public invitations and QR | Strict canonical contact/moment links and native QR display are implemented. Native camera scanner and physical universal-link acceptance remain open. |
| 19 | Recipient viewing and own copies | Verified previews/originals and independent recipient-owned Save are implemented. |
| 20 | Add photos back | Selected owned saved photos can contribute to a shared moment. |
| 21 | Reuse people | Explicitly accepted contact keys and encrypted optional local names are implemented. Contact synchronization across devices remains open. |
| 22 | Honest sharing states | Foreground/focus/reconnect reads withdraw received content when verified access ends; known expiry also withdraws locally. Network failures retain access, and independent copies/durable Save requests remain. Consumer opened/saved receipt counters remain open. |
| 23 | Visual search | Partial: conservative local Vision categories with separate inferred evidence. Physical classification and unrestricted embeddings remain open. |
| 24 | Natural language with evidence | Native/web relative/calendar/ISO date phrases and prefix/suffix compound queries use existing evidence and verified capture dates. Arbitrary person/place understanding remains open. |
| 25 | Correctable people groups | Not implemented. Requires on-device grouping, explicit naming/corrections and deletion/permission fences. |
| 26 | Better automatic picks | Bounded local clarity/exposure/favorite/burst policies and Find-scoped Best shots are implemented and tested. Physical ranking acceptance remains open. |
| 27 | Similar-photo review | Partial: Best shots explains suggested burst representatives and returns to All matches. Side-by-side comparison and broader visual similarity remain open. |
| 28 | Editable memories/stories | Not implemented. Must preserve original photos and user-authored captions. |
| 29 | Document OCR | Rotated English OCR is implemented/tested. Multilanguage support remains open. |
| 30 | Incremental intelligence | Source/revision cache, serial bounded previews and lifecycle cancellation are implemented. Physical energy/memory acceptance remains open. |
| 31 | Encrypted intelligence across devices | Supplied labels, favorites and completed OCR synchronize in signed encrypted annotations. Inferred categories/group identities remain open. |
| 32 | Optional cloud AI | Not implemented. Requires explicit opt-in, bounded spending and encrypted persisted results. |
| 33 | iPhone Share extension | Not implemented. Requires an isolated intake target and protected app-group handoff. |
| 34 | Saved webpages/URLs | Not implemented. |
| 35 | Browser HEIC import | Safari intake for verified HEVC stills/simple grids is implemented with bounded decoding and byte-preserved encrypted originals. Primary-associated EXIF capture-date extraction is bounded and tested through grouping/search/Save; absent or invalid metadata retains the fallback. Unsupported browsers/layouts show a clear alternative. Personal Safari acceptance remains open. |
| 36 | Complete Live Photo restore | Not implemented. Local still preview works; motion-pair backup is skipped visibly. |
| 37 | Video save/playback/restore | Not implemented. Video backup is skipped visibly. |
| 38 | Larger media recovery | Current originals are bounded to 50 MiB and queued durably. Larger-file multipart/streaming recovery remains open. |
| 39 | Nearby handoff | Not implemented. Public links provide the current remote handoff. |
| 40 | Exact duplicate review | Not implemented. SHA-256 verifies originals; it does not automatically delete or merge photos. |
| 41 | Trash and undo | Not implemented. Requires recoverable signed deletion before consumer deletion is exposed. |
| 42 | Free phone storage after verified backup | Not implemented. Requires full media-resource restore proof and explicit deletion consent. |
| 43 | Quotas/GC/restore operations | Atomic account ciphertext allocation limits and production auth throttles are implemented. Final-object collection and operational restore proof remain open. Written or ambiguous attempts keep their charge; staging plus final copies can exceed the allocated ciphertext bytes. |
| 44 | Private diagnostics | Bounded protected state/timing/count diagnostics are implemented; credential, filename and raw path logging is excluded. |
| 45 | Export/delete/permissions | Original export, local retention clearing and Photos permission controls are implemented. Whole-account export/deletion remain open. |
| 46 | Accessibility | Focused native/web password entry, native keyboard submit and Clear selection, and 44 px web search choices are verified. Public native Info is checked at accessibility-medium; full VoiceOver/Dynamic Type acceptance remains open. |
| 47 | Real-device acceptance | Public local two-person exchanges and synthetic 10,000-item tests pass. Personal iPhone/Safari and older-phone performance remain open. |

The active queue is above. Reference capabilities become finished only
after their complete consumer, persistence and authorization paths are verified.
