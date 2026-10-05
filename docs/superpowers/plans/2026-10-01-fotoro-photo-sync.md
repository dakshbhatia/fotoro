# Fotoro Photos Sync Implementation Plan

> **Historical record.** The dated evidence, contracts and task states below are
> preserved from the earlier slice. They do not describe current release status
> or an active work queue. Use [product](../../../fotoro/docs/product.md),
> [the only active queue](../../../fotoro/docs/product-backlog.md),
> [architecture](../../../fotoro/docs/foundation.md) and
> [current evidence](../../../fotoro/docs/verification.md). Old unchecked tasks
> and execution instructions require reconciliation with that queue before use.

> **For agentic workers:** Use superpowers:subagent-driven-development with the existing native/web workers and an independent reviewer. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect recent iPhone Photos and Safari through the existing encrypted catalog with simple onboarding and truthful, resumable sync status.

**Architecture:** Keep the current PhotoKit/local-file canvas and account system. Add account-scoped source checkpoints and a sequential native backup coordinator around the existing import/journal, and a coalesced foreground browser catalog coordinator. Widen original metadata support to HEIC while retaining the existing ciphertext transport and JPEG derivatives.

**Tech Stack:** SwiftUI/PhotoKit/ImageIO/GRDB, React/IndexedDB, current Fotoro contracts/crypto, Hono/D1/private R2.

**Spec:** `docs/superpowers/specs/2026-10-01-fotoro-photo-sync-design.md`

## Global Constraints

- Preserve original JPEG/PNG/HEIC bytes and extensions; maximum 50 MiB per original.
- Native thumbnail 320 px, preview 1600 px, JPEG quality 0.82; no lossy-original option.
- Native default last 30 days, sequential processing, explicit opt-in and fixture guard.
- No new dependency, provider, auth bypass, secret logging or private fixture upload.
- Live motion/video skipped visibly; no AI or closed-app sync claim.
- Local selections never upload merely because account setup opens.
- Existing approved execution method continues under the user's explicit PLAN AND BUILD instruction; no repeated generic approval handoff.

## Review Focus

1. Crash between import and enqueue must reuse one stable source/photo transaction.
2. Pause/lock/account-switch during network await must fence later writes/status.
3. A skipped Live Photo or failed iCloud read cannot yield an all-synced claim.
4. Duplicate foreground/online events must coalesce rather than overlap uploads.
5. HEIC restore must retain actual original bytes/extension and use JPEG display copies.

### Task1: HEIC contract and original preservation

**Files:** contracts models/schema/generated validators; `fotoro/tests/contracts.test.ts`; native PhotoImport/AppServices/LibraryView and ImportTests.

**Interfaces:** `PhotoMetadataV1.mediaType` adds `image/heic`; representation kinds and cryptographic framing remain unchanged. Native `PhotoImport.validate(Data,filename:) -> String` accepts only ImageIO-verified JPEG/PNG/HEIC and matching extensions.

- [x] Add a contract test accepting HEIC and rejecting unsupported video/media; run it red.
- [x] Widen the metadata type/schema, regenerate validators using `tools/generate-validators.ts`; run core checks.
- [x] Generate actual HEIC with ImageIO in a native test; assert preserved bytes/digest/.heic path and JPEG derivatives. Run red, implement validation/import/restore extension, run green.

### Task2: Durable native Photos backup and onboarding

**Files:** create native `Library/PhotosBackup.swift` (or small focused source/coordinator files); extend LibraryStore, PhotoImport, TransferJournal, AppServices, RecentPhotosView/AccountView; create PhotosBackupTests and regenerate Xcode project.

**Interfaces:** account-root LibraryStore exposes source checkpoint read/write plus atomic catalog+source+transfer insertion. PhotoImport consumes stable source/photo identity. Backup coordinator consumes one authorized source snapshot and captured account/store/importer/journal; exposes running/paused counts, errors/skips, and last checked time to the native sheet.

- [x] Test repeated scans/restart with stable source IDs produce one photo and transfer; transaction failure leaves no queued source without a journal entry.
- [x] Test Pause and locked/switched account during an await stop later work and preserve exact pending operation; skipped/failed counts remain separate from completion.
- [x] Implement one-at-a-time encrypted staging/upload and journal reconciliation. Resume existing pending work before new sources; cancellation checkpoints fence every awaited boundary.
- [x] Add opt-in Sync last 30 days after account unlock, original-format summary, actual progress, Pause/Retry and foreground resume. Refuse fixture private-library backup.
- [x] Run new and existing native tests; Debug/Release builds; actual public Photos onboarding/status/restored-catalog screenshots. Restore Simulator to the local Photos canvas. Private backup remains blocked in public QA accounts; progress behavior is covered by coordinator tests.

### Task3: Browser sync onboarding and status

**Files:** App/CloudApp/LocalTrial; create focused sync coordinator/status module; extend catalog/journal/session only as necessary; new sync tests.

**Interfaces:** captured vault identity scopes one coalesced catalog+journal refresh; status derives from real IndexedDB journal/catalog and encrypted last-checked setting. App preserves LocalTrial file references when opening cloud setup; explicit selected-file sync is the only upload trigger.

- [x] Test coalesced foreground/online triggers, stale account completion, lock/cancel, queued/failed/committed counts and last-check semantics.
- [x] Implement one visible Sync photos setup (Create account/Sign in, recovery as another-device option); put fixture/technical controls in Advanced development only.
- [x] Add explicit Sync selected photos confirmation inside unlocked cloud canvas, preserving local originals; prevent fixture bulk personal sync and concurrent workers.
- [x] Auto-refresh while cloud view is visible/online; Pause/Retry status, locked state and readable format/errors. HEIC cloud viewer uses JPEG derivatives and original HEIC download.
- [x] Run web tests/build; parent exercises actual chooser/setup/catalog/status at desktop/mobile widths. Safari local chooser/decoder/viewer was exercised in the prior slice; latest onboarding test stopped when the user took browser control.

### Task4: Integration, review and handoff

**Files:** README, native README, verification/deployment docs, progress ledger; isolated exchange test where format coverage belongs.

- [x] Independent reviewer checks source transactions, account/cancellation fences, status truthfulness, quality/format boundaries and privacy guard; fix concrete blockers.
- [x] Run `pnpm check` and the isolated real Worker exchange. Validate HEIC metadata roundtrip and digest preservation; do not claim physical acceptance from mocks/Simulator.
- [x] Record actual supported formats, size and derivative quality in the product/docs; leave the updated runnable preview open and commit/push reviewed changes.
- [x] Report unresolved release inputs: Cloudflare is unauthenticated, Apple signing/associated domains are unconfigured, and no connected physical iPhone acceptance run has occurred.
- [ ] After those inputs arrive, provision HTTPS, sign/install on the connected iPhone and verify same-account Safari restore.
