# Fotoro first slice: a private two-person photo exchange

October 1, 2026. Written design for user review. The approved conversational
direction is native iOS + Safari, selective open-source reuse, and a simple
photo experience independent of Ente as the application base. The user's
subsequent instruction to proceed approves this written spec. The user approved execution of the written plan on October 1, 2026.

## Outcome and boundary

Two people can import still photos, recognize a moment, explicitly share it,
view it on iPhone or Safari, save independent copies, and contribute back.
Original bytes survive the round trip. Authentication, key enrollment and
recovery are part of the foundation; a pretty fixture UI alone does not pass.

The first supported media types are JPEG and PNG, with a 50 MiB original limit
and 100 photos per exchange. Reject other types with a clear explanation; do
not convert and pretend their originals were preserved. HEIC, Live Photos,
video, chat/page Share extensions, full-library backup, face embeddings,
Gemini enrichment, stories, cleanup and native nearby transfer follow the
roadmap as separate slices. Local EXIF dates and chronological moment grouping
are included. Limitations must be visible where they affect an import.

Native intake is explicit selection into Fotoro's catalog, rather than mirroring
the entire device library. For Photos assets, request access to the selected
resource and read the unmodified original with PHAssetResourceManager. An edited
asset imports its unmodified resource; explain that its Photos edit is not
included. A JPEG offered through HEIC transcoding does not count as a supported
original. Reject Live Photo pairs in this slice. iCloud-only resources show a
pending download that can fail/retry; unavailable originals never become
verified imports. The digest is computed over the actual source resource bytes.

## Experience

- Open into a local chronological photo canvas before fetching remote state.
  Moments are reversible views over capture times, initially local-day groups.
  Missing dates use import time and retain that provenance.
- Search and Add are the only persistent action controls. Selection reveals
  Share. Opening a photo supports paging, zoom, accessible buttons and return
  to the same thumbnail/scroll position. Use native glass on iOS and a legible
  CSS approximation on web; reduced motion/transparency remains supported.
- A recipient card/code identifies the intended account. No mandatory contacts
  access, album naming or AI setup. The sender chooses ongoing access or a
  15-minute grant and sees exactly which photos are included.
- Invited, viewed and saved are distinct factual states. The recipient explicitly
  saves; contributing back adds their photos to the same shared moment view.
  Ongoing access applies only to that moment, not the whole library.

## Structure and reuse

Create the fresh application under `fotoro/` in the existing GitHub repository.
The current Ente-derived runtime remains a reference and keeps its own scripts
and dependencies. No new code imports its account/product services by default.

| Component | Responsibility | Reuse |
| --- | --- | --- |
| apps/ios | iOS 26+ capture, local catalog, viewer, encryption, transfer journal and save/contribute | SwiftUI, PhotoKit, AuthenticationServices, GRDB; Nuke for cloud representations |
| apps/web | Safari 26+ photo viewer/import, local cache, encryption, passkey ceremonies and receive/save/contribute | React + Vite + TypeScript, IndexedDB, TanStack Virtual, SimpleWebAuthn browser |
| services/api | Auth, grants, upload reconciliation, catalog cursors and authorized ciphertext delivery | Hono, Cloudflare Workers/D1/R2, SimpleWebAuthn server |
| packages/contracts | Versioned JSON Schema, Swift/TS models, canonical signed payload rules | Schema-validated fixtures and libsodium cross-language test vectors; generation tooling is an implementation choice |
| fixtures | Public media, two-account service fixtures, positive/negative crypto vectors | Reproducible local fixtures; no personal-library copies |

## Identity, vault and trust

Passkey authentication authorizes an account session. It does not imply access
to the vault key. On first enrollment the client creates random vault, box and
signing keys; private keys are stored inside an encrypted account bundle.
The service stores public keys, encrypted envelopes and opaque identifiers.

