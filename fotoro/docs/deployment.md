# Cloudflare deployment

The new Fotoro web and API build is developed in `fotoro/`. The upstream Ente runtime is a separate reference and does not deploy through this configuration.

## Target

- React/Vite static assets and `/v1/*` API served on one origin.
- Hono Worker with private R2 media and D1 account/grant/catalog records.
- Clients generate encrypted originals, previews and thumbnails before upload.
- Development fixture auth is restricted to loopback and never included in production.
- No AI provider is needed to build or run this first slice.

## Release order

1. Complete local contract, crypto, API, web and native checks; use generated/public fixture data.
2. Log in to the intended Cloudflare account through Wrangler's normal OAuth flow. Do not paste tokens into chat or commit credentials.
3. Create separate preview D1/R2 resources and apply migrations. Deploy a preview with explicit allowed origin/RP settings, never localhost fixture settings.
4. Exercise real passkey sessions, recovery, two-account exchange, upload reconciliation, revocation and independent save against that preview.
5. Build production with distinct bindings, production RP `fotoro.cloud`, allowed origin `https://fotoro.cloud`, secure cookies and authenticated media delivery.
6. Verify the deployment URL before changing domain routing. Attach `fotoro.cloud` only after checks pass; retain a rollback target.
7. Configure Apple associated domains and signing; test passkeys, background transfer and original restore on physical devices before TestFlight release.

A Worker preview with a different RP creates different passkey credentials. Do not assume those credentials migrate to the production RP.

## Current state

