import {annotationCaptureMetadata} from "./capture-metadata";

// These remain private, owner/digest-bound annotation facts. Older readers keep them.
export const ORGANIZATION_PREFIXES = {name: "fotoro.name.v1:", trash: "fotoro.trash.v1:", screenshot: "fotoro.screenshot.v1:"} as const;
export type PhotoOrganizationPatch = {name?: string | null; trash?: boolean; screenshot?: boolean | null};
export function organizationFactCategory(fact: string): keyof typeof ORGANIZATION_PREFIXES | undefined {
  return (Object.keys(ORGANIZATION_PREFIXES) as (keyof typeof ORGANIZATION_PREFIXES)[]).find(key => fact.startsWith(ORGANIZATION_PREFIXES[key]));
}
export function validPhotoName(name: string): boolean {
  return name === name.trim() && Array.from(name).length >= 1 && Array.from(name).length <= 160 && new TextEncoder().encode(name).length <= 240 &&
    !/[\\/<>:"|?*\p{C}]/u.test(name) && !/[. ]$/.test(name) && !/^\./.test(name) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
}
function one(facts: readonly string[] | undefined, key: keyof typeof ORGANIZATION_PREFIXES) {
  const values = (facts ?? []).filter(fact => fact.startsWith(ORGANIZATION_PREFIXES[key]));
  return values.length === 1 ? values[0].slice(ORGANIZATION_PREFIXES[key].length) : undefined;
}
export function photoName(value: {facts?: readonly string[]}, original: string): string {
  const name = one(value.facts, "name");
  return name && validPhotoName(name) ? name : original;
}
export const isPhotoTrashed = (value: {facts?: readonly string[]}) => one(value.facts, "trash") === "true";
export function isPhotoScreenshot(value: {facts?: readonly string[]; filename?: string; digest?: string; originalSha256?: string}) {
  const override = one(value.facts, "screenshot");
  if (override === "true" || override === "false") return override === "true";
  const metadata = annotationCaptureMetadata(value, value.digest ?? value.originalSha256 ?? "");
  return metadata?.items.some(item => item.p === "photos" && item.k === "subtypes" && item.v.split(",").includes("screenshot")) === true ||
    value.facts?.includes("screenshot") === true;
}
export function withPhotoOrganization<T extends {facts?: string[]}>(value: T, patch: PhotoOrganizationPatch): T {
  let facts = [...(value.facts ?? [])];
  for (const key of Object.keys(ORGANIZATION_PREFIXES) as (keyof typeof ORGANIZATION_PREFIXES)[]) {
    if (!Object.hasOwn(patch, key)) continue;
    const item = patch[key];
    if (item === undefined) continue;
    if (key === "name" ? item !== null && (typeof item !== "string" || !validPhotoName(item)) : item !== null && typeof item !== "boolean") throw new Error("Invalid photo organization change");
    if (item !== null && !(key === "trash" && item === false) && one(facts, key) === String(item)) continue;
    facts = facts.filter(fact => !fact.startsWith(ORGANIZATION_PREFIXES[key]));
    if (item !== null && !(key === "trash" && item === false)) facts.push(ORGANIZATION_PREFIXES[key] + item);
  }
  if (facts.length > 64) throw new Error("Photo facts are full. Remove an unused fact before changing this photo.");
  return {...value, facts};
}
export function suggestedPhotoName(input: {filename: string; digest?: string; date?: string; dateSource?: string; labels?: readonly string[]; location?: {name?: string}; screenshot?: boolean}) {
  const extension = input.filename.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1].toLowerCase();
  const slug = (text: string) => text.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const date = ["exif", "photos"].includes(input.dateSource ?? "") && input.date && Number.isFinite(Date.parse(input.date)) ? new Date(input.date).toISOString().slice(0, 10) : undefined;
  const words: string[] = [], seen = new Set<string>();
  const add = (text: string | undefined) => {
    const word = text ? slug(text) : "", key = word.toLowerCase();
    if (!word || seen.has(key)) return false;
    seen.add(key); words.push(word); return true;
  };
  add(input.screenshot ? "Screenshot" : undefined); add(input.location?.name);
  let tags = 0;
  for (const label of input.labels ?? []) if (add(label) && ++tags === 2) break;
  // Digest suffix prevents common date/tag collisions, independent of device locale/timezone.
  let digest = input.digest;
  if (digest && !/^[a-fA-F0-9]{64}$/.test(digest)) {
    try { const raw = atob(digest.replaceAll("-", "+").replaceAll("_", "/")); digest = raw.length === 32 ? Array.from(raw, c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("") : undefined; } catch { digest = undefined; }
  }
  const identity = digest?.toLowerCase().slice(0, 10);
  const evidence = Array.from([date, ...new Set(words)].filter(Boolean).join("_")).slice(0, 120);
  while (new TextEncoder().encode(evidence.join("")).length > 210) evidence.pop();
  let stem = [evidence.join(""), identity].filter(Boolean).join("_") || "Photo";
  if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(stem)) stem = "Photo_" + stem;
  return stem + (extension ? "." + extension : "");
}
export function renamedPhotoFile(file: File, name: string) {
  return validPhotoName(name) && name !== file.name ? new File([file], name, {type: file.type, lastModified: file.lastModified}) : file;
}

export function overlayOrganizationFacts(local: string[] | undefined, saved: string[] | undefined) {
  return [...(local ?? []).filter(fact => !organizationFactCategory(fact)), ...(saved ?? []).filter(fact => !!organizationFactCategory(fact))];
}
// The existing "photos" scope includes screenshots. Keep that default/wire meaning;
// an explicit Photos choice only removes items with current screenshot evidence.
export type PhotoOrganizationScope = "photos" | "photosOnly" | "screenshots" | "trash";
export function inOrganizationScope(photo: {facts?: readonly string[]; filename?: string; digest?: string}, scope: PhotoOrganizationScope = "photos") {
  if (scope === "trash") return isPhotoTrashed(photo);
  if (isPhotoTrashed(photo)) return false;
  if (scope === "screenshots") return isPhotoScreenshot(photo);
  return scope !== "photosOnly" || !isPhotoScreenshot(photo);
}
