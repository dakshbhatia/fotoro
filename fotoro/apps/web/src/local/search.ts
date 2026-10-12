import {parseNaturalDateQuery} from "./natural-date";
import type {PhotoVisualV1, PhotoLocationV1} from "@fotoro/contracts";
import {validatedVisualLabels} from "@fotoro/contracts/visual";
import {isLocationFact, validatedPhotoLocation} from "@fotoro/contracts/location";
import {isCloudObservationFact, observationSearchText} from "@fotoro/contracts/intelligence";
import {isPeopleFact, peopleNames} from "@fotoro/contracts/people";
import {isCaptureMetadataFact, captureMetadataSearchText} from "@fotoro/contracts/capture-metadata";

export interface SearchOcr {
  photoID: string;
  revision: string;
  processor: string;
  status: "complete" | "failed";
  text: string;
  confidence: number;
  error?: string;
}
export interface SearchPhoto {
  observationPhotoId?: string;
  id: string;
  digest?: string;
  filename: string;
  date: string;
  dateSource: "exif" | "photos" | "selected";
  captureTimezoneVerified?: true;
  captureVerified?: true;
  location?: PhotoLocationV1;
  labels?: string[];
  caption?: string;
  keywords?: string[];
  facts?: string[];
  favorite?: boolean;
  ocr?: SearchOcr;
  visual?: PhotoVisualV1 & {photoID: string; revision: string; status: "complete"};
  current?: () => boolean;
}
type Event = { at: number; session: string };
export interface SearchFeedback {
  version: 1;
  meanings: Record<string, Event[]>;
  photos: Record<string, Event[]>;
  pins: Record<string, string>;
}
export type SearchEvidence = "label" | "person" | "observation" | "keyword" | "caption" | "fact" | "filename" | "ocr" | "date" | "visual";
export interface SearchMeaning {
  id: string;
  term: string;
  kind: SearchEvidence;
  photoIds: string[];
  evidence: Record<string, SearchEvidence>;
}
export interface SearchResult {
  query: string;
  scope: string;
  meanings: SearchMeaning[];
  meaning?: SearchMeaning;
  photoIds: string[];
  photoId?: string;
  searching?: boolean;
  current?: () => boolean;
  metadataIncomplete?: boolean;
  visualStatus?: "unavailable" | "incomplete" | "missing-preview";
  textStatus?: "indexing" | "incomplete";
}
interface IndexedMeaning {
  id: string;
  term: string;
  normalized: string;
  sources: Map<string, SearchEvidence>;
}
interface PhrasePosition {
  photoId: string;
  source: SearchEvidence;
  display: string[];
  normalized: string[];
  start: number;
}
interface IndexedPhoto {
  dictionary: IndexedMeaning[];
  phrases: Map<string, PhrasePosition[]>;
}
export const emptyFeedback = (): SearchFeedback => ({ version: 1, meanings: {}, photos: {}, pins: {} });
export const normalizeSearch = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const noise = /^(?:img\d*|dsc\d*|pxl\d*|image|photo|fixture|screenshot|the|and|jpg|jpeg|png|heic)$/i;
const tier = (source: SearchEvidence) => source === "label" || source === "person" || source === "date" ? 4 : source === "keyword" || source === "fact" || source === "observation" ? 3 : source === "caption" ? 2 : source === "visual" ? 0 : 1;
const count = (events: Event[] | undefined, now: number) => (events ?? []).reduce((sum, event) => sum + Math.pow(0.5, Math.max(0, now - event.at) / (30 * 86400000)), 0);
const photoKey = (meaning: string, id: string) => JSON.stringify([meaning, id]);
const meaningKey = (scope: string, meaning: string) => JSON.stringify([scope, meaning]);
const words = (text: string): string[] => text.match(/[\p{L}\p{N}]+/gu) ?? [];
const hasCaptureDate = (photo: SearchPhoto) => photo.dateSource === "exif" || photo.dateSource === "photos";
type DatedMeaning = [number | null, number | null, string];
function datedMeaning(id: string): DatedMeaning | undefined {
  if (!id.startsWith("dated:")) return;
  try {
    const value: unknown = JSON.parse(id.slice(6));
    if (Array.isArray(value) && value.length === 3 && value.slice(0, 2).every(bound => bound === null || (typeof bound === "number" && Number.isFinite(bound))) && typeof value[2] === "string") return value as DatedMeaning;
  } catch {}
}

