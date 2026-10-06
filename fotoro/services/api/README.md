# Private Fotoro service

This service supports Sync, Search and Share. Product scope lives in
[product](../../docs/product.md); [product backlog](../../docs/product-backlog.md)
is the sole active queue. See [foundation](../../docs/foundation.md) for architecture,
[Cloudflare](../../docs/cloudflare.md) for the platform path and
[verification](../../docs/verification.md) for evidence.

Run `pnpm seed:local` once, then `pnpm dev:api` at the Fotoro workspace root for
127.0.0.1:8787. Browser origin is http://localhost:4310 or
http://127.0.0.1:4310, RP localhost. The Worker always rejects fixture-account
headers, including in local mode. Local test actors are inserted only by tests;
HTTP integration tests use actual hashed bearer sessions.

Production configuration selects RP fotoro.cloud and only origin
https://fotoro.cloud. The web app and API are live on that origin with private
D1/R2 bindings configured in `wrangler.toml`. See
[deployment and release status](../../docs/deployment.md).
Native passkeys require webcredentials:fotoro.cloud with an Apple association
file tied to the signed app.

Hono authenticates requests before querying immutable object references. Grant
options reserve server IDs and expiry before the client signs. Temporary grants
expire exactly 900 seconds after issuance. Save and contribution writes run in
D1 transactions with a check-constraint authorization guard; a zero-row permission
check aborts the entire transaction. Photo-insert triggers retain all objects.
Signed bodies are parsed only after Ed25519 verification and validated with the
shared precompiled schema. Account signing/box cards cannot be replaced through
this API: replacing an identity requires a future explicit trust-renewal flow.
JSON request bodies are capped at 2 MiB while annotation PUTs retain their 512 KiB
cap. Both declared and streamed sizes are checked before parsing. Encrypted media
uploads use the separately reserved ciphertext byte limit.

Ordinary upload staging PUT requires a session and a scoped capability. Native
background PUT uses `/v1/background/uploads/:id/staging`: the already reserved,
expiring capability permits only that ciphertext staging write, with no account
credential supplied to the iOS daemon. Reservation, commit and catalog publishing
still require an account session. Both routes use the same byte/digest checks.
FixedLengthStream bounds bytes. Commit incrementally hashes the observed staging
ETag and streams that version into a fresh conditional private final key. Final
keys are never writable by a client. An ambiguous R2/D1 commit can be reconciled
by retrying commit. Cleanup currently deletes expired staging only; final-object
garbage collection and source-photo deletion are deliberately unimplemented,
so pending/ambiguous or retained data cannot be deleted. This favors retention
safety but abandoned final objects consume storage until a future audited GC.

Web sessions use Secure HttpOnly SameSite=Strict cookies; native sessions use
opaque bearer tokens whose hashes are stored in D1. Secure cookies require HTTPS
in deployment; browser handling of loopback Secure cookies should be verified
in target Safari. Tests verify server cookie policy and native tokens, but do
not replace physical-device passkey/PRF/associated-domain acceptance checks.
Recovery retrieves encrypted wrappers and proves the recovered signing key with
an origin/client/account-bound one-use five-minute challenge; the secret never
reaches the service. A recovered session may add a new passkey via register/options
with its authenticated accountId and the same pinned enrollment card.

Current account entry creates a Fotoro password locally and uses signed start
enrollment; that password unlocks the encrypted recovery bundle and proves the
account signing key on another device. The server never receives the password.
Passkeys and device approval remain supported foundations; Apple ID login is not
delivered. Production auth/enrollment is rate limited. `GET /v1/storage` returns
the account’s reserved/stored ciphertext allowance (10 GiB default), distinct
from the client’s logical-original summary. Clients retain the 50 MiB complete
original limit; the service caps each ciphertext reservation at 55 MiB.

Run `pnpm test:api` and `pnpm check:api` from `fotoro/`. Workerd tests exercise real local D1/R2,
WebCrypto verification against the frozen libsodium vector, HTTP share/save/revoke/
contribute, replay, expiry and simulated ambiguous promotion. Browser/native
clients remain responsible for pinning cards, decrypting records and confirming
the plaintext original digest. The API cannot prove plaintext restoration.

Local dev/migrate persist to `.wrangler/fotoro-v1` so earlier generated developer
state is preserved separately. POST `/v1/auth/logout` invalidates the current
session and expires the cookie. Production `[env.production.assets]` points to
`apps/web/dist`; build web first to serve the application and API on the same
origin. Worker routing never forwards `/v1/` or `/__fixtures` to static fallback.

