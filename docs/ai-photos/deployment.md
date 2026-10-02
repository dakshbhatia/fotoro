# Fotoro hosting and next ten improvements

Decision recorded September 30, 2026. This is a proposed deployment, not an
already provisioned service.

## What exists

Code: [dakshbhatia/fotoro, codex/ai-photos](https://github.com/dakshbhatia/fotoro/tree/codex/ai-photos).
The fork retains Flutter mobile, React web, Go Museum, Postgres, and Ente's
encrypted storage and transfer mechanisms.

The new `/intelligence` web flow has selected-file import, EXIF extraction,
SHA-256 exact-duplicate review, lexical search, optional Gemini 3.8 enrichment,
and a PhotoSwipe carousel with zoom and contextual details. Its files and index
are session-only. It is not connected to account backup or encrypted index sync.
No paid model requests have been tested with a real key.

Unsigned iOS device/Simulator builds and iOS 27 Simulator startup were verified
in the preceding implementation pass. The new glass UI has not been ported to
native. Primary passkey unlock, new face/search indexing, trusted-contact grants,
nearby transfer, physical-device performance, and TestFlight remain unfinished.

## Recommended beta deployment

| Component | Host | Reason |
| --- | --- | --- |
| Photos, Accounts, and public Albums frontends | Cloudflare Workers Static Assets | The checked-in Next configuration uses `output: "export"`; serve production exports globally. |
| Museum API and Postgres | One Hetzner x86 VM, Docker Compose, Caddy | Runs the existing Go/database stack with few changes. Keep Postgres private. |
| Encrypted originals, thumbnails, and synced indexes | Private R2 Standard buckets through Ente's S3 adapter | Clients transfer directly using Museum's presigned URLs. Keep bucket credentials on the server. |
| Local OCR, faces, and embeddings | Supported client devices | Keep expensive indexing out of the browse path and preserve local-first operation. |
| Optional Gemini enrichment | Authenticated Museum extension with quotas | Keep shared paid keys out of the static frontend; send explicitly opted-in, stripped previews. |

This is the shortest path for this codebase, rather than a general claim that
VPS hosting beats every serverless option. Ordinary Workers do not host the
existing Go server and Postgres as-is. Cloudflare Containers can host Linux
images, but their disks are ephemeral by default and the durable database and
container lifecycle still need a deliberate design. That is additional work
for the first beta. [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/).

R2 stores ciphertext and does not resize images or transcode video. Start with
Ente's existing derivative and encrypted playback paths. Add a video platform
only when a measured playback requirement warrants provider-readable media.

### Current price references

An EU CX23 is listed at **$6.49/month** before IPv4 and VAT; an EU CX33 at
**$9.99/month**, with 4 shared vCPUs, 8 GB RAM, and 80 GB disk. Choose CX33 for
beta headroom when available; CX23 can be a smaller initial test host. These
are EU plans, not an Ashburn quote. Confirm stock and the final total in the
console before ordering. [Current price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/),
[instance specifications](https://www.hetzner.com/cloud/cost-optimized/).

Static asset requests are free and unlimited under the standard serving path;
the optional Workers Paid plan starts at $5/month. A static-only deployment
does not require a paid Worker relay. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

R2 Standard is **$0.015/GB-month**, with 10 GB-month free per account, operation
allowances, and free direct internet egress. If the free allowance is unused,
100 GB held for a full month costs **$1.35** for storage; 1,000 GB costs
**$14.85**. Include originals, derivatives, and recovery copies in the volume.
Operations above allowances, VM/IP/tax, database backups, domain, email, and
AI are additional. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

### Deploy in this order

1. Keep local development on the existing wrapper and loopback Docker stack.
   Build the web production export from the published fork and deploy a clearly
   marked session-only preview to Cloudflare first.
2. The intended domain is `fotoro.cloud`. Proposed origins: `fotoro.cloud` for
   Photos, `api.fotoro.cloud` for Museum, `accounts.fotoro.cloud` for Accounts,
   and `albums.fotoro.cloud` for Albums. Ownership, DNS, TLS, and provider access
   have not been established. Configure consistent origins before passkey enrollment.
3. Provision the VM only after region and budget are chosen. Deploy pinned Museum
   and Postgres images with Caddy, persistent database storage, SMTP, private
   database access, and separately stored production secrets. Do not expose the
   local quickstart or its example configuration directly.
4. Configure private R2 buckets and browser CORS. Prove original upload/download
   digests, interruption recovery, multipart video uploads, range requests, and
   HEIC/Live Photo behavior with disposable fixtures. Ente already uses direct
   client uploads through Museum-issued presigned URLs.
   [Object storage](https://ente.photos/help/self-hosting/administration/object-storage).
5. Connect the new canvas and index to the authenticated Ente catalog. Test the
   same library on iPhone and web, including refresh, offline use, and resuming
   sync. Public hosting alone does not make the new preview a backup service.
6. Before relying on it for personal photos, back up database and configuration
   separately from media and restore to a clean instance. Object storage without
   the encrypted key/catalog database is insufficient to recover the library.
   [Ente backup requirements](https://ente.com/help/self-hosting/administration/backup).
7. Build tagged releases from GitHub, keep a previous deployable image/export,
   and add only actionable uptime, storage, and backup-failure monitoring. Sign
   the iOS app and verify physical-device background transfers before TestFlight.

No server, bucket, domain, billing subscription, or public app has been created
by this plan. Provider access and the desired domain/region are still needed.

## Outside-perspective audit

Current-run screenshots were captured and inspected for the library, a
`singapore` search, and the settled full-screen viewer. Four public repository
fixtures were used. The library has a clear photo-first hierarchy and a quiet
glass dock; the search narrows correctly and the viewer preserves the original
image composition. Search currently depends on indexed words rather than query
understanding. The largest trust gap is that the attractive library is still
temporary, as its visible "Local preview · not backed up" label states.

This bounded audit does not establish real-library speed, physical gesture feel,
screen-reader behavior, or production backup reliability. Recommendations below
include missing product capabilities as well as small presentation changes.

## Ten changes, in priority order

1. **Remember my library.** Persist the encrypted catalog/index and rebuildable
   thumbnail cache; reopening should return to the same photos and position.
2. **Make backup trustworthy.** One quiet sync status with useful failure/retry
   detail; mark a file backed up only after the server verifies its upload.
3. **Make import effortless.** Show the first thumbnail immediately, finish work
   asynchronously, and let users pause or cancel a large import.
4. **Give photos time context.** Group by capture date, preserve chronological
   order, and offer one density adjustment for browsing versus reminiscing.
5. **Make search understand the request.** Combine text/OCR, people, dates, and
   semantic retrieval; display local results before optional enrichment completes.
6. **Give people names.** Reuse local face grouping with rename, merge, split,
   and correction; validate device and web retrieval before promising parity.
7. **Make cleanup a safe decision.** Compare duplicates side by side, choose a
   keeper, verify originals are backed up, and provide recoverable trash/undo.
8. **Let a selection do useful work.** Long press or a Select action on touch;
   shift selection on desktop; reveal Share/Album actions only while selected.
9. **Finish the gesture feel.** Preserve scroll/focus, permit immediate dismissal
   during transitions, prefetch adjacent media, and port the experience to native
   with appropriate haptics. Keep keyboard focus visible and motion optional.
10. **Make trusted sharing one clear flow.** Pick photos, pick a known recipient,
    show delivered confirmation. Family grants persist; friends' 15-minute
    windows govern new receipt, not deletion of copies already received.

Start with persistence and the truthful sync state. Then improve import,
selection, and search against a fixed fixture library before widening scope.
