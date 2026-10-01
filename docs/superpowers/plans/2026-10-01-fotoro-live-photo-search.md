# Browser Live Photo Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a usable local browser search with word completion, a stable single preview, supplied labels, explicit preference feedback and optional retained previews.

**Architecture:** A pure search index separates completion meanings from photo ranking. React reuses the existing local raster/viewer flow. A separate encrypted IndexedDB store retains optional previews and search metadata without retaining originals.

**Tech Stack:** Existing TypeScript, React, Web Crypto, IndexedDB and node:test/fake-indexeddb. The core adds no runtime dependencies; the coordinated OCR implementation uses locally bundled Tesseract.

**Coordination:** With verified human authorization, the existing “Plan AI photo iOS app” chat owns browser UI/OCR and native integration. This chat owns `search.ts`, `retention.ts`, `resources.ts` and their tests. The core now consumes supplied captions, keywords, facts, favorites and versioned OCR results. UI work below is tracked jointly instead of edited twice.

**Spec:** ../specs/2026-10-01-fotoro-live-photo-search-design.md

## Global Constraints

- Preserve entered spelling; normalization belongs only in the searchable derivative.
- Preserve the session-only default.
- Generate preview bytes at at most 1600 pixels on the longest edge.
- Bound retained browser previews to 100 MiB and the existing decoded cache to 48 MiB.
- No photo bytes, OCR text, queries or preferences are sent to a service.
- Opening a preview for inspection is not a successful search signal.
- This core implements labels/metadata/OCR retrieval and retention. The coordinated lane implements OCR perception and native/UI integration. Semantic models and face grouping remain outside this increment; device latency and ranking quality require separate measurement.
- The user explicitly instructed implementation after the written design was presented. Proceed with reversible local development in this session; this plan records the execution choices and is not represented as separately reviewed.

## Review Focus

- A longer prefix must find a meaning outside the six previously displayed suggestions.
- Recent/repeated filename mentions must not beat a direct supplied label.
- A stale asynchronous preview or retention write must not resurrect a cleared photo.
- Retained previews must not enable an original-file operation without digest-verified reselection.
- Storage failure/corrupt records must leave session photos usable and must not claim successful retention.

---

### Task 1: Pure completion and photo ranking

**Files:** Create `fotoro/apps/web/src/local/search.ts`; test `fotoro/apps/web/test/search.test.ts`.

**Interfaces:** `PhotoSearchIndex` consumes `SearchPhoto[]` (id, filename, date, dateSource, labels). `search(query, {allowedIds, committedMeaning, previous, now})` returns meanings, predicted meaning and ranked matching photo IDs. `acceptMeaning` and `choosePhoto` update distinct histories. Export versioned serializable feedback and an injected clock.

- [x] Write failing tests for Ronald/Rome/Rosa narrowing, label versus filename provenance, accents, noisy filenames, exact words, non-insertion-order ranking, small explicit scopes, a previously unshown completion, inspection neutrality, feedback decay and incompatible/stable prefix transitions.
- [x] Run the focused test with the existing `tsx --test` runner and observe failure before implementation.
- [x] Implement prefix dictionary retrieval over all candidate terms, hard eligibility, separate label/text meanings, ordered relevance tiers, explicit choice history and stable same-meaning preview behavior. Keep determinism independent of input array ordering.
- [x] Run the focused tests and the existing web tests; commit only these files.

### Task 2: Optional encrypted retained previews

**Files:** Create `fotoro/apps/web/src/local/retention.ts`; modify `resources.ts`; test `retention.test.ts` and `local.test.ts`.

**Interfaces:** `LocalPhoto` supports an available original File or a retained preview Blob, stores original size and content digest, and carries supplied labels. `LocalRetention` exposes `load()`, `save(photos, feedback)`, and `clear()`. `LocalResources.load` returns its prepared Blob alongside URL/dimensions so retention can reuse bounded raster generation. Content SHA-256 reconnects originals; search uses stable content identity.

- [x] Write failing tests using fake-indexeddb and real Web Crypto for reload restoration, ciphertext records, digest reconnection, original absence, preview budget eviction, corruption, and Clear racing a save.
- [x] Run focused tests and observe the expected failures.
- [x] Implement a separate database with a non-extractable AES-GCM key, authenticated encrypted record/feedback envelopes, serialized generation-fenced writes, a 100 MiB preview cap and honest storage errors. Preserve labels when preview bytes are evicted. Never persist a source File.
- [x] Update bounded raster loading for retained previews without changing original bytes. Keep bitmap/URL cleanup and stale-generation protection.
- [x] Run retention/local/search tests; commit only changed task files.

### Task 3: Working single-photo interaction

**Files:** Create `fotoro/apps/web/src/local/LocalSearch.tsx`; modify `LocalTrial.tsx`, `LocalViewer.tsx`, `styles.css`; adapt source-file backup projection if required.

**Interfaces:** `LocalSearch` consumes search result, available LocalPhoto records/resources and callbacks for completion acceptance, next/previous result, explicit preference and opening the existing viewer. The viewer's details add a separate supplied-label field; callbacks preserve the original filename/caption. Retention checkbox defaults off and restores only when the separate store was enabled.

- [ ] Integrate the index using memoized normalized records; restrict retrieval to the active Last 30 days scope, while the unfiltered selection remains available.
- [ ] Replace the queried grid with one preview, matching evidence and up to three alternate meanings; preserve the grid when the query is empty. Label editing updates only supplied labels; explicit preferred-result actions update feedback separately from preview inspection.
- [ ] Add optional retention restoration/save/clear with generation checks and errors visible in the existing status UI. Project only available source Files into backup. Disable original download/share for retained previews and explain reselection in details.
- [ ] Run `pnpm test:web` and `pnpm build:web`. Preserve existing local/original-byte, vault and sync tests.
- [ ] Use the browser to select public fixtures, supply a Ronald label on a neutral filename, type R/Ro/Ron/Ronald, choose an alternative and a preferred photo, verify no flicker/stale image, test unmatched text and clearing, and reopen with retention enabled. Confirm no original operation is enabled after reopening until the original is reselected. Check console errors and save a screenshot.
- [ ] Review the changed files for lifecycle/retention/source-boundary errors; fix findings and rerun affected checks. Commit the feature and report measured browser behavior plus remaining native/OCR/device-validation limits.

## Self-review

The core preserves source evidence, original bytes and bounded previews. It accepts derived OCR supplied by the coordinated lane, discards stale OCR without losing labels, scopes feedback, and fences cross-tab Clear. The integrated web suite passed 90/90 and production build passed on 2026-10-01. Native/OCR/UI implementation and final combined verification are owned by the coordinated chat. No latency or ranking-quality release gate is claimed from a developer-browser check.
