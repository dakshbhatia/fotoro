# Fotoro Consumer Simplicity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one understandable browse/search/share experience with explicit, dependable 10-day backup and same-account Safari restore.

**Architecture:** Preserve the encrypted media/annotation protocols and durable journals. Change consumer presentation independently on native and web; one core owner handles upload policy, shared source adapters and presentation contracts. Release/inference experiments stay outside the UI critical path.

**Tech Stack:** Existing SwiftUI/PhotoKit/Vision/GRDB; React/Vite/TanStack Virtual/local OCR; Hono Worker/D1/R2/libsodium. No new UI framework.

**Spec:** `docs/superpowers/specs/2026-10-01-fotoro-consumer-next-design.md`

## Global Constraints

- Preserve original bytes, signed media/source binding and account/vault-generation fences.
- Browse 10 days; local search may cover all permitted non-hidden still photos.
- Safari selection is explicit; retention and text-reading choices are visible and voluntary.
- A photo is saved only after verified catalog commit. Skips, pending annotations and failed work stay visible.
- Pause, Lock and sign out remain distinct. Manual import before Photos backup opt-in remains supported.
- No personal query/pin history in sync; no private annotation sidecars in shared originals/grants.
- No remote photo inference, credential workarounds or removal of Associated Domains.
- Product UI copy is application copy, not prose attributed to the user. Keep existing user labels verbatim.
- iOS 26+ build compatibility, keyboard/safe areas, reduced motion and accessibility remain required.

## Review Focus

- Pause during an outstanding request, then reopen: preserve queue and prohibit subsequent automatic writes.
- Sign in from Sync: retain the user's intent but wait for explicit Photos backup scope confirmation.
- Lock/account switch/permission revocation during search or share: stale callbacks cannot reveal or transmit bytes.
- Retained preview without original: reopening works; sharing requests verified original rather than substituting the preview.
- Unsupported media/partial OCR/annotation conflict: no false all-saved or fully-searchable status.

## Parallel Ownership

At most three implementation workers plus the integration owner run together.
One worker per lane owns its listed files. Shared interfaces are agreed before
cross-lane consumption. Do not create parallel edits in orchestration files.

| Lane | Sole ownership | Deliverable |
| --- | --- | --- |
| A — Native consumer UI | `fotoro/apps/ios/Fotoro/Library/RecentPhotosView.swift`, `RecentPhotosStore.swift`, `LibraryView.swift`, `PhotosBackupView.swift`, `PhotoViewer.swift`; `Search/LocalSearchView.swift`; `Vault/AccountView.swift`; `Exchange/ExchangeView.swift`; related UI/permission tests | Relaunch directly into permitted browsing; simple results/status/share; auth returns to intended step |
| B — Safari consumer UI | `fotoro/apps/web/src/app.tsx`, `CloudApp.tsx`, `styles.css`, `local/LocalTrial.tsx`, `LocalSearch.tsx`, `LocalViewer.tsx`, `library/Viewer.tsx`, `exchange/Exchange.tsx`; new presentation/share helpers; web UI tests | Useful first-use choices, photo-led results, visible progress, standard share/download |
| C — Durable sync and search core | Native `AppServices.swift`, `LibraryStore.swift`, `LocalSearchStore.swift`, API client/journal/background files; new native presentation/source adapter files; non-UI native regressions | Persistent Pause; accurate summary; authorized local/saved result bridge; interruption regression evidence |
| Integration owner | Contracts, API service/migrations, native project file references, CI/tools, release/spec/plan docs, combined verification | Freeze interfaces; review; provider/signing setup; end-to-end acceptance |

The integration owner does not edit lane files while their owners are active.
Only one worker controls a Simulator or a shared browser tab at a time. Read-only
review can run concurrently. UI changes do not require an encryption-schema change.

## Task 0: Freeze presentation and source interfaces

**Owner:** Integration owner with C; prerequisite for native shared-status/search consumption.

**Files:** Create native `Library/ConsumerSyncSummary.swift` and `Search/ConsumerPhotoReference.swift`; web `library/consumer-sync.ts`. Lane B owns the web type and shell bridge after agreement; the integration owner handles any required native project-file references.

