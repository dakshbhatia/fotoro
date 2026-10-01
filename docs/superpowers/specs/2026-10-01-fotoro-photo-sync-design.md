# Fotoro Photos sync

The user wants to open a simple iOS app, sync their recent Photos library, and see
the same pictures in Safari with understandable setup, progress, quality and
format behavior. This extends the existing encrypted catalog and resumable
transfer journal. No second storage service or authentication shortcut is added.

## Flow and defaults

- Local browsing remains available without an account or uploads.
- Sync photos explicitly opens account setup. Create account and Sign in are the
  primary choices; recovery connects another device when passkey vault unlock is
  unavailable. Saving the recovery code remains required for account creation.
- After a real account is unlocked, native onboarding offers Sync last 30 days.
  The user starts it explicitly; public fixture accounts cannot sync a private
  Photos library. Previously queued work is retained even when its source ages
  out of the 30-day selection.
- Native sync runs sequentially while the app is active and unlocked. Pause,
  Retry and foreground resume are explicit. Do not promise completion while the
  app is closed; durable background scheduling remains a release requirement.
- Safari refreshes the same account's encrypted catalog while visible/online.
  Local browser file selections are preserved separately and uploaded only after
  an explicit Sync selected photos action. Lock cancels active work.
- One status presents actual pending/completed/failed/skipped counts and the last
  successful catalog check. A failure or skipped source must never be called
  fully synced. Account changes cannot publish a previous account's status.

## Original fidelity and resources

Original JPEG, PNG and HEIC still files are preserved byte for byte and verified
by their digest. The original size limit remains 50 MiB per photo. Native creates
320 px thumbnails and 1600 px previews as JPEG at quality 0.82; those are browsing
copies, not a compressed-original backup mode. The browser can view native HEIC
uploads through these JPEG derivatives and download/share the untouched HEIC.
Browser-local HEIC intake is still unsupported when dimensions cannot be bounded.
Live Photo motion pairs and video are visibly skipped rather than silently
flattened into JPEG. No AI/face indexing is implied by sync.

PhotoKit source identity is the account-scoped localIdentifier. Photos edits do
not re-upload the unmodified original. New original-byte digests reuse an owned
local catalog record where possible, including sources restored from the cloud.
Source checkpoint, catalog record and transfer entry commit in one local database
transaction; the same source cannot produce a new random photo after a crash.
Stage at most one source before uploading/reconciling it. Ciphertext stays in
protected Pending storage until a verified server commit.

## Verification and release boundary

Test real HEIC bytes/extension and JPEG derivatives; source restart, repeated
scans, pause/cancel, stale account/lock completions, unsupported sources and
partial upload receipts. Exercise the actual browser sync/status UI and native
onboarding against public samples. Existing crypto/API/exchange tests remain.

Cloudflare is currently unauthenticated and Apple signing/domain validation is
unconfigured. Implementation and localhost verification can continue. A personal
iPhone-to-Safari cloud acceptance run requires normal provider sign-in, a real
HTTPS deployment, Apple signing and a connected phone; it must not be reported
complete until those are supplied and tested.