A random 256-bit recovery secret wraps the account bundle with libsodium
authenticated encryption. It is displayed through the real user flow and must
be saved before presenting recovery as available. The service never receives
the secret. A supported passkey PRF can add a credential-specific wrapper;
removing that credential does not remove recovery or other trusted-device
wrappers. Without PRF, a new device uses recovery or approval from a trusted
device. Unsupported providers must not produce a broken vault.

Trusted-device enrollment binds the authenticated account, device public key,
one-time challenge and intended origin. QR approval or recovery verifies the
binding before the bundle is wrapped to the device. Requests expire and cannot
be replayed. A replacement recipient key requires renewed trust. Recipient
public keys must be pinned from an account card received through an authentic
user-chosen channel/QR, rather than silently trusting a mutable server key
lookup. There is no claim that this new protocol inherits an upstream audit.

Account cards pin both box and signing keys. Every contributor's signing key
must pass the same authentic enrollment/pinning flow before their contribution
is accepted. Key replacement stops acceptance until trust is renewed.

An enrolled native device protects its local bundle with Keychain. An enrolled
web device persists only an encrypted bundle, PRF input and credential identifier;
PRF-capable credentials unwrap it locally. A non-PRF web session keeps the vault
key in memory and uses trusted-device approval or recovery again after reload.
Explain that fallback at enrollment. Cached photo browsing works offline once
the vault is unlocked; before unlock show only the locked shell. Lock clears
private keys and decrypted media from application memory; sign-out also removes
account wrappers and caches, after warning about pending unsent imports.

Freeze RP ID, allowed origins, associated domains, credential-specific wrapper
inputs/nonces and one-time device-challenge transitions with the common
contract. Production RP is fotoro.cloud; a loopback fixture configuration is
separate and cannot enroll production credentials. Credential removal deletes
only its wrapper; verified recovery/other-device access must remain available.

## Original storage and protocol

Use the same libsodium primitives through swift-sodium and libsodium.js.
Each representation has its own random key and secretstream header. Sequential
files use libsodium XChaCha20-Poly1305 secretstream with 4 MiB plaintext records;
the last record carries TAG_FINAL. Reject truncation, reordering, trailing data
and authentication failures. This format does not promise random-access video.

Define one versioned framing/manifest contract before client work branches:
opaque photo/representation IDs, algorithm and version, record lengths, header,
ciphertext size/digest and immutable object references. Encrypted metadata holds
original filename, media type, capture-time provenance, plaintext size/digest and
the representation keys. Signed canonical manifest/envelope payloads bind the
owner, moment, grant, recipient, version and content references. Use libsodium
sealed boxes for recipient confidentiality and Ed25519 signatures for sender
authentication; sealed boxes alone do not authenticate the sender.

Generate a small JPEG thumbnail and a medium JPEG preview before encryption;
retain the JPEG/PNG original unchanged. Decode previews only when needed.
Native plaintext caches use platform data protection; web decrypted Blob URLs
are bounded, revoked when replaced and cleared on lock/sign-out. Persistent
web media caches contain ciphertext. Cache data must be reconstructible.

Uploads follow reserved → uploaded → committed states with idempotency keys.
Stage ciphertext durably before upload so a restart can retry exact bytes.
R2 writes and D1 commits are reconciled; neither is treated as one transaction.
The local journal reconciles ambiguous finalization before retrying. Scheduled
orphan cleanup deletes only abandoned, unreferenced objects.

Signed uploads target staging keys only. Finalization reads the staged object
at an observed ETag and promotes that version into a fresh private final key
that has never been exposed through a PUT capability. Record the final reference
only after promotion. Retries reuse the reserved finalization identity. A replay
against staging after commit cannot modify the final object. Final keys have no
client overwrite endpoint; cleanup of staged bytes is separate from final data.

Native pending ciphertext lives in Application Support, not an evictable cache.
Web staging is separate from the bounded ciphertext read cache: never evict an
uncommitted upload as ordinary cache cleanup. Quota/write failures leave an
incomplete import with no backup claim. Browser storage can still be evicted;
keep source files with the user until commit and request re-selection to recover
missing staged data. Durable browser staging is not the only surviving original.

