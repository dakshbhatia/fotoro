# Fotoro Private Photo Exchange Implementation Plan

> **Historical record.** The dated evidence, contracts and task states below are
> preserved from the earlier slice. They do not describe current release status
> or an active work queue. Use [product](../../../fotoro/docs/product.md),
> [the only active queue](../../../fotoro/docs/product-backlog.md),
> [architecture](../../../fotoro/docs/foundation.md) and
> [current evidence](../../../fotoro/docs/verification.md). Old unchecked tasks
> and execution instructions require reconciliation with that queue before use.

Execution status, October 1: Tasks 1–5 have local development implementations,
correctness tests and independent review. Task 6 has CI, local startup, isolated
real D1/R2 encrypted exchange and restore verification. Physical-device/Safari
acceptance, background scheduling, large-library performance measurements and
provisioned deployment remain open. See
[current verification](../../../fotoro/docs/verification.md); unchecked acceptance
items below are not a claim that those release gates have passed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private two-person JPEG/PNG exchange on native iOS and Safari,
with independent saves, original-byte verification and recoverable transfers.

**Architecture:** A fresh `fotoro/` workspace contains SwiftUI, a static React
client and a Workers service. Shared contracts and crypto vectors land first;
three disjoint implementation workers then build against fixtures and integrate
the real service. Existing Ente-derived code remains an independently runnable
reference.

**Tech Stack:** SwiftUI/PhotoKit/GRDB/Nuke/swift-sodium; React/Vite/TypeScript/
TanStack Virtual/IndexedDB/libsodium.js; Hono/Workers/D1/R2/SimpleWebAuthn.

**Spec:** [2026-10-01-fotoro-private-photo-exchange-design.md](../specs/2026-10-01-fotoro-private-photo-exchange-design.md)

## Global Constraints

- iOS 26+ and Safari 26+; JPEG/PNG originals only, 50 MiB limit, 100 photos per exchange.
- Native Photos imports use unmodified original resources; reject HEIC conversion and Live Photo pairs.
- No external model API calls for development. No Gemini calls in this slice; later product enrichment remains optional.
- Original bytes remain unchanged; thumbnail and preview are independent encrypted representations.
- Secretstream plaintext record size is 4 MiB, with mandatory final-tag and trailing-data checks.
- Recovery uses a random 256-bit secret; passkey authentication and vault access are separate.
- New download requests recheck grants; already authorized transfers may finish after expiry.
- Upload capabilities access staging only; committed final objects cannot be overwritten through them.
- Save means independent Fotoro retention; native Photos export is later work.
- Never log keys, original bytes, names, OCR, prompts or photo descriptions.
- Preserve upstream license/attribution; do not rewrite user-authored personal copy.
- Existing localhost:4300/reference dependencies and runtime must remain usable.
- Use Codex built-in GPT-6.1 Sol workers with medium reasoning, as requested.

## Review Focus

- Photos resource is edited, iCloud-only, unsupported or inaccessible: import original bytes or show a recoverable failure; never silently transcode.
- Browser staging is evicted or full: preserve the external source and request re-selection; never claim backup before commit.
- Upload finalize is ambiguous or a signed PUT is replayed: reconcile one committed object and preserve immutable saved bytes.
- Grant expires/revokes while Save races cleanup: retain a completed recipient save atomically; deny a newly unauthorized save.
- PRF is unavailable or a credential disappears: recovery/trusted-device enrollment remains possible; do not silently expose a vault.

---

## Ownership and interface freeze

Coordinator owns `fotoro/packages/{contracts,crypto}`, `fotoro/fixtures`, root
scripts/lockfile and integration checks. Native owns only `fotoro/apps/ios`;
web owns only `fotoro/apps/web`; service owns only `fotoro/services/api`.
Root dependency changes are sent to the coordinator. Do not edit another lane.
After Task 1, Tasks 2–3, 4 and 5 can run in three parallel lanes. The service
lane completes 2 then 3; clients use fixture routes until service readiness.

All wire IDs are UUID strings. Binary values are base64url without padding.
Times are UTC ISO-8601 strings; server expiry uses its clock. Types are defined
in `packages/contracts/src/models.ts` and `schema/contract-v1.schema.json`:

