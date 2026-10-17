# Public search relevance benchmark

`public-relevance-v1.json` declares developer expectations from four repository
public images and explicitly supplied metadata. These are development judgments,
not held-out human relevance labels. Each failure remains in the output. No
personal photo, query, identifier, or location is read by this harness.

Run from `fotoro/`:

```sh
node_modules/.bin/tsx apps/web/tools/benchmark-public-search.ts --output=/tmp/fotoro-public-search-benchmark.json
node apps/web/tools/evaluate-semantic-find.mjs
node_modules/.bin/tsx tools/evaluate-local-search.ts --require-covered --benchmark
```

The first command runs production `LocalOcrQueue` orientation/confidence policy
with Node Tesseract transport, `PhotoSearchIndex.searchAsync`, browse filters,
and the semantic admission/composition helpers used by `useSemanticFind`. It
runs the pinned TinyCLIP q8 model with the production neutral-modality inputs.
OCR comes from JPEG previews of the actual public pixels, not injected expected
text. Image resizing/encoding uses Node Sharp, with the production 1600-pixel
preview, 512-pixel thumbnail, and JPEG quality 85 bounds; browser canvas pixels
and WASM timing are not measured. Explicit metadata provides tags, capture date,
place, filename correction, screenshots, favorite and Trash fixtures. Those
fields are never presented as automatic pixel recognition.

Reports separate lexical/filter retrieval, raw model thresholding, and combined
product composition. They include false positives, false negatives, expected
ranks, evidence provenance, precision/recall, and positive-query top-one counts.
The default command reports misses without failing. Add `--require-exact` to
fail when any declared exact result set is missed; it currently fails because
of document-type semantic false positives.

On the October 17 development Mac run, lexical/filter retrieval passed all
25 tasks: 27 relevant results, no false positives or false negatives, and all
20 positive-query first results correct. Three public text images, including
the inverted boarding pass, produced the expected words through OCR. The
Singapore night scene failed the OCR confidence gate; no text was fabricated.

For ten semantic queries over four images, combined product composition returned
9 of 9 expected results and 6 false positives: precision 60%, recall 100%, and
6 of 10 exact result sets. All 7 positive queries had a relevant first result.
The raw model's first result was relevant for 6 of 7 positive queries. For
`boarding pass`, production keeps both OCR-backed passes ahead of a receipt
that the model also scores highly. For `receipt`, OCR keeps the receipt first,
but both pass images remain appended as visual matches. Queries `a boarding pass
with text` and `a receipt with printed text` have no complete lexical match and
also confuse the document images. Fireworks, Ferris-wheel and water-reflection
prompts retrieve Singapore; dog/beach, cake and snowy-mountain controls reject
all four images. The production threshold was left at 0.25.

Cold boundaries are explicit in the JSON. The measured five-record first index
build was about 2.3 ms. First-worker OCR was about 364 ms; same-worker boarding
OCR about 110 ms, inverted boarding about 374 ms, and the rejected scene about
3,047 ms. TinyCLIP initialization was about 280 ms from an existing public asset
cache. These are Node CPU measurements, not a download-cold or physical-device
claim. Warm vector ranking excludes image/text inference. The separate existing
1,000-record synthetic metadata benchmark measured a first build of 13.5 ms,
unchanged-contribution rebuild of 3.2 ms, and 275 warm queries with p50 0.40 ms
and p95 1.28 ms. It excludes decoding, OCR, inference, storage and UI.

The measured unsupported behavior is specific: visual similarity does not
reliably distinguish printed document types and can append unrelated documents
even when OCR provides a correct first result. Natural-language filler is not
an OCR query rewriter. Exact typed identifiers and filenames retain their
existing semantic-exclusion policy. This corpus has only one real scene, two
printed layouts and one rotated copy: it does not qualify other scenes, low
light documents, handwriting, languages other than English, face identity,
landmark identity, download-cold browser startup, or large-library visual
coverage. No retrieval helper change was justified by these results; suppressing
all semantic expansion after an OCR match would trade away unread-photo recall.

## Regression floor

`pnpm test:search:relevance --require-baseline --output=/tmp/fotoro-public-search-relevance.json`
checks the explicit `baseline` in the public JSON. It requires all 25 lexical
cases, all 10 combined queries, relevant first results for all 7 positive
combined queries, no missing expected results, and at most 6 false positives.
Every accepted false-positive image is listed per query in `knownFailures`.
A different false positive fails even if the aggregate count stays below 6.
Improvements pass without requiring the known failures to remain.

This baseline is distinct from `--require-exact`, which still fails on the four
known combined document-query failures. Passing the baseline means no measured
regression against this small public corpus; it does not prove broadly reliable
or awesome search. The report still shows the four failures, 6/10 exact sets,
60% precision and 100% recall until production behavior actually improves.

The web/API CI job runs the real-model baseline and uploads the complete JSON
from `runner.temp` as `fotoro-public-search-relevance`, including on failure when
a report exists. The existing model smoke check and the benchmark share only
public pinned model assets in a runner-temporary cache. Reports and downloaded
models are outside Git. The iOS host-only and Simulator conditions are unchanged.
