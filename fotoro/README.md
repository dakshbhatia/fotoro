# Fotoro development build

Native SwiftUI app, React web app, and Hono API using private R2 objects and D1.
The default screen is a private local photo browser. The Ente tree at repository
root remains a reference; the new app lives here. See [what we reuse](docs/foundation.md).
The complete implementation and acceptance list is in [product work](docs/product-backlog.md).

On iOS, Open Photos requests access and pages permitted photos and videos using PhotoKit and
Apple's thumbnail cache. The Photos timeline combines permitted device media with
the unlocked account's saved originals in capture-time order. Only an exact verified
source revision and original digest hide a saved duplicate; edited renditions stay distinct.
HEIC and Live Photo previews use the system decoder.
Dates, favorites, screenshots and GPS coordinates come from the Photos library.
Browsing does not initialize an account or upload photos. Sharing explicitly
exports selected originals through the system share sheet, including both resources of a Live Photo.

Highlights choose a small, diverse set from each bounded capture-time moment,
using local previews. Clarity, exposure, favorites and capture-date variety guide
the picks; native Vision aesthetics and face capture quality provide additional
quality signals. Similar shots within a short verified capture window share a
representative. Photos and search still include the originals. Favorites,
screenshots and location filters use the library's existing facts. All Photos can
group by day or bounded capture-time moments; filters preserve reviewed selections.
Saved photos
opens the account library directly. Select → Save and the viewer's Save preserve
the exact reviewed sources; an unlocked account starts that manual batch, and
password entry completes the same Save if needed. Sync offers one explicit
Turn on sync choice. It remembers this account and service, then saves permitted
supported photos of any age and new photos while Fotoro is open. Pause persists
across reopening; Resume is explicit. Turn off stops automatic work without
deleting originals or photos already saved. Each automatic batch first reconciles
the account catalog, then uses an indexed digest lookup before staging a new upload.
This prevents sequential fresh-device reuploads; simultaneous first uploads can
still create duplicate catalog entries.

One Fotoro password opens the same saved photos on iPhone and the web. New Fotoro
creates that password; Open Fotoro opens the account. The iPhone keeps it in
protected Keychain. A remembered account opens locally while its session is valid;
expired sessions renew through a signed password proof at initial launch or an
explicit Open Fotoro. Manual lock is respected. Reopening resumes photo sync only
for an opted-in, unpaused account with current Photos access.
Settings shows the current account reference, Fotoro password
and Sign out. Existing passkeys remain under Settings, and existing recovery codes
work in the password field.
If a remembered account cannot open, Use another password exposes the same
password entry without signing out or removing unfinished work.

Native search covers all permitted non-hidden still photos, including older photos
outside the 10-day canvas. It indexes supplied labels, available metadata and
English text using Vision on one bounded local preview at a time. Local Vision
classification adds conservative scene categories with separate “Inferred scene”
evidence. Date searches include today, yesterday, last week and explicit date
ranges, with calendar/timezone boundaries. Scene classification failures preserve
text search. Visual similarity uses a pinned MIT-licensed TinyCLIP ViT-39M/16
Text-19M Core ML conversion on bounded device and saved previews. Its public model
packages download once, about 112.9 MiB before compilation; queries, photo pixels
and vectors stay on the device. Dates, labels and
recognized text continue working while the model prepares. Explicitly chosen
search meanings are preserved. This does not establish named person identity. Indexing does
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

Places shows photo stops in capture-date order. Native Photos locations and JPEG/HEIC
EXIF GPS from file originals travel in private encrypted annotations; released clients
keep reading the same wire format. Photo details opens the coordinate in Maps on request.
An optional browser import accepts supported Google Maps Timeline JSON exports,
previews conservative matches for photos without GPS and applies them only on confirmation.
Matching requires a verified capture instant, including an EXIF time-zone offset.
Reopen the original when a saved file photo lacks that proof. Timeline history stays
in browser memory; only confirmed photo locations are retained. Save photo changes
publishes queued location edits to the same Fotoro on other devices.

