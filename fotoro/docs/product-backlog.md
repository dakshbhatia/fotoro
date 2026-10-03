# Fotoro product work

The consumer flow is browse → find → Save → Share. One Fotoro password opens the
same encrypted library. Browsing, sign-in, reopening, and sharing must never send
unrelated originals. A sharing invitation names its authorized recipient; the
public link alone grants no photo access.

“Implemented” below describes checked source and public local-service behavior.
Personal iPhone/Safari acceptance, physical performance, and Apple release gates
are separate checks. “Partial” identifies a concrete remaining capability.

| # | Work | Current state and remaining work |
| --- | --- | --- |
| 1 | One-password sign-in | Implemented on native/web; wrong-password, interrupted enrollment and retry regressions pass. Owner acceptance remains open. |
| 2 | Remember the current user | Protected session/password persistence and account reference in Settings are implemented. |
| 3 | Install the current full build | Signed encrypted build 17 is installed, its exact version is read back, and launch succeeds. Protected runtime diagnostics report signed out and a completed picks pass; owner authentication acceptance remains open. |
| 4 | Save chosen photos through sign-in | Immutable reviewed sources and one-shot authenticated Save are implemented; public-service tests pass. |
| 5 | Restore identical originals in Safari | Isolated D1/R2 tests verify JPEG/PNG/HEIC bytes in a fresh session. Personal phone-to-Safari acceptance remains open. |
| 6 | Manual Save progress and Pause/Continue | Implemented. Continue uses the durable queue; it does not scan for new photos. |
| 7 | Offline/background/relaunch recovery | Durable ciphertext transfers, pause and stale-account fences are implemented. Physical daemon/relaunch acceptance remains open. |
| 8 | Retry without losing selection | Implemented for authentication, manual Save and sharing; incomplete work preserves exact sources for explicit Retry, and concurrent recipient Saves reuse one durable request. |
| 9 | Green release checks | Core/API/web/native checks are required on each exact PR head. |
| 10 | Full TestFlight release | Full build 4 awaits Apple's export-compliance declaration. Preview build 3 is a separate binary. |
| 11 | Sharp thumbnails | System-sized native thumbnails and late degraded-image rejection are implemented; browser gallery thumbnails use 512 px with bounded decoded caches. |
| 12 | Large-library responsiveness | 10,000 synthetic indexed records are tested; browser saved rows are virtualized. Physical frame/memory/battery measurements remain open. |
| 13 | Swipe/zoom/quiet viewer controls | Local and saved native viewers support paging, zoom and tap-to-hide controls; browser viewer supports zoom and paging. |
| 14 | Preserve navigation context | Query, source snapshots and reviewed selection survive account navigation. Physical long-scroll acceptance remains open. |
| 15 | Simple filters | Native recent photos: favorites/screenshots/location facts; saved library: favorites. Date search is implemented. Named-place inference is not implemented. |
| 16 | Photo moments | Native day or bounded two-hour capture groups are implemented. No invented outing titles. |
| 17 | Contextual Share | Saved selection and viewer Share in Fotoro are implemented on native/web. System original sharing remains available. |
| 18 | Public invitations and QR | Strict canonical contact/moment links and native QR display are implemented. Native camera scanner and physical universal-link acceptance remain open. |
| 19 | Recipient viewing and own copies | Verified previews/originals and independent recipient-owned Save are implemented. |
| 20 | Add photos back | Selected owned saved photos can contribute to a shared moment. |
| 21 | Reuse people | Explicitly accepted contact keys and encrypted optional local names are implemented. Contact synchronization across devices remains open. |
| 22 | Honest sharing states | Expiry, access ended and source/retry errors are implemented. Consumer opened/saved receipt counters remain open. |
| 23 | Visual search | Partial: conservative local Vision categories with separate inferred evidence. Physical classification and unrestricted embeddings remain open. |
| 24 | Natural language with evidence | Native/web relative/calendar/ISO date phrases and prefix/suffix compound queries use existing evidence and verified capture dates. Arbitrary person/place understanding remains open. |
| 25 | Correctable people groups | Not implemented. Requires on-device grouping, explicit naming/corrections and deletion/permission fences. |
| 26 | Better automatic picks | Bounded local clarity/exposure/favorite/burst policies are implemented and tested. Physical ranking acceptance remains open. |
| 27 | Similar-photo review | Partial: similar bursts choose a representative in picks. An explicit review surface remains open. |
| 28 | Editable memories/stories | Not implemented. Must preserve original photos and user-authored captions. |
| 29 | Document OCR | Rotated English OCR is implemented/tested. Multilanguage support remains open. |
| 30 | Incremental intelligence | Source/revision cache, serial bounded previews and lifecycle cancellation are implemented. Physical energy/memory acceptance remains open. |
| 31 | Encrypted intelligence across devices | Supplied labels, favorites and completed OCR synchronize in signed encrypted annotations. Inferred categories/group identities remain open. |
| 32 | Optional cloud AI | Not implemented. Requires explicit opt-in, bounded spending and encrypted persisted results. |
| 33 | iPhone Share extension | Not implemented. Requires an isolated intake target and protected app-group handoff. |
| 34 | Saved webpages/URLs | Not implemented. |
| 35 | Browser HEIC import | Safari intake for verified HEVC stills/simple grids is implemented with bounded decoding and byte-preserved encrypted originals. Unsupported browsers/layouts show a clear alternative; HEIC capture-time extraction remains open. |
| 36 | Complete Live Photo restore | Not implemented. Local still preview works; motion-pair backup is skipped visibly. |
| 37 | Video save/playback/restore | Not implemented. Video backup is skipped visibly. |
| 38 | Larger media recovery | Current originals are bounded to 50 MiB and queued durably. Larger-file multipart/streaming recovery remains open. |
| 39 | Nearby handoff | Not implemented. Public links provide the current remote handoff. |
| 40 | Exact duplicate review | Not implemented. SHA-256 verifies originals; it does not automatically delete or merge photos. |
| 41 | Trash and undo | Not implemented. Requires recoverable signed deletion before consumer deletion is exposed. |
| 42 | Free phone storage after verified backup | Not implemented. Requires full media-resource restore proof and explicit deletion consent. |
| 43 | Quotas/GC/restore operations | Private R2/D1 and durable journals exist. Quotas, final-object collection and operational restore proof remain open. |
| 44 | Private diagnostics | Bounded protected state/timing/count diagnostics are implemented; credential, filename and raw path logging is excluded. |
| 45 | Export/delete/permissions | Original export, local retention clearing and Photos permission controls are implemented. Whole-account export/deletion remain open. |
| 46 | Accessibility | Focused native/web password entry, native keyboard submit and Clear selection, and 44 px web search choices are verified. Public native Info is checked at accessibility-medium; full VoiceOver/Dynamic Type acceptance remains open. |
| 47 | Real-device acceptance | Public local two-person exchanges and synthetic 10,000-item tests pass. Personal iPhone/Safari and older-phone performance remain open. |

The next substantial capability work is broader media intake/restore, explicit
similar-photo review, correctable people groups, and recoverable deletion/storage
operations. Each needs a complete tested path through both encryption and the
consumer surface before it can be called finished.