Resume is account-scoped: a freshly authenticated device can retry the identical
operation while the original creator device remains in the audit record. An
expired reserved upload renews only its capability and expiry. Each capability
has a separate staging key, isolating late stale PUTs. Uploaded/committed states
remain immutable; cleanup never removes an uploaded staging object before commit.
Superseded staging keys can remain orphaned until future garbage collection.

Unsigned wrapper PUTs cannot replace any existing recovery or verified wrapper.
Signed recovery rotation is not implemented; account recovery remains immutable.
Committed contribution retries reconcile even after grant revoke/expiry, while
fresh or changed operations remain forbidden/conflicting. Recipient-owned saved
photos can be contributed using their exact independently retained objects and
original source AAD.

For native integration, after `pnpm seed:local`, run
`pnpm --filter @fotoro/api dev:native-test` on loopback 8787 and
`pnpm dev:fixtures` on 8790. The native-test helper bundles the real Worker with
`wrangler deploy --dry-run` and runs seeded local D1/R2 directly in Miniflare;
it avoids the development proxy hop. It does not deploy remotely.

Account-private annotations use signed, revision-checked encrypted updates and
change pages. The server cannot search photo pixels, OCR text or local vectors.
Production error diagnostics emit fixed phases/classes, status/code and UUID
request references; invocation logging is disabled to avoid capability URLs.

Optional Gemini photo understanding is off by default. `/v1/intelligence/capabilities`
and `/v1/intelligence/observe` require the existing authenticated account session
and origin checks. Local-only library users without an account session cannot use
this route. The client must consent to sending this individual preview to Google
for each analysis; this is separate from keeping a result or saving account changes.
The client re-encodes the visible preview as JPEG, stripping source metadata and
limiting its longest edge to 1024 pixels and its bytes to 512 KiB. The API checks
actual JPEG dimensions and rejects EXIF/IPTC/comment segments; it accepts no image
URL, object ID, original download instruction, caption, prompt, or client API key.
It never reads R2 or decrypts a server-stored photo. The pixels travel as plaintext
inside HTTPS to the Worker and Google; E2EE photo storage remains separate.
Google’s [API data terms](https://ai.google.dev/gemini-api/terms) apply to this
optional processing. Fotoro does not log or persist previews or provider results.

To enable in a reviewed environment, apply migration `0007_cloud_inference_work.sql`,
set the server-only `GEMINI_API_KEY` secret, and set all three Worker variables:
`CLOUD_INTELLIGENCE_ENABLED=true`, `CLOUD_INTELLIGENCE_DAILY_ACCOUNT_REQUESTS`
(a positive integer at most 1000), and `CLOUD_INTELLIGENCE_DAILY_GLOBAL_REQUESTS`
(a positive integer at most 10000). No value is provisioned by the repository.
Missing, invalid, or absent ledger configuration fails closed. Atomic D1 claims
count every admitted attempt, including provider failures and canceled browser
requests; claims are never refunded. UTC calendar-day limits apply per account
and globally, with fixed per-minute caps of 2 per account and 20 globally. The
ledger stores only scope, window, expiry and counts. Expired rows are removed on
later admitted work. Switching account IDs cannot bypass the global limit.

The allowlist is `gemini-3.8-flash` (default observation) and
`gemini-3.5-flash-lite` (cheaper extraction). Each request carries one inline
preview, a fixed instruction, no tools, one candidate and `maxOutputTokens=1024`;
the Worker aborts after 30 seconds and bounds the provider envelope at 64 KiB.
The strict observation schema separates objects, scene terms, visible text and
uncertainty. Runtime checks reject malformed, excessive, truncated or blocked
output. Results carry their photo ID, source revision, model and observation time;
clients must reject stale bindings and review evidence separately from personal
captions, labels and OCR. Retention is a client decision, never a server side effect.
These are hard work limits, **not a dollar spending guarantee**: provider billing,
thinking and image-token accounting can vary, and a timeout need not cancel
provider billing. Configure and monitor provider billing separately.

Model and REST behavior were verified against Google’s official
[3.8 Flash model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash),
[3.5 Flash-Lite model](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite),
[structured output REST](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)
and [image understanding REST](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding)
documentation on October 6, 2026. The API uses REST without a provider SDK.
[Gemini Embedding 2](https://ai.google.dev/gemini-api/docs/embeddings) supports
multimodal embeddings, but this release does not send embedding requests or mix
those vectors with the independent on-device index. A future integration needs
its own consent, model/version binding, quota accounting and retrieval evaluation.
Tests mock provider requests and never use a real key or send user photos.