| Type | Fields |
| --- | --- |
| AccountCardV1 | version:1, accountId, boxPublicKey, signingPublicKey |
| MediaBinding | version:1, photoId, representationId, kind:thumbnail/preview/original/metadata |
| RepresentationV1 | binding, objectId, header, ciphertextBytes, ciphertextSha256 |
| PhotoMetadataV1 | filename, mediaType, sourceDate, dateSource:exif/import, originalBytes, originalSha256, representationKeys |
| WrappedKeyV1 | version:1, nonce, ciphertext |
| PhotoManifestV1 | version:1, photoId, ownerAccountId, representations, metadataRepresentation, ownerWrappedMetadataKey |
| SignedPayloadV1 | version:1, kind, accountId, body, signature |
| UploadReservationV1 | uploadId, photoId, representationId, stagingUrl, expiresAt |
| UploadCommitV1 | uploadId, objectId, ciphertextBytes, ciphertextSha256 |
| GrantV1 | grantId, momentId, ownerAccountId, recipientAccountId, role:viewer/contributor, expiresAt:string/null, revokedAt:string/null, version:number |
| ShareKeyEnvelopeV1 | grantId, photoId, recipientAccountId, sealedMetadataKey, senderSignature |
| ShareBindingV1 | grantId, photoId, senderAccountId, recipientAccountId |
| SavedPhotoV1 | operationId, photoId, sourceGrantId, sourcePhotoId, manifest, signedPayload |
| ChangePageV1 | changes, nextCursor, hasMore |
| ApiErrorV1 | code, retryable, requestId |

`body` contains the base64url bytes of the actual JSON payload. Sign the UTF-8
encoding of the fixed ASCII tuple `JSON.stringify(["fotoro-signed-v1", kind,
accountId, body])`; verify those bytes before decoding/schema-validating body.
This avoids relying on implicit object key ordering between Swift and JS.
Bind media record AAD to the fixed tuple `["fotoro-media-v1", photoId,
representationId, kind]`. Container bytes are the libsodium header followed by
big-endian uint32 ciphertext record length and record bytes for each record.

Record ciphertext is produced only by libsodium secretstream. The per-photo
metadata key opens encrypted metadata containing representation keys; the owner
wraps that metadata key with their vault key. Recipient sealed boxes carry the
metadata key and signed bindings. Signatures use a distinct Ed25519 keypair.
Recovery wrapping uses libsodium secretbox with random nonces. Freeze all key
and wrapper byte sizes against library constants and test vectors in Task 1.

## Task 1: Executable contracts, crypto vectors and fixture runtime

**Owner:** coordinator. **Dependencies:** none.

**Files:** Create `fotoro/package.json`, `pnpm-workspace.yaml`, `tsconfig.json`,
`packages/contracts/{package.json,src/models.ts,src/validate.ts,schema/contract-v1.schema.json}`,
`packages/crypto/{package.json,src/media.ts,src/envelopes.ts,src/signatures.ts}`,
`fixtures/{accounts.json,crypto-v1.json,changes-v1.json}`,
`tools/fixture-server.ts`, `tools/dev.mjs`,
`tests/{contracts.test.ts,crypto.test.ts,fixture.test.ts}`.

**Interfaces:**
- `validateWire<T>(schemaName:string,value:unknown):T` rejects unsupported version/invalid fields.
- `signPayload(kind:string,accountId:string,body:Uint8Array,secretKey:Uint8Array):SignedPayloadV1`;
  `verifyPayload(value:SignedPayloadV1,publicKey:Uint8Array):Uint8Array` rejects bad signatures before parsing.
- `encryptMedia(records:AsyncIterable<Uint8Array>,key:Uint8Array,binding:MediaBinding):AsyncIterable<Uint8Array>`;
  `decryptMedia(container:AsyncIterable<Uint8Array>,key:Uint8Array,binding:MediaBinding):AsyncIterable<Uint8Array>`.
- `wrapKey(key:Uint8Array,vaultKey:Uint8Array):WrappedKeyV1`; `unwrapKey(value,vaultKey):Uint8Array`.
- `sealShareKey(metadataKey:Uint8Array,recipient:AccountCardV1,binding:ShareBindingV1,senderSecretKey:Uint8Array):ShareKeyEnvelopeV1`;
  `openShareKey(envelope,recipientSecretKey,senderCard,expectedBinding:ShareBindingV1):Uint8Array`
  verifies signed binding and intended recipient.
- Fixture HTTP routes match Task 2/3 routes exactly. Fixture identities are public test data;
  fixture auth runs only on loopback and is absent from production builds.

- [ ] Write tests: valid fixture schemas decode; version 2 is rejected; encrypted roundtrip
  preserves digest; wrong key/AAD, reordered records, truncation and bytes after TAG_FINAL fail;
  a share envelope for account B cannot open for C; altered sender signature fails.
