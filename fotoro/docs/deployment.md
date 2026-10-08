# Fotoro releases

The active app is `fotoro/`: SwiftUI on iPhone, React/Vite on the web, and a
Hono Worker with D1 and private R2. The upstream Ente application is a reference.

## Production

- Origin: `https://fotoro.cloud`, with web assets and `/v1/*` on one Worker.
- D1: `fotoro-production` (`a2c6f91e-5021-4b2f-8c9a-dfd18a9ea26e`).
- R2: `fotoro-private-production`, with public bucket access disabled.
- Authentication: production mode, secure sessions, production passkey RP.
- iPhone association: `A7TGPQ27JF.cloud.fotoro.Fotoro`.
- Account storage limit: 10 GiB. Logical camera original limit: 50 MiB.
- Originals, previews and thumbnails are encrypted by clients before upload.
- Visual search runs locally. Model downloads contain public weights; private
  photos, queries and vectors stay local on that path. Optional cloud observations
  require separate preview consent and explicitly configured provider/work limits;
  that route remains disabled by default.

### October 8 PR 51 checkpoint

The active Worker is `fc961e24-fc94-4b9a-a4b9-fdbecedbe01b` at 100%, deployment
`0323ca3a-13a3-4181-be90-2e4c61a12ba3`. Qualified PR 51 head
`63e51fbf0d1c6244bf266d484a8b6a7c716ca2b3` completed all 23 checks: seven success
and 16 intentional skips. Guarded merge `bbf15c60a7afc6222eda30e6ced422be6539edde`
has the same tree. All 46 non-HTML assets and root/Photos/Saved HTML match the
fresh fixture-free build. Seven auth/route/association checks, the service check
and all three startup checks pass; startup is 442,116 bytes across nine chunks.
All eight bindings and runtime are unchanged. No migrations or provider activation
were needed. Keep PR 50's `a4f88a21-b35f-4def-a07e-5c57543b8464` for rollback.

Browser Saved reads bounded windows, reports partial search coverage and preserves
chosen Photos items through explicit further loading. Public browser UI verifies
selection continuity, a correctly sized encrypted preview and byte-identical
original download. Native source adds paged album selection and reviewed Saved
People choices, direct passkey entry and optional current-view area names.
Build 47's audited archive and distribution IPA were accepted by Apple and read
back `VALID` / `IN_BETA_TESTING` in the same existing internal group. Physical
installation and family acceptance remain open.

### Earlier October 8 PR 50 checkpoint

The previously verified Worker was `a4f88a21-b35f-4def-a07e-5c57543b8464` at 100%, deployment
`26db1d26-de0a-4e28-b882-905684a1295f`. Qualified PR 50 head
`7dfe96d90830f3adee5533b6aea19e2d1be5ff96` completed all 23 checks: seven success
and 16 intentional skips. Guarded merge `ef4d85d91f974904d50759057859b57474328da9`
has the same tree. All 46 non-HTML assets and root/Photos/Saved HTML match the
fresh fixture-free build. Seven auth/route/association checks, the service check
and all three startup checks pass; startup is 440,288 bytes across nine chunks.
All eight bindings and runtime are unchanged; no migrations or optional provider
changes were needed. Keep PR 49's `850dabd0-5603-49a0-9330-28c98fede807` for rollback.

Browser Choose photos preserves its incoming album, while choosing from a different
active album clears the old invitation. Public desktop QA verifies explicit
contributions and fresh-session readback without console warnings/errors. Native
source adds reviewed Saved People choices, correction invalidation and independent
invitation opening, plus transient-commit retry and cancelled-catalog status fixes.
These checks do not establish physical family acceptance.

### Earlier October 8 PR 49 checkpoint

The active Worker is `850dabd0-5603-49a0-9330-28c98fede807` at 100%, deployment
`02649e71-2bbf-4fdc-8c48-27746ea9ee3f`. Qualified PR 49 head
`072cfa99d0f864c87cb8ed4132623efcd4274398` completed all 23 checks: eight success
and 15 intentional skips. Guarded merge `601bd3fab6cc964996c4ee3b0db427e04361044f`
has the same tree. All 46 non-HTML assets and root/Photos/Saved HTML match the
fresh fixture-free build. Seven auth/route/association checks and the service
check pass. Startup passes all three cases at 440,288 bytes across nine chunks.
All eight bindings and runtime are unchanged; no migrations or optional provider
changes were needed. Keep PR 48's `ba359106-30ac-4ac2-8f6a-0523c523a95a` for rollback.

