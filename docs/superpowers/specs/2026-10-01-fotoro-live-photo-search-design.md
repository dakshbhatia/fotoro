# Fotoro: live search that presents one useful photo

October 1, 2026. Written design for review. The user requested a cheap,
optional, personally relevant photo search that updates through
`R → Ro → Ron → Ronald`, then asked to solve it and verify the confidence.
Revised after the user asked for a wiser algorithm: predict a supported
meaning separately from ranking photos, and replace the blended relevance/
preference score with evidence rules and scoped history.
The conversational direction is approved; this written specification has not
yet been reviewed. No search implementation is represented as complete.

## Outcome

Typing updates one leading photo and a visible interpretation of the query.
Alternatives remain reachable. The leading photo is selected from supported
matches, using the current action and explicit previous selections. A
one-letter suggestion is tentative; the product does not promise to infer an
unknown person's name or guarantee the intended photo from an ambiguous letter.

The first deliverable is device-local metadata, supplied labels, OCR, prefix
completion, ranking and durable optional browser previews. These provide a
working search without an embedding model. Semantic concepts and correctable
face groups are later additions to the same index, each requiring its own
quality and device-performance evidence. Public-web image search is a separate
source integration and is outside this deliverable.

## Current evidence and gaps

- `RecentPhotosStore` fetches only images captured in the last 30 days. Search
  currently tests formatted dates, favorites, screenshots and GPS coordinates.
- The web local trial filters filenames/dates in memory. Its selected files
  and generated previews disappear when the page reloads. The account viewer
  separately filters decrypted filenames and dates.
- A browser check against the existing app, using two copies of its public
  Singapore fixture named Ronald-fixture.jpg and Rome-fixture.jpg, produced
  two matches for R/Ro and one for Ron/Ronald. Reload produced zero retained
  photos. This demonstrates filename filtering, not person recognition.
- Synthetic M5 Max measurements showed p95 SQLite prefix retrieval of up to
  200 candidates at 0.32 ms for 10,000 records and 2.75 ms for 100,000 records.
  Pure JavaScript 512-dimensional top-one scans measured 5.65/40.9 ms. These
  exclude image inference, storage reads, preview loading and rendering.
- The Ente reference pipeline is not integrated with the active Fotoro app.
  Its small-corpus timings do not establish performance for this design.

## User flow

1. Keep the existing photo canvas as the default. Beginning a non-empty query
   reveals a single leading preview, its predicted term and matching evidence.
2. Up to three alternative terms let the user correct an ambiguous meaning.
   Choosing one commits that interpretation until the query changes.
3. Previous/next controls and a swipe move among matching photos. Opening a
   result uses the existing viewer. Clearing search restores the canvas.
4. Photo details allow supplied labels, including a person's name. Preserve
   entered spelling; normalization belongs only in the searchable derivative.
   A supplied label does not mean an automatic face match occurred.
5. Accepting a completion records the intended meaning. Explicitly choosing a
   photo for use/share/download, or confirming it as the wanted result, records
   a photo preference. Opening a preview for inspection is not a successful
   search signal. Merely displaying a result creates neither event.
6. Show index coverage and unavailable-media state. An unindexed photo or
   unavailable iCloud preview is not treated as a verified negative match.

UI strings introduced by implementation are proposed product UI wording, not
rewrites of existing user-authored captions or other personal copy.

## Sources and persistence

### Native local Photos

Create a lightweight search store independently of `AppServices`. Opening
Photos remains the action that requests PhotoKit access. Enumerate permitted,
non-hidden still-image assets for search; keep the existing last-30-days canvas
as a browse view. Limited authorization bounds all indexing and retrieval.

Use GRDB/SQLite in a separate Application Support directory with complete file
protection. Persist metadata, supplied labels, OCR and preference records.
PhotoKit asset identifiers are device-local source references, not cross-device
photo identities. Refresh on library changes and foreground authorization
checks; purge entries whose assets are deleted or no longer permitted.

Read dates/location/favorite/subtype metadata first. On iOS 27+, existing
captions, keywords and original filenames can seed the index; iOS 26 falls
back to its available properties. Index OCR with Apple Vision on a bounded
preview off the main actor. Process one image at a time and initially disallow
network downloads for background indexing. Retry missing previews on a later
library refresh; user-visible viewing can use the existing iCloud behavior.

Vision is a proprietary platform shortcut. SQLite and the retrieval core are
open source. A requirement for an open-source OCR implementation can be met
with Tesseract separately, without changing the search record contract.

### Browser local selections

