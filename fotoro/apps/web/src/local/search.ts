export interface SearchPhoto {
  id: string;
  filename: string;
  date: string;
  dateSource: "exif" | "selected";
  labels?: string[];
}
type Event = { at: number; session: string };
export interface SearchFeedback {
  version: 1;
  meanings: Record<string, Event[]>;
  photos: Record<string, Event[]>;
  pins: Record<string, string>;
}
export interface SearchMeaning {
  id: string;
  term: string;
  kind: "label" | "filename" | "date";
  photoIds: string[];
}
export interface SearchResult {
  query: string;
  meanings: SearchMeaning[];
  meaning?: SearchMeaning;
  photoIds: string[];
  photoId?: string;
}
export const emptyFeedback = (): SearchFeedback => ({ version: 1, meanings: {}, photos: {}, pins: {} });
export const normalizeSearch = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const noise = /^(?:img\d*|dsc\d*|pxl\d*|image|photo|fixture|screenshot|the|and|jpg|jpeg|png|heic)$/i;
const count = (events: Event[] | undefined, now: number) => (events ?? []).reduce((sum, event) => sum + Math.pow(0.5, Math.max(0, now - event.at) / (30 * 86400000)), 0);
const photoKey = (meaning: string, id: string) => JSON.stringify([meaning, id]);

/** Perception happens elsewhere. This index only retrieves supported local meanings. */
export class PhotoSearchIndex {
  private records: Map<string, SearchPhoto>;
  private dictionary: SearchMeaning[];
  private history: SearchFeedback;
  constructor(photos: SearchPhoto[], feedback: SearchFeedback = emptyFeedback()) {
    this.records = new Map(photos.map(photo => [photo.id, photo]));
    this.history = structuredClone(feedback);
    const terms = new Map<string, SearchMeaning>();
    const add = (word: string, kind: "label" | "filename", photoId: string) => {
      const normalized = normalizeSearch(word);
      if (!normalized) return;
      const id = kind + ":" + normalized;
      let meaning = terms.get(id);
      if (!meaning) {
        meaning = { id, term: word, kind, photoIds: [] };
        terms.set(id, meaning);
      }
      if (!meaning.photoIds.includes(photoId)) meaning.photoIds.push(photoId);
    };
    for (const photo of [...photos].sort((a, b) => compare(a.id, b.id))) {
      for (const label of photo.labels ?? []) {
        add(label, "label", photo.id);
        for (const word of label.match(/[\p{L}\p{N}]+/gu) ?? []) add(word, "label", photo.id);
      }
      for (const word of photo.filename.replace(/\.[^.]+$/, "").match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (word.length >= 2 && /\p{L}/u.test(word) && !noise.test(word)) add(word, "filename", photo.id);
      }
    }
    this.dictionary = [...terms.values()].sort((a, b) => compare(normalizeSearch(a.term), normalizeSearch(b.term)) || compare(a.id, b.id));
  }
  feedback(): SearchFeedback { return structuredClone(this.history); }
  acceptMeaning(id: string, session: string, now = Date.now()) {
    this.record(this.history.meanings, id, session, now);
  }
  choosePhoto(meaning: string, id: string, session: string, now = Date.now(), pin = false) {
    if (!this.dictionary.some(term => term.id === meaning && term.photoIds.includes(id))) return;
    this.record(this.history.photos, photoKey(meaning, id), session, now);
    if (pin) this.history.pins[meaning] = id;
  }
  private record(target: Record<string, Event[]>, key: string, session: string, at: number) {
    const events = target[key] ?? [];
    if (events.some(event => event.session === session)) return;
    target[key] = [...events, { at, session }].slice(-64);
  }
  search(query: string, options: { allowedIds?: Set<string>; committedMeaning?: string; previous?: SearchResult; now?: number } = {}): SearchResult {
    const prefix = normalizeSearch(query), now = options.now ?? Date.now();
    const empty: SearchResult = { query, meanings: [], photoIds: [] };
    if (!prefix) return empty;
    const eligible = (id: string) => this.records.has(id) && (!options.allowedIds || options.allowedIds.has(id));
    const candidates: SearchMeaning[] = [];
    let low = 0, high = this.dictionary.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (normalizeSearch(this.dictionary[middle].term) < prefix) low = middle + 1; else high = middle;
    }
    for (let i = low; i < this.dictionary.length; i++) {
      const term = this.dictionary[i];
      if (!normalizeSearch(term.term).startsWith(prefix)) break;
      const ids = term.photoIds.filter(eligible);
      if (ids.length) candidates.push({ ...term, photoIds: ids });
    }
    if (/^\d/.test(prefix)) {
      const ids = [...this.records.values()].filter(photo => eligible(photo.id) && (photo.date.includes(prefix) || normalizeSearch(new Date(photo.date).toLocaleDateString()).includes(prefix))).map(photo => photo.id);
      if (ids.length) candidates.push({ id: "date:" + prefix, term: query.trim(), kind: "date", photoIds: ids });
    }
    candidates.sort((a, b) =>
      Number(normalizeSearch(b.term) === prefix) - Number(normalizeSearch(a.term) === prefix) ||
      count(this.history.meanings[b.id], now) - count(this.history.meanings[a.id], now) ||
      Number(b.kind === "label") - Number(a.kind === "label") || compare(a.id, b.id));
    const meaning = options.committedMeaning ? candidates.find(candidate => candidate.id === options.committedMeaning) : candidates[0];
    if (!meaning) return { ...empty, meanings: candidates.slice(0, 6) };
    const photoIds = [...meaning.photoIds].sort((a, b) => {
      const pin = this.history.pins[meaning.id];
      const age = (id: string) => {
        const photo = this.records.get(id)!;
        const date = Date.parse(photo.date);
        return photo.dateSource === "exif" && date <= now && Number.isFinite(date) ? date : 0;
      };
      return Number(b === pin) - Number(a === pin) ||
        count(this.history.photos[photoKey(meaning.id, b)], now) - count(this.history.photos[photoKey(meaning.id, a)], now) || age(b) - age(a) || compare(a, b);
    }).slice(0, 200);
    const previous = options.previous;
    const extending = previous && prefix.startsWith(normalizeSearch(previous.query));
    const stable = extending && previous.meaning?.id === meaning.id && previous.photoId && photoIds.includes(previous.photoId) && (!this.history.pins[meaning.id] || this.history.pins[meaning.id] === previous.photoId);
    return { query, meanings: candidates.slice(0, 6), meaning, photoIds, photoId: stable ? previous!.photoId : photoIds[0] };
  }
}
