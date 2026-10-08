# Fotoro roadmap

Build the smallest dependable Sync, Search, Share loop for the owner’s mom.
[Product](product.md) defines the audience, first value and reasons to return.
This file is the only active priority queue. Dated plans are historical records;
Cloudflare proposals become tasks here only when a consumer need admits them.

## Five things to master

| Foundation | Consumer outcome | Acceptance |
| --- | --- | --- |
| First value and identity | Their own photos first; account entry continues the chosen action. | Fresh and returning users browse, enable Sync or finish a chosen Save without losing selection or guessing which account is open. |
| Sync and restoration | Supported originals are available on another device. | Opt in once; preserve Pause and Photos permissions; interrupt, resume and restore identical still/video/Live Photo resources. Visible exclusions remain accurate. |
| Search and useful picks | Reach a useful photo quickly. | Dates, labels, text and visual matches stay bound to current evidence; measure retrieval and shortlist quality on real examples. |
| Sharing and receiving | Send the intended moment and let the recipient keep it. | System sharing and the private invitation route complete with the exact selected set; recipient identity and ownership remain correct. |
| Returning and smoothness | Reopen and continue without starting over. | Remembered access, cached previews, selection and durable work survive return; measure frame pacing, memory and search latency on supported hardware. |

## The ten foundations for Sync, Search and Share

| Order | Foundation and current implementation | Still needed to call it complete |
| --- | --- | --- |
| 1 | First photos and access: local photos before an account; password/passkey entry continues a chosen Save, Sync or invitation. A matching returning browser can sign in and unlock in one PRF request; fresh-browser discovery retains its second request. | Fresh iPhone → allow Photos → browse → opt in once → open the same Saved photos in Safari. Qualify real PRF passkeys on iPhone, Safari and Mac; Sign in with Apple is not implemented. |
| 2 | Sync intake: durable last-30-days initial scope, explicit expansion, Pause, retry and account/source fences. Existing 10-day anchors retain their exclusions until explicit expansion. | Physical background, relaunch, offline reconnect, changed permissions and edited/iCloud assets. Already scheduled ciphertext may finish in the background; new preparation needs the open, unlocked app. |
| 3 | Original recovery: encrypted JPEG/PNG/HEIC, supported video and complete Live Photo resources, bounded staging and byte verification. | Cross-device physical restore after an interrupted transfer and relaunch. Keep the 50 MiB logical-original limit until larger-original recovery is qualified. |
| 4 | Photo evidence: OCR, EXIF/Photos dates, observed locations, supplied labels and current revision bindings. iOS Info groups observed photo/camera fields, keeps capture details collapsed and shows provenance. Cheap metadata scopes heavy work before previews; native startup processes one bounded recent batch. | Personal-library OCR/metadata coverage, correction and location acceptance. No invented date or location for missing evidence; old Saved originals do not acquire trusted capture details retroactively. |
| 5 | People: opt-in local pinned models, reviewed names, merge, separate and rejection on both clients. Date/source/Any/Everyone filters precede pixels and ranking limits; explicit batches contain at most 500 pending photos and reuse current results. | Held-out identity quality and cross-device reviewed-name acceptance. Isolated browser inference passes; physical Safari still needs qualification. Separate portraits or similar places must not imply shared attendance. |
| 6 | Search and Picks: text/date/label search, local visual retrieval, diverse suggestions and explicit incomplete-coverage feedback. Browsing starts at 30 days; all photos and historical date queries stay reachable. | Held-out retrieval and shortlist quality against human choices; cold/warm time to the intended photo. Suggestions cannot silently select, save or delete originals. |
| 7 | Photo delivery and return: thumbnails/previews, owned URL leases, retry, cancellation and bounded native zoom/pan. Browser refresh reuses verified unchanged metadata; an atomic 100 MiB cache ledger avoids ciphertext rescans. | Large-library frame pacing, memory, battery, motion playback and interruptions on supported phones. Full encrypted-catalog first-load hydration remains. Missing derivatives cannot silently download originals. |
| 8 | Organization and accessibility: optional sortable photo tables, observed columns, keyboard navigation across virtualized rows and responsive selection/viewers. iOS Places adapts geographic clusters to zoom, counts available location metadata in the viewport and opens individual photos. | VoiceOver, Dynamic Type, physical gestures and broader hardware/browser acceptance. Geographic clusters are not resolved city identities; physical-device map performance remains unverified. |
| 9 | Share and receive: system original sharing, private invitations, recipient-owned Save and live albums with explicit acceptance and later chosen owned-photo additions. Three-person browser acceptance/contribution/end and Safari original download pass. | Physical share-sheet completion and the family journey on installed devices; first-contact friction and contact convergence. |
| 10 | Optional understanding and operation: preview consent → Gemini review → Keep, encrypted facts, account fences, request caps and audited native artifacts. PR 47 production and internal TestFlight 43 availability are verified; API errors expose bounded operation categories. | Deliberate provider activation and live cost/behavior evidence; physical TestFlight installation. Measure upload/commit failures, quota pressure, orphan allocation and restore behavior without private content in logs. |

