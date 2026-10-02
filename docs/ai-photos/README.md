# Earlier Ente reference experiment

The active build has moved to [fotoro/](../../fotoro/README.md): native SwiftUI,
React and a Cloudflare Worker. The instructions below describe the earlier
Ente reference experiment, not the current app. Use the new run instructions.

Reference branch: `codex/ai-photos`. The current web app and API are live at
[fotoro.cloud](https://fotoro.cloud). Current native releases and open acceptance
checks are recorded in [release setup](../../fotoro/docs/deployment.md) and
[verification](../../fotoro/docs/verification.md). The instructions and milestones
below belong to the earlier experiment.

This fork retains Ente's Flutter iOS app, React web app, Go Museum server,
encrypted storage and sync, album sharing, cleanup, and video playback.
Fotoro's `/library` presents the real encrypted account catalog and uploader with
a virtualized photo grid, metadata search and separate catalog/upload status.
The selected-photo intelligence preview remains separate; its AI index has not
yet been connected to account sync.

## Run and iterate

From the repository root:

```sh
node scripts/ai-photos.mjs doctor
node scripts/ai-photos.mjs services
node scripts/ai-photos.mjs web
```

Open http://localhost:4300/library for the account library (sign-in required),
http://localhost:4300/intelligence for the session-only intelligence preview,
or http://localhost:4300/gallery for the upstream gallery presentation.
The source web server reloads
when edited; Rust WASM only needs rebuilding when its source changes.

```sh
node scripts/ai-photos.mjs test
node scripts/ai-photos.mjs typecheck
node scripts/ai-photos.mjs build-web
node scripts/ai-photos.mjs stop
```

`stop` stops containers without removing local databases or photos.
`build-web` exports the Photos app to `web/apps/photos/.next-fotoro-build`;
Next's static export uses this configured output directory. It does not
overwrite the live dev server's `.next` directory.
The wrapper defaults to the local Museum endpoint; set `NEXT_PUBLIC_ENTE_ENDPOINT`
to the intended API URL **before building** a deployment export. The endpoint is
baked into browser assets. An export built against localhost is for local QA.
The development services bind to loopback: Museum 4800, MinIO 4320,
prebuilt photos 4390, accounts 4391, public albums 4392.
The service command reuses `server/quickstart.sh` from this checkout to generate
random credentials. Config files and toolchains are ignored by Git.
Use synthetic images and throwaway accounts while iterating.

## First-time dependencies

Use Node 22.23.3 or a compatible supported Node release, npm 11.12.1,
Docker Compose 2.30+, Flutter 3.47.2 (the upstream CI pin), Rust 1.98.1,
Go 1.26.6 (the upstream toolchain pin), and Xcode 27 for the new Apple APIs.
Xcode and Docker must be installed and Docker running before the commands above.

Local SDK locations used by the wrapper:

```text
.tools/flutter/bin/flutter
.tools/cargo/bin/rustup
.tools/rustup/                 # Rust toolchains
.tools/go/bin/go
```

Download the pinned Flutter SDK from the official release archive and extract
under `.tools`. On macOS ARM64 its zip SHA-256 is
`f456fd6733053d9301828a2e702d6cbec872923126809aa8c48eb0a696d6cc01`;
the upstream action includes checksums for other platforms.
Install Rust with official rustup using `CARGO_HOME="$PWD/.tools/cargo"`,
`RUSTUP_HOME="$PWD/.tools/rustup"`, `--no-modify-path`, and toolchain `1.98.1`.
Extract Go 1.26.6 from go.dev under `.tools/go` after checking its published checksum.
No global shell PATH edits are necessary.

```sh
node scripts/ai-photos.mjs setup-web
node scripts/ai-photos.mjs setup-mobile
node scripts/ai-photos.mjs setup-ios
node scripts/ai-photos.mjs ios
node scripts/ai-photos.mjs ios-sim
```

Mobile setup enforces the Flutter lockfile, prepares Rive iOS binaries, and
generates Flutter/Rust bindings. `setup-ios` installs the upstream-pinned
CocoaPods 1.17.0 into `.tools/gems`. It needs a modern Ruby: this machine uses
Homebrew Ruby 4.0.7 through the ignored `.tools/ruby` symlink. On another Mac,
install Ruby from its official distribution or Homebrew and put its directory
at `.tools/ruby`; no global shell PATH edit is required. The wrapper supplies
Ruby, gem and Flutter paths for each invocation.

The unsigned device and Simulator builds have passed. The fork adopts Flutter's
scene lifecycle for Xcode 27 and pins `home_widget` 0.10.0 to reuse its upstream
null-value crash fix and scene support. The iOS 27 Simulator reaches Ente's
existing onboarding. The photo-first redesign below is currently the web preview;
its native UI port remains product work. Signing and TestFlight still require
the user's Apple developer configuration.

## New feature and model decision

The preview reads selected image files locally, extracts EXIF dates/camera
metadata with Ente's existing parser, computes SHA-256 exact duplicate groups,
and builds a fast local search view. It never deletes a photo.

The user chose **`gemini-3.8-flash`** on September 30, 2026. Cloud analysis is
off until explicitly enabled with a paid key and committed with Done in the
developer connection sheet at `/intelligence?setup=1`. It then indexes in the
background, with pause/resume controls and no automatic retry of failed calls. It sends only a JPEG preview with a
1536-pixel maximum edge and no EXIF; visible faces and readable text are still
part of that image. It returns validated structured descriptions, tags, and
visible text. Identical originals reuse descriptions within the session.

The development page accepts a user's own paid API key in memory. Do not put a
shared production key in this static frontend. A production deployment needs an
authenticated relay, quota controls, consent/revocation handling, and encrypted
index persistence through Ente's existing per-file key hierarchy.

The main screen is a photo canvas with one floating glass search/import
control. Exact duplicates expose a contextual review action. Tap a photo for
the full-screen PhotoSwipe carousel: thumbnail zoom, horizontal swipe,
pinch/double-tap zoom, vertical dismissal, keyboard navigation, and focus return.
Details open on demand. Browsers that support file sharing expose the system
share sheet for the original file. The preview does not implement trusted-contact
grants, nearby transport, or duplicate deletion. Search and duplicate review work
with cloud disabled. See `design.md` for the interaction decisions and boundaries.

Search in this preview matches words in names, EXIF, descriptions, tags, and text.
It is lexical search; semantic embeddings and person/date query composition
remain product work. Refreshing clears the preview's files, index, and API key.

3.8 standard API pricing is $0.75/M input tokens and $3.75/M output tokens,
including thinking, through December 31, 2026; published rates double January 1.
Batch is half the standard rates. At an illustrative 1,000 input and 200 total
output tokens per photo, 10,000 photos cost $15 standard or $7.50 batch.
This preview uses standard requests with low thinking and reports actual token
usage; image resolution, thinking, failures, and response length affect bills.
It stops on errors rather than silently retrying paid calls.

Sources checked September 30:
[model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash),
[pricing](https://ai.google.dev/gemini-api/docs/pricing),
[paid API terms](https://ai.google.dev/gemini-api/terms).
Google's API receiving a preview is a separate disclosure from Ente's encrypted
backup; do not describe cloud enrichment as end-to-end encrypted inference.

## Remaining product milestones

1. Native iOS worker: existing Vision OCR, metadata and dedup first; device-friendly
   background scheduling; optional 3.8 enrichment; encrypted index sync.
2. Unified semantic retrieval on native and browser, measured against a fixed
   photo/query set. Resolve checkpoint licensing before shipping Ente's current
   MobileCLIP model; its source-code license does not grant model usage rights.
3. Primary passkey unlock with PRF-wrapped account keys and recovery. Upstream
   passkeys currently act as a second factor; that is not the requested final flow.
4. Trusted contact grants: permanent family or 15-minute friend windows; expiry
   governs receiving more photos, while already received copies remain.
5. Native nearby transport using Wi-Fi Aware/Network where supported, plus relay
   fallback; physical-device testing, interruptions, and permission revocation.
6. Original restore/digest verification before cleanup; R2 ciphertext storage
   integration and cost checks; real device performance and a signed iOS build.

Keep each milestone a small vertical slice with a reviewable diff and one clear
acceptance flow. Reuse Ente's existing mechanisms before creating a parallel one.
