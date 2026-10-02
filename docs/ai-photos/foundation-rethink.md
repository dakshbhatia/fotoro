# Fotoro: experience and foundation reconsidered

October 1, 2026. Research and proposed direction, not an approved implementation
spec. The user explicitly removed the Ente constraint. Preserve the working
library as a reference; choose the next foundation on its merits.

## Purpose

Make photos easier to exchange, find and enjoy with people who matter. The
first useful result should be a real photo viewed or received, before account
setup, contact import or AI configuration becomes a project of its own.

## Proposed experience

Open into pictures organized into quiet, chronological moments. A moment is a
view over originals, not a folder people must maintain. A short stack preview
lets someone recognize the day; tapping opens the full sequence. All photos is
one action away and remembers its position. Never impose a carousel on a large
library: use vertical scrolling for chronology, horizontal paging inside a
moment, and direct search for retrieval.

Keep Search and Add within thumb reach. Open a moment and Share becomes the
primary contextual action. A newly received contribution appears inside that
moment with factual attribution. No empty insight cards or synthetic social
activity. People, places and screenshots appear as useful search suggestions,
not ten permanent navigation destinations.

The distinctive loop is: recognize a shared day → choose what to share → the
other person views it → they can contribute theirs. A family relationship can
persist, but it does not silently grant the whole library. A temporary friend
grant can expire after 15 minutes; a received copy remains theirs.

## Ten jobs and acceptance targets

These are product hypotheses, not a claim of representative consumer research
or completed functionality.

| Job | Proposed interaction | Evidence needed to call it working |
| --- | --- | --- |
| Exchange photos after being together | Open a recognized moment, choose a recipient, share, receive contributions in the same sequence | Two accounts exchange originals, verify digests and permissions; track viewed separately from invited |
| Find a particular picture | Type “Maya at the beach last summer”; show photos and removable constraints | Fixed evaluation set covers people, time, place and scenes; uncertain interpretations can be corrected |
| Use a screenshot | Search its text; open the screenshot and copy detected text | OCR works locally; links/actions require explicit taps and retain the source image |
| Save something from the web | Share a URL/page to Fotoro; retain title, URL and selected/readable text | Safari share import survives extension termination; extracted content is sanitized |
| Keep a photo from a conversation | Share an attachment or import a file; retain available source information | Import works with real source apps; no fabricated sender or chat attribution |
| Find someone across years | Select a correctable face group from search | Licensed identity embeddings, evaluation, merge/split corrections; detection alone is insufficient |
| Revisit a time or place | Browse moments; expand a date or place constraint | Missing EXIF does not invent geography; edits do not move originals |
| Show photos beside someone | Edge-to-edge paging, pinch to zoom, dismiss back to the same thumbnail | Real-device gestures, accessibility, focus, position restoration and sustained scroll profiling |
| Enjoy or send a short story | Preview a suggested sequence, adjust it, explicitly share | Ordering is coherent, source media retained, no invented personal narrative or automatic publishing |
| Keep originals safe and reclaim space | Quiet verified backup; contextual duplicate review; passkey access on another device | Interrupted-transfer recovery, clean restore, key recovery, exact versus similar duplicate distinction and reversible deletion |

## Foundation options

1. **Recommended: native SwiftUI + Safari web over a small shared service.** Reuse
   focused components. Fits OS gestures, local indexing and server-blind storage.
   Sync, sharing, encryption interoperability and recovery still require serious
   implementation and verification; this is not a cosmetic wrapper.
2. **Noodle Gallery fork.** Fastest concrete route to collaborative spaces with
   R2/S3 storage. It retains Flutter/NestJS/Postgres/server ML assumptions. It
   would ship sooner as a conventional server-readable photo service; native
   SwiftUI and end-to-end encryption would be substantial separate work.
3. **Upstream Immich fork.** Established broad photo-server foundation. Gallery
   already implements some of the storage and collaboration changes Fotoro
   wants, so upstream requires more of those additions.

[Gallery source](https://github.com/open-noodle/gallery) is AGPL-3.0. Its
[S3 backend](https://github.com/open-noodle/gallery/blob/main/server/src/backends/s3-storage.backend.ts)
implements multipart writes and range delivery, while
[SharedSpaceService](https://github.com/open-noodle/gallery/blob/main/server/src/services/shared-space.service.ts)
implements membership roles. Uploads still pass through its server. The inspected
client search path calls the API; its advertised on-device CLIP must not be
treated as verified delivered functionality.

## Reuse for the recommended option

- iOS: SwiftUI, PhotoKit, Vision OCR, [GRDB](https://github.com/groue/GRDB.swift)
  for local metadata/FTS and [Nuke](https://github.com/kean/Nuke) for image loading,
  cache and bounded prefetch. Both libraries are MIT licensed.
- Web: React, worker-based local indexing, SQLite WASM/IndexedDB fallback,
  [Readability](https://github.com/mozilla/readability) for explicit saved-page
  capture, [SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn) for
  authentication ceremonies. Passkey authentication and encryption-key access
  are separate concerns; PRF support needs provider testing and recovery.
- AI: metadata/OCR first; benchmark
  [SigLIP2](https://huggingface.co/google/siglip2-base-patch16-224) as an
  Apache-2.0 image/text model candidate. Conversion and latency are unproven.
  MobileCLIP and InsightFace code licenses do not authorize commercial use of
  their restricted pretrained weights. AuraFace-v1 is a commercially oriented
  Apache-2.0 candidate to benchmark for local face embeddings. Optional cloud
  enrichment is explicit. Google now verifies `gemini-3.8-flash` for image/video
  understanding; the general vision model is not named “3.8 Flash-Lite.” See
  [roadmap.md](roadmap.md) for the verified model choice and tightened sequence.
- Cloud: Workers for auth, manifests and grants; private R2 ciphertext with
  direct resumable uploads. Preserve originals and version derivative manifests.
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
  make normal FFmpeg/large-model processing a separate client/container job.
  A server cannot ordinarily transcode or index end-to-end encrypted originals.

## Speed and feel requirements

Warm opening shows the local library before network work. Grid thumbnails and
opened-photo previews use distinct representations. Prefetch only neighboring
items with a byte budget; reduce it under memory, network and battery pressure.
Indexing yields to scrolling and suspends when necessary. Validate with a large
fixture library and real devices, not only the current three-image fixture.

Use glass for the small controls above content, as described in
[Apple's materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials).
Use native materials on iOS and a legible CSS approximation on web, with reduced
motion/transparency support. Haptics acknowledge selection or completion, not
every scroll step. Transitions must preserve the photo's visual position and
remain interruptible.

## First slice and development loop

Start with one complete two-person exchange: local import → moment preview →
explicit grant → recipient views and saves → contributor sends back. This tests
the product's reason to exist. Broader face grouping, stories and cleanup follow
as independently reviewable slices.

Proposed code boundaries: apps/ios, apps/web, services/api, packages/contracts
and fixture-based interoperability checks. Generate Swift/TypeScript contracts
from one versioned schema. Keep media loading, local indexing, sync and grants
separate. Use reproducible seeded libraries, two test accounts, one-command local
startup, and measured native/web interaction checks. No provider provisioning,
new scaffolding or dependency installation has been done for this proposal.