- [ ] Run `pnpm test:contracts` and `pnpm test:crypto` from `fotoro`; expect failure until implementations exist.
- [ ] Implement the named interfaces using libsodium wrappers, add fixed cross-language vectors,
  schema validation and a fixture server with deterministic two-account photo/moment data.
  Provide `pnpm dev:fixtures` and `pnpm check`; pin dependencies and locks. Smoke-check the
  existing reference runtime remains independent. No paid/external AI calls.
- [ ] Run both tests and fixture route smoke checks; expect all pass. Document exact fields,
  error codes and fixture URLs in `packages/contracts/README.md` and freeze before dispatch.
- [ ] Commit the workspace/contract deliverable. Later protocol changes require coordinator review
  and new vectors before either client adopts them.

## Task 2: Private upload, immutable delivery and catalog service

**Owner:** service lane. **Consumes:** Task 1 types/fixtures. **Files:** Create
`services/api/{package.json,wrangler.toml,src/index.ts,src/storage.ts,src/catalog.ts,src/errors.ts}`,
`services/api/migrations/0001_catalog.sql`, `services/api/test/storage.test.ts`.

**Interfaces:**
- `POST /v1/uploads/reserve` takes representation binding, bytes and ciphertext digest;
  returns UploadReservationV1 bound to authenticated owner.
- `POST /v1/uploads/:id/commit` returns UploadCommitV1 idempotently;
  `commitUpload(env:Env,actor:Actor,uploadId:string):Promise<UploadCommitV1>`.
- `GET /v1/objects/:id` streams ciphertext after ownership/current-grant check.
- `POST /v1/photos` stores a validated signed PhotoManifestV1 and ownership refs;
  `GET /v1/changes?cursor=...&limit=...` returns ChangePageV1 (maximum page 100).
- `Actor` is `{accountId:string,deviceId:string}` from Task 3 middleware; tests inject fixture actors.
- R2 staging/promoted object metadata and D1 reservation/commit/tombstone rows are explicit;
  `reconcileUpload(env,uploadId):Promise<UploadCommitV1|null>` checks ambiguous outcomes.

- [ ] Write Workers tests: unrelated actors denied; exact retry returns same commit;
  replayed staging PUT after commit leaves final object bytes unchanged; failures before/after
  promotion and D1 update reconcile; cursor replay is stable; referenced objects survive cleanup.
- [ ] Run `pnpm test:api` using Wrangler/Workers Vitest pool with local D1/R2; expect failures.
- [ ] Implement reserve/upload/promotion/finalization and bounded change pages. Use R2 streaming
  from observed staging ETag into a fresh private final key. Verify size/digest evidence,
  reject overwritten/mismatching staging and never expose a PUT capability for final keys.
  Use incremental SHA-256 from pinned `@noble/hashes` when verifying streamed bytes; do not
  buffer a 50 MiB object merely to call a whole-buffer digest API. Task 2 delivery policy
  permits only owner access; Task 3 extends it to authorized grants.
  D1 state transitions and dependent mutations include expected version/authorization.
- [ ] Run service tests; expect pass. `pnpm dev:api` starts a loopback service with local D1/R2;
  test production config rejects fixture auth. Do not provision public providers yet.
- [ ] Commit service storage/catalog deliverable.

## Task 3: Account sessions, vault enrollment, grants and independent saves

**Owner:** service lane. **Files:** Create
`services/api/src/{auth.ts,devices.ts,grants.ts,saves.ts}`,
`migrations/0002_accounts_grants.sql`, `test/{auth.test.ts,grants.test.ts,saves.test.ts}`.
**Consumes:** Task 1/2 models, signed-payload verifier and Actor.

**Interfaces:**
- `POST /v1/auth/register/options`, `/register/verify`, `/login/options`, `/login/verify`
  implement SimpleWebAuthn with one-use stored challenge, RP ID and allowed-origin configuration.
  Web uses secure HttpOnly same-site sessions; native uses a device-scoped session token.
- `POST /v1/devices/enroll`, `/enroll/:id/approve`, `/enroll/:id/complete`
  carry signed account/device/challenge/origin bindings; challenges expire after five minutes.
- `GET /v1/vault` and `PUT /v1/vault/wrappers/:id` store only encrypted wrappers and
  public identifiers. `DELETE /v1/credentials/:id` cannot silently remove the last verified recovery path.
- `POST /v1/moments/:id/grants` consumes GrantV1 + signed key envelopes;
  `DELETE /v1/grants/:id`, `POST /v1/grants/:id/viewed` have distinct idempotent states.
- `POST /v1/saves` consumes SavedPhotoV1; `savePhoto(env,actor,input):Promise<SavedPhotoV1>`
  atomically creates recipient catalog ownership and retention under active-grant/version conditions.
