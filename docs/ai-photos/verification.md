# Verification — September 30, 2026

Verified the development slice on `codex/ai-photos`:

- Photos workspace: 14 test files, 148 tests passed, including 9 new intelligence
  behavior tests. Opt-in and missing-key guards issue no requests; fake transport
  verifies the 3.8 payload, schema boundary, error handling, and token accounting.
- Photos TypeScript check: passed. Node wrapper syntax and Git whitespace: passed.
- Both prelogin and photos Rust/WASM packages: built successfully.
- Local Museum `/ping` and source web `/intelligence`: HTTP 200.
- Developer doctor: Node 22.23.3, Flutter 3.47.2, Rust 1.98.1, Go 1.26.6,
  Xcode 27.0, Docker 29.4.0, Compose 5.1.2.
- Mobile dependency/Rive/FRB setup: completed after installing rustfmt. Generated
  bindings leave no tracked changes. CocoaPods is not installed on this machine;
  iOS compilation, launch, signing, and physical-device flows are unverified.
- CUA in-app browser: meaningful page, no framework overlay. Synthetic JPEG
  import shows three photos; the second byte-identical image is the one duplicate
  copy; searching blue returns one photo. Settings reveal the API key field only
  after enabling Gemini, and Done stays disabled without a key.
- Glass layout: checked at the default 689px viewport and a 390×844 mobile
  viewport. Mobile document width equals viewport width; no horizontal overflow.
- Earlier console warning about MUI's removed `flexWrap` prop was corrected;
  no new relevant app warnings appeared after the correction.
- Fresh review found overlapping imports and a stale viewer object. Added a
  synchronous import guard, disabled the empty-state add action during work, and
  derived viewer contents from the current photo by ID. TypeScript and the full
  photos suite pass after those repairs.

Live Gemini requests were not made: no paid key was supplied. Provider quality,
latency, browser CORS, and real billing still require a live smoke test. The
new preview index is session-only; account sync, semantic embeddings, primary
passkey unlock, and nearby trusted sharing are roadmap work in `architecture.md`.

The existing Ente app's broader encrypted sync and storage flows were inherited;
they were not newly verified end-to-end against a signed iOS build in this slice.
