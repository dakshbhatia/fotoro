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

The last verified active Worker is `b3088ca5-5904-4dd6-9539-7ea59adc210b`
at 100%, deployment `b9389285-2daf-481a-8c17-dacce3adf95b` (2026-10-05,
merged PR 35). Read back the latest deployment before changing traffic;
deployment lists are chronological. Preserve the preceding version for rollback.
The three-S simplification changes web assets and native presentation; there is
no server migration or protocol change.

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
physical-device performance. Fix failed checks before merging.

Build production web assets from the merged source with `pnpm build:web`.
Development fixture settings belong to local processes and must not be exported
into the production build. Keep the configured D1/R2 bindings and production
origin unchanged. This release needs no new server migration.

Use Wrangler's existing OAuth session in the intended Cloudflare account. Do not
copy credentials into chat, Git or release logs. From `services/api/`, prepare a
version with `wrangler versions upload --env production`, inspect its bindings,
then deploy the verified version with `wrangler versions deploy --env production`.
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

Build 36 is archived and audited with the three-S simplification. Check release
credentials without archiving, exporting or uploading:

```sh
FOTORO_DEVELOPMENT_TEAM=YOUR_TEAM node tools/build-testflight.mjs 36 --preflight
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
See [verification](verification.md) for historical device and distribution proof.
Earlier deployment checkpoints remain available in Git history.
