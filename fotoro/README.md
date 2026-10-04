# Fotoro development build

Native SwiftUI app, React web app, and Hono API using private R2 objects and D1.
The default screen is a private local photo browser. The Ente tree at repository
root remains a reference; the new app lives here. See [what we reuse](docs/foundation.md).
The complete implementation and acceptance list is in [product work](docs/product-backlog.md).

On iOS, Open Photos requests access and pages permitted still photos using PhotoKit and
Apple's thumbnail cache. HEIC and Live Photo still previews use the system decoder.
Dates, favorites, screenshots and GPS coordinates come from the Photos library.
Browsing does not initialize an account or upload photos. Sharing explicitly
exports the still original through the system share sheet.

The native home suggests roughly 10% of viable recent photo groups from small
on-device previews. Clarity, exposure, favorites and capture-date variety guide
the picks; similar shots within a short verified capture window share a
representative. All Photos and search still include the originals. Favorites,
screenshots and location filters use the library's existing facts. All Photos can
group by day or bounded capture-time moments; filters preserve reviewed selections.
Saved photos
opens the account library directly. Select → Save and the viewer's Save preserve
the exact reviewed sources; an unlocked account starts that manual batch, and
password entry completes the same Save if needed. Sync offers one explicit
Turn on sync choice. It remembers this account and service, then saves permitted
supported photos of any age and new photos while Fotoro is open. Pause persists
across reopening; Resume is explicit. Turn off stops automatic work without
deleting originals or photos already saved.

One Fotoro password opens the same saved photos on iPhone and the web. New Fotoro
creates that password; Open Fotoro opens the account. The iPhone keeps it in
protected Keychain. A remembered account opens locally while its session is valid;
expired sessions renew through a signed password proof at initial launch or an
explicit Open Fotoro. Manual lock is respected. Reopening resumes photo sync only
for an opted-in, unpaused account with current Photos access.
Settings shows the current account reference, Fotoro password
and Sign out. Existing passkeys remain under Settings, and existing recovery codes
work in the password field.

Native search covers all permitted non-hidden still photos, including older photos
outside the 10-day canvas. It indexes supplied labels, available metadata and
English text using Vision on one bounded local preview at a time. Local Vision
classification adds conservative scene categories with separate “Inferred scene”
evidence. Date searches include today, yesterday, last week and explicit date
ranges, with calendar/timezone boundaries. Scene classification failures preserve
text search; this is category matching, not unrestricted semantic search or named
person recognition. Indexing does
not download iCloud originals. Local search lives in a protected database excluded
from device backup. Labels and completed recognized text attached to synced
originals also travel encrypted through the account. Search choices and pins stay
on each device.

In the browser, Open photos selects JPEG/PNG files and supported HEIC stills for a local session. Search,
day grouping, zoom and original sharing/download work without an account. The
selection's Save action carries the chosen originals through password entry and
starts the same manual save once the account opens. Saved photos opens read-only.
The browser cannot scan the iPhone Photos library. Settings optionally enables local
English text recognition and retained search. Retention saves encrypted labels,
text, preferences and up to 100 MiB of previews using a browser-held key; originals
are not retained. After reopening, reselecting the matching SHA-256 original
enables download/share. Browser storage can be cleared or evicted. With retention
off, reloading clears the selection.
Date phrases combine with existing filename, label and text evidence; date filters
use original capture dates, never the date a file was selected. Unknown image
dimensions are skipped before decoding. Safari's native HEIC decoder is required
for HEIC intake; unsupported browsers show a JPEG/PNG alternative. Bounded header
validation accepts HEVC stills and simple grids, preserving the original bytes.
Thumbnail/preview caches are bounded and generated sequentially; browser gallery
thumbnails are 512 px and viewer previews are 1600 px.

Browser imports automatically suggest roughly 10% of viable unique groups using
small local previews, clarity/exposure, favorites and verified capture-date variety.
Only visually similar bursts with verified original capture times are grouped;
ambiguous dates stay separate. Review lets you change picks, select all or restore
the suggestions. Every original stays unchanged and every imported photo remains
searchable. The reviewed subset reaches account setup only when you open Sync;
upload still requires Sync selected photos. Picks are session-only, and retained
previews require reselecting the original before upload. This selector is currently
implemented in both the browser and native app. Both support a reviewed subset;
native selection can also save older permitted search results from their viewer.

Search shows one photo with its source evidence and alternative meanings. Add
labels in Photo details. Choosing a meaning, confirming a photo and pinning its
representative are separate explicit actions; merely inspecting a preview does
not teach a preference. Text mentions never establish named face identity.

On iOS, select photos and tap Save, or tap Save in a photo viewer. Preparation
processes one original at a time. Continue saving resumes queued encrypted files.
Editing labels does not start uploads. Reopening Fotoro starts photo sync only
after the explicit Turn on sync choice. Opening Saved photos or
tapping Refresh downloads the catalog without sending queued uploads or edits.
Encrypted file uploads already scheduled can finish through iOS
background transfer; force quitting interrupts system transfers. In the browser,
Settings → Sync photos connects the local canvas to the encrypted account catalog.
Opening setup preserves selected files and
uploads nothing; Save selected photos starts their upload. Sign-in, returning to
the tab and reconnecting may refresh the saved catalog but never send pending
originals or edits. Continue saving and Sync changes are explicit actions.

Account annotations are bound to the unchanged original digest, encrypted with
the account vault key, signed and revisioned separately from media. Label edits
and text wait in an encrypted outbox until an explicit save or Sync changes action.
Concurrent edits preserve changes to
different fields; a conflicting field waits for an explicit choice. Private
annotations are absent from shared grants.

Native imports preserve JPEG/PNG/HEIC originals byte for byte, up to 50 MiB.
Native browsing copies are JPEG thumbnails at 320 px and previews at 1600 px, quality
82%; they never replace the original. Safari displays HEIC through those copies
and downloads the untouched HEIC. Browser imports accept JPEG/PNG and supported
HEIC stills when the native browser decoder is available. HEIC capture-time
extraction is not implemented in browser intake, so those imports are excluded
from capture-date searches until a verified capture date is available. Live Photo
motion pairs and videos are visibly skipped by backup.

Production limits each account to 10 GiB of allocated ciphertext by default.
Reservations consume headroom atomically; unused leases expire, while writes
that started keep their charge even if interrupted. Promotion can retain both
staging and final copies, so this is an allocation limit rather than an exact
R2 billing total. Auth and enrollment limits return a timed retry. Object
collection and full disaster-restore qualification remain unfinished.

Select saved photos → Share in Fotoro chooses an accepted contact. Public contact
links replace account-card JSON; optional contact names are encrypted locally.
Photo invitations open in the browser or app, with explicit identity acceptance
after password entry. Native contact and invitation QR codes carry the same public
links. Recipients can open previews, save verified independent copies and add their
saved photos back. Senders can end access; copies already saved remain independent.
No sharing action resumes unrelated pending uploads. Account, vault and contact-key
changes cancel delayed work before it can publish or update a different catalog.

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
Open Photos starts local browsing. Saved photos opens the saved library or one
password entry; developer controls are inside Advanced in DEBUG builds. Physical-device
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