Browser imports automatically suggest diverse moment highlights using
small local previews, clarity/exposure, favorites and verified capture-date variety.
Only visually similar bursts with verified original capture times are grouped;
ambiguous dates stay separate. Review lets you change picks, select all or restore
the suggestions. Every original stays unchanged and every imported photo remains
searchable. Save carries the reviewed subset through account setup;
opening Saved does not upload it. Picks are session-only, and retained
previews require reselecting the original before upload. This selector is currently
implemented in both the browser and native app. Both support a reviewed subset;
native selection can also save older permitted search results from their viewer.

Browser visual similarity runs MIT-licensed TinyCLIP ViT-8M/16 Text-3M with a
quantized ONNX graph in a lazy worker. Pinned model and tokenizer files total
26.6 MiB, plus 12.0 MiB of runtime files on Safari or 21.8 MiB on other browsers.
These cold downloads are separate from local browsing startup: the current build's
static JavaScript graph is 364,013 bytes across three chunks, within the 500 KiB
guard. Model downloads are cached; private photo pixels and
queries are never uploaded. Vectors are session-only and cleared when access locks.
Native and browser vectors use separate model identities and are never compared
across processors. The native Core ML conversion is a community artifact with
pinned source hashes; its conversion has not been independently reproduced.
See [model provenance and licenses](docs/foundation.md).
The real-model smoke check verifies one public scene against contrasting queries;
held-out retrieval accuracy and device latency still need measurement.

Search shows one photo with its source evidence and alternative meanings. Add
labels in Photo details. Choosing a meaning, confirming a photo and pinning its
representative are separate explicit actions; merely inspecting a preview does
not teach a preference. Text mentions never establish named face identity.

On iOS, select photos and tap Save, or tap Save in a photo viewer. Preparation
processes one original at a time. Continue saving resumes queued encrypted files.
Editing labels does not start uploads. Reopening Fotoro starts photo sync only
after the explicit Turn on sync choice. Saved shows sync progress and Pause/Resume.
Returning to Saved checks the catalog; pull down to refresh it explicitly.
These reads do not send queued uploads or edits.
Encrypted file uploads already scheduled can finish through iOS
background transfer; force quitting interrupts system transfers. In the browser,
Saved opens the encrypted account catalog. Opening it preserves selected files and
uploads nothing; Save starts the chosen upload. Sign-in, returning to
the tab and reconnecting may refresh the saved catalog but never send pending
originals or edits. Continue and Save changes are explicit actions.

Account annotations are bound to the unchanged original digest, encrypted with
the account vault key, signed and revisioned separately from media. Label edits
and text wait in an encrypted outbox until an explicit save or Sync changes action.
Concurrent edits preserve changes to
different fields; a conflicting field waits for an explicit choice. Private
annotations are absent from shared grants.

Native imports preserve JPEG/PNG/HEIC, MP4/MOV originals, and complete Live Photo
still/MOV pairs byte for byte, up to 50 MiB per logical original. A signed media
manifest kind keeps new media out of legacy readers; new readers explicitly opt
in and require the server's media-version acknowledgment before advancing their cursor.
Native browsing copies are JPEG thumbnails at 320 px and previews at 1600 px, quality
82%; they never replace the original. Safari displays HEIC through those copies
and downloads the untouched HEIC. Browser imports accept JPEG/PNG and supported
HEIC stills when the native browser decoder is available. Verified primary-image
EXIF capture dates support grouping and search; Timeline matching additionally
requires a verified time-zone offset. Larger
camera originals remain visible skips. Saved video and Live Photo motion can be
played after verification; Save to Photos restores their original resources.

Production limits each account to 10 GiB of allocated ciphertext by default.
Reservations consume headroom atomically; unused leases expire, while writes
that started keep their charge even if interrupted. Promotion can retain both
staging and final copies, so this is an allocation limit rather than an exact
R2 billing total. Auth and enrollment limits return a timed retry. Object
collection and full disaster-restore qualification remain unfinished.

Selected photos open the standard system share sheet after originals are verified.
Browser sharing prepares the originals first, then uses a fresh user click; platforms
without file sharing offer explicit downloads. Share in Fotoro chooses an accepted contact. Public contact
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
Named people, cleanup, optional remote AI enrichment, nearby transport, large-video
uploads and full-library scale qualification remain planned work.