- `POST /v1/moments/:id/contributions` requires contributor role and signed manifests from
  an enrolled identity; clients additionally pin/verify contributor cards before accepting content.

- [ ] Write tests: challenge replay/wrong RP/origin denied; fixture auth absent in production;
  enrollment binding swap/replay denied; expiry boundary uses server time;
  revoked grants deny new downloads/save/contribution; saved originals survive source-grant removal;
  save/cleanup race never drops recipient retention; replaced signing keys require renewed trust.
- [ ] Run `pnpm test:api`; expect failures for new routes/states.
- [ ] Implement the interfaces, authoritative permission reads and atomic/idempotent recipient-save
  mutation. Use five-minute enrollment expiry and exactly 15-minute temporary grants.
  Never infer authority from a client supplied account ID or a successful zero-row SQL statement.
- [ ] Run API tests and the fixture-to-real-service HTTP contract comparison; expect pass.
  Document associated-domain/HTTPS production setup separately from loopback fixtures.
- [ ] Commit account/grant/save deliverable.

## Task 4: Native local canvas, protected vault and exchange

**Owner:** native lane. **Files:** Create
`apps/ios/Fotoro.xcodeproj`, `Fotoro/{FotoroApp.swift,AppServices.swift}`,
`Fotoro/Library/{LibraryView.swift,PhotoViewer.swift,LibraryStore.swift,PhotoImport.swift}`,
`Fotoro/Vault/{VaultStore.swift,AccountSession.swift,CryptoAdapter.swift}`,
`Fotoro/Exchange/{ExchangeView.swift,TransferJournal.swift,APIClient.swift}`,
`FotoroTests/{CryptoVectorTests.swift,ImportTests.swift,TransferTests.swift,ExchangeTests.swift}`.
**Consumes:** frozen wire models, fixture routes and crypto vectors.

**Interfaces:**
- Codable wire types preserve Task 1 field names and binary encoding.
- `SelectedResource` contains id, origin (Photos/file), resource identifier and optional file URL.
  `LocalPhoto` contains photoId, manifest, metadata, transfer state and optional original/thumbnail URLs.
  `UnlockMethod` is PRF, trusted-device approval or recovery secret; native protected local access
  can reuse its enrolled Keychain wrapper.
- `PhotoImport.importResources(_ selected:[SelectedResource]) async throws -> [LocalPhoto]`
  reads unmodified supported originals, stages originals/derivatives and reports individual failures.
- `LibraryStore.apply(_ page:ChangePageV1) throws`, `photos(after id:String?,limit:Int) throws -> [LocalPhoto]`
  persist catalog/cursor through GRDB transactions.
- `VaultStore.unlock(_ method:UnlockMethod) async throws`, `lock()`, `recover(secret:Data) async throws`;
  Keychain holds native protected access, PRF/recovery/device wrappers implement shared contracts.
- `TransferJournal.enqueue(_ photo:LocalPhoto)`, `resumePending() async`,
  `APIClient.save(_ input:SavedPhotoV1) async throws -> SavedPhotoV1` use Task 2/3 endpoints.

- [ ] Write native tests using the exact crypto vectors; reject swapped binding/key/signature,
  iCloud resource failure, edited/unsupported/transcoded sources, journal restart and ambiguous commit.
  Add receive/save/contribute fixtures and lost-credential/non-PRF recovery cases.
- [ ] Run `xcodebuild test` on a discovered available Simulator with scheme `Fotoro`;
  expect failures until modules exist. Select destination from actual XcodeBuildMCP discovery.
- [ ] Implement project/app and the named modules. Use PhotoKit caching for local resources,
  GRDB for catalog/journal, native viewer gestures and bounded Nuke cloud previews.
  Stage pending ciphertext in Application Support; keep crypto/I/O off UI rendering.
  Use glass controls, accessible actions, stable-photo scroll restoration and explicit send/save UI.
- [ ] Run native tests/build and Simulator fixture flow. Expect original digests preserved and
  cached navigation usable before network work. Capture screenshots of actual states.
- [ ] Commit native deliverable. Physical-device passkeys/background checks remain release gates.

## Task 5: Safari client, encrypted cache and exchange

**Owner:** web lane. **Files:** Create
`apps/web/{package.json,index.html,vite.config.ts,src/main.tsx,src/app.tsx,src/styles.css}`,
`src/library/{Library.tsx,Viewer.tsx,catalog.ts}`,
`src/vault/{vault.ts,session.ts}`,
`src/exchange/{Exchange.tsx,api.ts,journal.ts,cache.ts}`,
`test/{vault.test.ts,journal.test.ts,save.test.ts}`.
**Consumes:** frozen wire types, shared crypto module, fixture routes.

