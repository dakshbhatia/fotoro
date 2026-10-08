// Account-private capture evidence carried by the existing annotation facts wire.
export const CAPTURE_METADATA_PREFIX = "fotoro.capture.v1:";
export const isCaptureMetadataFact = (fact: string) => fact.startsWith("fotoro.capture.");
export type CaptureMetadataProvenance = "photos" | "original";
export type CaptureMetadataField = "width" | "height" | "createdAt" | "modifiedAt" | "addedAt" | "duration" | "mediaType" | "contentType" | "subtypes" | "sourceTypes" | "burst" | "burstSelection" | "hasAdjustments" | "cameraMake" | "cameraModel" | "lensMake" | "lensModel" | "iso" | "aperture" | "exposureSeconds" | "focalLength" | "focalLength35mm" | "orientation" | "originalDateTime" | "offsetTimeOriginal";
export interface CaptureMetadataItemV1 {k: CaptureMetadataField; p: CaptureMetadataProvenance; v: string}
export interface PhotoCaptureMetadataV1 {version: 1; originalSha256: string; items: CaptureMetadataItemV1[]}
export interface CaptureMetadataRow {label: string; value: string; provenance: CaptureMetadataProvenance}
const count = (value: string) => Array.from(value).length;
// Account originals use canonical unpadded base64URL of 32 bytes; local browser
// records may carry the older 64-hex digest. Binding remains exact in either form.
const digest = (value: string) => /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value) || /^[a-f\d]{64}$/i.test(value);
const text = (value: string) => !!value && value === value.trim() && count(value) <= 120 && !/[\p{Cc}\p{Cf}]/u.test(value);
const numeric = (value: string, min: number, max: number, integer = false, exclusiveMin = false) =>
  (integer ? /^\d+$/ : /^\d+(?:\.\d+)?$/).test(value) && Number.isFinite(Number(value)) &&
  (exclusiveMin ? Number(value) > min : Number(value) >= min) && Number(value) <= max && (!integer || Number.isInteger(Number(value)));
