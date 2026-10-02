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
  id: string;
  digest?: string;
  filename: string;
  date: string;
  dateSource: "exif" | "selected";
  labels?: string[];
  caption?: string;
  keywords?: string[];
  facts?: string[];
  favorite?: boolean;
  ocr?: SearchOcr;
}
type Event = { at: number; session: string };
export interface SearchFeedback {
  version: 1;
  meanings: Record<string, Event[]>;
  photos: Record<string, Event[]>;
  pins: Record<string, string>;
}
export type SearchEvidence = "label" | "keyword" | "caption" | "fact" | "filename" | "ocr" | "date";
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
export const emptyFeedback = (): SearchFeedback => ({ version: 1, meanings: {}, photos: {}, pins: {} });
export const normalizeSearch = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const noise = /^(?:img\d*|dsc\d*|pxl\d*|image|photo|fixture|screenshot|the|and|jpg|jpeg|png|heic)$/i;
const tier = (source: SearchEvidence) => source === "label" || source === "date" ? 4 : source === "keyword" || source === "fact" ? 3 : source === "caption" ? 2 : 1;
const count = (events: Event[] | undefined, now: number) => (events ?? []).reduce((sum, event) => sum + Math.pow(0.5, Math.max(0, now - event.at) / (30 * 86400000)), 0);
const photoKey = (meaning: string, id: string) => JSON.stringify([meaning, id]);
const meaningKey = (scope: string, meaning: string) => JSON.stringify([scope, meaning]);
const words = (text: string): string[] => text.match(/[\p{L}\p{N}]+/gu) ?? [];