The release adds bounded action diagnostics across native, web and API, including
independent server request references, client trace IDs, timings, decoding outcomes
and fixed waiting/failure reasons. Production verifies header/body reference
agreement, trace CORS and one exact final live log correlation. Photos Settings
shows Copy diagnostics and its copied notice; Saved account entry renders without
console errors. See [diagnostics](diagnostics.md) for collection and evidence limits.
These checks do not establish personal-account or installed-device acceptance.

### Earlier October 7 PR 48 checkpoint

The previously verified Worker was `ba359106-30ac-4ac2-8f6a-0523c523a95a` at 100%,
deployment `2f0d0d56-0cce-4d76-83e4-d2aa52f4b9b8`. Qualified PR 48 head
`f302ca09f30a2df7d65fe0d7d92e38870277ac20` completed all 23 checks; guarded
merge `2d14f8ba456fed053d2a0bd829e646c2172b1abc` has the same tree. All 46
non-HTML asset digests and root/Photos/Saved HTML match the fresh fixture-free
build. Seven auth/route/association checks and the service check pass. Startup
passes all three cases at 436,081 bytes across nine chunks. Production bindings
and runtime are unchanged, no migrations were needed, and optional inference
remains disabled. Production Photos and Saved entry render without console
errors. Preserve PR 47's `5314d5c1-6d9b-4081-9a6b-f27649fd0123` for rollback.

The release adds source-bound capture details to native and web Info, local-only
original-header reads, authoritative edited Photos dates/GPS, and adaptive native
Places clusters. Physical iCloud, background, passkey and family acceptance remain
open; geographic clusters do not establish resolved city identities.

### Earlier PR 47 checkpoint

