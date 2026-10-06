export const CLOUD_FACT_PREFIX = "fotoro.ai.v1:";
export const isCloudObservationFact = (fact: string) => fact.startsWith(CLOUD_FACT_PREFIX);
export type PhotoObservationModel = "gemini-3.8-flash" | "gemini-3.5-flash-lite";
export interface PhotoObservationV1 {
  version: 1;
  photoId: string;
  sourceRevision: string;
  processor: PhotoObservationModel;
  observedAt: string;
  observations: {objects: string[]; scene: string[]; visibleText: string; uncertainty: string[]};
}
const chars = (value: string) => Array.from(value).length;
const cleanText = (value: string) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const exactKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const models = new Set(["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
const validTexts = (value: unknown, count: number, limit: number): value is string[] =>
  Array.isArray(value) && value.length <= count && value.every(item => typeof item === "string" && item.trim().length > 0 && chars(item) <= limit && cleanText(item));
export function validPhotoObservation(value: unknown): value is PhotoObservationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as PhotoObservationV1;
  const observations = item.observations;
  return exactKeys(item, ["version", "photoId", "sourceRevision", "processor", "observedAt", "observations"])
    && item.version === 1 && typeof item.photoId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.photoId)
    && typeof item.sourceRevision === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.sourceRevision)
    && models.has(item.processor) && typeof item.observedAt === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.observedAt) && Number.isFinite(Date.parse(item.observedAt))
    && !!observations && typeof observations === "object" && !Array.isArray(observations)
    && exactKeys(observations, ["objects", "scene", "visibleText", "uncertainty"])
    && validTexts(observations.objects, 12, 80) && validTexts(observations.scene, 6, 80)
    && typeof observations.visibleText === "string" && chars(observations.visibleText) <= 1200 && cleanText(observations.visibleText)
    && validTexts(observations.uncertainty, 4, 160);
}

/* Reserved facts fit the existing encrypted annotation format and strict older
   readers. Machine observations never replace supplied labels, captions or OCR. */
export function withPhotoObservation<T extends {facts?: string[]}>(value: T, observation: PhotoObservationV1 | undefined): T {
  const facts = (value.facts ?? []).filter(fact => !isCloudObservationFact(fact));
  if (observation) {
    if (!validPhotoObservation(observation)) throw new Error("Invalid photo observation");
    const binding = value as T & {photoId?: string; originalSha256?: string};
    if (binding.photoId !== undefined && binding.photoId !== observation.photoId
      || binding.originalSha256 !== undefined && binding.originalSha256 !== observation.sourceRevision) throw new Error("Photo observation binding mismatch");
    const {objects, scene, visibleText, uncertainty} = observation.observations;
    const text = Array.from(visibleText), parts: string[] = [];
    for (let index = 0; index < text.length; index += 200) parts.push(text.slice(index, index + 200).join(""));
    facts.push(CLOUD_FACT_PREFIX + "photo:" + observation.photoId);
    facts.push(CLOUD_FACT_PREFIX + "revision:" + observation.sourceRevision);
    facts.push(CLOUD_FACT_PREFIX + "header:" + JSON.stringify({v: 1, m: observation.processor,
      at: observation.observedAt, o: objects.length, s: scene.length, t: parts.length, u: uncertainty.length}));
    for (const [kind, values] of [["object", objects], ["scene", scene], ["text", parts], ["uncertainty", uncertainty]] as const)
      values.forEach((item, index) => facts.push(CLOUD_FACT_PREFIX + kind + ":" + index + ":" + item));
  }
  if (facts.length > 64 || facts.some(fact => !fact || chars(fact) > 240)) throw new Error("Photo observation exceeds annotation capacity");
  return {...value, ...(value.facts || observation ? {facts} : {})};
}

export function annotationObservation(value: {facts?: string[]; photoId?: string; originalSha256?: string}, binding: {photoId: string; sourceRevision: string}): PhotoObservationV1 | undefined {
  const facts = value.facts;
  if (!Array.isArray(facts) || facts.length > 64 || facts.some(fact => typeof fact !== "string" || !fact || chars(fact) > 240)) return;
  const outer = value as {photoId?: string; originalSha256?: string};
  if (outer.photoId !== undefined && outer.photoId !== binding.photoId
    || outer.originalSha256 !== undefined && outer.originalSha256 !== binding.sourceRevision) return;
  const reserved = facts.filter(isCloudObservationFact), headers = reserved.filter(fact => fact.startsWith(CLOUD_FACT_PREFIX + "header:"));
  const photos = reserved.filter(fact => fact.startsWith(CLOUD_FACT_PREFIX + "photo:"));
  const revisions = reserved.filter(fact => fact.startsWith(CLOUD_FACT_PREFIX + "revision:"));
  if (headers.length !== 1 || photos.length !== 1 || revisions.length !== 1
    || photos[0] !== CLOUD_FACT_PREFIX + "photo:" + binding.photoId
    || revisions[0] !== CLOUD_FACT_PREFIX + "revision:" + binding.sourceRevision) return;
  try {
    const raw = headers[0].slice((CLOUD_FACT_PREFIX + "header:").length), header = JSON.parse(raw);
    if (!header || typeof header !== "object" || Array.isArray(header) || Object.keys(header).sort().join() !== "at,m,o,s,t,u,v"
      || (raw.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? []).length !== 7 || header.v !== 1) return;
    for (const [key, maximum] of [["o", 12], ["s", 6], ["t", 6], ["u", 4]] as const)
      if (!Number.isInteger(header[key]) || header[key] < 0 || header[key] > maximum) return;
    const read = (kind: string, count: number) => {
      const prefix = CLOUD_FACT_PREFIX + kind + ":", values = reserved.filter(fact => fact.startsWith(prefix));
      if (values.length !== count) throw new Error("Incomplete observation");
      return Array.from({length: count}, (_, index) => {
        const matching = values.filter(fact => fact.startsWith(prefix + index + ":"));
        if (matching.length !== 1) throw new Error("Ambiguous observation");
        return matching[0].slice((prefix + index + ":").length);
      });
    };
    if (reserved.length !== 3 + header.o + header.s + header.t + header.u) return;
    const text = read("text", header.t);
    if (text.some((part, index) => chars(part) < 1 || chars(part) > 200 || index < text.length - 1 && chars(part) !== 200)) return;
    const observation: PhotoObservationV1 = {version: 1, ...binding, processor: header.m, observedAt: header.at,
      observations: {objects: read("object", header.o), scene: read("scene", header.s), visibleText: text.join(""), uncertainty: read("uncertainty", header.u)}};
    return validPhotoObservation(observation) ? observation : undefined;
  } catch {return;}
}

export function observationSearchText(value: {facts?: string[]}, binding: {photoId: string; sourceRevision: string}): string[] {
  const observation = annotationObservation(value, binding);
  return observation ? [...observation.observations.objects, ...observation.observations.scene, observation.observations.visibleText].filter(Boolean) : [];
}
