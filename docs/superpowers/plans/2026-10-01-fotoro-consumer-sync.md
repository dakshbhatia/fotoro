# Fotoro consumer sync implementation

**Goal:** Make private photo sync carry useful search data and expose one understandable consumer status on iOS and Safari.

**Architecture:** Immutable encrypted media plus owner-only encrypted annotation sidecars; signed optimistic revisions and durable client outboxes. iOS background URLSession transfers already encrypted staged files.

**Global constraints:** Preserve source labels verbatim, current retrieval/retention behavior, account/source/generation fences, fixture restrictions and original bytes. No personal search history in sync or annotations in shared grants. No credential or signing-profile workarounds. User BUILD NOW authorization supersedes another design approval stage.

**Review focus:** Atomic conflict handling; idempotent retry; no account/recipient leakage; authenticated ciphertext origin; background reconnect and cancellation; honest release readiness.

1. Root: add bounded shared annotation contracts, failing protocol/security tests, D1 storage and atomic owner-only endpoints/change events. Generate validators and pass contract/API checks.
2. Browser agent: encrypt and sign durable annotations; validate/hydrate catalog changes; pass LocalPhoto digest-bound search data to initial uploads; add cloud labels/text search and consumer status. Test lock/account/source/conflict behavior.
3. Native sync agent: add native wire models/outbox and source binding; integrate local labels/OCR and catalog search; simplify onboarding/status. Test and run Simulator.
4. Background agent: transfer staged ciphertext through background URLSession with durable identities and origin/account checks; reconnect delegate events; integrate journal retry. Test transport lifecycle and build.
5. Root: serve configured Apple association metadata, prepare deployment checks, independently review client/security/lifecycle changes, run combined checks, verify rendered browser flow and native evidence, then report the exact install/deployment state.

## Verified outcome

Implementation and independent review are complete. Core checks pass 11 tests,
API 27, browser 115, native 85, and isolated real HTTP exchange 3. Production web
and unsigned generic-device iOS Release builds pass. Rendered browser onboarding
and receipt retrieval are verified; the current app is installed in Simulator.

Release still requires Cloudflare account/bindings and HTTPS routing, Xcode
account provisioning with an app-specific Associated Domains profile, and a
physical iPhone. The configured public domain currently returns 404 for both
vault and Apple association endpoints. Scheduled encrypted background transfer
is implemented; physical suspension/termination and complete phone-to-Safari
acceptance remain unverified. See `fotoro/docs/verification.md` for exact scope.
