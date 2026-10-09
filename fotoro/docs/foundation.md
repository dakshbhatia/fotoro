# Fotoro foundation

[Product](product.md) owns the user journey; [the backlog](product-backlog.md) owns
the active queue. [Cloudflare path](cloudflare.md) describes infrastructure
prerequisites. Build numbers and measured results belong in [verification](verification.md).

The repository is an Ente fork. The active `fotoro/` application is a separate
SwiftUI/React client and Hono service; it does not currently run Ente's backend,
sync engine or machine-learning pipeline. Existing repository licensing remains
in place.

| Need                                                                  | Current foundation                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone navigation, contextual controls and sheets                     | SwiftUI system components and native Liquid Glass on iOS 26+                                                                                      |
| Photos permission, asset metadata, still/video/Live Photo previews and originals | PhotoKit, `PHAsset`, `PHAssetResourceManager`, Apple's decoder and AVFoundation                                                                  |
| Original-file sharing                                                 | `PHAssetResourceManager` and `UIActivityViewController`; browser Web Share or download                                                            |
| Browser grid and previews                                             | React, the existing virtualized layout and a bounded sequential image cache                                                                       |
| Encrypted saving and exchange                                         | The existing Fotoro protocol, libsodium, GRDB, Hono, D1 and private R2; one-password accounts, chosen Save and account-scoped opt-in photo sync       |
| Resumable Photos backup                                               | Account-scoped PhotoKit source checkpoints, atomic GRDB source/catalog/transfer insertion, sequential encrypted upload and receipt reconciliation |
| Local text search and photo picks                                     | Apple's Vision OCR and bounded on-device image analysis; browser OCR and preview analysis use same-origin assets                                  |