These gates qualify the current implementation. Test coverage and a public
fixture exchange do not prove a personal-library journey or a better product.
Current release and build numbers live in [verification](verification.md).
The latest fixes make optional passkeys reachable, preserve password recovery,
keep mounted previews alive, retry failed PhotoKit previews, and stop incomplete
Search/OCR work from claiming a completed empty result. These changes do not
close the physical acceptance gates above. Prioritize the first-phone and
cross-device journey before admitting more features.

## Current boundaries

Native automatic preparation starts with the last 30 days after one explicit
opt-in while the app is open and unlocked. Older initial photos require expansion;
newly observed arrivals are admitted without inventing capture dates. Already scheduled ciphertext uploads may finish in the background.
Existing 10-day Sync anchors preserve their journal and exclusions until explicit
expansion to 30 days. Date and reviewed-People metadata scope heavy processing;
the next batch and unavailable-source retry remain explicit actions.
Browser uploads stay explicit. The logical-original limit is 50 MiB, including
complete Live Photo pairs; account allocation is 10 GiB of ciphertext. Excluded
originals remain visible and are reported as incomplete sync.

Local OCR, pinned visual models, Picks/Best shots, private annotations, photo
locations, confirmed browser Timeline import, optional photo tables and reviewed
local People groups are implemented. Optional Gemini observations are behind
server enablement, bounded work caps and per-photo consent. Locations need
real capture evidence; raw Timeline history and model vectors are not uploaded.
Scene publication remains disabled for older-reader compatibility. Personal
retrieval quality, physical media/background acceptance and large-library
performance remain open.

iOS Info separates observed media/camera details from user labels and reviewed
Fotoro People names. Apple People names are not available through this feature.
Original-file capture details remain bound to the source digest; missing details
on older Saved photos do not trigger an original download or become trusted by
inference. iOS Places starts with capture dates from the last 30 days, with explicit
older/all-date expansion. It uses the permitted device metadata index and loaded
Saved pages, with at most 80 map markers and a nearby photo list. Counts cover
available metadata, not an unloaded Saved catalog. Coordinate clustering works
without reverse geocoding; supplied place names and Apple basemap labels do not
turn a geographic cluster into a verified city or landmark. Physical-device frame
pacing, memory and large-library acceptance remain open.

Live albums have a fixed owner-plus-invitee roster of at most 12, at most 1,000
photos and a 50-accepted-active-albums allowance per account. Pending invitations
do not consume that allowance. Each invited member explicitly accepts before
reading or adding chosen owned Saved photos. Originals are reused, and private
annotation/People facts do not become album search data. Album search currently
uses filenames and dates; richer family/place search stays in the private finder.
Original files retain their embedded metadata, and ending access cannot recall
previous downloads. Cross-trip landmark grouping and automatic attendance are
not implemented.

Current identity is one Fotoro password with protected remembered native access.
An open account can add a passkey; compatible PRF credentials can unlock the
same encrypted account on another device. A returning browser can use one system
request when its cached account, selected credential, public keys and wrapper
salt match fresh server data. Fresh-browser discovery needs two system passkey
requests to discover the account and then evaluate its wrapper salt.
Providers without usable PRF retain the password path. Sign in with Apple is
not delivered. System sharing is the main original-file
route; private invitations require accepted contacts. Contact synchronization
across devices remains open.

The current source fixes Sync checkpoints for excluded changed Photos revisions, obsolete
synced OCR evidence, browser expiration recovery for the same account and local
browser clearing when server logout cannot finish. Returning browsers can unlock
cached encrypted photos through a genuine transport failure without claiming a
server sign-in; failed visual checks no longer claim a successful empty result.
Production browser-reader interruption/reopen tests now cover five media kinds,
while physical qualification remains open. Full-app release audits now
gate archive/export/upload. These changes and their local regression evidence
are recorded in [verification](verification.md). PR 47 production and build 43
availability through the existing internal TestFlight group are verified, including
the 30-day metadata-first follow-up. Physical installation and acceptance remain open.

## Admit later work only with a complete job

Correctable People needs a measured task, naming/merge/split corrections and
permission/deletion fences. Larger originals need bounded staging, durable
resumption, cleanup and exact restore before the size limit changes. Safe cleanup
needs recoverable deletion, undo and convergence before freeing device storage.
Optional cloud AI needs explicit opt-in, a spending bound and a plaintext access
model; current daily request/token caps are not dollar limits. Share extensions,
stories, saved URLs, nearby transfer and public discovery
wait for a specific admitted journey. None is required to qualify the core loop.

For every change: remove obsolete controls as their replacement works, reuse the
existing queue/index/protocol, verify the whole affected task, and retain one
useful next action for incomplete states.
