# Fotoro local search implementation plan

> **Historical record.** The dated evidence, contracts and task states below are
> preserved from the earlier slice. They do not describe current release status
> or an active work queue. Use [product](../../../fotoro/docs/product.md),
> [the only active queue](../../../fotoro/docs/product-backlog.md),
> [architecture](../../../fotoro/docs/foundation.md) and
> [current evidence](../../../fotoro/docs/verification.md). Old unchecked tasks
> and execution instructions require reconciliation with that queue before use.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Native and browser implementation are independent domains assigned under the dispatching-parallel-agents skill; the primary agent integrates and verifies them. Existing user authorization to plan and build governs execution.

**Goal:** Make supplied labels and text in local photos searchable through one leading result, with honest evidence and local persistence.

**Architecture:** Native and browser each maintain a local term dictionary and source-scoped history. Metadata is indexed first, OCR enriches available previews in a serial queue, and typing only reads the index. Local search remains independent of the encrypted account catalog.

**Tech Stack:** SwiftUI, PhotoKit, Vision, GRDB; React, TypeScript, Web Crypto, IndexedDB, pinned locally served Tesseract.js.

**Spec:** `docs/superpowers/specs/2026-10-01-fotoro-live-photo-search-design.md` (current two-stage evidence rules, not the earlier blended score).

## Global constraints

- Keep the existing last-30-days canvas; native search includes all permitted non-hidden still images.
- Browser session-only is the default. Retention is an explicit option, stores no originals, and is never called a backup or password vault.
- Preserve supplied labels verbatim; normalize only searchable derivatives. Never infer named identity from filenames or OCR.
- No photo bytes, OCR text, queries or preferences are sent to a service. Native indexing does not download iCloud originals.
- OCR processes one bounded preview at a time, at most 1600 pixels on the longest edge.
- Browser retained previews are bounded to 100 MiB; the existing decoded cache remains bounded to 48 MiB.
- Permission, source scope and accepted interpretation are hard constraints. No raw photo-count popularity and no invented confidence percentage.
- Completion acceptance and confirmed photo use are distinct, deduplicated per search session, and decay with a 30-day half-life. Preview inspection is neither event.
- At most six candidate meanings and 200 candidates per meaning; cap selection must follow evidence/history/context lanes rather than insertion order.
- Full original bytes remain unchanged. A retained preview cannot enable original operations until SHA-256-verified reselection.
- No account wire-schema change, silent trial upload, embedding model, face identity model or background-backup promise in this slice.

## Review focus

1. Clear/permission withdrawal while OCR or retention writes are pending must not resurrect records.
2. An older supported record must survive large prefix ranges and source-filtered retrieval.
3. Equal-display label and text meanings must retain distinct provenance; routine history must not defeat stronger evidence.
4. Missing preview, unreadable OCR, quota failure and invalid retained ciphertext must expose partial coverage without fabricating matches.
5. Reload/reselection/retention-off must preserve or erase exactly the promised data and keep original operations gated.

## Shared retrieval contract

The implementations may use idiomatic platform types, but share these semantics and fixture expectations:

- `SearchRecord`: version, stable ID, source scope/ref/revision, filename, verified capture date, favorite, facts, labels, captions/keywords, OCR text/confidence/status/version, preview/original availability.
- `SearchMeaning`: stable relation-aware ID, normalized term, original display, evidence relation, eligible count. Label and text relations never share a meaning solely because display text is equal.
- `SearchResponse`: query generation, leading photo ID and meaning, ordered compatible results, up to three alternative meanings, indexed/total/available-preview coverage. Empty is a valid response.
- `search(query, scope, acceptedMeaningID?, previous?, now)`: enumerate the whole eligible prefix range; order meanings by accepted constraint, exactness, decayed acceptance, known context, evidence class, stable ID. Rank photos by explicit compatible pin, strongest evidence class, decayed confirmed use, context, favorite, verified capture date, stable photo ID.
- `acceptMeaning(meaningID, scope, sessionID, now)` and `confirmUse(meaningID, photoID, scope, sessionID, now)` are separate idempotent events. `pinRepresentative` is an explicit association and remains permission/relation constrained.
- Prefix extension preserves an eligible prior photo only while its meaning and best evidence class remain unchanged. Incompatible continuation immediately releases accepted interpretation.
- Unicode case/diacritic normalization, phrase/word prefix matching, extension/function-word/numeric filename noise suppression, structured date/location fallback. Supplied short labels remain valid.
- Root-owned `fotoro/fixtures/search/cases.json` describes adversarial expected behavior, consumed or mirrored by platform tests without modifying its expected results.

### Task 1: Native local search (native implementation lane)

**Files:** Create focused search model/index/store files under `fotoro/apps/ios/Fotoro/Search/`; modify `RecentPhotosStore.swift`, `RecentPhotosView.swift` and the local viewer/details; add tests under `fotoro/apps/ios/FotoroTests/`; regenerate project only if needed.

**Interfaces:** Local search is created independently from `AppServices`, observes allowed PhotoKit assets, exposes query/coverage/results and verbatim label editing. Existing viewer/share accepts older eligible search assets without widening the browse canvas.

