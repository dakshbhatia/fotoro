# Fotoro development build

Native SwiftUI app, React web app, and Hono API using private R2 objects and D1.
The default screen is a private local photo browser. The Ente tree at repository
root remains a reference; the new app lives here. See [what we reuse](docs/foundation.md).

On iOS, Open Photos requests access and shows the last 30 days using PhotoKit and
Apple's thumbnail cache. HEIC and Live Photo still previews use the system decoder.
Dates, favorites, screenshots and GPS coordinates come from the Photos library.
Browsing does not initialize an account or upload photos. Sharing explicitly
exports the still original through the system share sheet.

In the browser, Open photos selects JPEG/PNG files for a local session. Search,
day grouping, zoom and original sharing/download work without an account. Closing
or reloading clears the session; the browser cannot scan the iPhone Photos library.
Unknown image dimensions, including HEIC in this browser slice, are skipped before
decoding. Thumbnail/preview caches are bounded and generated sequentially.

Backup & sharing opens the separate encrypted exchange slice: JPEG/PNG imports
up to 50 MiB, encrypted originals and derivatives,
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

Open http://127.0.0.1:4310 and choose Open photos. No account is required for local
browsing. For the cloud demo, Settings → Backup & sharing exposes public test
accounts in development. Those keys are intentionally public. Fixtures reset when
stopped; clear the cloud session after a reset. The demo does not simulate successful passkeys.

For the real local Worker/D1/R2 service:

```sh
pnpm seed:local
pnpm dev:service
```

The seed command uses local storage only. Recover with a public code printed by
the command. Do not store personal photographs in either public test account.

Open `apps/ios/Fotoro.xcodeproj`, scheme `Fotoro`, on an iOS 26+ Simulator.
Open Photos starts local browsing. Settings → Backup & sharing opens account
setup; developer controls are inside Advanced in DEBUG builds. Physical-device
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
library targets, then add cloud HEIC/Live Photo preservation and durable local OCR/EXIF
indexing. Semantic search, faces, dedupe cleanup, optional Gemini enrichment,
video, and nearby transport remain planned work.
