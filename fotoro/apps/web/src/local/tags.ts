import {normalizeSearch} from "./search";

// Preserve the supplied words; duplicate identity follows the photo search rules.
export function newPhotoTag(value: string, tags: readonly string[]): string | undefined {
  const tag = value.trim();
  const identity = (text: string) => normalizeSearch(text).split(/\s+/).join(" ");
  if (!tag || Array.from(tag).length > 120 || tags.length >= 64 || tags.some(existing => identity(existing) === identity(tag))) return;
  return tag;
}