- [x] Write failing pure retrieval tests for the shared cases, separate acceptance/use, 30-day decay, pin eligibility, scope before candidate cap, prefix stability and late generations.
- [x] Run targeted native tests and record the expected failures before implementation.
- [x] Implement indexed two-stage retrieval and durable protected GRDB records/history. Use FTS5/indexed fields; preserve labels across revision-derived OCR invalidation. Exclude the index from device backup.
- [x] Write lifecycle tests for all-age authorized enumeration, removed/limited assets, withdrawal and stale OCR completions. Include 100-frame burst completion equality and neutral-filename OCR.
- [x] Implement serial off-main-actor Vision OCR on network-disabled bounded previews with processor/revision state. Empty/unavailable OCR is coverage, never a fabricated label. Use iOS 27 caption/keyword properties only when confirmed in the SDK.
- [x] Add the one-leading-result presentation and alternatives within the current search field. Details support label editing, explicit wanted-result confirmation and explicit representative selection. Inspection alone creates no use event; share confirms use only on actual successful handoff.
- [x] Run native tests, Debug/Release builds and actual Simulator interactions: search, choose interpretation, inspect without feedback, label, reopen, older asset, clear. Capture public-fixture evidence. Report commands, counts and unverified physical-device behavior; do not commit.

### Task 2: Browser local search and retention (browser implementation lane)

**Files:** Create focused retrieval/OCR/retention files under `fotoro/apps/web/src/local/`; modify `LocalTrial.tsx`, `LocalViewer.tsx`, `resources.ts`, local styles and web tests. Own JS dependency/lockfile changes and reproducible OCR asset preparation.

**Interfaces:** Extend `LocalPhoto` with optional original file, content digest and retained preview reference. Existing cloud-selection callback receives only actual selected `File`s. `LocalResources.load` supports bounded retained previews; original operations require a matching live file. Search response/history semantics follow the shared contract.

- [x] Write failing pure retrieval tests for the shared cases and ranking/history rules, plus persistence tests using fake-indexeddb.
- [x] Run `pnpm --filter @fotoro/web test` and record failures before implementation.
- [x] Implement in-memory dictionary/postings retrieval with the same two-stage rules and separate deduplicated events. Keep the live path free of hashing/OCR/original reads.
- [x] Implement SHA-256 source identity and explicit AES-GCM-encrypted IndexedDB retention using a non-extractable origin key. Hydrate metadata separately from preview blobs. Enforce 100 MiB preview eviction while retaining labels/history, and gate originals after reload until digest match.
- [x] Test default reload-empty; opt-in reload preview/labels/history; mismatched file cannot restore originals; quota/ciphertext failure; retention-off removes key/records; cross-tab/clear/generation races cannot resurrect data.
- [x] Pin Tesseract.js 7.0.0 and English data 1.0.0; prepare worker/core/language assets locally from installed packages before dev/build. Set all runtime paths explicitly. Add optional OCR control with truthful progress; reuse one worker, terminate and fence work on clear/toggle/unmount.
- [x] Test injected OCR queue cancellation/error/version behavior and actual OCR on a neutral-filename public text fixture. All OCR runtime asset requests must stay on this origin.
- [x] Add one leading search preview, interpretation/evidence and alternatives; preserve viewer navigation and accessibility. Details edit labels and expose explicit confirmation/pinning without treating preview inspection as success.
- [x] Run web tests/typecheck/build and report evidence, dependency provenance and remaining limits; do not commit or control the primary agent's browser.

### Task 3: Integration, review and try-now verification (primary lane)

**Files:** Shared public test fixtures, `fotoro/docs/verification.md`, `fotoro/docs/deployment.md`, relevant README files and this plan.

- [x] Fix expected IDs for 30 retrieval tasks before measuring; include people, text/documents, metadata places/moments, deliberately uncovered visual concepts and absent terms. Do not manufacture visual success through filename hints.
- [x] Review both implementation diffs and obtain an independent whole-change review. Address permission/storage/generation and provenance defects before release.
- [x] Run required native and workspace checks; measure synthetic lookup and actual query-to-preview separately. Describe hardware/corpus and avoid claiming physical iPhone performance from Simulator results.
- [x] Verify in the existing in-app-browser tab with public fixtures: labels, ambiguity/acceptance, actual OCR, retention reload, original gating/reselection, clear/retention-off. Verify the pinned same-origin OCR asset configuration and actual recognition; review that no inference/query data request is implemented.
- [x] Update exact release blockers: Apple development certificate exists; current provisioning profile lacks Associated Domains; no physical phone connected; Cloudflare account unauthenticated. No TestFlight/cloud deployment claim.
- [x] Open the finished local app, commit verified changes to `codex/ai-photos`, push and confirm CI. Report what can be tried and what remains unverified.

## Plan self-review

The first-deliverable requirements map to Tasks 1 and 2; integration and held-out checks map to Task 3. Semantic models, automatic face groups, cloud index integration, closed-app backup and physical-device acceptance remain subsequent deliverables. They are documented as gaps, never completion claims. Platform implementations share semantics rather than introducing a cross-platform runtime dependency. No original user-authored design prose is edited by this plan.

## Execution ownership update

The user's separate active chat, “Find top use cases for photo search,” began
the browser search/retention/UI implementation in this same checkout while this
plan was being prepared. Its plan is `2026-10-01-fotoro-live-photo-search.md`.
The user approved coordination between the chats. The other chat owns browser
retrieval, resources, retention and their tests. This chat owns native search,
browser OCR/assets, LocalTrial/LocalViewer/LocalSearch, their styles and UI tests,
and final combined verification. Preview and metadata APIs were handed over
explicitly; neither chat overwrites the other's files.

## Final evidence and limits

Native: 57 tests and Release build pass locally; browser: 97 tests and production
build pass; API: 20 tests; core: 10 tests; isolated exchange: two tests. Both
platforms cover 20/20 frozen supported retrieval cases and leave 10 unsupported
visual/absent cases empty. Final scoped review reports no confirmed P1/P2 findings.
Actual browser and Simulator evidence and synthetic measurements are recorded in
`fotoro/docs/verification.md`. Browser full OCR-detail hydration and physical
iPhone/Safari performance remain unverified; semantic search, faces and closed-app
scheduling are subsequent deliverables. Push/CI confirmation is recorded with the
final handoff after the local verification commit.
