export interface PeopleAssignment {personId: string; name: string; box: [number, number, number, number]}
export const PEOPLE_SOURCE_PREFIX = "fotoro:people-source:v1:";
export const PERSON_PREFIX = "fotoro:person:v1:";
export const isPeopleFact = (fact: string) => fact.startsWith(PEOPLE_SOURCE_PREFIX) || fact.startsWith(PERSON_PREFIX);
const count = (value: string) => Array.from(value).length;
const validDigest = (value: string) => /^[a-f\d]{64}$/i.test(value) || /^[\w-]{43}$/.test(value);
function assignment(value: unknown): PeopleAssignment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>, box = item.b;
  if (Object.keys(item).sort().join(",") !== "b,n,p" || typeof item.p !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(item.p)
    || typeof item.n !== "string" || !item.n.trim() || count(item.n) > 80 || /[\u0000-\u001f\u007f]/u.test(item.n)
    || !Array.isArray(box) || box.length !== 4 || box.some(value => !Number.isInteger(value) || value < 0 || value > 10000)
    || box[2] <= 0 || box[3] <= 0 || box[0] + box[2] > 10000 || box[1] + box[3] > 10000) return;
  return {personId: item.p, name: item.n, box: box as PeopleAssignment["box"]};
}
export function validatedPeopleAssignments(facts: readonly string[] | undefined, originalSha256: string): PeopleAssignment[] {
  if (!validDigest(originalSha256) || !facts || facts.length > 64 || facts.some(fact => typeof fact !== "string" || count(fact) > 240)) return [];
  const sources = facts.filter(fact => fact.startsWith(PEOPLE_SOURCE_PREFIX));
  if (sources.length !== 1 || sources[0] !== PEOPLE_SOURCE_PREFIX + originalSha256) return [];
  const result: PeopleAssignment[] = [], boxes = new Set<string>();
  for (const fact of facts.filter(fact => fact.startsWith(PERSON_PREFIX))) {
    try {
      const raw = fact.slice(PERSON_PREFIX.length), parsed = JSON.parse(raw);
      if ((raw.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? []).length !== 3) return [];
      const item = assignment(parsed);
      if (!item || boxes.has(item.box.join(","))) return [];
      boxes.add(item.box.join(",")); result.push(item);
    } catch {return [];}
  }
  return result;
}
export const peopleNames = (facts: readonly string[] | undefined, originalSha256: string) => [...new Set(validatedPeopleAssignments(facts, originalSha256).map(item => item.name))];
export function factsWithPeople(facts: readonly string[] | undefined, originalSha256: string, assignments: readonly PeopleAssignment[]): string[] {
  if (!validDigest(originalSha256)) throw new Error("People require the original photo digest.");
  const result = (facts ?? []).filter(fact => !isPeopleFact(fact));
  const boxes = new Set<string>();
  for (const item of assignments) {
    const compact = {p: item.personId, n: item.name, b: item.box};
    const encoded = PERSON_PREFIX + JSON.stringify(compact);
    if (!assignment(compact) || boxes.has(item.box.join(",")) || count(encoded) > 240) throw new Error("This person name or face box exceeds the photo metadata capacity.");
    boxes.add(item.box.join(",")); result.push(encoded);
  }
  if (assignments.length) result.push(PEOPLE_SOURCE_PREFIX + originalSha256);
  if (result.length > 64 || result.some(fact => typeof fact !== "string" || count(fact) > 240)) throw new Error("People exceed the photo metadata capacity. Existing facts were preserved.");
  return result;
}