October 1, 2026: the active checkout is `/Users/dakshbhatia/Documents/GitHub/Fotoro`.
The native/web/API development build runs locally, with the web preview at 4310,
real local API at 8787 and public fixtures at 8790. Production D1/R2 bindings and
Cloudflare access are still required. The owner is signed in to Xcode, an
app-specific development provisioning profile includes Associated Domains, and
the final signed consumer checkpoint is installed on the connected iPhone. Its
latest launch attempt was refused while the phone was locked; the earlier
checkpoint launched successfully.
Local browsing starts with the last 10 days; local search covers permitted still
photos of any age. Personal Photos access remains the user's choice.
Fotoro's App Store Connect record is created (app 6818330547). The internal group
has the owner's requested tester and automatic distribution enabled. Build 1
was rejected for missing orientation metadata. The corrected version 0.1.0,
build 2 archived and uploaded successfully at 19:10 Eastern and has finished
processing. Its current App Store Connect status is Missing Compliance;
Apple's encryption declaration remains open. Release
artifacts and distribution logs stay outside the repository.
The service now serves `/.well-known/apple-app-site-association` when
`APPLE_APP_IDS` contains the signed application identifier, for example
`APPLICATION_PREFIX.cloud.fotoro.Fotoro`. Use the actual application-identifier
entitlement from the signed build. Multiple identifiers are comma-separated.
Missing or invalid configuration returns an uncached 503; the route does not
fall through to the web app. It lists `webcredentials.apps` for passkeys.
Universal-link handling remains unimplemented. See
[Apple's associated domains documentation](https://developer.apple.com/documentation/xcode/supporting-associated-domains).
Wrangler's normal account check is unauthenticated. No public Fotoro service
or TestFlight release is claimed yet. See [verification](verification.md).

## Internal TestFlight checkpoint

Version 0.1.0, build 2 is uploaded and processed. `Fotoro Internal` has automatic
distribution enabled and the requested existing owner tester; no account roles
were changed. Tester access still reports no available build until compliance is
completed. No invitation or ready-to-install TestFlight result is claimed.
Build-specific What to Test notes are saved. Adding the group to this build opens
the encryption form, so build-specific groups/testers remain zero until the gate
is resolved; group membership and build access are distinct.

The native binary uses libsodium for XChaCha20-Poly1305 secretstream media,
XSalsa20-Poly1305 secretbox envelopes, X25519 sealed boxes and Ed25519 signatures.
These are public implementations; Fotoro does not invent a cipher. They are
additional to Apple's system TLS. The current
[XChaCha IETF draft](https://datatracker.ietf.org/doc/draft-irtf-cfrg-xchacha/)
is expired and has no formal standing in the IETF standards process. Publication,
industry use and formal standard approval are distinct facts. Apple's
[export compliance overview](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance)
and [documentation table](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption/)
must be applied to the actual declaration; source inspection alone does not prove
a legal exemption or an existing CCATS document. The actual proprietary/nonstandard
and Both choices lead to mandatory export-document upload, with no approved
documents available on this app record. The standard-only path asks about France;
a France answer alone does not establish that classification for this binary.
No compliance answer, `ITSAppUsesNonExemptEncryption` override or unsupported
exemption has been submitted.

Saved beta test notes: "Browse photos from the last 10 days. Search permitted
photos and recognized text. Share an original photo. Hosted backup is unavailable
in this build." Local Photos access does not opt the library into uploads. This
pilot does not establish personal iCloud or background-transfer acceptance.

The owner approved and implemented the separate `FotoroLocalPreview` scheme.
It shares PhotoKit/Vision views and search, uses an isolated
`FotoroLocalPreviewSearch` index, explicit source/resource allowlists and GRDB-only
linkage. Account, Fotoro network/backup/exchange sources and Sodium are excluded
from this binary. Local-only scope is visible on first open, the gallery and
Settings. The default encrypted scheme and its formats remain intact. Installing
this beta replaces the app under the same bundle identifier; it does not import
or change the full app's index or account files.

`node tools/build-testflight.mjs <build-number> --local-preview --upload` checks
the signed archive and a distribution-signed IPA before upload. It scans the
single executable, matching dSYM and link map for excluded code, verifies icons/
privacy-only resources and checks the preview-specific Apple-OS-only encryption
metadata. Unexpected bundled binaries, account resources or background/domain
entitlements fail the audit. Actual processing and tester access still need
App Store Connect verification after upload.

The final version0.1.0(build3) signed preview archive passed its artifact audit.
It has not uploaded: the pre-upload app-store IPA export returns exit70,
`No Accounts` and no `iOS Distribution` certificate. An explicit team retry
returns the same errors; this Mac has a development identity and no local
distribution identity. Build2 used Apple cloud signing for its upload workflow.
The Mac is locked, so Xcode signing/Organizer inspection requires the owner to
unlock it. No certificate was created/revoked and no weaker audit was substituted.
The physical preview installation also failed with CoreDevice4016 while the
paired phone transport was unavailable. The working public Simulator preview is
at `http://localhost:3200/`; personal phone or TestFlight access is not claimed.

Foreground Photos sync is implemented locally. On a deployed/signed build:
create or unlock one account on iPhone, save its recovery code, then start
Sync last 10 days. Open the same HTTPS service in Safari and sign in or recover
that account to load committed photos. Open and unlock the iPhone app to scan and
prepare more photos and finish catalog commits. An encrypted upload already
scheduled with iOS can continue in the background. Whole-library background
processing and a personal physical-device acceptance run remain release gates;
localhost on this Mac is not an installable iPhone service.

Read-only checks of `https://fotoro.cloud/v1/vault` and the HTTPS association route
currently return 404. This origin is not serving the prepared API/association build.

Production web assets and Worker bundling pass a Wrangler `--dry-run`. Wrangler
reports missing production D1/R2 bindings: those bindings are not inherited from
the local environment. Add the real resource identifiers before deployment;
the dry-run is not a provisioned or usable service.

After deploying to the intended HTTPS origin, run `pnpm check:service
https://fotoro.cloud APPLICATION_PREFIX.cloud.fotoro.Fotoro`. It checks the
unauthenticated API response and configured passkey association without creating
an account or changing data. It cannot replace the physical-device run.

Account-private labels and recognized text use migration
`0004_private_annotations.sql`. Apply migrations before deploying the updated
clients. These sidecars are encrypted with the account vault key, signed by the
account and atomically revisioned. They are absent from sharing grants; search
choices and pins stay on each device. Client pending edits survive interruption
and conflicting edits wait for a visible choice.

`PUT /v1/background/uploads/:id/staging?cap=...` accepts only an existing,
expiring, 256-bit upload capability. It can write one bounded staging object and
cannot read, reserve or commit an object. Background requests carry no account
bearer or cookie credentials. The service never redirects this endpoint. Apple
background URLSession follows redirects without the foreground redirect veto;
clients therefore require this trusted, same-origin endpoint and verify the
final response origin. Original data is encrypted before transport. Catalog
commits still require authenticated foreground work after vault unlock.

References: [Workers static assets](https://developers.cloudflare.com/workers/static-assets/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
