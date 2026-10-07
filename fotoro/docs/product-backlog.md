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
| 1 | First photos and access: local photos before an account; password and optional passkey entry continue a chosen Save or Sync. | Fresh iPhone → allow Photos → browse → opt in once → open the same Saved photos in Safari. Qualify real PRF passkeys on iPhone, Safari and Mac; Sign in with Apple is not implemented. |
| 2 | Sync intake: durable last-10-days initial scope, explicit expansion, Pause, retry and account/source fences. | Physical background, relaunch, offline reconnect, changed permissions and edited/iCloud assets. Already scheduled ciphertext may finish in the background; new preparation needs the open, unlocked app. |
| 3 | Original recovery: encrypted JPEG/PNG/HEIC, supported video and complete Live Photo resources, bounded staging and byte verification. | Cross-device physical restore after an interrupted transfer and relaunch. Keep the 50 MiB logical-original limit until larger-original recovery is qualified. |
| 4 | Photo evidence: OCR, EXIF dates, observed locations, supplied labels and current revision bindings. Saved OCR now follows its consumer display ID. | Personal-library OCR/metadata coverage, correction and location acceptance. No invented date or location for missing evidence. |
| 5 | People: opt-in local pinned models, reviewed names, merge, separate and rejection on both clients. | Held-out identity quality, Safari inference and cross-device reviewed-name acceptance. |
| 6 | Search and Picks: text/date/label search, local visual retrieval, diverse suggestions and explicit incomplete-coverage feedback. | Held-out retrieval and shortlist quality against human choices; cold/warm time to the intended photo. Suggestions cannot silently select, save or delete originals. |
| 7 | Photo delivery and return: thumbnails/previews for browsing, owned URL leases, preview retry, cancellation and bounded native zoom/pan. | Large-library frame pacing, memory, battery, motion playback and interruptions on supported phones. Missing derivatives cannot silently download originals. |
| 8 | Organization and accessibility: optional sortable photo tables, observed columns, keyboard navigation across virtualized rows and responsive selection/viewers. | VoiceOver, Dynamic Type, physical gestures and broader hardware/browser acceptance. |
| 9 | Share and receive: system original sharing, private invitations and recipient-owned Save. | Physical share-sheet completion and a two-person invitation through sign-in, opening and Save; first-contact friction and contact convergence. |
| 10 | Optional understanding and operation: preview consent → Gemini review → Keep, encrypted facts, account fences, request caps and audited native release artifacts. | Deliberate provider activation and live cost/behavior evidence; current TestFlight installation and production release. Measure upload/commit failures, quota pressure, orphan allocation and restore behavior without private content in logs. |

These gates qualify the current implementation. Test coverage and a public
fixture exchange do not prove a personal-library journey or a better product.
Current release and build numbers live in [verification](verification.md).
The latest fixes make optional passkeys reachable, preserve password recovery,
keep mounted previews alive, retry failed PhotoKit previews, and stop incomplete
Search/OCR work from claiming a completed empty result. These changes do not
close the physical acceptance gates above. Prioritize the first-phone and
cross-device journey before admitting more features.

## Current boundaries

Native automatic preparation starts with the last 10 days after one explicit
opt-in while the app is open and unlocked. Older initial photos require expansion;
newly observed arrivals are admitted without inventing capture dates. Already scheduled ciphertext uploads may finish in the background.
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

Current identity is one Fotoro password with protected remembered native access.
An open account can add a passkey; compatible PRF credentials can unlock the
same encrypted account on another device. A fresh device may need two system
passkey assertions to discover the account and then evaluate its wrapper salt.
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
are recorded in [verification](verification.md); they do not close the physical
acceptance or distribution-signing gates above.

## Admit later work only with a complete job

Correctable People needs a measured task, naming/merge/split corrections and
permission/deletion fences. Larger originals need bounded staging, durable
resumption, cleanup and exact restore before the size limit changes. Safe cleanup
needs recoverable deletion, undo and convergence before freeing device storage.
Optional cloud AI needs explicit opt-in, a spending bound and a plaintext access
model. Share extensions, stories, saved URLs, nearby transfer and public discovery
wait for a specific admitted journey. None is required to qualify the core loop.

For every change: remove obsolete controls as their replacement works, reuse the
existing queue/index/protocol, verify the whole affected task, and retain one
useful next action for incomplete states.
