# Fotoro roadmap

October 1, 2026. This covers the whole product. The approved private-photo exchange
slice now has a local native/web/API implementation in `fotoro/`; see its
[run instructions](../../fotoro/README.md) and [verification](../../fotoro/docs/verification.md).
Later slices still require their own implementation and acceptance checks.

## One experience

Browse your life, find the picture, exchange the moment. Open into photos;
moments organize chronology without making people manage folders. Search and
Add stay within reach. Share appears where photos are selected. People, places,
screenshots, saved pages and stories are contextual views, not separate apps.

## Five deliverables, in order

| Step | What ships | Reuse | Definition of done |
| --- | --- | --- | --- |
| 1. Feel and capture | Native local photo canvas; moment paging; Share extension for chat attachments, screenshots and web URLs; EXIF and OCR indexing | SwiftUI, PhotoKit/PHCachingImageManager, Vision, GRDB, Nuke, Readability | Actual phone library opens before network work; 10,000-item fixture stays responsive; imports survive interruption; return restores scroll/selection |
| 2. Keep and recover | Encrypted resumable backup; Safari library; passkey sign-in, trusted-device enrollment and vault recovery; preserve original/Live Photo resources | R2, Workers, D1, SimpleWebAuthn, AuthenticationServices, established crypto primitives | iPhone → Safari clean restore matches original digests; interrupted uploads resume; lost credential recovery works; unrelated account is denied |
| 3. Exchange | Share a moment, view, save and contribute back; ongoing family relationships; 15-minute friend grants; nearby QR/link handoff | Platform share sheets and authenticated relay; examine Gallery permission patterns | Two people complete the loop on iPhone/web; expiry/revocation checked on new requests; invitation/view/save states differ; saved copies survive revocation |
| 4. Find | Natural-language retrieval combining OCR, time, place, scenes and correctable face groups; optional asynchronous cloud enrichment | SQLite FTS, SigLIP2 candidate, AuraFace candidate, Gemini 3.8 Flash | Evaluated query set; local results before cloud completion; merge/split controls; clear model/version provenance; no face match silently grants sharing |
| 5. Revisit and reclaim | Previewable automatic stories; exact-duplicate cleanup then similar-shot review; optional native nearby peer transfer | Existing moment/embedding index, content hashes, Vision similarity, native transport APIs | Stories are editable before sharing; trash is recoverable; backup verified before reclaiming originals; peer transfer can fall back to relay |

Basic exact-duplicate detection belongs in ingestion from step 1. Step 5 adds
the cleanup experience and similarity suggestions, not the first duplicate check.
The first externally useful beta ends at step 3. Test the two-person exchange
throughout development; do not postpone integration until all five steps exist.

## Ten jobs covered

Sharing (3), screenshots (1/4), chat attachments (1), saved web pages (1), people
and faces (4), place/time (1/4), smart grouping (1/4), natural-language search
(4), joyful browsing/stories (1/5), safe sync and dedupe/cleanup (2/5).
Natural-language commands propose selections or edits; sending and deleting
remain explicit actions with preview and undo where applicable.

## Small stack, deliberate reuse

- **iPhone:** SwiftUI/system glass; UIKit collection view only if profiling
  establishes a grid bottleneck. PhotoKit caching for local assets, Nuke for
  cloud derivatives, GRDB/FTS for the local catalog, Vision/Core ML for indexing.
- **Safari:** React, virtualized media grid, browser worker for indexing,
  IndexedDB initially. Add SQLite WASM/OPFS when query measurements justify it;
  browser caches are reconstructible, never the sole backup or recovery store.
- **Cloud:** Workers API/static web + D1 coordination + private R2 objects.
  D1 holds opaque identifiers, authorization, upload state and sync cursors;
  photo metadata and AI indexes are encrypted objects. Account/share relationship
  metadata is still visible to the coordination service. D1's 10 GB paid database
  limit requires capacity monitoring, not a promise of unlimited scale.
- **Media:** preserve original bytes; generate a small thumbnail and medium
  preview on the client, then encrypt. Use AVFoundation/native playback first.
  Design and verify chunked authenticated encrypted video range playback in
  step 2. Client decoding, transcoding and Live Photo behavior need actual tests.
  A server cannot ordinarily run FFmpeg or cloud image transformations over
  end-to-end encrypted originals. Hetzner/container FFmpeg and Mux/Stream are
  optional later choices for an explicitly server-readable media mode.
- **Repository:** apps/ios, apps/web, services/api, packages/contracts,
  fixtures. Share schemas and test vectors across Swift/TypeScript, not UI code.
  One local startup command, two fixture accounts, large media fixture, CI for
  contract/crypto/sync tests, Safari checks and Simulator build; TestFlight for
  physical-device verification. Keep upstream attribution and pin adopted
  versions/model revisions. Existing Ente code remains a reference, not a base
  requirement. Gallery is the fallback if shipping a conventional photo server
  quickly becomes more important than the native/private architecture.

