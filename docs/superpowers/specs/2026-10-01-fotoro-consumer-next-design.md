# Fotoro next consumer release design

## Intent

The user wants a radically simple, attractive iOS and Safari photo app that makes
recent photos easy to browse, useful pictures easy to find, and backup easy to
understand. They explicitly want independent work in parallel. This design turns
that request into a small consumer release, followed by separately measured AI
work. It does not promise parity with every Apple/Google feature in one release.

## Current evidence

- `d460a403e6` passes both CI jobs: 11 core, 27 API, 115 web, 3 real HTTP exchange
  tests; native executes 85 tests with one expected permission skip and no failures.
- Local iOS and browser previews are running. Encrypted originals, previews,
  annotation outboxes, local OCR, metadata/label search and scheduled encrypted
  background uploads exist.
- Independent source audits found five native and five browser consumer gaps.
  The native Pause regression is repaired separately from UI work: three new
  controlled regressions reproduce it before the fix; all 88 native tests pass
  locally afterward. New-revision remote CI is separate from the baseline above.
- HTTPS API/AASA deployment, physical signing and phone-to-Safari acceptance are
  release blockers. They require actual provider access and a connected phone.
- Earlier CI loopback connection losses remain unexplained. A later unchanged
  production build passed; that is not evidence of a transport fix.

## Consumer promise

**Open -> see photos -> search -> open the right picture -> share.**

**Enable backup -> choose last 10 days -> see progress -> find the same photo in Safari.**

Local browsing works before account creation. Signing in alone does not start
uploading the Photos library. A first-time backup scope choice is explicit.

### Home

A photo grid leads the screen. Search is easy to reach with one thumb. A compact
backup indicator opens one status sheet. Account/security controls live inside
that sheet; they do not replace the photo experience.

Native launch restores already-granted PhotoKit access without a new permission
request. First use asks for access through the existing system flow. Limited and
denied permissions remain truthful. Safari uses explicit selection; it cannot
silently enumerate the iPhone library.

### Search

Photos lead results. Opening and swiping require no confirmation. Existing
ranking, feedback and ambiguity rules remain internally intact. Only meaningful
alternative choices appear when useful; detailed provenance and optional
corrections live behind Info. Remove predicted/accepted/meaning/representative
vocabulary from the normal path.

One search should cover permitted local photos and verified owned saved photos.
Keep their source identities and access checks. Deduplicate only using a verified
source mapping or original digest; never merge by filename, date or visual guess.
Changing accounts or locking removes account-owned search results. Revoking local
Photos permission removes that local source; independently owned cloud originals
remain subject to the account's existing authorization.

Text reading is offered directly after Safari selection, not discovered through
Settings. Local persistence gets an explicit nearby choice. It retains bounded
previews and search data, not silently retained original files. On-device native
OCR can prepare local previews automatically after permission, with progress that
does not block browsing. iCloud-only text coverage must remain honest.

### Backup

One sheet communicates state, photo-level completed/remaining counts when known,
last successful catalog check, skipped items and one relevant action. Preparation,
encrypted upload and final catalog commit are distinct internally. A photo counts
as saved only after its verified catalog commit. Annotation failure or skipped
media cannot disappear behind an unconditional completion message.

Presentation states: notStarted, preparing, uploading, checking, upToDate, paused,
offline, needsAttention. These are client presentation values, not a new wire
protocol. No invented ETA or fabricated total. Paused and offline are different;
explicit Continue resumes a pause, while reconnection may resume an enabled job.

Pause persists across foreground and process restoration, preserves queued work,
and stops future automatic uploads and annotation writes. Read-only refresh may
continue. Manual Files imports before Photos backup opt-in remain supported.
Lock, Pause and sign out retain their distinct security semantics.

Background wording describes actual capabilities: already scheduled ciphertext
can continue; additional PhotoKit preparation and final commit need the unlocked
foreground app. Never promise continuous unattended whole-library backup yet.

### Viewer and sharing

The photo fills the viewer. Share, Favorite when supported, and Info are familiar
contextual actions. Local and owned saved photos expose standard system sharing
of a verified original, with download fallback in browsers. A retained local
preview clearly asks for the original when sharing needs it. Never silently send
a preview as the original. Private annotations never enter a shared file/grant.

Encrypted account-to-account exchange remains a separate advanced workflow until
recipient discovery/approval has a consumer design. Pasted account-card JSON is
excluded from the main Share action. Preserve existing trust and grant checks.

### Appearance

Use existing native SwiftUI/iOS 26+ controls and system glass for floating chrome.
Keep glass off photo content and avoid layered translucent surfaces. Safari uses
its existing lightweight UI primitives; no new design-system dependency is needed.
Keep accessible targets, contrast, reduced motion and safe-area/keyboard behavior.
Use real photo content, not decorative AI imagery, to make the interface attractive.

## Next intelligence release

Receipts, screenshots and bookings are the first retrieval tasks. Favorites and
screenshots can use verified existing metadata. Places/trips need actual location
and date evidence. People requires a real face pipeline and correctable grouping;
supplied name labels must not be presented as detected identities.

Semantic/face work starts with an isolated feasibility/quality experiment using
public samples. Reuse upstream Ente preprocessing, versioning and test vectors
where suitable. Its current web ML inference bridge is Electron-specific, not a
ready Safari implementation. Check exact model and source licenses, packaging,
download size, cross-platform parity, memory and thermal costs before integration.
A future encrypted derived index must bind original digest and model/preprocessor
version, support invalidation, and remain private across account/permission changes.
Do not upload personal photos to an inference provider under this design.

AI editing, video intelligence, duplicate deletion, Live Photo motion backup and
nearby recipient discovery are separate releases. Browser HEIC import is an
important interoperability gap to investigate; do not imply that local JPEG/PNG
selection already handles every iPhone format.

## Release acceptance

Use a consented physical iPhone corpus containing at least 10 days of photos,
including receipts, screenshots, an older searchable picture, HEIC, an iCloud-only
asset and unsupported video/Live Photo cases. Verify:

1. First use and relaunch land in the right permission/gallery state.
2. A neutral-filename receipt is found from recognized text without a settings hunt.
3. Account creation/sign-in returns to the requested backup step without an upload
   starting before scope confirmation; recovery instructions remain accessible.
4. Same-account Safari restores a committed original and encrypted labels/text.
5. Pause -> background -> reopen remains paused; Continue resumes queued work.
6. Lost commit response/reconnection/restart reconciles without duplicate originals.
7. Local and saved originals use familiar sharing; cancel is silent.
8. Lock/account switch/permission revocation remove only the relevant source data.
9. Completion names skipped/failed items; originals remain byte-identical.
10. A 10,000-item/1,000-thumbnail device run measures rendering, query-to-visible
    preview, memory, battery and indexing throughput, not just metadata lookup.

## Success boundary

This release earns a usable, understandable photo-to-Safari experience. It does
not earn a best-on-market claim. Comparative search quality needs a held-out corpus
and the same tasks run against relevant existing products.
