# Verification — October 1, 2026

The local development slice works. It has not been deployed publicly or released
through TestFlight. Independent reviews reproduced defects, fixes added permanent
regressions, and the implemented scope was re-reviewed.

| Check                                   | Evidence                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts, crypto and loopback fixtures | 10 tests; HEIC and PhotoKit date schema boundaries, signature/binding failures, original preservation, independent saves and retry behavior                                                                                                                                               |
| Worker/D1/R2 API                        | 20 tests; real cryptographic WebAuthn ceremony, challenge replay, recovery, upload crash reconciliation, capability renewal, retained objects, grants and saves                                                                                                                           |
| Web                                     | 32 tests; exchange/local cache policies plus coalesced sync, account fences, sequential staging, failed-first-source halt and public legacy queue no-network guard                                                                                                                        |
| Web production build                    | TypeScript and Vite pass; local entry 264.7kB (82.8kB gzip); cloud/libsodium loads only after Sync photos; large cloud chunk warning remains                                                                                                                                              |
| Native                                  | 27 tests pass; source checkpoints, stable identity, pending digest reuse, cancellation, HEIC preservation, public-account boundaries and moved-sandbox paths; Debug and Release builds pass                                                                                               |
| Cross-language media                    | Swift decrypts frozen TS vectors; TS decrypts checked-in Swift-produced ciphertext and rejects altered binding                                                                                                                                                                            |
| Real local HTTP exchange                | 2 tests pass: isolated fresh migrations + recovery sessions + both-way contribute/save + revocation + clean restore; real HEIC upload/fresh-session restore preserves bytes, extension and digest                                                                                         |
| Actual web UI                           | Import, viewer, share, manual account-card pinning, receive, digest-verified save, lock and sign-out exercised in the in-app browser; real local Worker recovery/session restored the library at localhost, and an interrupted browser import committed after reload/new-session recovery |
| Actual native UI                        | Simulator onboarding/status/public-account guard captured; decoded square cloud grid restores after sandbox relocation; installed local Photos canvas left open. Prior viewer/exchange and Keychain relaunch checks passed                                                                |
| Local-only entry                        | Reviewed: no API/account/fixture-key initialization before explicitly opening Sync photos; no automatic local-photo uploads                                                                                                                                                               |
| Browser sync UI                         | Actual mobile-width setup, real local Worker recovery, status and public-account upload block exercised; all three public local file selections survive setup and return to the canvas                                                                                                    |
| Actual local browser UI                 | Public JPEG files selected in the in-app browser; thumbnails, filename search, paging/details and viewer exercised. Safari's native chooser, raster decode and viewer also exercised                                                                                                      |
| Actual local Photos UI                  | Open Photos triggered the genuine OS permission prompt, then rendered public sample assets from Simulator Photos; no personal library tested                                                                                                                                              |
| Native local policies                   | 4 tests pass: 30-day boundary, authorized/limited access, actual metadata search facts, and current/neighbor viewer bounds                                                                                                                                                                |

Screenshots: [web library](../apps/web/Evidence/library.jpg),
[native library](../apps/ios/Evidence/library.png),
[native viewer](../apps/ios/Evidence/viewer.png).
Local trial: [web](../apps/web/Evidence/local-trial.jpg),
[native](../apps/ios/Evidence/local-trial-photos.png). Sync status:
[browser](../apps/web/Evidence/sync-status-mobile.jpg),
[native](../apps/ios/Evidence/sync-status.png).
All shown photos are public samples.

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

Native local browsing supports system-rendered HEIC and Live Photo still previews.
Native cloud imports preserve JPEG/PNG/HEIC originals up to 50 MiB; thumbnail and
preview copies are 320/1600 px JPEG at quality 82%. Backup visibly skips Live Photo
motion pairs and videos. Native sync runs while active/unlocked; Safari refreshes
its account while the cloud view is visible/online. Browser imports accept JPEG/PNG.
Browser local decoding skips unknown dimensions (including current HEIC metadata) before decode. The 48MiB web budget
bounds generated raster caches, not total browser or transient decoder memory.

Video, OCR/AI indexing, face grouping, semantic search, cleanup and nearby transfer
are outside this slice. Production auth rejects fixture headers; production web
builds disable fixture mode. Browser local selections are session-only, while the
cloud catalog uses evictable browser storage.