**Interfaces:**
- `ConsumerSyncState`: `notStarted | preparing | uploading | checking | upToDate | paused | offline | needsAttention`.
- `ConsumerSyncSummary`: `state: ConsumerSyncState`, `completedPhotos: Int?`, `totalPhotos: Int?`, `skippedPhotos: Int`, `lastCheckedAt: Date?`, `detail: String?`, `action: ConsumerSyncAction`. Web uses number/string timestamp equivalents.
- Relevant action: `start | continue | retry | signIn | openSettings | review | none`.
- Native `ConsumerPhotoReference`: `.device(String)` or `.saved(String)`; source ID remains unchanged.
- Native `ConsumerSearchHit`: `photo: ConsumerPhotoReference`, `evidence: String?`. It references existing photo-domain objects rather than copying their bytes or metadata.
- Native `AppServices.consumerSyncSummary: ConsumerSyncSummary` is an observed, maintained presentation snapshot; never decrypt a whole catalog inside a SwiftUI body getter.
- Native `AppServices.consumerSearch(_ query: String, local: LocalSearchStore) async throws -> [ConsumerSearchHit]` returns only currently permitted/owned references. Preserve local ranking, then existing saved-catalog ordering; do not compare uncalibrated scores from different retrieval engines. Generation/account/source checks run before publishing.
- Web `CloudApp` adds `onSyncSummary?: (summary: ConsumerSyncSummary) => void`; `LocalTrial` adds `syncSummary?: ConsumerSyncSummary`. `app.tsx` bridges this display snapshot. B derives it from existing sync/journal facts and resets account-specific counts on lock/sign out.
- Core consumes existing `AppServices.pauseSync()`, `startPhotosBackup()`, `resumeTransfers()`, `searchCatalog(_:)`, local `SearchIndex`, and existing source-revision/digest bindings. The consumer models are local presentation contracts, never network DTOs.

- [ ] Pin derivation rules with tests: no completed count from uploaded representations; paused takes precedence over reconnect; unknown total is omitted; incomplete annotations/skips remain visible.
- [ ] Implement the native maintained summary snapshot and source-reference adapter above before lane A consumes them; test invalidation on lock/account switch and partial source coverage. Existing cloud substring retrieval is not silently upgraded to visual understanding or universal date parsing.
- [ ] Freeze source-resolution behavior: authorized local hit, verified owned saved hit, and verified duplicate mapping; never deduplicate by filename/date.

## Task 1: Durable Pause policy

**Owner:** C. **Status:** implemented and independently reviewed during planning; full native suite passes 88/88 locally. Committed as `6deda57351`; new-revision remote CI remains separate.

**Files:** Native `AppServices.swift`, `LibraryStore.swift`, `Exchange/APIClient.swift`; focused native regression tests.

**Interfaces:** Preserve existing command signatures. Add account-scoped persistent upload-pause state separately from Photos backup opt-in. Test-only/internal session-configuration injection retains production ephemeral session and redirect/origin policy.

- [x] Reproduce: Pause with an outstanding journal entry, foreground/resume/new service restoration, then count journal mutation and annotation write requests; expected count is zero. Three tests fail with 11 assertions before the behavioral fix.
- [x] Preserve default manual Files imports before Photos sync opt-in; account A's pause does not pause account B. Existing exchange regression remains green.
- [x] Implement the automatic-write fence; existing explicit Start/Continue clears it. Preserve queued work. Read-only catalog refresh remains possible.
- [x] Verify explicit Continue resumes and existing lock/background/journal tests remain green: 14 focused tests and all 88 native tests pass.
- [x] Commit only this defect and its regressions after review; do not fold in UI redesign. Independent review found no actionable P1/P2. Controlled tests cover dispatch/persistence, not a real staging PUT or physical daemon lifecycle.

## Task 2: Native first-use, search and sharing

**Owner:** A. **Depends on:** agreed summary/source interfaces; C integration available for saved hits.

**Interfaces:** Consume current permission/search stores and existing auth/backup commands. Add an account-view completion callback that returns the caller to its pending intent; it does not itself opt the Photos library into uploads.

- [ ] Restore already-granted PhotoKit access and search on launch. Verify first use never prompts before Open Photos; relaunch opens gallery; limited/denied states remain correct.
- [ ] Retain Sync intent through Create/Sign in/Recovery, fetch the owned catalog after unlock, then show explicit last-10-days backup choice and progress. Ordinary sign-in does not start PhotoKit upload.
- [ ] Replace search-control overload with matching photos and useful optional alternatives. Move evidence/corrections into Info; preserve prefix stability, permission filtering and existing feedback data.
- [ ] Present C's authorized local/saved hits through one search surface. Test a cloud-only receipt plus a local older receipt and account/permission changes.
- [ ] Add standard original sharing to the saved-photo viewer, using the existing verified media path and system activity sheet. Preserve separate encrypted exchange trust checks.
- [ ] Verify public fixture flows in Simulator; record screenshots and keyboard/accessibility checks. Run focused regressions and `pnpm test:ios`.