## AI: useful immediately, smarter over time

1. EXIF, date, source type, exact hashes and Vision OCR: local, incremental and
   cheap. No model download required before browsing.
2. SigLIP2 for image/text retrieval; AuraFace-v1 for local face embeddings:
   commercially permissive model-card candidates, not proven iPhone/Safari
   deployments. Pin the exact assets, confirm preprocessing and licenses,
   convert/quantize, and benchmark memory/quality before adoption. Apple Vision
   provides face detection; it does not provide named-person identity groups.
3. Default optional cloud enrichment: **`gemini-3.8-flash`, low thinking effort**,
   small structured outputs, previews only with explicit cloud-AI opt-in.
   Queue analysis once per content/model/prompt version; batch background jobs,
   cache encrypted results, enforce spending caps and retry idempotently.
   Do not copy private photographs into logs. Gemini does not replace embeddings,
   the local index, sync or face clustering.
4. Evaluate 3.5 Flash-Lite against 3.8 on the same labeled photo tasks. Adopt it
   for bulk tagging only if quality is sufficient. Avoid elaborate routing until
   that measurement earns it. Use 3.8 now where cloud enrichment is enabled.

### Verified Google models and prices

Per million tokens, USD, checked October 1, 2026. Output includes thinking.

| Vision-capable model | Standard input / output | Batch input / output |
| --- | --- | --- |
| Gemini 3.8 Flash | $0.75 / $3.75 | $0.375 / $1.875 |
| Gemini 3.5 Flash-Lite | $0.30 / $2.50 | $0.15 / $1.25 |
| Gemini 3.1 Flash-Lite | $0.25 / $1.50 | $0.125 / $0.75 |

3.8 prices are introductory through December 31, 2026; those rates double
January 1, 2027. The current catalog lists 3.8 Flash-Lite **TTS**, not a general
3.8 Flash-Lite vision endpoint. Image-generation models are unnecessary for
indexing photographs. Illustrative 3.8 batch cost for 10,000 items at 1,000 input
and 150 total output tokens each is $6.56 now; this is hypothetical, not a
measured image-token/quality estimate. Measure actual usage before projecting.

Billing-enabled Gemini services do not use prompts/responses to improve Google
products, but Google receives the opted-in previews and retains limited abuse
logs. This is not local processing or zero retention. Process results back into
the encrypted index; never describe a cloud-AI-enabled photo as never leaving
the device.

## Proof before promises

The roadmap is complete in scope; the following are engineering acceptance
gates, not solved features: cross-client vault recovery, encrypted streaming
video, local embedding quality/performance, background transfer reconciliation
and two-person grants. Resolve these in their scheduled slices before exposing
the corresponding promise. iOS imports from Messages/WhatsApp are explicit
shares/files; Fotoro cannot silently ingest those chats. Background work is
OS-scheduled. A 15-minute grant cannot erase a copy already downloaded. Native
nearby transport is an enhancement; Safari uses the relay/link path.

Proposed performance targets: warm cached library usable within 500 ms; local
query p95 within 200 ms; warm neighboring preview within 100 ms. Benchmark on
an older supported iPhone and Safari with 10,000 items. Measure frame pacing,
memory, battery and bounded cache bytes while indexing runs. These are targets,
not results from the existing three-image demo. Ship measured caching and
prefetch behavior with step 1, rather than treating speed as final polish.

## Primary sources

- [Google model catalog](https://ai.google.dev/gemini-api/docs/models),
  [pricing](https://ai.google.dev/gemini-api/docs/pricing),
  [3.8 thinking levels](https://ai.google.dev/gemini-api/docs/latest-model),
  [paid-service data terms](https://ai.google.dev/gemini-api/terms).
- [SigLIP2 model card](https://huggingface.co/google/siglip2-base-patch16-224),
  [AuraFace-v1 model card](https://huggingface.co/fal/AuraFace-v1).
- [Nuke](https://github.com/kean/Nuke), [GRDB](https://github.com/groue/GRDB.swift),
  [Readability](https://github.com/mozilla/readability),
  [SimpleWebAuthn PRF](https://simplewebauthn.dev/docs/advanced/prf).
- [PhotoKit caching](https://developer.apple.com/documentation/photos/phcachingimagemanager),
  [PhotoKit change history](https://developer.apple.com/videos/play/wwdc2022/10132/),
  [background work](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados).
- [R2 prices](https://developers.cloudflare.com/r2/pricing/),
  [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
  [Gallery S3 implementation](https://docs.opennoodle.de/features/s3-storage).
