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

Before this foundation release, the verified active Worker is
`2038bd0d-65bd-4fa2-ab1f-0c069cc7115c` at 100%, deployment
`14c055ea-1d2b-4206-8938-4f37867183c2` (2026-10-04). Previous Worker
`b1e70904-3b84-486a-a605-88fdd4630cf9` is the rollback target. Read back the
latest deployment before changing traffic; deployment lists are chronological.

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

Build 34 is archived and audited with the partial-sync correction. Check release
credentials without archiving, exporting or uploading:

```sh
FOTORO_DEVELOPMENT_TEAM=YOUR_TEAM node tools/build-testflight.mjs 34 --preflight
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