Preserve the session-only default. Offer explicit local retention for people
who want reopening to restore search. Retention stores encrypted search
records, preferences and bounded previews in a separate IndexedDB database;
it does not silently retain or upload original files.

Use a non-extractable Web Crypto AES-GCM key stored by this origin. This
protects stored bytes; it does not establish a password lock or protection
against code running in this origin. Do not describe it as account-vault
encryption. Turning retention off removes its local records/key/previews.
Browser storage is evictable and is never described as a backup.

Generate an original-content SHA-256 once per selected supported file to
reconnect labels/preferences after reselection and avoid duplicate retained
records. Preserve originals unchanged. After reload, retained previews are
searchable/viewable; original-file download/share requires reselecting the
original. Reconnect only after its digest matches, not just its filename.

Generate preview bytes at at most 1600 pixels on the longest edge. Bound
retained browser previews to 100 MiB and the existing decoded cache to 48 MiB.
If storage fails, keep the current session usable, expose the failure, and do
not claim the failed records were retained. Eviction reduces preview coverage,
not supplied labels; clearing retention explicitly removes both.

Use a locally served, pinned Tesseract.js worker and selected language assets
for optional browser OCR. No photo bytes, OCR text, queries or preferences are
sent to a service. Cancellation and generation checks fence Clear, retention
changes, new file batches and stale OCR/preview completions.

### Encrypted account catalog

The first deliverable keeps account search and local trial search separate;
it does not change wire contracts or silently import trial selections. A
later account-index integration must use authenticated encryption and
per-record updates. Server-side plaintext indexing cannot satisfy the current
private-photo architecture. Searching a photo grants no sharing authority.

## Record and index

Each versioned search record contains:

- Stable record ID, source type and source reference.
- Source content/revision identifier and capture-time provenance.
- Original filename, available captions/keywords, favorite and media subtype.
- Supplied labels, stored verbatim; separately normalized searchable terms.
- OCR text/confidence, processor version and pending/complete/failed state.
- Preview availability/reference and original availability.
- Optional future visual/face features with exact model and preprocessing IDs.

Keep source facts, supplied labels and inferred features distinct. Changing a
model or image revision invalidates its derived features without erasing the
user's labels. Durable labels are not a disposable inference cache.

Maintain normalized terms and photo postings. A term stores its display form,
meaning/source relation, evidence type and eligible photo count. Keep accepted
completion history separate from confirmed photo-use history. Aliases share
a meaning only when that relation is explicitly supplied or belongs to the
supported concept vocabulary; do not invent a person's nickname/identity.
Identical display words may refer to a supplied label or a text mention. The
native index uses SQLite FTS5 plus indexed structured fields. The browser uses
in-memory term/posting maps reconstructed from its authorized local records;
SQLite WASM and a remote search service are not required for this slice.

## Retrieval and ranking

Normalize case/diacritics for matching, retaining the supplied display text.
Tokenize words so file extensions and arbitrary substring coincidences do not
dominate completion. Use prefix matching for short inputs; do not apply fuzzy
matching to a one-letter prefix. Existing metadata filtering remains a
fallback for dates and coordinates.

### Stage 1: predict a supported meaning

Completion searches a local dictionary of meanings with permitted matching
records. Keep function words, extensions, numeric filename noise and isolated
OCR characters out of this suggestion dictionary; retain their source text
for explicit full-text retrieval. Supplied short labels remain valid. Do not
embed R/Ro/Ron or run a language model on each keystroke.

Search the whole eligible prefix range before selecting up to six candidate
meanings. A cached global top-six list must not hide an eligible meaning in a
smaller explicit scope. Native uses indexed prefix retrieval; browser uses a
prefix dictionary plus postings. Reuse the full previous dictionary range
while the prefix extends, not merely the six surfaced suggestions. A longer
prefix can reveal a term that was previously outside that six. Backing up or
changing scope starts from the relevant index.

Order meanings by: explicit accepted interpretation (a hard constraint), exact
whole-term match ahead of a mere prefix, decayed explicit completion history,
known current-moment relevance as a tie-break, usable evidence class, then a
stable normalized term/meaning ID. Typing an exact term remains tentative
until accepted; a longer continuation can make it ineligible immediately.

Use no raw photo-count popularity term: 100 burst frames must not make Rome
100 times more likely than Ronald. At cold start, ties resolve using supported
evidence/context and deterministic ordering; expose alternatives. Maintain
history per user, meaning and explicit source scope. Decay accepted completion
events by half every 30 days. These counts rank a provisional suggestion;
they are not calibrated intent probabilities or proof of correctness.

