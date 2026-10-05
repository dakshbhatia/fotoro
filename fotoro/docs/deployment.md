# Fotoro releases

The active app is `fotoro/`: SwiftUI on iPhone, React/Vite on the web, and a
Hono Worker with D1 and private R2. The upstream Ente application is a reference.

## Production

- Origin: `https://fotoro.cloud`, with web assets and `/v1/*` on one Worker.
- D1: `fotoro-production` (`a2c6f91e-5021-4b2f-8c9a-dfd18a9ea26e`).
- R2: `fotoro-private-production`, with public bucket access disabled.
- Authentication: production mode, secure sessions, production passkey RP.
- iPhone association: `A7TGPQ27JF.cloud.fotoro.Fotoro`.
- Account storage limit: 10 GiB. Logical camera original limit: 50 MiB.
- Originals, previews and thumbnails are encrypted by clients before upload.
- Visual search runs locally. Model downloads contain public weights; private
  photos, queries and vectors are not sent to an inference provider.

The last verified active Worker is `e6a09961-6ddb-42c5-9fc0-fabaf195d9b0`
at 100%, deployment `49a1d235-3bc4-499f-bc1b-e48955447078` (2026-10-05,
merged [PR 42](https://github.com/dakshbhatia/fotoro/pull/42)). All 35 non-HTML
asset digests match the qualified build; Photos and Saved HTML routes reference
the expected entry assets. The preceding qualified version is
`f19242f0-7762-43a8-b66c-0be45c3f6cdf`. Read the current deployment back before
changing traffic; preserve the preceding qualified version for rollback.

Documentation-only edits do not change this runtime checkpoint and need no Worker
deployment or native archive. Current native distribution gates are recorded below;
[verification](verification.md) owns detailed release evidence.

## Release checks

From `fotoro/`:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:search:visual
pnpm test:exchange:isolated
```

The Fotoro GitHub workflow also compiles and tests both the full native app and
its isolated local Photos preview. The pinned-model smoke cases exercise actual
inference on a public photo; they do not establish held-out retrieval quality or
physical-device performance. Fix failed checks before merging. Require successful checks for the exact PR head,
then merge with a head-commit guard. Confirm the merged tree matches that qualified
head before building release artifacts.

Build production web assets from the qualified merged source with `pnpm build:web`.
Development fixture settings belong to local processes and must not be exported
into the production build. Keep the configured D1/R2 bindings and production
origin unchanged. Apply migrations only when the qualified change requires them; PR 42 needs none.

Use Wrangler's existing OAuth session in the intended Cloudflare account. Do not
copy credentials into chat, Git or release logs. From `services/api/`, prepare a
version with `wrangler versions upload --env production`, inspect its bindings,
then deploy the inspected version at 100% with
`wrangler versions deploy VERSION_ID@100% --env production`.
Publish assets and API together: media-aware clients require the server's
`mediaVersion: 1` acknowledgement, and older readers exclude new media kinds.

After cutover, require the expected Worker at 100%, matching built asset digests,
HTTPS routes and the exact signed Apple association:

```sh
pnpm check:service https://fotoro.cloud A7TGPQ27JF.cloud.fotoro.Fotoro
```

Use a public fixture for browser QA. Verify search, selection, sharing preparation,
responsive layout and console errors. A service health check does not establish
personal-account sync or original restoration on a physical phone.

## Native distribution

The last verified TestFlight build is 25 (`VALID`, `IN_BETA_TESTING`). This code
pass uses CI for native validation; no new IPA, phone install or TestFlight upload
is implied by web deployment. The owner reports Xcode already signed in; do not
repeat historical account setup instructions.

Build 37 archives the qualified PR 41 source and passes the full archive audit
with all 69 native input hashes unchanged. It is development-signed; no IPA was
exported and no TestFlight upload occurred. Build 36 remains the earlier archive
of the qualified three-S source. Check release
credentials without archiving, exporting or uploading:

```sh
FOTORO_DEVELOPMENT_TEAM=YOUR_TEAM node tools/build-testflight.mjs 37 --preflight
```

The check reports credential type and local distribution identity count, without
printing key IDs, paths, certificates or tokens. It does not verify an Xcode
account or claim the build is upload-ready. An individual API key uses
`ASC_KEY_SUBJECT=user` and no issuer; this access is verified for build metadata.
[Individual keys cannot use Apple's provisioning endpoints](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api). Signing needs an
available distribution identity/profile, a usable signed-in Xcode account, or a
team key with its issuer for automatic provisioning. Keep keys outside the repo.

First App Store publication excludes France, as approved by the owner. Keep full
app encryption and the distribution artifact's compliance declaration aligned;
the local Photos preview is a separate target with a different encryption scope.
The full release helper audits the archive before export and requires an audited
distribution IPA before upload. The audit checks the requested build and signed
app identity, production associated domains, one arm64 executable, matching
binary/dSYM UUIDs and ten defined static crypto symbols. Preview scope,
false or malformed full-app encryption declarations, extra executable resources
and a mismatched exported build fail before upload. `pnpm check` includes the
release orchestration regressions. An archive-only audit does not qualify an IPA
or an App Store Connect upload; processing and compliance still require readback.
See [verification](verification.md) for current evidence and its historical appendix.
Earlier deployment checkpoints remain available in Git history.
