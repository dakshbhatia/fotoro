# Fotoro native slice

Open `Fotoro.xcodeproj`, scheme `Fotoro`. Xcode27/iOS26+; SwiftPM pins Sodium0.11.0, GRDB7.11.1 and Nuke12.9.0. `python3 generate_project.py` regenerates the checked-in project after adding source files.

The app defaults to `https://fotoro.cloud`. The locked account screen's API connection supports an HTTPS endpoint or loopback HTTP endpoint. Real local Worker testing uses `http://127.0.0.1:8787`; DEBUG fixture account actions use8790 and public accounts. Release excludes those fixture actions and fixture-unlock implementation. Passkey requests use `fotoro.cloud` in production or `localhost` on loopback. Associated-domain entitlements are included; physical-device signing/domain validation is required.

The main canvas opens from the account's local GRDB catalog after Keychain/recovery/PRF/device unlock. Search/Add are persistent; long-press a thumbnail to select, then Share appears. Add contains Files/Photos, shared moments and account actions. Photos intake reads the unmodified PHAssetResource, including edited assets' unmodified originals, and rejects HEIC/Live Photos/video. Imports stage ciphertext under protected Application Support/Pending; never under an evictable cache.

For Simulator integration tests, start the fixture server8790 and real Worker8787 with the repository's public accounts seeded. Discover a Simulator first and pass its actual UDID:

```sh
xcodebuild -project Fotoro.xcodeproj -scheme Fotoro \
  -destination 'platform=iOS Simulator,id=<discovered-UDID>,arch=arm64' \
  -derivedDataPath /tmp/fotoro-native-derived \
  test CODE_SIGN_IDENTITY=- ARCHS=arm64
```

Leave Simulator ad-hoc signing enabled. `CODE_SIGNING_ALLOWED=NO` makes Keychain tests fail with missing entitlement access.

Tests cover frozen JS/libsodium vectors; native signature equality; wrong binding/key/signature/version, reordered/truncated/trailing media; original byte retention; edited/iCloud read faults; GRDB journal restart and ambiguous commit; receive/save/contribute and retention after grant removal; lost save receipt after revocation; real Worker recovery-session authentication and signed device enrollment/replay rejection. The crypto test writes `Documents/native-interop.json` in the Simulator app container for reverse JavaScript decryption.

Physical passkey/PRF ceremonies, real iCloud network conditions, Photos edit integration, 10,000-photo performance/memory targets and background scheduling are not claimed as verified. Device approval currently transfers explicit JSON requests through ShareLink/paste; camera QR scanning is not implemented. Native Photos-library export is outside this slice.