The previously verified Worker was `5314d5c1-6d9b-4081-9a6b-f27649fd0123`
at 100%, deployment `910a7e1e-e2f7-4d19-8984-4bbd1bb72985` (2026-10-07,
merged [PR 47](https://github.com/dakshbhatia/fotoro/pull/47)). All 45 non-HTML
asset digests match the qualified build; Photos and Saved HTML routes match the
built HTML. All 23 checks passed or skipped for qualified head `332891661eb37927a55ff2101ae0cb0668281dd8`;
the guarded merge `a76bfa1cab4c7ab4392be8b6a0eddec28ae2e53a` has the same tree.
The 30-day default and metadata-first processing are deployed. A fresh build passes
all three startup checks at 430,339 bytes. An immediate asset propagation mismatch
cleared on bounded readback before release qualification. No new migration was needed.
Migrations 0007 and 0008 are applied, with schema and ledger read back and no
pending migrations. A private staging copy removed 0007's leading comment after
Wrangler rejected its semicolon; the qualified SQL statements were unchanged.
Production bindings were preserved, and optional inference remains disabled.
The preceding qualified version is PR 46's `8777a26f-ac52-4f7a-95ae-f2bdd94a188e`.
Read the current deployment back before
changing traffic; preserve the preceding qualified version for rollback.

Documentation-only edits do not change this runtime checkpoint and need no Worker
deployment or native archive. Current native distribution gates are recorded below;
[verification](verification.md) owns detailed release evidence.

## Release checks

From `fotoro/`:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:search:visual
pnpm test:exchange:isolated
```

The Fotoro GitHub workflow also compiles and tests both the full native app and
its isolated local Photos preview. The pinned-model smoke cases exercise actual
inference on a public photo; they do not establish held-out retrieval quality or
physical-device performance. Fix failed checks before merging. Require successful checks for the exact PR head,
then merge with a head-commit guard. Confirm the merged tree matches that qualified
head before building release artifacts.

Build production web assets from the qualified merged source with `pnpm build:web`.
Development fixture settings belong to local processes and must not be exported
into the production build. Keep the configured D1/R2 bindings and production
origin unchanged. Apply migrations only when the qualified change requires them. Optional cloud
photo understanding adds migration `0007_cloud_inference_work.sql`; its provider
key, enable flag and explicit account/global daily work caps must remain absent
until cloud inference is deliberately configured. See the API README for the
preview-consent contract and limits.

Use Wrangler's existing OAuth session in the intended Cloudflare account. Do not
copy credentials into chat, Git or release logs. From `services/api/`, prepare a
version with `wrangler versions upload --env production`, inspect its bindings,
then deploy the inspected version at 100% with
`wrangler versions deploy VERSION_ID@100% --env production`.
Publish assets and API together: media-aware clients require the server's
`mediaVersion: 1` acknowledgement, and older readers exclude new media kinds.

After cutover, require the expected Worker at 100%, matching built asset digests,
HTTPS routes and the exact signed Apple association:

```sh
pnpm check:service https://fotoro.cloud A7TGPQ27JF.cloud.fotoro.Fotoro
```

Use a public fixture for browser QA. Verify search, selection, sharing preparation,
responsive layout and console errors. A service health check does not establish
personal-account sync or original restoration on a physical phone.

## Native distribution

The last verified TestFlight build is 47 (0.1.0), independently read `VALID` and
`IN_BETA_TESTING` on October 8. The same existing internal group auto-linked it,
with the same one tester and no group, membership or access changes. What to Test
notes and their exact build linkage match independent readback. All 154 native
inputs and three release tools match qualified merged source
`bbf15c60a7afc6222eda30e6ced422be6539edde` through archive, Organizer distribution
export and accepted upload. Full encrypted archive and IPA audits pass. The
existing cloud-managed identity signed and uploaded it. Apple accepted the same
pinned ONNX resource-stub dSYM warning as 46; the main binary/static runtime and
matching dSYM pass audit. The unchanged approved encryption and France-exclusion
facts qualify the documentation-exemption metadata; no new declaration was created.
Build 47 adds paged Saved album/People choices, direct welcome passkey access and
optional current-view map-area names. Physical installation and installed-device
acceptance remain open.

The preceding verified TestFlight build is 46 (0.1.0), independently read `VALID` and
`IN_BETA_TESTING` on October 8. The same existing internal group auto-linked it,
with the same one tester and no group, membership or access changes. What to Test
notes and their exact build linkage match independent readback. All 154 native
inputs and three release tools match qualified merged source
`ef4d85d91f974904d50759057859b57474328da9` through archive, Organizer distribution
export and upload. Full encrypted archive and IPA audits pass. The existing
cloud-managed identity exported and uploaded after CLI export could not see the
account or a local distribution certificate. Apple accepted the same pinned ONNX
resource-stub dSYM warning as 45; the main binary/static runtime and matching dSYM
pass the audit. The same approved encryption and France-exclusion facts qualify
the documentation-exemption metadata; binary encryption is unchanged and no
declaration was created. Build 46 adds reviewed Saved People choices, correction
invalidation, album-selection continuity and native retry/cancellation fixes.
Physical installation and installed-device acceptance remain open.

The preceding verified TestFlight build is 45 (0.1.0), independently read `VALID` and
`IN_BETA_TESTING` on October 8. The same existing internal group auto-linked it,
with the same one tester and no group, membership or access changes. What to Test
notes and their exact build linkage match independent readback. All 154 native
inputs and three release tools remain unchanged from qualified merged source
`601bd3fab6cc964996c4ee3b0db427e04361044f` through archive, distribution export
and upload. Full encrypted archive and Organizer IPA audits pass. The existing
cloud-managed distribution identity exported and uploaded after CLI export could
not see the account or a local distribution certificate. Apple accepted the known
pinned resource-stub dSYM warning; the main binary/static runtime and matching
dSYM pass the audit. The same approved encryption and France-exclusion facts
qualify documentation-exemption metadata; binary encryption is unchanged and no
declaration was created. Build 45 adds the Sync diagnostics Copy/Share controls.
Physical installation and installed-device acceptance remain open.

The preceding verified TestFlight build is 44 (0.1.0), independently read `VALID` and
`IN_BETA_TESTING` on October 7. The existing internal group shows Testing for 44,
with the same one tester as 43. Only this build's assignment was added; tester
membership is unchanged. What to Test notes and their build linkage match
independent readback. All 154 native inputs and release tools match qualified head
`f302ca09f30a2df7d65fe0d7d92e38870277ac20`, the immutable archive and the audited
Organizer distribution IPA. Both Xcode 26 hosted suites and Xcode 27 local suites
pass. Organizer used the existing cloud-managed distribution identity after CLI
export could not see the account. Apple accepted the pinned resource-stub dSYM
warning; main binary/static runtime and matching dSYM pass the release audit.
The same known encryption and approved France exclusion qualify documentation
exemption metadata; the binary declaration is unchanged and no new declaration
was created. Physical installation and installed-device acceptance remain open.

The preceding verified TestFlight build is 43 (0.1.0), independently read `VALID` and
`IN_BETA_TESTING` on October 7. Its existing internal group auto-linked it, with
the same one tester and no assignment or permission mutation. What to Test notes
and their exact build linkage match independent readback. Source
`332891661eb37927a55ff2101ae0cb0668281dd8` passed exact-head CI; all 147 native
inputs and release tools match the immutable archive and audited Organizer IPA.
The existing cloud-managed distribution identity exported and uploaded it after
CLI export again could not see the Xcode account or a local distribution certificate.
Apple accepted the pinned resource-stub dSYM warning; main binary/static runtime
and dSYM pairing pass. The same documented standard outside-OS encryption and
approved France exclusion qualify documentation-exemption metadata; binary
encryption settings are unchanged. No new declaration was created. Physical
installation, passkeys, original restoration and background acceptance remain open.
Build 43 contains the 30-day and metadata-first processing changes from PR 47.

The preceding verified TestFlight build is 42 (0.1.0), processed `VALID` and
`IN_BETA_TESTING` in the same existing internal group as build 41 on October 7.
The existing tester has access; no testers or permissions were added. Its archive
and distribution IPA were audited before upload. Physical installation and
acceptance remain unverified. CLI export lacked an available account; Xcode
Organizer used the existing cloud-managed distribution identity to export and
upload the same immutable archive. Its native source is
`d218a02fcb8d9cfb63a7e8865900b60685b6b4e2`, with all 147 native/tool input hashes
matched and identical native inputs in qualified head `8311a8639801ad99fe80c42449bab41b1b7f1eab`.
What to Test notes were saved and independently read back. The resource-framework
dSYM warning did not prevent Apple's accepted processing; the main static runtime
and binary/dSYM pairing pass the release audit. App Store Connect's documentation
exemption metadata preserves the known standard algorithms outside Apple's OS
and approved France exclusion; the binary encryption declaration is unchanged.
Build 41 is the preceding verified internal candidate. Build 42 contains PR 46's
family albums and access changes; the later 30-day processing follow-up is separate.

Build 38 archives the qualified PR 43 source and passes the full archive audit
with all 69 native input hashes matched. It is development-signed; no IPA was
exported and no TestFlight upload occurred. Build 37 preserves the earlier PR 41
archive. Check release
credentials without archiving, exporting or uploading:

```sh
FOTORO_DEVELOPMENT_TEAM=YOUR_TEAM node tools/build-testflight.mjs 38 --preflight
```

The check reports credential type and local distribution identity count, without
printing key IDs, paths, certificates or tokens. It does not verify an Xcode
account or claim the build is upload-ready. An individual API key uses
`ASC_KEY_SUBJECT=user` and no issuer; this access is verified for build metadata.
[Individual keys cannot use Apple's provisioning endpoints](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api). Signing needs an
available distribution identity/profile, a usable signed-in Xcode account, or a
team key with its issuer for automatic provisioning. Keep keys outside the repo.

On October 6, restoring the existing Xcode account and using an Apple-first
process PATH allowed CLI and Organizer exports of build 39. The supplied
Organizer `Copy failed` log mixed Apple rsync with Homebrew rsync 3.5.1, which
rejected `--extended-attributes`. The build helper already sets that tool path.
Apple accepted the upload but rejected build 39's processing with 90208: ONNX's
plist minimum OS was 15.1 while Xcode's generated resource-framework binary
required 26.0.

Build 40 corrects the copied framework's metadata and re-signs it in a final
archive-only full-app phase. Both archive and signed IPA pass the strengthened
audit with minimum OS 26.0. Apple completed processing; the encryption answers
declare standard algorithms outside Apple's OS and preserve the approved France
exclusion. The existing group's automatic distribution made build 40 available
to its one tester, and the What to Test notes were saved and read back. This
internal candidate does not qualify a production web deployment or PR merge.

First App Store publication excludes France, as approved by the owner. Keep full
app encryption and the distribution artifact's compliance declaration aligned;
the local Photos preview is a separate target with a different encryption scope.
The full release helper audits the archive before export and requires an audited
distribution IPA before upload. The audit checks the requested build and signed
app identity, production associated domains, one arm64 executable, matching
binary/dSYM UUIDs and ten defined static crypto symbols. Preview scope,
false or malformed full-app encryption declarations, extra executable resources
and a mismatched exported build fail before upload. The only accepted nested
Mach-O is ONNX Runtime 1.24.2's pinned codeless resource-framework stub: unsigned
bytes, platform, declared/binary/app minimum-OS compatibility, identity and
signature are checked, and the main binary's dSYM
must prove static ONNX linkage. Other nested executables remain rejected.
`pnpm check` includes the release artifact and orchestration regressions.
An archive-only audit does not qualify an IPA
or an App Store Connect upload; processing and compliance still require readback.
See [verification](verification.md) for current evidence and its historical appendix.
Earlier deployment checkpoints remain available in Git history.