### Stage 2: choose a compatible photo

Apply permission, explicit source/time scope and accepted meaning as hard
constraints before personalization. A label association and a text mention
are different relations. For a supplied Ronald label, direct label matches
rank ahead of captions/keywords, which rank ahead of plain filename/OCR
mentions. Text-only Ronald results retain their text provenance. A named-person
interpretation requires a supplied person association; a filename or receipt
mention cannot establish who is pictured. The first slice does not claim
automatic face identity or account/recipient association.

An explicitly pinned representative is a user-supplied preferred-result
association for that meaning, so it can override the default evidence order.
Keep its displayed reason as the user's choice; it does not establish detected
face identity. A routine successful-use event is preference history, not a pin.
An incompatible relation or revoked permission still makes a pin ineligible.

Within the strongest eligible evidence class, order photos by: decayed
confirmed-use count for this
meaning/scope; known current moment as a tie-break; favorite; verified capture
time descending; stable photo ID. A recent or frequently opened filename
cannot outrank a direct supplied label. Preserve each record's original
evidence independently of pins and preference events.

Date/location queries use their structured match, not mention counts. For a
text interpretation, retrieved matching tokens/phrases establish candidates;
full-text rank and OCR recognition confidence apply within that text channel.
They are not comparable numerical probabilities across channels. Future
visual concepts must similarly retain their own evidence/validation rules.
Recency is a fallback, not a general definition of relevance: older named
photos and selected receipts remain eligible.

Collect at most 200 candidates per meaning from indexed strongest-evidence,
confirmed-use, current-moment and favorite/recent lanes. Each lane is ordered
by its applicable ranking fields; union their bounded heads, deduplicate, and
validate the candidate cap against retrieval recall. Do not use arbitrary
insertion order or promise a globally optimal first result from an untested
cap. Exact content duplicates and known native bursts offer a representative
with children still reachable; time proximity alone is not duplicate proof.
Do not collapse distinct documents just because their thumbnails look alike.

### Stable display and feedback

During prefix extension, retain the current photo while the predicted meaning
is unchanged and the photo remains in the best eligible evidence class.
Do not shuffle it merely because its relative recency or a background-derived
tie-break changes. A changed meaning, stronger evidence class, explicit
representative choice, incompatible continuation or revoked permission
replaces it immediately. Keep a deterministic tie-breaker and a query
generation token so late work cannot update a newer result.

Keep completion acceptance and confirmed photo use as separate event types.
Deduplicate each event within a search session; decay confirmed-use events by
half every 30 days. Key photo preference by meaning, source scope and photo ID.
Showing, hovering, prefetching or inspecting a preview is not success. Ignoring
an alternative is not rejection: it may never have been examined. A deliberate
correction updates this search, while editing a wrong supplied label changes
that label's factual association. Do not randomly replace the visible first
photo to collect training data.

Expose the predicted term, its relation/evidence and alternatives without an
invented confidence percentage. Partial index coverage and missing previews
remain visible. No supported candidate produces an honest no-match/coverage
state; a prior choice cannot resurrect an incompatible or inaccessible photo.

### Cost of the live path

Read cheap metadata first, then enrich permitted available previews in a
bounded queue, prioritizing currently visible/selected assets. Cache normalized
terms and thumbnail references. Typing performs prefix retrieval, bounded
ranking and a cached preview swap; it does not re-read originals, OCR photos,
download a model or call a service. For browser retention, hydrate the search
dictionary/postings separately from detail OCR text and image bytes, and
measure its memory as library size grows. A small preview cache alone does
not prove that the search index is small.

The first slice is a rules-and-counts baseline. Introduce a learned reranker
only after held-out retrieval tasks demonstrate an improvement. Merely showing
one photo concentrates exposure; clicks alone must not teach the system that
the repeatedly displayed photo is necessarily the wanted result.

## Later semantic and face work

For common concepts, precompute text vectors and aliases for a bounded
vocabulary, then derive photo associations during indexing. The browser can
retrieve those associations without loading an image/text model on typing.
Unseen words require a separately tested fallback; vocabulary coverage is not
presented as arbitrary natural-language understanding.

SigLIP2 is an Apache-2.0 candidate, not a proven Fotoro deployment. The available
base ONNX exports are approximately 95 MB for INT8 vision and 283 MB for INT8
text. Download size is not runtime memory. Exact export, preprocessing,
quantization quality and phone/browser memory need validation before adoption.

Current upstream MobileCLIP model terms exclude product development and
commercial product use; reference benchmarks are not permission to ship those
weights. AuraFace-v1's Apache-2.0 model card makes it a candidate for subsequent
face work, requiring detector/encoder validation and correctable grouping.

