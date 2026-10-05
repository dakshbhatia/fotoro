# Fotoro durable account library implementation plan

> **Historical record.** The dated evidence, contracts and task states below are
> preserved from the earlier slice. They do not describe current release status
> or an active work queue. Use [product](../../fotoro/docs/product.md),
> [the only active queue](../../fotoro/docs/product-backlog.md),
> [architecture](../../fotoro/docs/foundation.md) and
> [current evidence](../../fotoro/docs/verification.md). Old unchecked tasks
> and execution instructions require reconciliation with that queue before use.

**Goal:** Connect Fotoro to the existing encrypted Ente account catalog and
verified upload path, while retaining the separate session-only demo.

**Design:** The user requested `build` after reviewing `product.md` and the
first implementation target. This is a presentation of the existing gallery
flow, not a second authentication, encryption, or storage system. Execute inline.

**Files and responsibilities:**
- `pages/library.tsx`: authenticated Fotoro entry using the existing gallery.
- `pages/gallery.tsx`: opt-in Fotoro presentation; existing account mount,
  hidden/trash filtering, catalog persistence, uploader, selection and viewer.
- `components/FotoroLibraryChrome.tsx`: heading, sync state, search/import dock.
- `services/fotoro-library.ts`: metadata search and honest refresh-state tracking.
- `FileList.tsx`, `FileListWithViewer.tsx`, thumbnail layout helper: optional
  Fotoro grid layout while retaining virtualization and default Ente layout.
- account redirect/root/plan pages: default account destination `/library`.
- `pages/intelligence.tsx`: a visible connection to the account library;
  selected demo photos are never silently uploaded.

## Acceptance and implementation

- [x] Write failing tests for edited-name/caption/camera/date search, multiword
  matching and order preservation. Inputs are the already visibility-filtered
  gallery files, never the unfiltered catalog.
- [x] Write failing tests proving a pending refresh is not current, failed
  refresh never becomes current, offline does not call the remote transport,
  and a deliberate retry can recover. Use the existing serialized pull queue.
- [x] Implement the service and connect state tracking to Gallery's actual pull
  pipeline. Reuse successful upload callbacks; do not infer backup from a local
  File or from merely selecting it. Keep originals/encryption in Ente's uploader.
- [x] Add the Fotoro route and chrome. Preserve original gallery presentation,
  upload errors/retries, download/export, recovery, logout and hidden collections.
- [x] Keep grid virtualization; add tested three-column mobile / wider desktop
  layout as an optional presentation. Preserve the upstream default layout.
- [x] Connect account entry redirects and the demo's sign-in action.
- [x] Run Photos tests, TypeScript, changed-file lint and formatting. Build the
  static production export, then inspect the live preview and account guard.
- [x] Exercise a local fixture account and original round trip if available.
  If account UI requires human credential entry, report that exact verification
  limit; never substitute browser-injected auth or a fake successful backup.
- [x] Review the final diff, record results, commit and push to GitHub.

## Scope boundaries

This slice adds the account-connected canvas. Production deployment, primary
passkey unlock, new trusted-contact grants, new semantic/face indexing and
encrypted persistence of the demo's Gemini descriptions remain separate work.
The server and cryptographic protocols are unchanged. Existing authenticated
catalog persistence is reused; browser caches remain subject to browser eviction.

## Results

See [verification.md](verification.md): 160 Photos tests, TypeScript, lint and
static export pass; local upload, refresh, fresh-origin restore, duplicate skip,
empty-file review and a downloaded original SHA-256 round trip were exercised.
Physical-device interoperability and production deployment remain next work.
