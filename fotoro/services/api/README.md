# Private Fotoro service

Local only; this repository does not provision D1, R2, DNS or passkey domains.
Run `pnpm seed:local` once, then `pnpm dev:api` at the Fotoro workspace root for
127.0.0.1:8787. Browser origin is http://localhost:4310 or
http://127.0.0.1:4310, RP localhost. The Worker always rejects fixture-account
headers, including in local mode. Local test actors are inserted only by tests;
HTTP integration tests use actual hashed bearer sessions.

Production configuration selects RP fotoro.cloud and only origin
https://fotoro.cloud. Provision private D1/R2 bindings separately, migrate all
SQL files and configure HTTPS/domain before enabling production. The existing
production Wrangler environment deliberately has no provisioned bindings.
Native associated domains must include webcredentials:fotoro.cloud and
applinks:fotoro.cloud with an Apple association file tied to the signed app.
No deployment has been performed.

Hono authenticates requests before querying immutable object references. Grant
options reserve server IDs and expiry before the client signs. Temporary grants
expire exactly 900 seconds after issuance. Save and contribution writes run in
D1 transactions with a check-constraint authorization guard; a zero-row permission
check aborts the entire transaction. Photo-insert triggers retain all objects.
Signed bodies are parsed only after Ed25519 verification and validated with the
shared precompiled schema. Account signing/box cards cannot be replaced through
this API: replacing an identity requires a future explicit trust-renewal flow.

Upload staging PUT is a session-and-capability-authorized Worker route. Its
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

Run `pnpm test:api` and `pnpm check:api`. Workerd tests exercise real local D1/R2,
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
