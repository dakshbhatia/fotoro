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
export const emptyFeedback = (): SearchFeedback => ({ version: 1, meanings: {}, photos: {}, pins: {} });
export const normalizeSearch = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const noise = /^(?:img\d*|dsc\d*|pxl\d*|image|photo|fixture|screenshot|the|and|jpg|jpeg|png|heic)$/i;
const tier = (source: SearchEvidence) => source === "label" || source === "date" ? 4 : source === "keyword" || source === "fact" ? 3 : source === "caption" ? 2 : 1;
const count = (events: Event[] | undefined, now: number) => (events ?? []).reduce((sum, event) => sum + Math.pow(0.5, Math.max(0, now - event.at) / (30 * 86400000)), 0);
const photoKey = (meaning: string, id: string) => JSON.stringify([meaning, id]);
const meaningKey = (scope: string, meaning: string) => JSON.stringify([scope, meaning]);
const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];

/** Perception happens elsewhere. Typing only retrieves supported local meanings. */
export class PhotoSearchIndex {
  private records: Map<string, SearchPhoto>;
  private dictionary: IndexedMeaning[];
  private history: SearchFeedback;
  constructor(photos: SearchPhoto[], feedback: SearchFeedback = emptyFeedback()) {
    this.records = new Map(photos.map(photo => [photo.id, photo]));
    this.history = structuredClone(feedback);
    const terms = new Map<string, IndexedMeaning>();
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
        add(label, "label", photo.id);
        for (const word of words(label)) add(word, "label", photo.id);
      }
      for (const keyword of photo.keywords ?? []) {
        add(keyword, "keyword", photo.id);
        for (const word of words(keyword)) add(word, "keyword", photo.id);
      }
      for (const fact of photo.facts ?? []) add(fact, "fact", photo.id);
      for (const word of words(photo.caption ?? "")) if (!noise.test(word)) add(word, "caption", photo.id);
      for (const word of words(photo.filename.replace(/\.[^.]+$/, ""))) {
        if (word.length >= 2 && /\p{L}/u.test(word) && !noise.test(word)) add(word, "filename", photo.id);
      }
      const ocr = photo.ocr;
      if (ocr?.status === "complete" && ocr.photoID === photo.id && ocr.revision === (photo.digest ?? photo.id) && Number.isFinite(ocr.confidence) && ocr.confidence >= 0 && ocr.confidence <= 1) {
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
    const supported = this.dictionary.some(term => term.id === meaning && term.sources.has(id)) || (meaning.startsWith("date:") && this.search(meaning.slice(5), { now, scope }).meanings.some(term => term.id === meaning && term.photoIds.includes(id)));
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
      const strongest = ids.reduce<SearchEvidence>((best, id) => tier(term.sources.get(id)!) > tier(best) ? term.sources.get(id)! : best, term.sources.get(ids[0])!);
      candidates.push({ id: term.id, term: term.term, kind: strongest, photoIds: ids, evidence: Object.fromEntries(ids.map(id => [id, term.sources.get(id)!])) });
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
    const sorted = [...meaning.photoIds].sort((a, b) => {
      const captureTime = (id: string) => {
        const photo = this.records.get(id)!, date = Date.parse(photo.date);
        return photo.dateSource === "exif" && date <= now && Number.isFinite(date) ? date : 0;
      };
      const confidence = (id: string) => meaning.evidence[id] === "ocr" ? this.records.get(id)!.ocr?.confidence ?? 0 : 0;
      return Number(b === pin) - Number(a === pin) || tier(meaning.evidence[b]) - tier(meaning.evidence[a]) ||
        count(this.history.photos[photoKey(key, b)], now) - count(this.history.photos[photoKey(key, a)], now) ||
        confidence(b) - confidence(a) || Number(this.records.get(b)!.favorite === true) - Number(this.records.get(a)!.favorite === true) || captureTime(b) - captureTime(a) || compare(a, b);
    });
    const previous = options.previous, extending = previous && prefix.startsWith(normalizeSearch(previous.query));
    const previousId = previous?.photoId;
    const bestTier = tier(meaning.evidence[sorted[0]]);
    const stable = extending && previous.scope === scope && previous.meaning?.id === meaning.id && previousId && sorted.includes(previousId) &&
      (pin ? pin === previousId : tier(meaning.evidence[previousId]) === bestTier);
    const photoIds = stable ? [previousId!, ...sorted.filter(id => id !== previousId)].slice(0, 200) : sorted.slice(0, 200);
    return { query, scope, meanings: candidates.slice(0, 6), meaning, photoIds, photoId: photoIds[0] };
  }
}
