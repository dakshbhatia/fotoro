export interface LocalChoices {readText: boolean; retain: boolean}
const key = "fotoro.local-choices.v1";
export function loadLocalChoices(): LocalChoices | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value && typeof value.readText === "boolean" && typeof value.retain === "boolean" ? value : undefined;
  } catch {return undefined;}
}
export function saveLocalChoices(value: LocalChoices) {
  try {localStorage.setItem(key, JSON.stringify(value));} catch {}
}