R2 is private. Every new download request passes through an authenticated
Worker that checks current ownership or grant access, using authoritative
permission reads. Direct signed upload URLs are restricted to the owner's
reserved object/version. No long-lived signed download capability defeats
grant revocation. A transfer authorized before expiry may finish; requests
started at or after expiry are denied. Already received bytes/keys remain usable.

## Save, contribute and synchronization

Saving creates a recipient-owned encrypted catalog record with keys wrapped
for their vault. Its immutable object references remain retained independently
of the sender/grant; removal from a shared moment cannot delete a saved copy.
Confirm the original digest on the client before reporting a verified save.

Save means retention in the recipient's Fotoro library. Export to Photos/Files
is a separate later action; this slice provides an original-file download in
web and does not claim round-trip Photos-library export. The save mutation checks
the active grant and expected version, then atomically/idempotently creates the
recipient catalog record and retention reference in D1. Cleanup cannot race
that retained reference. A revoked grant denies a new save operation even when
the recipient previously viewed the preview.

Only active contributor grants permit attaching new photos to a shared moment.
Contribution manifests carry the contributor's verified signing identity.
Every relevant SQL mutation includes authorization and expected-version
conditions; dependent writes cannot proceed after a zero-row conditional result.

Catalog changes use bounded cursor pages, opaque stable IDs and tombstones.
The client applies each page transactionally and retains its cursor. Duplicate
uploads, retried contribution/save operations and stale responses are handled
idempotently. Browsing remains possible offline; actions needing remote access
show pending/failure state with retry instead of fabricated completion.

## Verification and release

1. Swift encrypts / web decrypts and the reverse; shared vectors reject tampering,
   wrong keys, swapped representations, truncation, reordering and unknown versions.
2. iPhone sends → Safari receives/saves → Safari contributes → iPhone restores.
   Original digests match in both directions after a clean local-state reset.
3. Interrupted uploads/finalization recover without duplicate catalog entries;
   failures between R2 and D1 do not lose or expose originals.
   Replaying a staging PUT after finalization cannot change a committed original.
4. Unrelated accounts cannot list/download/contribute. Revoked/expired grants deny
   new requests. Recipient-owned saves still restore after grant removal.
5. PRF-capable and non-PRF enrollment, recovery, device approval/replay rejection
   and credential removal are exercised. Production auth excludes fixture bypasses.
6. A 10,000-item catalog fixture with at least 1,000 distinct thumbnails verifies
   virtualization, focus and restoration while sync runs; the 100-photo exchange
   limit is a separate scope. Restore by stable photo ID plus offset when sync
   changes preceding items. Measure on iPhone 13 at 60 Hz with iOS 26+ and Safari
   26+ on the development Mac. After unlock and an initial warm pass, 20 library
   opens target p95 ≤500 ms; 100 cached neighboring previews target p95 ≤100 ms.
   A 60-second scripted scroll targets fewer than 1% frames exceeding 33 ms.
   Bound decoded-image cache to 48 MiB and ciphertext read cache to 500 MiB
   native/100 MiB web; native process peak memory target is 250 MiB. Quota
   pressure reduces read caches, never pending staging. These are acceptance
   targets, not current results.

Physical-device passkeys, associated domains and TestFlight require real
signing/domain configuration. Local fixtures/Simulator prove their own scope;
production deployment and credentials are not implied by this spec.

## Parallel ownership

The coordinator freezes schemas, envelope/framing contracts and golden vectors
first. Then three implementers own disjoint paths: native, web and service.
Clients can use contract fixtures while the API is built. Shared-contract and
root dependency changes go through the coordinator. One integrated two-account
flow, independent review and the acceptance checks above gate completion.

## References

[Roadmap](../../ai-photos/roadmap.md),
[libsodium secretstream](https://libsodium.gitbook.io/doc/secret-key_cryptography/secretstream),
[sealed-box authentication limit](https://libsodium.gitbook.io/doc/public-key_cryptography/sealed_boxes),
[R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/),
[SimpleWebAuthn PRF](https://simplewebauthn.dev/docs/advanced/prf).
