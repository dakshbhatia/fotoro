# Verification — October 5, 2026

This is the current evidence record. [The backlog](product-backlog.md) owns next
work; [product](product.md) owns the intended experience. Earlier measurements and
release checkpoints are preserved in the [historical appendix](history/verification-through-pr38.md).
No speed, accuracy, cost or adoption claim is inferred from a passing smoke test.

## Qualified source and live web

[PR 39](https://github.com/dakshbhatia/fotoro/pull/39) merged as
`bf86e7c3a3519e2f66bd20ad130ef735d18183ab`. Its exact checked head was
`fa608d11fba4e66efc6db8d1b22008bcb7676913`; [CI run 37343396881](https://github.com/dakshbhatia/fotoro/actions/runs/37343396881)
completed with all 23 reported checks successful or skipped, including successful
Fotoro web/API and full/preview iOS jobs. Independent review found no material issue.

The active Worker is `a62846b6-f045-40e4-b809-acc6daaac32d`, deployment
`76470ad4-8565-43d5-b302-94898074ddf6`, at 100%. All 36 served asset digests match
the qualified production build. HTTPS service routes and the exact Apple app
association pass readback. A fresh production browser check passes the 390-pixel
entry, account focus and Back path without unexpected JavaScript errors or
production account writes. [Deployment](deployment.md) owns release commands.
Documentation-only changes leave this runtime checkpoint unchanged.

## What this iteration verifies

The three-S simplification preserves an explicit Turn on sync choice through
account entry, bound to the selected service, account and unlocked catalog.
Opening Sync status alone remains read-only. Healthy Sync omits repeated detail,
provides View synced photos and keeps Pause reachable. Rare disable and sharing
options stay under disclosures. Web search stays visible; Clear retains focus.
A prepared invitation presents Send photos for its fixed recipient and selection;
Choose another person resets the invitation before a new grant.

The consent regression fails when authorization overwrites the service selected
before sign-in, then passes with the origin fence. Local full native verification
passes 364 of 365 tests; preview passes 112 of 113, each with the existing Vision
inference-context skip and no failures. Core/release checks, all 70 API and 397
web tests, typechecks and the production build pass. No backend, account protocol
or model change is introduced by PR 39.

Rendered verification uses Playwright with ephemeral headless Google Chrome.
Two disposable loopback accounts and a public Singapore photo exercise real
encrypted D1/R2 storage. Local and Saved search stay visible and retain focus after
Clear. Saved fits 320×568, 390×844 and 1280×720 without horizontal overflow.
Prepared sharing hides creation controls, retains the recipient, resets deliberately
and creates a new grant only after another explicit Share choice. Send photos
invokes browser sharing with the prepared link. No unexpected page or console
errors occur; completion of the OS share sheet is not asserted.

The browser startup graph measures 392,090 JavaScript bytes across four chunks,
below the 500 KiB budget. Account crypto and visual inference remain deferred.
Pinned-model public-image smoke checks exercise real inference; they do not
establish held-out search quality or physical-device latency, memory or battery use.

## iPhone and distribution

Build 36 archives with all 42 Swift sources, 69 native inputs, matching arm64 dSYM,
production associations and unchanged full static encryption. The archive source
is `d32e490f2d7f96ca0c47103432609e57c05b4433`; all native inputs match the qualified
PR 39 source. It is development-signed, not a newly uploaded TestFlight build.

Build 25 remains the latest verified internal TestFlight build (`VALID`,
`IN_BETA_TESTING`). Build 21 is the last verified physical-phone launch checkpoint.
The latest distribution preflight reports no available Apple Distribution identity.
Individual API access is verified for build metadata; provisioning/signing and a
fresh TestFlight install remain open. No external TestFlight invitation is qualified.
First App Store publication excludes France, as approved by the owner.

Release proof is kept outside Git under the protected `three-s-simple-d32e490`
record: source inputs, archive audit, exact-head CI, merge proof, asset digests,
Worker traffic readback and browser/service checks. Credentials and private account
data are excluded from repository documentation.

## Limits and acceptance still open

- Logical originals remain bounded to 50 MiB, including a complete Live Photo pair.
  Camera media within that bound is supported; oversized originals need qualified
  streaming/recovery work before raising it.
- Account allowance is 10 GiB of reserved/stored ciphertext. Client original-byte
  summaries are a different quantity. Final-object cleanup and disaster recovery
  are not fully qualified; do not promise reclaimed space.
- Automatic native Sync requires opt-in and foreground/unlocked preparation. iOS
  can finish scheduled ciphertext PUTs; this is not continuous locked-phone backup.
  Browser uploads stay explicit.
- Search, picks, photo GPS and confirmed Timeline imports operate locally. Named
  people and cross-device contact sync are open. Scene publication remains disabled
  for reader compatibility. Local vectors and raw Timeline imports do not upload.
- Full first-use/returning-account acceptance, two-person sharing completion,
  interruption/relaunch restoration, accessibility and realistic library performance
  still need physical-device evidence. Apple ID login is not delivered.

A public fixture, a synthetic 10,000-item index or a simulator pass does not prove
that Fotoro is ten times better than an alternative. Compare the same real tasks
and libraries using [the comparison protocol](competitive-baseline.md).
