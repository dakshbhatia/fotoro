# Following an action through Fotoro

Client diagnostics describe what happened, without storing photo content or personal
metadata. An ephemeral `traceId` links a sign-in, Sync or sharing action to its API
requests. Each server request also gets an independent `requestId`, returned in
`X-Request-Id` on success and failure. Error JSON uses that same request reference.
Neither ID grants access to anything.

## Get a report

- iPhone: open **Sync → Diagnostics → Copy diagnostics** or **Share diagnostics**.
  The local history persists across app launches, capped at 160 events and 64 KiB.
  This control is available from TestFlight 0.1.0 (45).
- Browser: open Settings in Photos or Saved, then **Copy diagnostics**. If clipboard
  access fails, select the displayed report. This source change retains up to 128
  sanitized events in tab-session storage across reloads (64 KiB input cap).
  Writes share a 250 ms window and flush on pagehide/hidden. Closing the tab ends
  retention; denied/quota-limited storage falls back to memory. **Clear diagnostics**
  and manual sign-out clear retained history and fence late operations. An expired
  session preserves troubleshooting history. There is no automatic upload.
- Server: from `fotoro/services/api/`, use `pnpm exec wrangler tail --env production
  --format json`. Reproduce the action, then stop the tail. Raw Wrangler envelopes
  can contain request URLs and capabilities; retain them privately, never paste
  the raw envelope into an issue or chat. The Fotoro console event itself excludes
  those values. A connected banner does not prove a reproduced request arrived;
  match its trace/request references, and reproduce again if the first event is
  absent. Historical logs require separate observability access.

Save the copied client JSON and private server tail locally, then from `fotoro/`:

```sh
node tools/diagnostics.mjs client.json server.private.jsonl
node tools/diagnostics.mjs --json client.json server.private.jsonl
```

The reader accepts client JSON/JSONL and Wrangler JSON envelopes. It reconstructs
reports from fixed fields, ignores raw envelopes and unknown values, and limits
input size and event counts. Output shows action outcomes, timings, failures,
available last-completed steps, and matched client/server request references.
It never prints input filenames or parser error text.

## Current understanding and gaps (October 15)

The released build-80 checkpoint contains bounded action/request diagnostics.
These explain observed requests and interrupted stages; they do not establish
complete indexing or a healthy personal library. Build 80's browser history
disappears on reload; this change adds the bounded tab-session retention above.
Native history is a short ring, not a full session archive. Historical
production log access has not been established with the current credentials.

The last retained physical build-78 audit counted 21,481 local catalog records,
2,466 with completed OCR and 19,015 unchecked. That is about 11.5% OCR coverage,
not text-recognition accuracy. Its catalog query samples had a 46 ms median and
59 ms maximum; action samples had a 100.5 ms median and 111 ms maximum. These
measure different boundaries and are not full UI-to-result latency percentiles.
The user reported fast results but weak relevance. Builds 79/80 and the library's
current coverage have not been qualified on physical hardware; phone use is paused.

Restricting that retained catalog to the latest ten calendar days (October 6–15,
America/New_York) yields 218 photos: all 218 have completed OCR, visual
classification and current semantic vectors. This supports a smaller experiment;
it does not score recognition or relevance and does not refresh phone state.

This source change adds an **export-time local index snapshot** to native Copy/
Share diagnostics. It is not present in build 80. Each stage (OCR, visual,
semantic) reports whole permitted local Photos catalog counts: total, complete,
pending, failed, unavailable, deferred, model-deferred and the next future retry
delay. Failed/unavailable are separate from pending; deferred overlaps unfinished
states. Completed OCR includes photos with no recognized text. Saved/web indexing
is a separate catalog and is not included. The count follows the local scheduler's
catalog, including Fotoro Trash entries still present in that catalog.

The snapshot reports scheduler activity (not ready, inactive, interacting, waiting
for idle, running, retry scheduled or idle). These are observed states, not a
diagnosis: idle does not mean complete and a retry timer does not prove a source
will become available. The reader shows build and snapshot age without printing
absolute timestamps. A changed/withdrawn source generation discards all coverage
from the unfinished read. Catalog and selected-window counts run off the UI actor
in read transactions only when explicitly exporting; they are not queried
per keystroke or polled. Whole-catalog and automatic-window coverage stay separate.
Export snapshots do not replace the persisted action history.

Automatic heavy analysis starts with **Latest 10 days** for this iteration. The
Photo analysis range control can explicitly expand to **All photos**; the choice
persists on the device. Existing metadata, completed OCR and older search results
remain available. The original-backup date horizon and Pause remain independent.
Debug runs may pin the experiment with `FOTORO_ANALYSIS_WINDOW_DAYS=10`.

Each stage now persists aggregate last-attempt and last-completed-commit times
alongside the index. Exports contain their ages, not photo identifiers or text.
An older index starts with unknown progress ages; retries do not invent completed
work. Clearing the permitted catalog clears these aggregates. Progress ages are
for the stage in this index, including work outside the selected automatic window.
The reader flags `no_recent_checkpoint` only for an active unfinished run lasting
at least 60 seconds without a recent durable attempt. A long preview/model/
inference wait can explain this signal; it is not proof of a stall or permission
to retry, upload or delete anything. There is no new polling or alert service.

The same export includes the cached Sync UI projection (state, reason, account
state, completed/total/skipped counts and last server-check age when known).
Exporting does not start Sync, read originals or make network requests. Unknown
last-check age stays unknown; a freshly exported cached state is not a fresh
server verification or proof that another device can see a change. Last-check
age is measured at capture; the reader separately reports the export's age.

