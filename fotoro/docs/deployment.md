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
6. Verify the production bindings and active Worker version before cutover. Back up authoritative DNS, prepare equivalent records in the pending Cloudflare zone, change nameservers, and attach `fotoro.cloud`. Require HTTPS API, association and browser checks before declaring the service live; retain the DNS rollback target.
7. Configure Apple associated domains and signing; test passkeys, background transfer and original restore on physical devices before TestFlight release.

A Worker preview with a different RP creates different passkey credentials. Do not assume those credentials migrate to the production RP.

## Current state

October 2 release checkpoint: [PR 2](https://github.com/dakshbhatia/fotoro/pull/2)
is merged into `main` at `adb35ae652`. Both the
[main CI run](https://github.com/dakshbhatia/fotoro/actions/runs/36960016617)
and [PR CI run](https://github.com/dakshbhatia/fotoro/actions/runs/36958905612)
passed, including the native, web/API and repository checks.

The local-only version 0.1.0, build 3 is uploaded. Xcode Organizer used the
existing account's cloud-managed Apple distribution certificate to produce its
IPA. The signed archive and distribution IPA passed the strict preview artifact
audit, and Apple package validation passed before that exact audited IPA uploaded
successfully at 00:39 Eastern. The API reports `VALID`,
`usesNonExemptEncryption=false` and internal `IN_BETA_TESTING`. Build-specific
local-preview test notes were saved and read back. This build browses recent
Photos, searches permitted photos/text and shares originals; hosted backup is
excluded. Actual owner TestFlight installation remains a device check.
App Store Connect also verifies the existing internal group has one tester and
one build: 0.1.0 (3) is `Testing`, and the requested owner tester is `Invited`.
The matching development-signed preview was subsequently installed and launched
on the connected physical iPhone. CoreDevice verifies version 0.1.0, build 3 and
its running process. Personal Photos access remains the owner's choice; this
direct installation does not establish TestFlight invitation acceptance or
installation through TestFlight.

[PR 4](https://github.com/dakshbhatia/fotoro/pull/4) is now merged at
`59d66f8506`. Every exact-head native, web/API and repository check completed
successfully before the merge. It adds linear local/saved search merging, bounded
error diagnostics, adaptive dark styling and 44 px controls at the smallest
verified browser width.

An existing local individual App Store Connect key was verified against this
exact Fotoro app record and copied into private storage outside the repositories.
It can read Fotoro build and group metadata. As described in
[Apple's API key documentation](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api),
individual keys cannot use Apple's provisioning endpoints; they do not replace
the Xcode signing account or a distribution certificate. Xcode 27's installed
`altool` supports `--api-key-subject user`: this existing individual key validated
and uploaded the already distribution-signed build 3 IPA. The existing build 2 is `VALID` in the API, with its
encryption declaration unset; this is not an installable beta claim.

The owner approved the account-scoped Wrangler grant, and its normal OAuth flow
saved the credential in the macOS keychain. Production uses the isolated D1
`fotoro-production` and R2 `fotoro-private-production`; bucket public access is
disabled. All five production migrations applied and were read back after the
`retention_live` CASE expression parser fix. The production bindings, signed
application association identifier and `fotoro.cloud` custom-domain route are
explicit in `services/api/wrangler.toml`.

Worker version `d04b80fc-b484-4d57-b1df-846c12182ed1` is active at 100%, tagged
`48780562ca`. The `fotoro.cloud` custom domain is attached to that existing Worker
and read back; no code re-upload was needed. `workers_dev` remains false. The
production dry-run packages all five bindings without warnings; it is not proof
of a reachable service.

The owner's existing Vercel credential was reused privately to verify the exact
team domain, and its DNS backup is complete. The registrar accepted the approved
Cloudflare nameservers and its custom-nameserver readback matches. Authoritative
`.cloud` servers and public resolvers now return the assigned Cloudflare pair.
The apex is a managed Worker record; the wildcard fallback, domain connection
and all three CAA records are preserved. The Free zone is active. Canonical
HTTPS serves the web app; `pnpm check:service` passes the unauthenticated API
and exact signed iPhone passkey association checks. Desktop and 390 × 844
browser checks pass Photos → Sync → Back without console warnings or errors.
Real-account passkeys, recovery, personal photo sync and original restore still
require physical-device acceptance.

Historical October 1, 2026 checkpoint: the active checkout was `/Users/dakshbhatia/Documents/GitHub/Fotoro`.
The native/web/API development build runs locally, with the web preview at 4310,
real local API at 8787 and public fixtures at 8790. Production D1/R2 bindings and
Cloudflare access were still required at that checkpoint. The owner is signed in to Xcode, an
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
Wrangler OAuth is authorized and the production service is live at
`https://fotoro.cloud`. The separate local Photos preview is in internal TestFlight.
See [verification](verification.md).

## Full build 4 checkpoint

The full encrypted 0.1.0 (4) development app is installed on the connected
iPhone and its exact version is read back. Launch was blocked by the locked
phone. The full archive passes strict signature, metadata, entitlement and
matching-dSYM checks; it retains the production service URL and includes sync.
It does not carry the local-preview encryption exemption. The distribution
IPA is exported and audited; Apple validation and upload are in progress.
No build 4 beta availability is claimed.

## Encrypted build 2 checkpoint

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

### API release metadata

`tools/asc-metadata.mjs` supports both team and individual keys. Set
`ASC_KEY_PATH` and `ASC_KEY_ID` from private local configuration. Team keys also
require `ASC_ISSUER_ID`; individual keys use `ASC_KEY_SUBJECT=user` and omit the
issuer. Credentials stay outside the repository, and JWTs remain in memory.
This authentication is separate from Xcode archive/export signing.

From `fotoro/`, check an exact iOS marketing version and build:

```sh
node tools/asc-metadata.mjs status --version 0.1.0 --build 3
```

After that local preview's archive and distribution IPA pass the artifact audit,
set its build-specific test notes:

```sh
node tools/asc-metadata.mjs set-what-to-test --version 0.1.0 --build 3 --local-preview
```

The helper verifies the exact Fotoro app/bundle and selected build before the
notes write, then reads back the saved notes. `--notes-file` preserves explicitly
supplied wording. Processing, encryption and beta states are reported separately;
group assignment and actual tester access still require their own verification.
The current read-only check finds build 3 as `VALID` and `IN_BETA_TESTING`; its
local-preview notes are verified. Build 2 remains `MISSING_EXPORT_COMPLIANCE`.

The final version 0.1.0 (build 3) signed preview archive and distribution IPA
passed their artifact audits. Terminal `xcodebuild` export still returns exit 70
with `No Accounts` and no local distribution identity, while the unlocked Xcode
Organizer can use its existing account and cloud-managed distribution certificate.
The signed IPA was copied from Xcode staging into private release storage and
audited against the unchanged archive and link map before validation/upload.
No preview audit was bypassed. A preceding physical preview installation failed
with CoreDevice4016 while its phone transport was unavailable. The later
connected-device install and launch succeeded independently of the TestFlight
API state; personal Photos access has not been inspected.

For an individual key, keep metadata authentication (`ASC_KEY_SUBJECT=user`,
no `ASC_ISSUER_ID`) separate from `altool`'s arguments. Its parser requires an
issuer argument even with `--api-key-subject user`; use the actual observed team
issuer in a separate private `ASC_UPLOAD_ISSUER_ID`, never a guessed value.
After the immutable archive/distribution IPA audit passes, Xcode 27 supports:

```sh
xcrun altool --validate-app "$FOTORO_AUDITED_IPA" \
  --api-key "$ASC_KEY_ID" --api-issuer "$ASC_UPLOAD_ISSUER_ID" \
  --api-key-subject user --p8-file-path "$ASC_KEY_PATH"
xcrun altool --upload-package "$FOTORO_AUDITED_IPA" \
  --api-key "$ASC_KEY_ID" --api-issuer "$ASC_UPLOAD_ISSUER_ID" \
  --api-key-subject user --p8-file-path "$ASC_KEY_PATH"
```

Require validation/upload exit 0 and their `VERIFY SUCCEEDED` / `UPLOAD SUCCEEDED`
markers. Keep credentials and receipts outside Git. Verify the exact app, iOS
marketing version/build, beta state and internal group through App Store Connect;
an upload receipt alone does not establish tester availability.

Foreground Photos sync is implemented locally. On a deployed/signed build:
create or unlock one account on iPhone, save its recovery code, then start
Sync last 10 days. Open the same HTTPS service in Safari and sign in or recover
that account to load committed photos. Open and unlock the iPhone app to scan and
prepare more photos and finish catalog commits. An encrypted upload already
scheduled with iOS can continue in the background. Whole-library background
processing and a personal physical-device acceptance run remain release gates;
localhost on this Mac is not an installable iPhone service.

Before cutover, read-only API and association checks returned the old Vercel
404. The approved registrar change, active Cloudflare zone and Worker custom
domain now serve canonical HTTPS. `pnpm check:service` confirms the protected
API returns its expected unauthenticated response and the passkey association
contains the signed application identifier.

Production web assets and Worker bundling pass a Wrangler `--dry-run` with the
created production D1/R2 bindings, static assets, production authentication and
Apple association identifier. These bindings are explicit because environments
do not inherit the local database or bucket. All five production migrations
are applied. The custom domain is attached to the active Worker and the
registrar delegation is changed. Canonical HTTPS API, association and browser
onboarding checks pass; the dry-run remains a separate packaging check.

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
