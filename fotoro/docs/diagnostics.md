# Following an action through Fotoro

Client diagnostics describe what happened, without storing photo content or personal
metadata. An ephemeral `traceId` links a sign-in, Sync or sharing action to its API
requests. Each server request also gets an independent `requestId`, returned in
`X-Request-Id` on success and failure. Error JSON uses that same request reference.
Neither ID grants access to anything.

## Get a report

- iPhone: open **Sync → Diagnostics → Copy diagnostics** or **Share diagnostics**.
  The local history persists across app launches, capped at 160 events and 64 KiB.
  This control requires the diagnostics update; TestFlight 44 predates it.
- Browser: open Settings in Photos or Saved, then **Copy diagnostics**. If clipboard
  access fails, select the displayed report. History is in memory, capped at 128
  events; copy it before reloading or closing the tab.
- Server: from `fotoro/services/api/`, use `pnpm exec wrangler tail --env production
  --format json`. Reproduce the action, then stop the tail. Raw Wrangler envelopes
  can contain request URLs and capabilities; retain them privately, never paste
  the raw envelope into an issue or chat. The Fotoro console event itself excludes
  those values. Historical logs require separate observability access.

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

## What the events establish

Native actions record start, terminal outcome, last completed step where available,
counts and fixed waiting/failure reasons. Sync state changes distinguish signed out,
locked, permission required, paused, offline, pending transfers/annotations and retry.
Metadata/OCR/people work records batch counts rather than names, pixels or asset IDs.
Native background PUTs remain independent of foreground action traces; reattachment
and Sync state reports provide their aggregate status.

Browser actions identify passkey/password entry, refresh/save, album membership and
contributions, sharing and original preparation. Concurrent actions use explicit
contexts. Successful request detail is limited to 12 per action, with a terminal
request count; failures remain visible within the bounded history. JSON decoding
and wire validation must complete before a client request is marked successful.

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

## October 8 readback before this update

- Apple independently reports build 44 `VALID` and `IN_BETA_TESTING`.
- Production still serves PR 48 Worker `ba359106-30ac-4ac2-8f6a-0523c523a95a` at 100%.
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
