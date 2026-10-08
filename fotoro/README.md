# Fotoro

Sync, Search, Share for everyday family photos. The active app is SwiftUI on
**iPhone**, React/Vite on the **web**, and Hono on **Cloudflare Workers**, with
D1 records and private R2 ciphertext. [fotoro.cloud](https://fotoro.cloud) serves
web and API together. The parent Ente tree is an attributed reference.

Open Photos and browse before account setup. Turn on sync once when ready;
account entry continues that choice. Photos is the browsing surface, Picks
suggests useful shots, and Saved holds originals available on another device.
Select a moment and use system sharing, or choose an accepted person for a
private Fotoro invitation. Opening Saved is read-only.

## Read the right document

| Need | Owner |
| --- | --- |
| Audience, pain, first value and reasons to return | [Product](docs/product.md) |
| Next work and completion gates | [Roadmap](docs/product-backlog.md) — the only active queue |
| Full setup, screens and native glass | [Interaction rules](design/interaction-reference.md) |
| Data ownership, encryption and local intelligence | [Foundation](docs/foundation.md) |
| Current Cloudflare path and admitted next foundations | [Cloudflare](docs/cloudflare.md) |
| Build, TestFlight and production rollout | [Deployment](docs/deployment.md) |
| What shipped, evidence and current limits | [Verification](docs/verification.md) |

## Current behavior and limits

- Browsing alone does not authorize uploads. One Fotoro password opens Saved across
  devices; protected native remembered access respects manual lock. Apple ID
  sign-in is not delivered. Existing protocol compatibility stays in Settings.
- Opted-in native Sync prepares supported Photos originals while open/unlocked.
  Pause persists. Already scheduled ciphertext uploads can finish in background.
  Browser Save/uploads stay explicit; it cannot scan the iPhone Photos library.
- Originals, thumbnails and previews are encrypted before upload. Native supports
  JPEG/PNG/HEIC, MP4/MOV and complete Live Photo resources within 50 MiB per logical
  original. Private account allocation is 10 GiB of ciphertext. Visible exclusions
  remain incomplete; abandoned ciphertext cleanup and disaster restore need work.
- OCR and pinned visual models run locally on bounded previews. Model downloads
  contain public weights; private photos, queries and vectors are not sent to an
  inference provider. Search remains usable while visual inference prepares.
- Dates, supplied labels, text, local visual matches, Picks/Best shots and private
  locations are implemented. Confirmed browser Timeline import retains only photo
  locations with valid capture evidence. Scene publication stays off for older
  readers; vectors and raw Timeline history are not uploaded.
- Public-fixture tests qualify wiring. Personal-library retrieval, physical media
  and background behavior, older-phone performance and the full mom journey remain
  open. See Verification for the current web/native distribution distinction.

## Run locally

Use Node 22 and pnpm 10.17.1. From `fotoro/`:

```sh
pnpm install --frozen-lockfile
pnpm doctor
pnpm dev
```

Open http://127.0.0.1:4310. The fixture service contains public test accounts;
private uploads to those accounts are blocked. Use only public media. This
preview does not prove production authentication or personal photo backup.

For the real local Worker, D1 and R2 implementation:

```sh
pnpm seed:local
pnpm dev:service
```

Seeding is local-only. Its public codes are fixture credentials, never private
accounts. Create a disposable local account for end-to-end Save/restore tests.
See the [API guide](services/api/README.md) for service and storage boundaries.

## Check and release

```sh
pnpm check
pnpm test:search:visual
```

Native checks require the local API at 8787 and fixtures at 8790; CI starts both. Use
`pnpm test:ios` for the full app and `pnpm test:ios --local-preview` for the separate
Photos preview. See the [native guide](apps/ios/README.md).

Current release procedures and evidence belong to Deployment and Verification.
Exact-head CI, audited artifacts and production readback qualify rollout;
physical acceptance is a separate gate.
