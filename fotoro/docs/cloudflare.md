# Cloudflare path

The product stays simple: Sync, Search and Share. Cloudflare carries encrypted
storage, account authorization and delivery behind that interface. Reliability,
restoration and a clear account state matter before a broader platform stack.

## Document map

- [Product](product.md): consumer behavior and boundaries.
- [Product backlog](product-backlog.md): the sole active work queue; phases below
  are prerequisites and direction, not another queue.
- [Foundation](foundation.md): architecture and encryption invariants.
- [Deployment](deployment.md): deployed versions and release status.
- [Verification](verification.md): actual tests, device evidence and remaining gates.

## Implemented now

One Worker serves the web build and authenticated API at `https://fotoro.cloud`,
with D1 for account/session/operation/retention state and private R2 for ciphertext.
Workers supports deploying static assets with API logic as one unit; Fotoro uses
`ASSETS`, SPA fallback and Worker-first routing, excluding API/fixture paths from
fallback. See [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).

Clients encrypt originals, display derivatives and private annotations before
upload. Local native TinyCLIP Core ML/browser TinyCLIP ONNX and OCR process pixels
on the device; vectors never upload. Scene publication is disabled for reader
compatibility. Cloudflare cannot infer scenes, transcode originals or run private
search over ciphertext without keys. Preserve that boundary.

The current identity is one Fotoro password backed by a locally encrypted account
bundle and signing-key proof. Passkeys/device approval remain supported foundations;
Apple ID login is not delivered. Web sessions use secure HttpOnly cookies; native
sessions use hashed opaque bearer tokens. Browser uploads are explicit. Native
automatic Sync requires one-time consent, Photos permission and an open/unlocked
account for preparation; iOS may finish already scheduled ciphertext staging PUTs.

Reservation and commit are account-scoped and idempotent. The ordinary staging PUT
requires a session and scoped capability; native background PUT has only the
expiring capability for one staging object. It cannot commit/publish/read. Commit
hashes observed ciphertext and conditionally promotes it to an immutable final key.
Retry reconciles ambiguous R2/D1 outcomes. The 50 MiB complete-original limit stays;
server reservations have a separate 55 MiB ciphertext cap. Production allowance is
10 GiB of reserved/stored ciphertext; client summaries count logical original bytes.

API diagnostics use fixed phases/classes, status/code, duration and request references;
ephemeral action IDs link client events to requests. See [diagnostics](diagnostics.md)
for collection, bounded summaries and evidence limits.
Worker observability is configured with invocation logging disabled to avoid
capability URLs. Source-photo deletion and final-object GC are not implemented;
expired-staging cleanup is limited, and abandoned finals/superseded staging can
retain storage. Do not promise reclaimed bytes or delete ambiguous retained data.

## Phase 1: measure and harden what exists

Record real Sync failures/retries, restoration integrity, request latency and
Worker CPU, then inspect D1 rows scanned/written and R2 stored bytes/operations
against actual billing. Choose targets from observed demand; there are no measured
product benchmarks or cost forecasts here. Workers exposes health/runtime metrics
and logs; D1 exposes row counts, latency and storage metrics. See
[Workers observability](https://developers.cloudflare.com/workers/observability/) and
[D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).

Keep diagnostic fields bounded and exclude keys, passwords, URLs/capabilities,
queries, photo contents and personal identifiers. Inspect privacy before adding
traces or more telemetry. Qualify account/session expiry, sign-out, account/origin
switches, permission withdrawal, lost receipts and paused/background reconciliation.
Deletion needs an explicit ownership/retention model, tombstones, retry-safe quota
reconciliation and auditable orphan detection before any destructive cleanup.

## Phase 2: qualify bounded larger originals when needed

Keep the current limit until measured user need justifies larger originals and a
bounded implementation passes native/browser/device recovery checks. R2 multipart
can upload parts across Worker invocations; part requests still face Worker body
limits, and multipart state must persist outside the Worker. See
[R2 multipart from Workers](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/).

Persist upload ID, part numbers/ETags, byte/digest expectations, operation identity
and expiry in the account journal/server state. Bound part size, concurrency,
client disk/memory and reserved quota. Test restart, stale capabilities, session
renewal, account/origin changes, duplicate/late parts, completion races, checksum
failure, abort and orphan cleanup. Completed ciphertext still needs immutable
promotion, idempotent catalog publication and client plaintext digest verification.
A larger R2 upload is not proof that the original can be safely restored.

## Phase 3: add background services only for concrete work

Use Queues only when a measured server-owned metadata/ciphertext task needs durable
asynchronous processing, such as audited orphan reconciliation. Keep plaintext
preparation and AI local. Queues delivers at least once, so consumers need durable
idempotency keys, bounded retries, a dead-letter/recovery path and authorization
rechecks before side effects. See
[Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).
Do not add Queues, Durable Objects, Vectorize or Workers AI for stack completeness.

## Tooling

Repository commands still use pinned Wrangler and `wrangler.toml`. Cloudflare's
new `cf` CLI covers the broader API and can delegate existing builds to Wrangler;
a migration is optional maintenance work after local/test/production configuration
parity is proven. It is not a product prerequisite. See the official
[cf launch](https://blog.cloudflare.com/cloudflare-cf-cli-launch/).