**Interfaces:**
- `UnlockMethod` is `{kind:"prf"}` / `{kind:"trustedDevice",enrollmentId:string}` /
  `{kind:"recovery",secret:Uint8Array}`. `PendingImport` contains operationId, photoId,
  stagingKeys, sourceFilename, sourceDigest and state (staging/queued/uploading/committing/committed/failed).
- `unlockVault(method:UnlockMethod):Promise<UnlockedVault>`; `lockVault():void`;
  `UnlockedVault` contains ephemeral key material and `dispose():void`.
- `stageImport(file:File):Promise<PendingImport>` validates supported source/50 MiB limit,
  writes ciphertext staging and metadata into IndexedDB atomically where supported.
- `resumePendingImports():Promise<void>` reconciles missing staging and unknown commits;
  `saveReceivedPhoto(grantId:string,photoId:string):Promise<SavedPhotoV1>` decrypts/verifies original
  before constructing recipient-owned manifest/key wrapper and calling Task 3 Save.
- `applyChanges(page:ChangePageV1):Promise<void>` atomically updates encrypted cached catalog/cursor.

- [ ] Write tests: non-PRF reload requires approval/recovery; lock clears decrypted URL/key access;
  quota/partial staging/eviction cannot mark backup complete; source re-selection matches digest;
  save retry preserves one recipient record; expired-save failure remains explicit.
- [ ] Run `pnpm test:web`; expect failures until functions exist.
- [ ] Implement static React/Vite client, worker-based crypto/staging, TanStack virtualization,
  decrypted Blob lifecycle and separate pending/read stores. Render only ciphertext cache until
  unlock. Use shared crypto fixtures, passkey ceremonies, bounded caches and current grant APIs.
  No SSR photo decryption, contact import, analytics SDK, provider key or private-source logging.
- [ ] Run unit/build checks; verify actual Safari UI through authorized browser tooling:
  import → select → share → receive → save → contribute, keyboard focus, search clear,
  lock, offline cached viewing and scroll restoration. Record actual screenshots/results.
- [ ] Commit web deliverable.

## Task 6: Integrate, measure and prepare release

**Owner:** coordinator. **Files:** Create
`tools/{dev.mjs,seed.mjs}`, `tests/integration/{exchange.test.ts,recovery.test.ts}`,
`.github/workflows/fotoro.yml`, `docs/{local-development.md,verification.md,deployment.md}`
inside `fotoro/`, except the workflow which belongs at the repository root
`.github/workflows/fotoro.yml`. **Consumes:** Tasks 1–5 deliverables.

- [ ] Write integrated scenarios against real local D1/R2: iPhone sends to Safari;
  Safari saves/contributes; clean restores preserve both directions' original digests;
  interrupted promotion/commit/save, revoked grants, staging replay and credential loss are exercised.
  Assert actual viewed/saved acknowledgments, not merely link generation.
- [ ] Run scenarios; failures identify integration gaps before deployment. Add `pnpm dev`
  for fixture seeding/service/web and `pnpm check` for contracts/crypto/API/web/build.
- [ ] Integrate without relaxing contracts or security checks. CI installs locked dependencies,
  checks schemas/vectors/API/web and builds/tests the native Simulator target on macOS.
  Seed a 10,000-record fixture with 1,000 distinct public/generated thumbnails; keep source
  media separate from repo secrets and never use a private library for CI.
- [ ] Run full checks, bidirectional restore and native/Safari performance measurements from
  the spec: p95 warm library ≤500 ms, neighbor preview ≤100 ms, fewer than 1% scroll frames
  exceeding 33 ms at 60 Hz; native peak memory ≤250 MiB and specified cache caps.
  Record actual results and failures. Complete independent spec/code review before release.
- [ ] Commit verified work. Prepare Workers/D1/R2 preview and domain configuration with separate
  production bindings; real credentials, passkey enrollment, associated domains, signed
  TestFlight and physical-device tests require their actual available configuration.
  Report unavailable release prerequisites; do not mark the product shipped from Simulator/fixtures.

## Self-review and handoff

Coverage: protocol/recovery (1/3/4/5), storage/expiry/save/contribute (2/3),
native capture/feel (4), Safari/eviction (5), integration/performance/release (6).
Review Focus cases have corresponding assertions in their owning tasks.
No photo intelligence/video/cleanup capability is claimed by this slice.

The human has selected Codex built-in GPT-6.1 Sol medium parallel workers.
The user approved implementation on October 1, 2026 with “RUN IT MOVE FAST build”.
Coordinator completes Task 1, dispatches service/native/web lanes, reviews each
deliverable and integrates Task 6.
