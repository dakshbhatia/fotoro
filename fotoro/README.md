# Fotoro development build

Native SwiftUI app, React web app, and Hono API using private R2 objects and D1.
The default screen is a private local photo browser. The Ente tree at repository
root remains a reference; the new app lives here. See [what we reuse](docs/foundation.md).

On iOS, Open Photos requests access and shows the last 10 days using PhotoKit and
Apple's thumbnail cache. HEIC and Live Photo still previews use the system decoder.
Dates, favorites, screenshots and GPS coordinates come from the Photos library.
Browsing does not initialize an account or upload photos. Sharing explicitly
exports the still original through the system share sheet.

The native home suggests roughly 10% of viable recent photo groups from small
on-device previews. Clarity, exposure, favorites and capture-date variety guide
the picks; similar shots within a short verified capture window share a
representative. All Photos and search still include the originals. Account shows
the signed-in account reference. Save picks adds the current suggestions from the
last 10 days once, after account unlock. Automatic sync is off.

Account uses one generated Fotoro password. New Fotoro creates that password;
Continue opens the account. Enter the same password on iPhone or the web to sign
in and unlock saved photos. The iPhone keeps its password in protected Keychain;
Account → Your Fotoro password lets you copy or save it later. Existing passkeys
remain available under Other ways to sign in, and existing recovery codes work in
the password field.

Native search covers all permitted non-hidden still photos, including older photos
outside the 10-day canvas. It indexes supplied labels, available metadata and
English text using Vision on one bounded local preview at a time. Indexing does
not download iCloud originals. Local search lives in a protected database excluded
from device backup. Labels and completed recognized text attached to synced
originals also travel encrypted through the account. Search choices and pins stay
on each device.

In the browser, Open photos selects JPEG/PNG files for a local session. Search,
day grouping, zoom and original sharing/download work without an account. The
browser cannot scan the iPhone Photos library. Settings optionally enables local
English text recognition and retained search. Retention saves encrypted labels,
text, preferences and up to 100 MiB of previews using a browser-held key; originals
are not retained. After reopening, reselecting the matching SHA-256 original
enables download/share. Browser storage can be cleared or evicted. With retention
off, reloading clears the selection.
Unknown image dimensions, including HEIC in this browser slice, are skipped before
decoding. Thumbnail/preview caches are bounded and generated sequentially.

Browser imports automatically suggest roughly 10% of viable unique groups using
small local previews, clarity/exposure, favorites and verified capture-date variety.
Only visually similar bursts with verified original capture times are grouped;
ambiguous dates stay separate. Review lets you change picks, select all or restore
the suggestions. Every original stays unchanged and every imported photo remains
searchable. The reviewed subset reaches account setup only when you open Sync;
upload still requires Sync selected photos. Picks are session-only, and retained
previews require reselecting the original before upload. This selector is currently
implemented in both the browser and native app. Browser selection is editable;
native sync uses the current suggestions.

Search shows one photo with its source evidence and alternative meanings. Add
labels in Photo details. Choosing a meaning, confirming a photo and pinning its
representative are separate explicit actions; merely inspecting a preview does
not teach a preference. Text mentions never establish named face identity.

On iOS, Account → Save picks starts one manual batch. Preparation processes one
original at a time. Continue saving resumes only queued encrypted files; Save picks
starts another current selection. Reopening Fotoro and editing labels do not
start uploads. Refresh saved photos downloads the account catalog only when tapped.
Encrypted file uploads scheduled by a manual batch can finish through iOS
background transfer; force quitting interrupts system transfers. In the browser,
Settings → Sync photos connects the local canvas to the encrypted account catalog.
Opening setup preserves selected files and
uploads nothing; Sync selected photos starts their upload.

Account annotations are bound to the unchanged original digest, encrypted with
the account vault key, signed and revisioned separately from media. Label edits
and text wait in an encrypted outbox until an explicit save or Sync changes action.
Concurrent edits preserve changes to
different fields; a conflicting field waits for an explicit choice. Private
annotations are absent from shared grants.

Native imports preserve JPEG/PNG/HEIC originals byte for byte, up to 50 MiB.
Native browsing copies are JPEG thumbnails at 320 px and previews at 1600 px, quality
82%; they never replace the original. Safari displays HEIC through those copies
and downloads the untouched HEIC. Browser imports accept JPEG/PNG. Live Photo
motion pairs and videos are visibly skipped by backup.

The encrypted exchange also provides encrypted metadata,
metadata search, password/passkey/device-approval protocols, explicit sharing,
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
browsing. Sync photos exposes public test accounts inside Advanced in fixture
development builds. Those keys are intentionally public and private uploads are
blocked, including when a public account is unlocked through recovery. Fixtures reset when
stopped; clear the cloud session after a reset. The demo does not simulate successful passkeys.

For the real local Worker/D1/R2 service:

```sh
pnpm seed:local
pnpm dev:service
```

The seed command uses local storage only. Recover with a public code printed by
the command. Do not store personal photographs in either public test account.

Open `apps/ios/Fotoro.xcodeproj`, scheme `Fotoro`, on an iOS 26+ Simulator.
Open Photos starts local browsing. Account opens password entry and account
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

The web app and API are live at [fotoro.cloud](https://fotoro.cloud). Validate
personal sync and original restore on a signed physical iPhone and Safari,
then measure the large-library targets.
Live Photo motion preservation, semantic search, faces, cleanup, optional
AI enrichment, video and nearby transport remain planned work.