## Acceptance and falsification

Automated behavior and real browser/native interactions must show:

1. With conflicting Ronald/Rome/Rosa terms, R and Ro expose ambiguity, Ron
   narrows to supported names, and a committed Ronald interpretation excludes
   unrelated records. A file named Ronald does not assert detected identity.
2. Accepting a completion and confirming photo use affect their respective
   subsequent decisions; preview inspection affects neither. History never
   defeats eligibility. Preference decay is exercised using a fixed clock,
   and restored records preserve the same preference. A recent/favored/
   frequently inspected filename match cannot beat a direct supplied label.
3. Prefix extension keeps an eligible same-meaning result stable, but typing
   an incompatible continuation replaces it. Late OCR/preview completions
   cannot resurrect cleared records or overwrite a newer query's image.
4. Browser retention survives reopening with the correct preview/labels.
   Original operations remain unavailable until digest-verified reselection.
   Default session-only mode still clears on reload. Quota failures remain
   honest; turning retention off clears its records and key.
5. An older permitted native photo is searchable beyond the recent canvas.
   Limited access, asset deletion and permission withdrawal remove its result.
   Missing capture dates are not silently called capture dates.
6. OCR retrieves a known word from a neutral-filename fixture. Rotation,
   unreadable text, unsupported formats and unavailable previews fail without
   assigning fabricated labels. No query/photo-data network request occurs.
7. Native and browser memory bounds hold while indexing and rapid typing run.
   Existing view/share/original-byte checks remain green.
8. A 100-frame burst does not multiply the corresponding meaning's completion
   popularity. Equal-display label/text meanings keep their provenance; an
   exact typed/accepted meaning replaces an incompatible prior prediction.
   Scope-filtered candidate generation still finds a relevant older record
   when the global prefix leaders are outside that scope, and extending a
   prefix can find a meaning outside its previously surfaced six. An explicit
   pin changes the default without claiming detected identity, while revoked
   access removes it. Missing-preview and partially indexed cases do not
   fabricate certainty.

Use 30 fixed retrieval tasks across people, saved information, places, moments
and visual things, plus absent-term cases. Specify acceptable photo IDs before
running a ranking variant. Compare metadata-only, OCR/labels, and personalized
ranking. Measure meaning recall in the six-candidate set separately from
acceptable first-photo rate given the intended meaning. Report corrections,
time/keystrokes to the wanted result and first-photo changes during typing;
do not optimize click-through rate as a substitute for retrieval success.
Freeze evaluation tasks before adjusting rules/parameters, keeping tasks used
to tune the algorithm separate from the reported holdout. Do not score an
inherently ambiguous one-letter query as an exact
identity prediction. Visual-only cases establish the first slice's coverage
limit and the later model's baseline; they are not falsely passed by labels.

Targets after unlock and a warm cache: p95 query-to-leading-cached-preview
at most 100 ms on a physical iPhone 13 and Safari on the development Mac; at
least 80% completed-word acceptable first results on the covered OCR/label/
metadata tasks. These are proposed release gates, not measured results.
Report indexing coverage, initial indexing time, memory and device thermal
conditions alongside retrieval results. Simulator/Mac tests do not substitute
for physical-iPhone battery or iCloud checks.

## References

- [Current native browsing](../../../fotoro/apps/ios/Fotoro/Library/RecentPhotosStore.swift).
- [Current browser trial](../../../fotoro/apps/web/src/local/LocalTrial.tsx).
- [PhotoKit extended metadata](https://developer.apple.com/documentation/photos/phassetextendedmetadata).
- [Vision OCR](https://developer.apple.com/documentation/vision/recognizing-text-in-images).
- [SQLite FTS5](https://www.sqlite.org/fts5.html).
- [Personalized query completion research](https://www.microsoft.com/en-us/research/wp-content/uploads/2013/01/SIGIR2013-Shokouhi-PersonalizedQAC.pdf).
- [Bias in learning from search clicks](https://www.microsoft.com/en-us/research/publication/unbiased-learning-rank-biased-feedback/).
- [Tesseract.js](https://github.com/naptha/tesseract.js).
- [SigLIP2 model card](https://huggingface.co/google/siglip2-base-patch16-224)
  and [ONNX files](https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX/tree/main/onnx).
- [MobileCLIP model terms](https://github.com/apple-aiml-research/ml-mobileclip/blob/main/LICENSE_MODELS).
- [AuraFace-v1 model card](https://huggingface.co/fal/AuraFace-v1).