Apple Photos provides the interaction reference. Apple's
[Liquid Glass adoption guide](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)
and [Landmarks example](https://developer.apple.com/videos/play/wwdc2025/323/)
provide the platform patterns. Glass belongs on controls over the photo content;
the photo grid stays plain. We use system components before custom effects.

## One source and one journal for each job

PhotoKit supplies permitted device photos; the account catalog supplies Saved.
Browser files are explicit local sources. Saved is a read-only view of account
originals, not an instruction to upload or to write into Apple Photos. Clients
verify the decrypted original digest when restoring. Immutable encrypted media
and revision-bound annotations carry account content; local search data is a
rebuildable index, not a second source of originals.

Native GRDB stores protected source checkpoints, catalog state and the transfer
journal. Existing reservation, upload, commit and receipt reconciliation own
retry behavior. Keep one queue and one revision-bound intelligence index. Do not
add an alternative sync engine to fix presentation or a second index for a model.

Browsing and account entry create no new upload intent. Account entry can continue
an already chosen Save or Sync consent; explicit Save starts a chosen batch.
Native automatic Sync starts after opt-in and prepares new originals while the
app/account is open and unlocked; iOS can finish already scheduled ciphertext
PUTs. Pause, sign-out, account/origin changes and permission withdrawal fence work.
Browser uploads remain explicit. Private annotations use their existing encrypted
outbox; AI suggestions never authorize Save or replace a user's selection.

Photo GPS and confirmed Google Timeline imports support Places/Timeline locally.
Raw imported location data and local vectors are not uploaded. Reviewed People groups now use the existing local index and encrypted facts.
Automatically inferred trips and automatic cleanup remain open product work.

Trips present the existing live albums and reuse encrypted originals and the accepted-member roster.
Optional photo details use an additive signed/encrypted sidecar, authenticated
against the contributor, immutable album definition, manifest and original digest.
Only the contributor can revise it. Explicit reviewed names and location support
album People/place/capture-date search; private OCR and unrelated annotations are
excluded. Names are contributor-scoped snapshots, not a shared face-identity graph.
Filtering precedes exact-original grouping, which preserves all contributed copies.
Older servers can still serve albums without this optional details capability.

Download trip enumerates the complete bounded contribution list independently of
the visible gallery and filters. It authenticates originals sequentially, groups
exact originals, and additionally compares ordered verified resource bundles so
renamed equivalent Live Photo pairs export once. Distinct motion resources stay
complete. One ZIP uses safe per-photo paths; interrupted, changed or incomplete
work produces no completed archive. Native stages protected temporary files and
uses Foundation ZIP coordination off the main actor. Browser ZIP creation reuses
fflate 0.8.3 with its MIT notice, streams to a temporary file under an origin-wide
lock where supported, and uses a bounded 128 MiB fallback otherwise. Browser ZIP
output remains below 4 GiB. Published browser temporary output stays available
until explicit download cleanup or leaving the trip; keep the trip open until
the browser finishes downloading. This is an explicit export, not cloud AI work.

Approved contact cards and names have one account-private encrypted journal,
separate from photo upload consent and Pause. The account signs an encrypted
contact book; the service stores only its owner, revision and signed ciphertext.
Clients retain exact pending requests across interruptions and merge independent
edits. Changing an identity already trusted on this device, overlapping name edits
or removal conflicts requires an explicit choice. Removed entries retain
tombstones so an older offline device cannot silently restore them. Contact sync
does not add album members or share photos. Browser reads stay within contact
records; native state is scoped to the account catalog and API origin.

## Intelligence wiring — October 2026

Find resolves eligible photos through the existing index. Best shots applies the
versioned `moment-highlights-v3` policy to that matching subset before grouping
capture-time moments and choosing diverse representatives. Suggestions carry
measured reasons and never become a Save
intent or replace a user's selection. Preview work is serial and cancellable;
query, source revision, permission and account changes invalidate the result.
The fixed `picks-v1.json` checks compose retrieval with shortlisting in CI.
Synthetic policy checks do not qualify real-photo ranking or model accuracy.

The next native image representation to evaluate is Apple's
[Vision feature print](https://developer.apple.com/documentation/vision/analyzing-image-similarity-with-feature-print)
for image-to-image similarity. It can improve reviewed similar-shot diversity;
it does not supply text embeddings or identify named people. Store any qualified
representation in the existing revision-bound intelligence index, with request
revision and processor version in its identity. Do not add a second index.

Text/image retrieval uses TinyCLIP. The [Microsoft MIT license](https://github.com/microsoft/Cream/blob/main/TinyCLIP/LICENSE)
permits modification and redistribution, including commercial use, with its
copyright and permission notice retained. The model publishers also mark the
checkpoints and conversions MIT. The Apple/Hugging Face MIT software attribution
for the reused CLIP tokenizer is retained separately; it does not grant rights to
Apple's research-only model weights. Those weights are not used.

The browser uses [TinyCLIP ViT-8M/16 Text-3M ONNX](https://huggingface.co/onnx-community/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M-ONNX/tree/9463a9c508a344c837ffefe9d724f3827bf2dc79),
revision `9463a9c508a344c837ffefe9d724f3827bf2dc79`, with one quantized graph.
Pinned model/config/tokenizer files total 27,925,629 bytes. The separately loaded
runtime adds 12,552,676 bytes on Safari or 22,867,301 bytes on other browsers.
These are uncompressed asset sizes, excluding worker JavaScript and HTTP headers.
Account crypto and semantic inference remain deferred from browser startup. The
startup test enforces a 500 KiB ceiling when build output is available; current
measurements are recorded in [verification](verification.md).

Native uses the [community TinyCLIP ViT-39M/16 Text-19M Core ML conversion](https://huggingface.co/nufrnd/lvc-tinyclip-coreml/tree/81f9cabad48edb0b78ac83e8ffb8039c9fda6cd1),
revision `81f9cabad48edb0b78ac83e8ffb8039c9fda6cd1`. Its six package files total
118,341,921 bytes, excluding bundled tokenizer resources and compiled model files.
The publisher's [provenance record](https://huggingface.co/nufrnd/lvc-tinyclip-coreml/blob/81f9cabad48edb0b78ac83e8ffb8039c9fda6cd1/provenance.json)
pins the author checkpoint `07a4b0bc751cb64fecd2b661c048c1dd98d69444`, conversion
versions and source hashes. All four recorded source hashes match the pinned
upstream artifacts, but the named conversion script was not publicly located;
we have not independently reproduced the conversion. The package's MIT notice
is retained. This is a community conversion, not an official Microsoft Core ML
release.

Both paths produce local 512-value vectors. Processor and source-revision fences
keep old or different-model vectors out of rankings; native and browser vectors
are not interchangeable or synced. Model file downloads contain no private photo
pixels, queries or embeddings. Date, label and recognized-text search remains
available if inference cannot prepare. A single public-image smoke test does not
qualify held-out retrieval accuracy, memory, latency or thermal behavior on iPhone
and Safari. Cloud inference still requires explicit opt-in and a spending bound;
local intelligence creates no upload intent; opted-in Sync can run during browsing.

## October 6 foundation implementation

Automatic native Sync now anchors its first intake to the last 30 days. The
checkpoint excludes older or undated initial assets, then admits newly observed
identifiers without inventing a capture date. This includes later permission
grants and backdated imports; it is an initial intake boundary, not a permanent
capture-date filter. Expanding to older photos is explicit;
Pause and saved source retries survive returning to the app. Browsing still
shows every permitted photo. Preparation requires an open, unlocked app;
already staged ciphertext can finish uploading in the background.

The browser photo table shares the grid's selection, viewer and thumbnail
resources. Optional columns expose observed capture dates, dimensions, type,
location, labels, OCR status and original availability. Missing capture dates
remain unavailable. Thumbnail leases protect displayed object URLs from cache
eviction; abandoned queued requests do not decode offscreen images.

People is opt-in local inference. Both clients use the pinned OpenCV SFace
2021dec embedding model from OpenCV Zoo commit
`47534e27c9851bb1128ccc0102f1145e27f23f98` (Apache 2.0). Both clients use
YuNet 2023mar from the same commit (MIT). Notices ship with the assets. Automatic
groups are tentative; naming, merging, separating and rejecting are reviewed
corrections. Templates stay local. Confirmed names use digest-bound encrypted
facts and the existing search index, with source, permission and account fences.
Native publication requires an eligible unadjusted original; edited-current
photo boxes remain local until their original pixel binding can be proved.
Browser provisional groups and rejections last for the session; named edits use
local retention or the owned annotation outbox.

Optional cloud photo understanding uses the authenticated Worker route and
Gemini 3.8 Flash or 3.5 Flash-Lite. It remains unavailable until a server key and
explicit account/global daily work caps are configured. Each analysis needs
separate consent to send a reduced, metadata-free JPEG to Google. Analyze stages
objects, scenes and visible text for review; Keep retains separate source-bound
observations. Both requests bind the authenticated server account to the unlocked
vault's expected account before provider dispatch. Supplied captions, labels and
local OCR remain intact. Kept cloud
observations enter browser search; native readers preserve their encrypted facts
without indexing internal marker syntax. Owned edits
use the encrypted outbox and explicit Save changes. Uncertainty and internal
marker syntax do not become search terms. Work caps bound request counts;
provider billing after timeout is not a dollar guarantee. No live provider or
physical-device quality claim follows from fixture checks.