/* Perception happens elsewhere. Typing only retrieves supported local meanings. */
export class PhotoSearchIndex {
  private records: Map<string, SearchPhoto>;
  private dictionary: IndexedMeaning[];
  private phrases = new Map<string, PhrasePosition[]>();
  private history: SearchFeedback;
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
      const id = (source === "label" ? "label:" : "text:") + normalized;
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
      for (const keyword of photo.keywords ?? []) {
        phraseSource(keyword, "keyword", photo.id);
        add(keyword, "keyword", photo.id);
        for (const word of words(keyword)) add(word, "keyword", photo.id);
      }
      for (const fact of photo.facts ?? []) { add(fact, "fact", photo.id); phraseSource(fact, "fact", photo.id); }
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
  feedback(): SearchFeedback { return structuredClone(this.history); }
  acceptMeaning(id: string, session: string, now = Date.now(), scope = "local:all") {
    this.record(this.history.meanings, meaningKey(scope, id), session, now);
  }
  choosePhoto(meaning: string, id: string, session: string, now = Date.now(), pin = false, scope = "local:all") {
    const derived = /^(?:date|text|label):/.test(meaning) ? this.search(meaning.slice(meaning.indexOf(":") + 1), { now, scope, committedMeaning: meaning }).meaning : undefined;
    const supported = this.dictionary.some(term => term.id === meaning && term.sources.has(id)) ||
      (derived?.id === meaning && derived.photoIds.includes(id)) ||
      (meaning.startsWith("file:") && normalizeSearch(this.records.get(id)?.filename ?? "") === meaning.slice(5));
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
    const prefix = normalizeSearch(query), now = options.now ?? Date.now(), scope = options.scope ?? "local:all";
    const empty: SearchResult = { query, scope, meanings: [], photoIds: [] };
    if (!prefix) return empty;
    const eligible = (id: string) => this.records.has(id) && (!options.allowedIds || options.allowedIds.has(id));
    const candidates: SearchMeaning[] = [];
    const byId = new Map<string, SearchMeaning>();
    const include = (id: string, term: string, photoId: string, source: SearchEvidence) => {
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
    let low = 0, high = this.dictionary.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.dictionary[middle].normalized < prefix) low = middle + 1; else high = middle;
    }
    for (let i = low; i < this.dictionary.length; i++) {
      const term = this.dictionary[i];
      if (!term.normalized.startsWith(prefix)) break;
      // Numeric OCR tokens require an exact query, rather than noisy digit completion.
      if (/^\d+$/.test(term.normalized) && term.normalized !== prefix) continue;
      const ids = [...term.sources.keys()].filter(eligible);
      if (!ids.length) continue;
      for (const id of ids) include(term.id, term.term, id, term.sources.get(id)!);
    }
    const tokens = words(prefix);
    if (tokens.length > 1 && tokens.length <= 16) {
      for (const position of this.phrases.get(tokens[0]) ?? []) {
        if (!eligible(position.photoId) || position.start + tokens.length > position.normalized.length) continue;
        if (!tokens.every((token, offset) => offset === tokens.length - 1 ? position.normalized[position.start + offset].startsWith(token) : position.normalized[position.start + offset] === token)) continue;
        const term = position.display.slice(position.start, position.start + tokens.length).join(" ");
        include((position.source === "label" ? "label:" : "text:") + normalizeSearch(term), term, position.photoId, position.source);
      }
    }
    // Literal filenames remain available when the user types file-like syntax or digits.
    if (/[._-]|\d/.test(prefix)) {
      for (const photo of this.records.values()) {
        if (!eligible(photo.id)) continue;
        const filename = normalizeSearch(photo.filename), stem = filename.replace(/\.[^.]+$/, "");
        if (filename.startsWith(prefix) || stem === prefix || (/^\d+$/.test(prefix) && words(stem).includes(prefix))) {
          include("file:" + filename, photo.filename, photo.id, "filename");
        }
      }
    }
    if (/^\d/.test(prefix)) {
      const ids = [...this.records.values()].filter(photo => eligible(photo.id) && (photo.date.includes(prefix) || normalizeSearch(new Date(photo.date).toLocaleDateString()).includes(prefix))).map(photo => photo.id);
      if (ids.length) candidates.push({ id: "date:" + prefix, term: query.trim(), kind: "date", photoIds: ids, evidence: Object.fromEntries(ids.map(id => [id, "date" as const])) });
    }
    candidates.sort((a, b) =>
      Number(normalizeSearch(b.term) === prefix) - Number(normalizeSearch(a.term) === prefix) ||
      count(this.history.meanings[meaningKey(scope, b.id)], now) - count(this.history.meanings[meaningKey(scope, a.id)], now) ||
      tier(b.kind) - tier(a.kind) || compare(a.id, b.id));
    const meaning = candidates.find(candidate => candidate.id === options.committedMeaning) ?? candidates[0];
    if (!meaning) return { ...empty, meanings: candidates.slice(0, 6) };
    const key = meaningKey(scope, meaning.id), pin = this.history.pins[key];
    const ranks = new Map(meaning.photoIds.map(id => {
      const photo = this.records.get(id)!, parsed = Date.parse(photo.date);
      return [id, [
        Number(id === pin), tier(meaning.evidence[id]), count(this.history.photos[photoKey(key, id)], now),
        meaning.evidence[id] === "ocr" ? photo.ocr?.confidence ?? 0 : 0,
        Number(photo.favorite === true), photo.dateSource === "exif" && parsed <= now && Number.isFinite(parsed) ? parsed : 0,
      ]] as const;
    }));
    const sorted = [...meaning.photoIds].sort((a, b) => {
      const left = ranks.get(a)!, right = ranks.get(b)!;
      for (let position = 0; position < left.length; position++) {
        const difference = right[position] - left[position];
        if (difference) return difference;
      }
      return compare(a, b);
    });
    const previous = options.previous, extending = previous && prefix.startsWith(normalizeSearch(previous.query));
    const previousId = previous?.photoId;
    const bestTier = tier(meaning.evidence[sorted[0]]);
    const stable = extending && previous.scope === scope && previous.meaning?.id === meaning.id && previousId && sorted.includes(previousId) &&
      (pin ? pin === previousId : tier(meaning.evidence[previousId]) === bestTier);
    const photoIds = sorted.slice(0, 200);
    if (stable && !photoIds.includes(previousId!)) photoIds.splice(199, 1, previousId!);
    return { query, scope, meanings: candidates.slice(0, 6), meaning, photoIds, photoId: stable ? previousId : photoIds[0] };
  }
}