/* Perception happens elsewhere. Typing only retrieves supported local meanings. */
export class PhotoSearchIndex {
  private records: Map<string, SearchPhoto>;
  private dictionary: IndexedMeaning[];
  private phrases = new Map<string, PhrasePosition[]>();
  private history: SearchFeedback;
  private indexedPhotos = new Map<string, IndexedPhoto>();
  constructor(photos: SearchPhoto[], feedback: SearchFeedback = emptyFeedback()) {
    this.records = new Map(photos.map(photo => [photo.id, photo]));
    this.history = structuredClone(feedback);
    const terms = new Map<string, IndexedMeaning>();
    const phraseSource = (text: string, source: SearchEvidence, photoId: string) => {
      const display = words(text.slice(0, 256 * 1024)), normalized = display.map(normalizeSearch);
      for (let start = 0; start + 1 < normalized.length; start++) {
        const positions = this.phrases.get(normalized[start]) ?? [];
        positions.push({ photoId, source, display, normalized, start });
        this.phrases.set(normalized[start], positions);
      }
    };
    const add = (word: string, source: SearchEvidence, photoId: string) => {
      const normalized = normalizeSearch(word);
      if (!normalized) return;
      const id = (source === "label" || source === "person" ? "label:" : source === "visual" ? "visual:" : "text:") + normalized;
      let meaning = terms.get(id);
      if (!meaning) {
        meaning = { id, term: word, normalized, sources: new Map() };
        terms.set(id, meaning);
      }
      const old = meaning.sources.get(photoId);
      if (!old || tier(source) > tier(old)) meaning.sources.set(photoId, source);
    };
    for (const photo of [...this.records.values()].sort((a, b) => compare(a.id, b.id))) {
      for (const label of photo.labels ?? []) {
        phraseSource(label, "label", photo.id);
        add(label, "label", photo.id);
        for (const word of words(label)) add(word, "label", photo.id);
      }
      const visual = photo.visual;
      if (visual?.status === "complete" && visual.photoID === photo.id && visual.revision === photo.digest) {
        for (const label of validatedVisualLabels(visual)) add(label.label, "visual", photo.id);
      }
      for (const keyword of photo.keywords ?? []) {
        phraseSource(keyword, "keyword", photo.id);
        add(keyword, "keyword", photo.id);
        for (const word of words(keyword)) add(word, "keyword", photo.id);
      }
      for (const fact of photo.facts ?? []) if (!isLocationFact(fact) && !isCloudObservationFact(fact) && !isPeopleFact(fact) && !isCaptureMetadataFact(fact)) { add(fact, "fact", photo.id); phraseSource(fact, "fact", photo.id); }
      for (const term of captureMetadataSearchText(photo, photo.digest ?? "")) {
        add(term, "fact", photo.id); phraseSource(term, "fact", photo.id);
        for (const word of words(term)) add(word, "fact", photo.id);
      }
      for (const fact of observationSearchText(photo, {photoId: photo.observationPhotoId ?? photo.id, sourceRevision: photo.digest ?? photo.id})) {
        add(fact, "observation", photo.id); phraseSource(fact, "observation", photo.id);
        for (const word of words(fact)) add(word, "observation", photo.id);
      }
      for (const name of peopleNames(photo.facts, photo.digest ?? "")) {
        add(name, "person", photo.id); phraseSource(name, "person", photo.id);
        for (const word of words(name)) add(word, "person", photo.id);
      }
      const location = validatedPhotoLocation(photo.location);
      if (location) {
        add("GPS", "fact", photo.id);
        if (location.name) {add(location.name, "fact", photo.id); phraseSource(location.name, "fact", photo.id); for (const word of words(location.name)) add(word, "fact", photo.id);}
      }
      phraseSource(photo.caption ?? "", "caption", photo.id);
      phraseSource(photo.filename.replace(/\.[^.]+$/, ""), "filename", photo.id);
      for (const word of words(photo.caption ?? "")) if (!noise.test(word)) add(word, "caption", photo.id);
      for (const word of words(photo.filename.replace(/\.[^.]+$/, ""))) {
        if (word.length >= 2 && /\p{L}/u.test(word) && !noise.test(word)) add(word, "filename", photo.id);
      }
      const ocr = photo.ocr;
      if (ocr?.status === "complete" && ocr.photoID === photo.id && ocr.revision === (photo.digest ?? photo.id) && Number.isFinite(ocr.confidence) && ocr.confidence >= 0 && ocr.confidence <= 1) {
        phraseSource(ocr.text, "ocr", photo.id);
        for (const word of words(ocr.text)) if (word.length >= 2 && !noise.test(word)) add(word, "ocr", photo.id);
      }
    }
    this.dictionary = [...terms.values()].sort((a, b) => compare(a.normalized, b.normalized) || compare(a.id, b.id));
  }
  dispose() {this.records.clear(); this.dictionary = []; this.phrases.clear(); this.indexedPhotos.clear();}
  // Account metadata can be much larger than the grid. Build once outside render,
  // yielding after bounded work, with an explicit transient-memory admission budget.
  static async build(photos: SearchPhoto[], signal: AbortSignal, current: () => boolean, budgetBytes = 128 * 1024 * 1024,
    reuse?: {index: PhotoSearchIndex; unchanged: ReadonlySet<string>}) {
    const index = new PhotoSearchIndex([]), terms = new Map<string, IndexedMeaning>();
    let bytes = 0, lastYield = performance.now();
    const check = () => {signal.throwIfAborted(); if (!current()) throw new DOMException("Search source changed", "AbortError");};
    const yieldWork = async () => {if (performance.now() - lastYield >= 4) {await new Promise<void>(resolve => setTimeout(resolve, 0)); lastYield = performance.now();} check();};
    const account = (amount: number) => {bytes += amount; if (bytes > budgetBytes) throw new Error("CACHED_SEARCH_BUDGET");};
    const ordered = async <T>(items: T[], compareItems: (a: T, b: T) => number) => {
      let sorted = items;
      for (let width = 1; width < sorted.length; width *= 2) {
        const next: T[] = [];
        for (let start = 0; start < sorted.length; start += 2 * width) {
          let left = start, right = Math.min(start + width, sorted.length);
          const middle = right, end = Math.min(start + 2 * width, sorted.length);
          while (left < middle || right < end) {
            const a = sorted[left], b = sorted[right];
            if (right >= end || left < middle && compareItems(a, b) <= 0) next.push(sorted[left++]); else next.push(sorted[right++]);
            if (next.length % 1024 === 0) await yieldWork();
          }
        }
        sorted = next; await yieldWork();
      }
      return sorted;
    };
    try {
      check();
      for (const photo of photos) {
        account(256 + 2 * JSON.stringify(photo).length); index.records.set(photo.id, photo); await yieldWork();
      }
      const rows: SearchPhoto[] = [];
      for (const photo of index.records.values()) {rows.push(photo); await yieldWork();}
      for (const photo of await ordered(rows, (a, b) => compare(a.id, b.id))) {
        check();
        // Only the caller's verified unchanged receipts authorize reuse. Contributions
        // contain text postings, never the predecessor's source/current closures.
        const retained = reuse?.unchanged.has(photo.id) ? reuse.index.indexedPhotos.get(photo.id) : undefined;
        const fresh = retained ? undefined : new PhotoSearchIndex([photo]);
        const row: IndexedPhoto = retained ?? {dictionary: fresh!.dictionary, phrases: fresh!.phrases};
        index.indexedPhotos.set(photo.id, row);
        index.records.set(photo.id, photo);
        for (const term of row.dictionary) {
          account(160 + 2 * (term.id.length + term.term.length + term.normalized.length) + 80 * term.sources.size);
          const existing = terms.get(term.id);
          if (existing) for (const [id, evidence] of term.sources) {existing.sources.set(id, evidence); account(80);}
          else {terms.set(term.id, {...term, sources: new Map(term.sources)}); account(160 + 2 * (term.id.length + term.term.length + term.normalized.length) + 80 * term.sources.size);}
        }
        for (const [word, positions] of row.phrases) {
          const existing = index.phrases.get(word);
          if (existing) for (const position of positions) existing.push(position); else index.phrases.set(word, [...positions]);
          // Phrase positions share token arrays; this deliberately overcounts tokens for admission.
          account(168 * positions.length + 4 * word.length);
        }
        await yieldWork();
      }
      const dictionary: IndexedMeaning[] = [];
      for (const term of terms.values()) {dictionary.push(term); await yieldWork();}
      const sorted = await ordered(dictionary, (a, b) => compare(a.normalized, b.normalized) || compare(a.id, b.id));
      check(); index.dictionary = sorted; return index;
    } catch (error) {index.dispose(); throw error;}
  }
  feedback(): SearchFeedback { return structuredClone(this.history); }
  acceptMeaning(id: string, session: string, now = Date.now(), scope = "local:all") {
    this.record(this.history.meanings, meaningKey(scope, id), session, now);
  }
  choosePhoto(meaning: string, id: string, session: string, now = Date.now(), pin = false, scope = "local:all") {
    const dated = datedMeaning(meaning), baseMeaning = dated?.[2] ?? meaning, photo = this.records.get(id), captured = photo && Date.parse(photo.date);
    if (dated && (!photo || !hasCaptureDate(photo) || !Number.isFinite(captured) || (dated[0] !== null && captured! < dated[0]) || (dated[1] !== null && captured! >= dated[1]))) return;
    const derived = /^(?:date|text|label):/.test(baseMeaning) ? this.search(baseMeaning.slice(baseMeaning.indexOf(":") + 1), { now, scope, committedMeaning: baseMeaning }).meaning : undefined;
    const supported = (dated && baseMeaning === "date") || this.dictionary.some(term => term.id === baseMeaning && term.sources.has(id)) ||
      (derived?.id === baseMeaning && derived.photoIds.includes(id)) ||
      (baseMeaning.startsWith("file:") && normalizeSearch(photo?.filename ?? "") === baseMeaning.slice(5));
    if (!supported) return;
    const key = meaningKey(scope, meaning);
    this.record(this.history.photos, photoKey(key, id), session, now);
    if (pin) this.history.pins[key] = id;
  }
  private record(target: Record<string, Event[]>, key: string, session: string, at: number) {
    const events = target[key] ?? [];
    if (events.some(event => event.session === session)) return;
    target[key] = [...events, { at, session }].slice(-64);
  }
  search(query: string, options: { allowedIds?: Set<string>; scope?: string; committedMeaning?: string; previous?: SearchResult; now?: number } = {}): SearchResult {
    const work = this.query(query, options); let step = work.next();
    while (!step.done) step = work.next();
    return step.value;
  }
  async searchAsync(query: string, options: { allowedIds?: Set<string>; scope?: string; committedMeaning?: string; previous?: SearchResult; now?: number } = {}, signal?: AbortSignal, current: () => boolean = () => true): Promise<SearchResult> {
    const work = this.query(query, options); let deadline = performance.now() + 4;
    const check = () => {if (signal?.aborted || !current()) throw new DOMException("Search cancelled", "AbortError");};
    try {
      check(); let step = work.next();
      while (!step.done) {
        check();
        if (performance.now() >= deadline) {await new Promise(resolve => setTimeout(resolve, 0)); check(); deadline = performance.now() + 4;}
        step = work.next();
      }
      check();
      const result = step.value, sources = new Map<string, SearchPhoto>();
      for (const candidate of new Set([...result.meanings, ...(result.meaning ? [result.meaning] : [])]))
        for (const id of candidate.photoIds) {
          if (this.records.get(id)?.current) sources.set(id, this.records.get(id)!);
          if (performance.now() >= deadline) {await new Promise(resolve => setTimeout(resolve, 0)); check(); deadline = performance.now() + 4;}
        }
      if (sources.size) result.current = () => {for (const [id, record] of sources) if (this.records.get(id) !== record || record.current?.() === false) return false; return true;};
      check(); if (result.current?.() === false) throw new Error("CACHED_SEARCH_SOURCE_CHANGED"); return result;
    } finally {work.return(undefined as never);}
  }
  private *query(query: string, options: { allowedIds?: Set<string>; scope?: string; committedMeaning?: string; previous?: SearchResult; now?: number }): Generator<void, SearchResult> {
    function* ordered<T>(values: T[], compare: (a:T,b:T)=>number): Generator<void,T[]> {
      let source = values, target = new Array<T>(values.length);
      for (let width = 1; width < source.length; width *= 2) {
        for (let start = 0; start < source.length; start += width * 2) {
          let left = start, right = Math.min(start + width, source.length), end = Math.min(start + width * 2, source.length), middle = right;
          for (let out = start; out < end; out++) {
            target[out] = left < middle && (right >= end || compare(source[left], source[right]) <= 0) ? source[left++] : source[right++];
            if (out % 128 === 0) yield;
          }
        }
        [source,target] = [target,source];
      }
      return source;
    }
    const now = options.now ?? Date.now(), scope = options.scope ?? "local:all", dateQuery = parseNaturalDateQuery(query, {now});
    const dated = dateQuery.phrase !== undefined, prefix = dated ? dateQuery.text : normalizeSearch(query);
    const empty: SearchResult = { query, scope, meanings: [], photoIds: [] };
    if (!prefix && !dated) return empty;
    const dates = new Map<string, number>();
    const captured = (id: string) => {
      if (!dates.has(id)) dates.set(id, Date.parse(this.records.get(id)!.date));
      return dates.get(id)!;
    };
    const eligible = (id: string) => this.records.has(id) && this.records.get(id)?.current?.() !== false
      && (!options.allowedIds || options.allowedIds.has(id)) && (!dated || (hasCaptureDate(this.records.get(id)!) && Number.isFinite(captured(id)) && (dateQuery.from === undefined || captured(id) >= dateQuery.from) && (dateQuery.until === undefined || captured(id) < dateQuery.until)));
    const candidates: SearchMeaning[] = [];
    const byId = new Map<string, SearchMeaning>();
    const include = (id: string, term: string, photoId: string, source: SearchEvidence) => {
      if (dated) id = "dated:" + JSON.stringify([dateQuery.from ?? null, dateQuery.until ?? null, id]);
      let candidate = byId.get(id);
      if (!candidate) {
        candidate = { id, term, kind: source, photoIds: [], evidence: {} };
        candidates.push(candidate); byId.set(id, candidate);
      }
      const old = candidate.evidence[photoId];
      if (!old) candidate.photoIds.push(photoId);
      if (!old || tier(source) > tier(old)) candidate.evidence[photoId] = source;
      if (tier(source) > tier(candidate.kind)) candidate.kind = source;
    };
    if (dated && !prefix) {
      for (const photo of this.records.values()) {yield; if (eligible(photo.id)) include("date", dateQuery.phrase!, photo.id, "date");}
    }
    let low = 0, high = this.dictionary.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.dictionary[middle].normalized < prefix) low = middle + 1; else high = middle;
    }
    for (let i = low; i < this.dictionary.length; i++) {
      const term = this.dictionary[i];
      if (!prefix) break;
      if (!term.normalized.startsWith(prefix)) break;
      // Numeric OCR tokens require an exact query, rather than noisy digit completion.
      if (/^\d+$/.test(term.normalized) && term.normalized !== prefix) continue;
      for (const [id, source] of term.sources) {yield; if (eligible(id)) include(term.id, term.term, id, source);}
    }
    const tokens = words(prefix);
    if (tokens.length > 1 && tokens.length <= 16) {
      for (const position of this.phrases.get(tokens[0]) ?? []) {
        yield;
        if (!eligible(position.photoId) || position.start + tokens.length > position.normalized.length) continue;
        if (!tokens.every((token, offset) => offset === tokens.length - 1 && !/^\d+$/.test(token) ? position.normalized[position.start + offset].startsWith(token) : position.normalized[position.start + offset] === token)) continue;
        const term = position.display.slice(position.start, position.start + tokens.length).join(" ");
        include((position.source === "label" || position.source === "person" ? "label:" : "text:") + normalizeSearch(term), term, position.photoId, position.source);
      }
    }
    // Literal filenames remain available when the user types file-like syntax or digits.
    if (/[._-]|\d/.test(prefix)) {
      for (const photo of this.records.values()) {
        yield; if (!eligible(photo.id)) continue;
        const filename = normalizeSearch(photo.filename), stem = filename.replace(/\.[^.]+$/, "");
        if (filename.startsWith(prefix) || stem === prefix || (/^\d+$/.test(prefix) && words(stem).includes(prefix))) {
          include("file:" + filename, photo.filename, photo.id, "filename");
        }
      }
    }
    for (const candidate of candidates) for (const id of candidate.photoIds) {yield; if (!eligible(id)) throw new Error("CACHED_SEARCH_SOURCE_CHANGED");}
    const orderedCandidates = yield* ordered(candidates, (a, b) =>
      Number(normalizeSearch(b.term) === prefix) - Number(normalizeSearch(a.term) === prefix) ||
      count(this.history.meanings[meaningKey(scope, b.id)], now) - count(this.history.meanings[meaningKey(scope, a.id)], now) ||
      tier(b.kind) - tier(a.kind) || compare(a.id, b.id));
    const meaning = orderedCandidates.find(candidate => candidate.id === options.committedMeaning) ?? orderedCandidates[0];
    if (!meaning) return { ...empty, meanings: orderedCandidates.slice(0, 6) };
    const key = meaningKey(scope, meaning.id), pin = this.history.pins[key];
    const ranks = new Map<string, number[]>();
    for (const id of meaning.photoIds) {
      yield;
      const photo = this.records.get(id)!, parsed = captured(id);
      ranks.set(id, [
        Number(id === pin), tier(meaning.evidence[id]), count(this.history.photos[photoKey(key, id)], now),
        meaning.evidence[id] === "ocr" ? photo.ocr?.confidence ?? 0 : 0,
        Number(photo.favorite === true), hasCaptureDate(photo) && parsed <= now && Number.isFinite(parsed) ? parsed : 0,
      ]);
    }
    const sorted = yield* ordered(meaning.photoIds.slice(), (a, b) => {
      const left = ranks.get(a)!, right = ranks.get(b)!;
      for (let position = 0; position < left.length; position++) {
        const difference = right[position] - left[position];
        if (difference) return difference;
      }
      return compare(a, b);
    });
    const previous = options.previous, extending = previous && prefix.startsWith(dated ? parseNaturalDateQuery(previous.query, {now}).text : normalizeSearch(previous.query));
    const previousId = previous?.photoId;
    const bestTier = tier(meaning.evidence[sorted[0]]);
    const stable = extending && previous.scope === scope && previous.meaning?.id === meaning.id && previousId && sorted.includes(previousId) &&
      (pin ? pin === previousId : tier(meaning.evidence[previousId]) === bestTier);
    const photoIds = sorted.slice(0, 200);
    if (stable && !photoIds.includes(previousId!)) photoIds.splice(199, 1, previousId!);
    // No await/yield may separate this evidence fence from returning the result.
    // Earlier yielded checks can themselves be crossed by a later source withdrawal.
    for (const candidate of new Set([...orderedCandidates.slice(0, 6), meaning])) {
      for (const id of candidate.photoIds) if (!eligible(id)) throw new Error("CACHED_SEARCH_SOURCE_CHANGED");
    }
    return { query, scope, meanings: orderedCandidates.slice(0, 6), meaning, photoIds, photoId: stable ? previousId : photoIds[0] };
  }
}
