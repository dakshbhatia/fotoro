# Local search verification

Use [verification](../../../docs/verification.md) for recorded evidence and
[product backlog](../../../docs/product-backlog.md) for the sole active queue.
See [product](../../../docs/product.md) for Sync, Search and Share and
[foundation](../../../docs/foundation.md) for privacy boundaries. Browser uploads
remain explicit; QA fixtures never authorize library uploads.

Start `pnpm dev:web` from `fotoro/` and open `/qa/ocr.html`. Select a public
PNG or JPEG fixture, then choose **Recognize selected fixture**. The harness
scales its preview to at most 1600 pixels, displays the source digest and tagged
OCR result, and keeps the fixture in memory only. **Recognize blank preview**
checks the no-text case. **Cancel OCR** exercises the worker lifecycle fence.
This page is a development entry point, separate from the product interface.

The primary integration uses:

```ts
const queue = new LocalOcrQueue({ onProgress });
const result = await queue.recognize(
  photo.id,
  photo.digest,
  async () => ({ blob: boundedPreview, width, height }),
  () => sourceGenerationIsCurrent && photoRevisionStillMatches,
);
// undefined means cancelled/stale; a failed result has empty text and an error.
// Store complete text with its processor/revision; it does not supply a label.
await queue.cancel(); // Clear, OCR off, source changes, and unmount.
```

OCR uses `tesseract.js` 7.0.0, `tesseract.js-core` 7.0.0, and the
`@tesseract.js-data/eng` 1.0.0 `4.0.0_best_int` English language variant. npm
package integrity hashes are in `pnpm-lock.yaml`. `tools/prepare-ocr-assets.mjs`
checks versions and writes SHA-256/byte provenance to
`public/ocr/v1/manifest.json`. Generated assets are ignored by Git and prepared
before `dev` and `build`. The script copies scalar, SIMD, relaxed-SIMD, and
matching LSTM wrappers and WASM files, plus package/bundled license notices.
Its generated package footprint is 47,797,598 bytes; each worker fetches only its
selected core and English data.

All worker/core/language paths explicitly use the current origin. The worker
receives bounded preview bytes through its message channel; its language cache
is disabled. No photo, OCR result, or query is posted to a service. The queue
runs one worker, reuses it, and terminates it on cancellation and errors.

The minimal worker host mirrors the `load`, `loadLanguage`, `initialize`, and
`recognize` messages in the installed pinned package's `src/createWorker.js`.
It owns the native Worker before initialization. This avoids the upstream
7.0.0 initialization promise remaining unresolved after a language-load
failure and permits immediate termination during initialization. Protocol
correlation and error/cancellation phases are covered by `test/ocr.test.ts`;
a future dependency upgrade requires rechecking that boundary and actual OCR.

This harness establishes actual OCR and request paths, not semantic image
recognition, face identity, Safari performance, or physical-device memory.
Processor `lstm-orientation-v2` first applies detected text skew correction.
Nonempty output below the 0.60 recognition-quality gate gets three additional
quarter-turn attempts on the same bounded preview and worker. The strongest
nonempty output wins within that OCR channel; output below the gate is failed
with empty text, while an initially blank output completes empty. This gate is
an engineering rule, not calibrated accuracy or intent confidence. Actual
orientation behavior must still be verified with fixtures.

Visual search is a separate local channel: browser TinyCLIP runs pinned ONNX
weights through ONNX Runtime on bounded previews. Model/runtime GETs are allowlisted
and hash checked; photo pixels, vectors and query text are never uploaded. Native
uses its own pinned TinyCLIP Core ML conversion, so neither fixture scores nor
model dimensions establish cross-device accuracy parity. OCR text remains separate
from supplied labels and inferred scenes. Scene publication is disabled for reader
compatibility; vectors stay local.

Run `pnpm test:search:fixtures` for deterministic retrieval checks and
`pnpm test:search:visual` for one real TinyCLIP inference over the checked-in public
Singapore photo. The latter loads public model assets and compares fireworks, dog
and cake prompts; it does not exercise browser worker behavior or measure user
accuracy, Safari latency or device memory. `pnpm test:web` covers the web boundaries;
actual OCR, browser network privacy and visual behavior still need rendered checks.
