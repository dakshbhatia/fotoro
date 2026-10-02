# Fotoro: reuse and parallel build layout

October 1, 2026. Design guidance, not a claim that the new build or commands
already exist. [Roadmap](roadmap.md) covers the whole product;
[first-exchange spec](../superpowers/specs/2026-10-01-fotoro-private-photo-exchange-design.md)
defines the first shipping slice for review.

## Reuse map

| Job | Repository / platform | How to adopt |
| --- | --- | --- |
| iOS presentation and touch | SwiftUI / PhotoKit / Vision / AuthenticationServices | Native APIs first; glass on controls; profiling determines UIKit escape hatches |
| Native catalog and OCR text search | [groue/GRDB.swift](https://github.com/groue/GRDB.swift) | Dependency; migrations, observation, FTS |
| Cloud image loading | [kean/Nuke](https://github.com/kean/Nuke) | Dependency; custom encrypted-data pipeline, bounded cache/prefetch |
| Browser virtualized grid | [TanStack/virtual](https://github.com/TanStack/virtual) | Dependency; headless layout so Fotoro controls the visual experience |
| Workers API | [honojs/hono](https://github.com/honojs/hono) | Dependency; small explicit routes and D1/R2 bindings |
| Passkey ceremonies | [MasterKale/SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn) | Dependency; web/server validation, native AuthenticationServices client |
| Encryption primitives | [jedisct1/swift-sodium](https://github.com/jedisct1/swift-sodium), [jedisct1/libsodium.js](https://github.com/jedisct1/libsodium.js) | Dependencies; common vectors and versioned protocol, independent review |
| Saved-page extraction | [mozilla/readability](https://github.com/mozilla/readability) | Later capture slice; sanitized extracted text/source URL |
| Optional cloud vision | [googleapis/js-genai](https://github.com/googleapis/js-genai) | Later indexing slice; billed Gemini 3.8 Flash, low effort, validated structured output |
| On-device semantic search | [Google SigLIP2](https://huggingface.co/google/siglip2-base-patch16-224), [apple/coremltools](https://github.com/apple/coremltools) | Benchmark pinned model conversion, preprocessing and memory before adoption |
| On-device face grouping | [fal/AuraFace-v1](https://huggingface.co/fal/AuraFace-v1) | Benchmark exact permitted weights and alignment; user labels and merge/split corrections |
| Mature photo-server patterns | [open-noodle/gallery](https://github.com/open-noodle/gallery), [immich-app/immich](https://github.com/immich-app/immich) | Source references or deliberate whole-app fallback; AGPL obligations retained |

Use package dependencies for focused libraries. Fork when we need to change
upstream behavior and can maintain the patch. Pin versions/revisions, retain
licenses/attributions and verify model weights separately from code licenses.

## Parallel design

Four active slots: coordinator plus three implementers. Existing research
agents have reviewed the independent domains; they have not built this stack.

| Owner | Exclusive paths | What it can build independently after contracts freeze |
| --- | --- | --- |
| Coordinator | fotoro/packages/contracts, fixtures, root lockfile/scripts/CI | Schema generation, crypto vectors, fixture service, integration and review |
| Native implementer | fotoro/apps/ios | Capture/catalog/viewer, crypto adapter, journal and exchange UI against fixtures |
| Web implementer | fotoro/apps/web | Safari gallery/viewer, ciphertext cache, crypto adapter and receive/save UI against fixtures |
| Service implementer | fotoro/services/api | Auth validation, D1 state, R2 upload/delivery, grants/cursors and permission tests |

The shared prerequisites are account/device identifiers, key enrollment,
representation framing, grant permissions, upload transitions and cursor/error
schemas. Freeze them centrally. Parallel workers do not invent endpoints or
independently rewrite shared models. Integrate continuously: fixture flow →
real service → bidirectional exchange → restore/permission/recovery failures.
AI is a later independent worker once the media/index contracts are stable.

## Development setup

Fresh `fotoro/` workspace in the existing GitHub repo. Proposed tooling is pnpm
for TypeScript packages, Vite for the private static web client, Wrangler local
D1/R2 for services, SwiftPM dependencies and Xcode for native. Pin tools and
dependency locks during implementation. Node v22.23.3 and Xcode 27.0 are present
on this machine; pnpm and new workspace commands have not been installed/built.

The intended command surface is one local `dev`, one `check`, separate
contract/crypto/API/web checks, and a named native Simulator scheme. Generate
public fixtures and two isolated account identities reproducibly. Keep AI
provider calls mocked in CI; paid and personal-photo runs are explicit.

Deploy the static web/API to Workers with private R2 and D1. Separate preview
and production storage/auth settings. Real passkey/native domain configuration,
signing and TestFlight are release work. Add a VM only when a measured workload
needs server compute; server processing requires access to plaintext.

## Twenty practices that matter

1. Show cached photos before waiting for the network.
2. Preserve original bytes; version each independent derivative.
3. Give every photo/representation stable identity.
4. Decode display-sized images instead of originals in the grid.
5. Virtualize large chronology; restore scroll and selection.
6. Prefetch nearby items with byte/concurrency budgets and cancellation.
7. Index off the UI thread; yield under interaction/memory/battery pressure.
8. Keep encryption and I/O out of render/body execution.
9. Use durable local journals and idempotent service mutations.
10. Reconcile unknown outcomes before repeating expensive submissions.
11. Treat R2/D1 updates as separate operations with recoverable state.
12. Authorize each current download and contribution, including expiry.
13. Separate authentication, vault enrollment and recovery.
14. Test cross-language crypto with tamper/truncation/replay cases.
15. Keep plaintext previews, OCR and names out of logs.
16. Version model weights, tokenizer, alignment, preprocessing and indexes together.
17. Show uncertain grouping as editable suggestions; never auto-grant from faces.
18. Make sends explicit and cleanup reversible; distinguish invited/viewed/saved.
19. Use platform accessibility, reduced motion/transparency and meaningful haptics.
20. Profile large libraries on actual Safari and physical iPhones before speed claims.

## AI job contract for the later slice

Use one optional Gemini 3.8 Flash enrichment path first. No agent framework or
vector server is needed. Local EXIF/OCR/search works before cloud results.

Persist jobs by asset digest + preview recipe + model + prompt/schema version.
Use queued → submitting → submitted → validating → committed, with retry_wait,
failed, cancelled and superseded side states. Record provider request/batch IDs,
attempts, consent generation and actual token usage. Reconcile unknown submission
outcomes; local deduplication does not guarantee exactly-once provider billing.
Reject stale/unconsented results and commit validated metadata atomically.

Cloud opt-in covers plaintext previews reaching our relay and Google. Strip
EXIF/GPS unless needed, keep original/face vectors local, encrypt retained
results, enforce spending caps and delete provider batch/files after ingestion
or cancellation. Provider deletion does not imply zero abuse-log retention.
Use actual media token/quality measurements before forecasting cost. Face
embeddings group similarity; the user supplies names and corrections.

## Knowledge to consult during implementation

- [Apple materials](https://developer.apple.com/design/human-interface-guidelines/materials),
  [PhotoKit persistent changes](https://developer.apple.com/videos/play/wwdc2022/10132/),
  [background transfers](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background(withidentifier:)).
- [React performance guidance](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices):
  remove waterfalls, keep heavy libraries off the initial path, narrow state subscriptions.
- [D1 transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
  [R2 presigned capability behavior](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
- [libsodium streams](https://libsodium.gitbook.io/doc/secret-key_cryptography/secretstream),
  [passkey PRF/recovery](https://simplewebauthn.dev/docs/advanced/prf).
- [Gemini 3.8 controls](https://ai.google.dev/gemini-api/docs/latest-model),
  [batch lifecycle](https://ai.google.dev/gemini-api/docs/batch-api),
  [media-resolution accounting](https://ai.google.dev/gemini-api/docs/media-resolution).
