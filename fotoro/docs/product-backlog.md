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

## Next work, in order

| Order | Work | Complete when |
| --- | --- | --- |
| 1 | Deliver the qualified iPhone build | Distribution signing permits the latest audited full archive to reach TestFlight. Verify Apple processing and the installed version with fresh phone authorization. Web deployment does not qualify this gate. |
| 2 | Qualify first-use and returning setup | Install → allow Photos → see photos → opt in once → pause/resume → open Saved in Safari works with a fresh private account and a remembered account. Record actions and failures; fix observed friction before expanding setup. |
| 3 | Qualify original recovery | Restore byte-identical JPEG/PNG/HEIC, supported video and complete Live Photo resources across an interrupted transfer and relaunch. Keep the current logical-original limit until bounded recovery is qualified. |
| 4 | Make the first Search useful | Evaluate supported date, text and visual queries on a held-out corpus. Separate unavailable previews, unfinished indexing and real empty answers; record cold and warm time to the intended photo. |
| 5 | Make Picks worth opening | Evaluate useful variety and burst representatives against human choices. Every original remains reachable; suggestions do not silently change selection, save or delete. |
| 6 | Qualify the easiest Share | Exercise physical system sharing from local and Saved originals. Test a two-person private invitation through sign-in, opening and recipient Save. Record first-contact friction and simplify the observed failure. |
| 7 | Qualify coming back | Repeat the loop after backgrounding, offline use, expiration, explicit lock and reconnect. Preserve Pause and unsent edits; stale account, service or source work cannot publish into a new context. |
| 8 | Operate the Cloudflare foundation | Measure upload/commit failures, quota pressure, orphan allocation and restore behavior without private content in logs. Use the [Cloudflare path](cloudflare.md) for bounded larger-original recovery and server-owned work only when admitted here. |

These gates qualify the current implementation. Test coverage and a public
fixture exchange do not prove a personal-library journey or a better product.
Current release and build numbers live in [verification](verification.md).

## Current boundaries

Native automatic preparation follows one explicit opt-in while the app is open
and unlocked. Already scheduled ciphertext uploads may finish in the background.
Browser uploads stay explicit. The logical-original limit is 50 MiB, including
complete Live Photo pairs; account allocation is 10 GiB of ciphertext. Excluded
originals remain visible and are reported as incomplete sync.

Local OCR, pinned visual models, Picks/Best shots, private annotations, photo
locations and confirmed browser Timeline import are implemented. Locations need
real capture evidence; raw Timeline history and model vectors are not uploaded.
Scene publication remains disabled for older-reader compatibility. Personal
retrieval quality, physical media/background acceptance and large-library
performance remain open.

Current identity is one Fotoro password with protected remembered native access.
Sign in with Apple is not delivered. System sharing is the main original-file
route; private invitations require accepted contacts. Contact synchronization
across devices remains open.

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