## Task 3: Safari first-use, search and sharing

**Owner:** B. **Can run alongside:** Tasks 1 and 2 after Task 0 agreement.

**Interfaces:** Preserve `PhotoSearchIndex`, `LocalResources`, retention and annotation/journal APIs. Use the agreed summary presentation values. System-share helper consumes only a verified `File`, called from a user gesture; download is fallback.

- [ ] Immediately after selection, offer text reading and bounded preview/search retention. Verify a neutral-name receipt becomes searchable without Settings and opt-in/opt-out reopen semantics remain correct.
- [ ] Lead search with matching photos/swiping. Move predicted/accepted/meaning/pin/provenance controls behind optional details without changing ranking/source semantics.
- [ ] Expose shared backup status while browsing; preserve query, selected photo and scroll position when entering/leaving account setup. Check ten uploads, offline/reconnect, pause/reopen, skipped items and annotation conflict.
- [ ] Give owned saved originals the same system Share/download flow as selected originals. Verify unsupported Web Share falls back and cancel produces no error banner.
- [ ] Check compact phone layout, keyboard, safe area, screen-reader names and reduced motion with the actual browser. Use public samples only.
- [ ] Run `pnpm test:web` and `pnpm build:web`; save rendered evidence. Physical Safari behavior is a later release gate, not established by desktop emulation.

## Task 4: Real service and physical acceptance

**Owner:** Integration owner. **Can prepare alongside:** UI/core work. **External critical path:** actual account access and physical phone.

**Files:** `fotoro/docs/deployment.md`, `verification.md`, `tools/check-service.mjs`; service configuration/migrations and signing configuration only when actual resources are available.

- [ ] Complete normal Cloudflare login; create distinct preview/production D1/R2 resources and apply migrations; deploy HTTPS with correct RP/origin/AASA configuration and rollback target.
- [ ] Sign in through Xcode; obtain app-specific Associated Domains provisioning; connect a physical iPhone. Do not substitute wildcard provisioning or strip entitlements.
- [ ] Run the spec's 10-day phone-to-Safari corpus scenarios, including recovery, byte-identical originals, interruption, Pause, background lifecycle and same-account annotations.
- [ ] Investigate any reproduced connection loss with retained service/process/transport evidence. Do not hide it behind test skips or indiscriminate mutation retries.
- [ ] Integrate Tasks 1–3 and run `pnpm check`, `pnpm test:exchange:isolated`, `pnpm test:ios`, unsigned Release compilation and hosted service checks. Record physical checks separately from automated tests.

## Task 5: Resource/format gate and isolated intelligence experiment

**Owner:** Reassign the three lanes after consumer integration; no simultaneous edits to finished orchestration files.

**Files:** Dedicated measurement/evaluation tools and test corpora; isolated native/model adapter prototype; upstream code remains reference-only until exact licenses and packaging are reviewed.

- [ ] Measure 10,000 records/1,000 thumbnails on a supported physical iPhone and Safari: frame pacing, preview latency, decoder/process memory, battery and OCR throughput. Current metadata-only benchmarks do not establish these.
- [ ] Investigate browser HEIC import using genuine iPhone exports; preserve original bytes, orientation/date metadata and bounded decode. Document video/Live Photo skips explicitly.
- [ ] Evaluate a paired image/text model on held-out receipt/screenshot/booking and visual queries. Check model/source licenses, binary download size, CPU/GPU/runtime packaging, preprocessing and native/Safari parity before committing to integration.
- [ ] Evaluate unnamed local face groups separately, with merge/split/hide corrections and no inferred identity names. Compare quality/device cost before expanding scope.
- [ ] Write a separate derived-index spec and implementation plan only after feasibility: original digest/model version binding, encrypted pagination, source invalidation and account/permission isolation.

## Release order and explicit deferrals

**Consumer batch:** Task 0 -> Tasks 1/2/3 in parallel -> combined review/verification.
**Release path in parallel:** provider access -> HTTPS/resources -> signed app -> physical acceptance.
**Intelligence batch:** feasibility and measurements -> selected model/index contract -> implementation.

Do not delay the usable consumer release for AI editing, video intelligence,
duplicate deletion, Live Photo motion, or automatic trip/people features that have
not passed their own feasibility and quality checks. Do not describe the release
as better than every existing photo app without comparative evidence.