Still missing: a verified historical server query path, a complete event archive,
an end-to-end latency distribution, held-out personal retrieval scoring, and
physical second-device/performance acceptance. Independent browser clients pass
the public-fixture rename/screenshot/Trash/Restore/reload/original-byte journey;
that does not qualify installed-phone behavior. No automatic diagnostic upload
or alerting is implied by this report.

The remaining acceptance order is: measure current coverage and its waiting
reasons; verify OCR continues through idle/resume and finishes without starving
search; score expected results on representative personal searches; verify an
edit/name/screenshot correction and Trash/Restore on a second device; then measure
physical launch, scrolling, memory and battery cost. Until those pass, describe
the product as partially qualified, rather than fully working end to end.

## What the events establish

Native actions record start, terminal outcome, last completed step where available,
counts and fixed waiting/failure reasons. Sync state changes distinguish signed out,
locked, permission required, paused, offline, pending transfers/annotations and retry.
Metadata/OCR/people work records batch counts rather than names, pixels or asset IDs.
Native background PUTs remain independent of foreground action traces; reattachment
and Sync state reports provide their aggregate status.

Native search UI traces begin only when query work is admitted after debounce;
their monotonic elapsed clock includes that debounce. `rowsReady` records current
text-result publication before optional visual enrichment. `uiPreview` completes
when the first matching thumbnail has an image available to a scroll-visible
result view, after current query/account/source and visibility checks. Cached or
degraded usable images count; placeholders do not. A final empty result closes
with `noMatches` and no successful preview. Zero text rows wait for enrichment;
failed enrichment closes as failed, not as an invented empty success. One aggregate
preview-unavailable notice may precede a later successful image. Query replacement,
source/account withdrawal, leaving results and suspension cancel outstanding traces.
The query task can finish normally while image readiness remains pending.

These are bounded UI readiness events, not per-tile logs. They do not establish
physical frame presentation, occlusion, dropped frames, scrolling smoothness or FPS.
Scroll visibility is the framework's thumbnail-rectangle threshold. Older search
events that end at the catalog engine cannot establish UI preview latency. The
diagnostics report keeps row readiness and preview readiness separate.

Browser actions identify passkey/password entry, refresh/save, album membership and
contributions, sharing and original preparation. Concurrent actions use explicit
contexts. Successful request detail is limited to 12 per action, with a terminal
request count; failures remain visible within the bounded history. JSON decoding
and wire validation must complete before a client request is marked successful.

Local browser import, visual search and OCR also record scan, preview transfer,
model preparation and analysis waits. Successful stage detail is limited to six
stages per action. Terminal counts describe completed photos for these local
operations; skipped previews, failed recognition and cancelled work do not claim
successful completion. Stage events retain no filenames, queries or recognized text.

The server emits one compact final `api.request` or `api.error` per `/v1/*` request.
Fields include fixed method/area/phase, status, outcome, bounded elapsed time and,
for failures, an allowlisted code and class. Staging and commit have distinct phases.
Server timing ends when the response is ready; it does not prove a streamed body
finished transferring or that a client restored and verified an original. Static
assets do not generate these events. Invocation logging remains disabled.

A missing terminal event can reflect an evicted/truncated window, an action still
running or app termination. A missing server match can reflect the tail window or
an older client. Neither proves lost photos. A 200 response alone does not establish
successful client decode, verification, catalog publication or cross-device visibility.

## Privacy boundary

No photo/account/device identifiers, person names, queries, OCR text, GPS/EXIF,
URLs/fragments/capabilities, keys, passwords, cookies, bearer tokens, payloads or raw
errors enter client events or Fotoro server diagnostics. IDs identify temporary
actions and requests only. Client reports stay local until the user copies/shares
them; there is no automatic diagnostic upload. Counts and timings are bounded.
New labels must be closed enums and new fields must pass the privacy tests.

## Historical evidence: October 8 released diagnostics

PR 49 qualified head `072cfa99d0f864c87cb8ed4132623efcd4274398` completed all
23 checks (eight success, 15 intentional skips). Guarded merge
`601bd3fab6cc964996c4ee3b0db427e04361044f` has the same tree. Production Worker
`850dabd0-5603-49a0-9330-28c98fede807` serves 100%. A deliberate read-only 401
probe's client trace and response/body request reference matched one final live
`api.error` event, including method, status, phase, class and duration. Earlier
capture attempts missed their probe; the successful capture matched the second
of two fresh probes. This proves that observed correlation, without assigning a
cause to the earlier misses or claiming historical log access.

Apple independently reports build 45 `VALID` and `IN_BETA_TESTING`, with the same
existing internal group and tester. Production Settings renders Copy diagnostics
and its copied notice without console errors. Local desktop/mobile checks and
native export regressions pass. The native toolbar is visible in the Simulator;
its menu handoff and physical installation still require device acceptance.

## Readback before this update

- Apple independently reports build 44 `VALID` and `IN_BETA_TESTING`.
- At that checkpoint, production served PR 48 Worker
  `ba359106-30ac-4ac2-8f6a-0523c523a95a` at 100%.
- The available Simulator ring contains 160 events from build 40, including three
  upload 409s. Those are older local observations, not current physical-phone proof.
- The physical-phone diagnostic read failed because the device connection reset.
  The current OAuth session could connect a live Worker tail and observe an
  intentional read-only unauthenticated probe (401); historical observability query
  access returned 403. No claim about earlier personal sessions follows from that.

Remaining product and physical acceptance work is tracked in
[the foundation queue](product-backlog.md), and release availability in
[deployment](deployment.md). Diagnostics make those journeys inspectable; they do
not replace a real iPhone → Safari → family member → second iPhone acceptance run.
