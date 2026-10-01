# Fotoro development build

Native SwiftUI app, React web app, and Hono API using private R2 objects and D1.
This is the approved private-photo exchange slice. The Ente tree at repository
root remains a reference; the new app lives here.

Implemented: JPEG/PNG imports up to 50 MiB, encrypted originals and derivatives,
metadata search, passkey/recovery/device-approval protocols, explicit sharing,
15-minute or ongoing grants, view/save/contribute, revocation, and recipient-owned
saved copies. Exchanges accept up to 100 photos. Originals are verified by digest.

## Run

Use Node 22 and pnpm 10.17.1. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm run doctor
pnpm dev
```

Open http://127.0.0.1:4310 and choose a public test account. These fixture keys
are intentionally public. Fixtures reset when stopped; use “Sign out and clear
this browser” after a reset. This demo does not simulate successful passkeys.

For the real local Worker/D1/R2 service:

```sh
pnpm seed:local
pnpm dev:service
```

The seed command uses local storage only. Recover with a public code printed by
the command. Do not store personal photographs in either public test account.

Open `apps/ios/Fotoro.xcodeproj`, scheme `Fotoro`, on an iOS 26+ Simulator.
Debug controls can select loopback fixtures or the local API. Physical-device
passkeys require HTTPS, signing, and associated domains.

## Check

```sh
pnpm check
pnpm test:exchange:isolated
```

For native tests, keep the local API seeded/running at 8787 and fixtures at 8790,
then run `pnpm test:ios`. The CI workflow starts both services before native tests.
The isolated exchange check creates and removes its own local D1/R2 state.

See [verification](docs/verification.md), [release setup](docs/deployment.md),
and the [product roadmap](../docs/ai-photos/roadmap.md).

Next: validate on a signed physical iPhone and HTTPS Safari, measure the large
library targets, then add HEIC/Live Photo preservation and durable local OCR/EXIF
indexing. Semantic search, faces, dedupe cleanup, optional Gemini enrichment,
video, and nearby transport remain planned work.