const isoDate = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const lists = {
  subtypes: ["panorama", "hdr", "screenshot", "livePhoto", "depthEffect", "animation", "spatial", "streamed", "highFrameRate", "timelapse", "screenRecording", "cinematic"],
  sourceTypes: ["userLibrary", "cloudShared", "iTunesSynced"],
  burstSelection: ["autoPick", "userPick"],
};
const validList = (value: string, allowed: readonly string[]) => {
  const parts = value.split(",");
  return parts.every(part => allowed.includes(part)) && [...new Set(parts)].sort().join(",") === value;
};
export function validatedCaptureMetadataItem(value: unknown): CaptureMetadataItemV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "k,p,v" || typeof item.k !== "string" || typeof item.v !== "string" || !text(item.v) || !["photos", "original"].includes(item.p as string)) return;
  const {k, p, v} = item;
  let valid = false;
  if (["width", "height"].includes(k)) valid = numeric(v, 1, 1_000_000, true);
  else if (k === "contentType") valid = text(v);
  else if (p === "photos") {
    if (["createdAt", "modifiedAt", "addedAt"].includes(k)) valid = isoDate(v);
    else if (k === "duration") valid = numeric(v, 0, 1e9);
    else if (k === "mediaType") valid = ["image", "video", "audio"].includes(v);
    else if (Object.hasOwn(lists, k)) valid = validList(v, lists[k as keyof typeof lists]);
    else if (["burst", "hasAdjustments"].includes(k)) valid = ["true", "false"].includes(v);
  } else {
    if (["cameraMake", "cameraModel", "lensMake", "lensModel"].includes(k)) valid = text(v);
    else if (k === "iso") valid = numeric(v, 1, 10_000_000, true);
    else if (k === "aperture") valid = numeric(v, 0, 128, false, true);
    else if (k === "exposureSeconds") valid = numeric(v, 0, 86400, false, true);
    else if (["focalLength", "focalLength35mm"].includes(k)) valid = numeric(v, 0, 100000, false, true);
    else if (k === "orientation") valid = numeric(v, 1, 8, true);
    else if (k === "originalDateTime" && /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(v)) valid = isoDate(v.slice(0, 10).replaceAll(":", "-") + "T" + v.slice(11) + ".000Z");
    else if (k === "offsetTimeOriginal") valid = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
  }
  return valid ? item as unknown as CaptureMetadataItemV1 : undefined;
}
// Exactly three string-valued JSON members; decoded keys must be distinct.
// This also rejects escaped duplicate keys without miscounting quoted text in v.
const itemJson = /^\s*\{\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*\}\s*$/u;
export function annotationCaptureMetadata(value: {facts?: readonly string[]; originalSha256?: string}, originalSha256: string): PhotoCaptureMetadataV1 | undefined {
  const facts = value.facts;
  if (!digest(originalSha256) || (value.originalSha256 !== undefined && value.originalSha256 !== originalSha256) || !Array.isArray(facts) || facts.length > 64 || facts.some(fact => typeof fact !== "string" || !fact || count(fact) > 240)) return;
  const reserved = facts.filter(fact => fact.startsWith(CAPTURE_METADATA_PREFIX));
  const sources = reserved.filter(fact => fact.startsWith(CAPTURE_METADATA_PREFIX + "source:"));
  if (sources.length !== 1 || sources[0] !== CAPTURE_METADATA_PREFIX + "source:" + originalSha256 || reserved.length < 2 || reserved.length > 33) return;
  const items: CaptureMetadataItemV1[] = [], seen = new Set<string>();
  for (const fact of reserved) {
    if (fact === sources[0]) continue;
    if (!fact.startsWith(CAPTURE_METADATA_PREFIX + "item:")) return;
    try {
      const raw = fact.slice((CAPTURE_METADATA_PREFIX + "item:").length), match = raw.match(itemJson);
      if (!match || new Set([JSON.parse(match[1]), JSON.parse(match[3]), JSON.parse(match[5])]).size !== 3) return;
      const item = validatedCaptureMetadataItem(JSON.parse(raw));
      if (!item || seen.has(item.p + ":" + item.k)) return;
      seen.add(item.p + ":" + item.k); items.push(item);
    } catch {return;}
  }
  return {version: 1, originalSha256, items};
}
const labels: Record<CaptureMetadataField, string> = {width: "Width", height: "Height", createdAt: "Created in Photos", modifiedAt: "Modified in Photos", addedAt: "Added to Photos", duration: "Duration", mediaType: "Media", contentType: "Format", subtypes: "Media features", sourceTypes: "Photos source", burst: "Burst", burstSelection: "Burst selection", hasAdjustments: "Photos adjustments", cameraMake: "Camera maker", cameraModel: "Camera", lensMake: "Lens maker", lensModel: "Lens", iso: "ISO", aperture: "Aperture", exposureSeconds: "Exposure", focalLength: "Focal length", focalLength35mm: "35 mm equivalent", orientation: "EXIF orientation", originalDateTime: "Original capture time", offsetTimeOriginal: "Original time offset"};
const names: Record<string, string> = {image: "Photo", video: "Video", audio: "Audio", panorama: "Panorama", hdr: "HDR", screenshot: "Screenshot", livePhoto: "Live Photo", depthEffect: "Depth effect", animation: "Animation", spatial: "Spatial", streamed: "Streamed", highFrameRate: "High frame rate", timelapse: "Time lapse", screenRecording: "Screen recording", cinematic: "Cinematic", userLibrary: "Photos library", cloudShared: "Shared Photos", iTunesSynced: "iTunes sync", autoPick: "Automatic pick", userPick: "Selected pick"};
const formats: Record<string, string> = {"public.jpeg": "JPEG", "public.png": "PNG", "public.heic": "HEIC", "public.heif": "HEIF", "public.avif": "AVIF", "com.compuserve.gif": "GIF", "public.tiff": "TIFF", "com.adobe.raw-image": "RAW", "com.apple.quicktime-movie": "QuickTime video", "public.mpeg-4": "MPEG-4 video"};
export function captureMetadataRows(metadata: PhotoCaptureMetadataV1): CaptureMetadataRow[] {
  return metadata.items.map(item => {
    let value = item.v;
    if (item.k === "mediaType") value = names[value];
    else if (item.k === "contentType") value = Object.hasOwn(formats, value) ? formats[value] : value;
    else if (Object.hasOwn(lists, item.k)) value = value.split(",").map(part => names[part]).join(", ");
    else if (["createdAt", "modifiedAt", "addedAt"].includes(item.k)) value = value.replace("T", " ").replace("Z", " UTC");
    else if (["width", "height"].includes(item.k)) value += " px";
    else if (["duration", "exposureSeconds"].includes(item.k)) value += " s";
    else if (["focalLength", "focalLength35mm"].includes(item.k)) value += " mm";
    else if (item.k === "aperture") value = "ƒ/" + value;
    else if (["burst", "hasAdjustments"].includes(item.k)) value = value === "true" ? "Yes" : "No";
    return {label: labels[item.k], value, provenance: item.p};
  });
}
// Only useful, source-bound camera/media words enter Find; JSON and numeric settings do not.
export function captureMetadataSearchText(value: {facts?: readonly string[]; originalSha256?: string}, originalSha256: string): string[] {
  const metadata = annotationCaptureMetadata(value, originalSha256);
  if (!metadata) return [];
  return [...new Set(metadata.items.flatMap(item => {
    if (["cameraMake", "cameraModel", "lensMake", "lensModel"].includes(item.k)) return [item.v];
    if (item.k === "mediaType") return [names[item.v]];
    if (item.k === "subtypes") return item.v.split(",").map(part => names[part]);
    if (item.k === "burst" && item.v === "true") return ["Burst"];
    return [];
  }))];
}
