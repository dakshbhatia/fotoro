# Verification — October 1, 2026

The local development slice works. It has not been deployed publicly or released
through TestFlight. Independent reviews reproduced defects, fixes added permanent
regressions, and the implemented scope was re-reviewed.

| Check | Evidence |
| --- | --- |
| Contracts, crypto and loopback fixtures | 9 tests; signature/binding failures, original preservation, independent saves and retry behavior |
| Worker/D1/R2 API | 20 tests; real cryptographic WebAuthn ceremony, challenge replay, recovery, upload crash reconciliation, capability renewal, retained objects, grants and saves |
| Web | 13 tests; quota/transaction failures, encrypted staging, lock/key clearing, exact save retries, delayed account-switch sync, native device-proof interoperability, sign-out and upload origin guards |
| Web production build | TypeScript and Vite pass; large libsodium bundle warning remains |
| Native | 11 tests pass; saved-copy contribution/reshare regression also passes; Debug and Release builds pass |
| Cross-language media | Swift decrypts frozen TS vectors; TS decrypts checked-in Swift-produced ciphertext and rejects altered binding |
| Real local HTTP exchange | Isolated fresh migrations + recovery sessions + encrypted upload + both-way contribute/save + revocation + clean restore; original bytes/digests match |
| Actual web UI | Import, viewer, share, manual account-card pinning, receive, digest-verified save, lock and sign-out exercised in the in-app browser; real local Worker recovery/session restored the library at localhost, and an interrupted browser import committed after reload/new-session recovery |
| Actual native UI | Simulator locked/library/viewer/exchange screens captured; restored preview displayed and local Keychain relaunch checked |

Screenshots: [web library](../apps/web/Evidence/library.jpg),
[native library](../apps/ios/Evidence/library.png),
[native viewer](../apps/ios/Evidence/viewer.png).

The Node HTTP exchange test exercises the service and shared web crypto, while
native tests exercise Swift against fixtures and real recovery/device-approval
routes. This is not a claim of a complete physical iPhone-to-Safari acceptance run.

## Remaining release gates

- Cloudflare account access, distinct production D1/R2 bindings, HTTPS and domain
  routing; Apple signing and associated domains.
- Physical passkey/PRF and non-PRF flows, original PhotoKit/iCloud resources and
  native background scheduling. Transfer journals are durable; a production
  background scheduler is not implemented.
- A 10,000-item dataset with 1,000 distinct thumbnails and measured library,
  frame pacing, memory and battery targets on an older supported iPhone and
  Safari. No performance acceptance is claimed from this small fixture.
- Final-object garbage collection and deletion/retention races. Final ciphertext
  is retained conservatively; abandoned staging/final objects can consume storage.
- Native camera QR scanning and credential-management UI are not implemented.

HEIC, Live Photos, video, AI indexing, face grouping, semantic search, cleanup and
nearby transfer are outside this slice. Production auth rejects fixture headers;
production web builds disable fixture mode. Browser storage remains evictable.
