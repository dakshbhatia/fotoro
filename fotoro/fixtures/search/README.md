# Local search checks

These checks support [Search](../../docs/product.md). See
[verification](../../docs/verification.md) for evidence and
[product backlog](../../docs/product-backlog.md) for the sole active queue.

`cases.json` freezes 19 synthetic records and 30 expected retrieval tasks before
implementation measurements: 20 covered by supplied labels/metadata/text,
5 visual concepts intentionally uncovered, and 5 absent terms. These are
development checks, not a held-out real-user corpus or accuracy claim.

The source facts are explicit test inputs. A Ronald label is supplied by the
test; a file named Ronald is only a filename mention. No face identity is
detected. The adversarial rules cover provenance, ambiguous prefixes, history,
scope/candidate limits, stability and permission withdrawal.

`neutral-a.png` contains SEATTLE RECEIPT / INVOICE 4826 / TOTAL 28.50.
`neutral-b.png` contains BOARDING PASS / BOSTON / GATE TWELVE.
`neutral-c.png` rotates the latter by 180 degrees. Filenames contain none of
those text terms. They are generated public test data and contain no personal
documents. OCR success must come from their pixels, not injected search text.

Run `pnpm test:search:fixtures` from `fotoro/` for the deterministic retrieval
checks. Regenerate the PNGs from that same directory on macOS with:

```sh
swift tools/create-search-fixtures.swift "$PWD/fixtures/search"
```

Source images are 2400×1600 on the development Mac's Retina drawing context.
Indexing must resize them to the declared preview limit. Pixel/font rendering
can differ between macOS versions; expected words remain fixed.

`picks-v1.json` freezes seven Find → quality shortlist checks. The subset must
be chosen before the quota and similarity grouping. Cases cover an outside
favorite, verified bursts, capture-date variety, unknown dates, unavailable
previews and unsupported visual meaning. Its measurements are synthetic inputs;
passing establishes policy composition, not real-photo ranking accuracy. Run
`pnpm test:picks:fixtures`. A processor version change requires requalification.

`pnpm test:search:visual` is a separate real-inference smoke check using the public
`fixtures/media/singapore.jpg` and the pinned browser TinyCLIP ONNX model. It checks
one fireworks prompt against dog/cake controls, not the five intentionally
uncovered synthetic visual tasks. Native TinyCLIP Core ML and browser ONNX are
separate model conversions; this command establishes neither parity nor held-out
accuracy. It downloads public model assets, never personal images or local vectors.
Use the [web QA guide](../../apps/web/qa/README.md) for pixel OCR and browser checks.
