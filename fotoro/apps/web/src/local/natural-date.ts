export interface NaturalDateQuery {
  text: string;
  phrase?: string;
  from?: number;
  until?: number;
}
type Period = {from: number; until: number};
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const normalized = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim().replace(/\s+/g, " ");
const remaining = (value: string) => {
  const words = value.split(" ").filter(Boolean);
  if (["from", "in", "on", "during"].includes(words.at(-1) ?? "")) words.pop();
  if (["photo", "photos", "picture", "pictures"].includes(words[0])) {
    words.shift();
    if (words[0] === "of") words.shift();
  }
  return words.join(" ");
};
function firstWeekday(): number {
  try {
    const locale = new Intl.Locale(new Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
      weekInfo?: {firstDay: number}; getWeekInfo?: () => {firstDay: number};
    };
    return (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay! % 7 || 0;
  } catch { return 0; }
}
function period(year: number, month = 1, day = 1, unit: "year" | "month" | "day" = "day"): Period | undefined {
  if (year < 1900 || year > 2200) return;
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return;
  const end = new Date(start);
  if (unit === "year") end.setFullYear(year + 1);
  else if (unit === "month") end.setMonth(month);
  else end.setDate(day + 1);
  return {from: start.getTime(), until: end.getTime()};
}
function strictPeriod(value: string): Period | undefined {
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) return;
  const [year, month = 1, day = 1] = value.split("-").map(Number);
  return period(year, month, day, value.length === 4 ? "year" : value.length === 7 ? "month" : "day");
}
function namedPeriod(value: string): Period | undefined {
  const words = value.replaceAll(",", "").split(" "), month = months.indexOf(words[0]);
  if (month < 0 || words.length < 2 || words.length > 3 || !/^\d{4}$/.test(words.at(-1) ?? "")) return;
  if (words.length === 3 && !/^\d{1,2}$/.test(words[1])) return;
  return period(Number(words.at(-1)), month + 1, words.length === 3 ? Number(words[1]) : 1, words.length === 3 ? "day" : "month");
}
function relativePeriod(phrase: string, now: number, weekStart: number): Period {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const unit = phrase.split(" ").at(-1);
  if (phrase === "yesterday") start.setDate(start.getDate() - 1);
  else if (unit === "week") start.setDate(start.getDate() - (start.getDay() - weekStart + 7) % 7 - (phrase.startsWith("last") ? 7 : 0));
  else if (unit === "month") { start.setDate(1); start.setMonth(start.getMonth() - (phrase.startsWith("last") ? 1 : 0)); }
  else if (unit === "year") { start.setMonth(0, 1); start.setFullYear(start.getFullYear() - (phrase.startsWith("last") ? 1 : 0)); }
  const end = new Date(start);
  if (unit === "week") end.setDate(end.getDate() + 7);
  else if (unit === "month") end.setMonth(end.getMonth() + 1);
  else if (unit === "year") end.setFullYear(end.getFullYear() + 1);
  else end.setDate(end.getDate() + 1);
  return {from: start.getTime(), until: end.getTime()};
}
export function parseNaturalDateQuery(query: string, options: {now?: number; firstWeekday?: number} = {}): NaturalDateQuery {
  const text = normalized(query), result: NaturalDateQuery = {text}, now = options.now ?? Date.now();
  if (!Number.isFinite(now)) return result;
  const apply = (bounds: Period, rest: string, phrase: string): NaturalDateQuery => ({text: remaining(rest), phrase, ...bounds});
  for (const phrase of ["today", "yesterday", "this week", "last week", "this month", "last month", "this year", "last year"]) {
    if (text === phrase || text.endsWith(" " + phrase)) return apply(relativePeriod(phrase, now, options.firstWeekday ?? firstWeekday()), text.slice(0, -phrase.length).trim(), phrase);
    if (text.startsWith(phrase + " ")) return apply(relativePeriod(phrase, now, options.firstWeekday ?? firstWeekday()), text.slice(phrase.length).trim(), phrase);
  }
  const words = text.split(" ");
  for (const leading of [false, true]) {
    const range = leading ? words.slice(0, 4) : words.slice(-4);
    if (range.length === 4 && range[0] === "from" && ["to", "through"].includes(range[2])) {
      const first = strictPeriod(range[1]), last = strictPeriod(range[3]);
      if (first && last && first.from < last.until) return apply({from: first.from, until: last.until}, (leading ? words.slice(4) : words.slice(0, -4)).join(" "), range.join(" "));
      return result;
    }
    let invalidNamed = false;
    for (const size of [3, 2]) {
      if (words.length < size) continue;
      const dateWords = leading ? words.slice(0, size) : words.slice(-size), phrase = dateWords.join(" ");
      const bounds = namedPeriod(phrase);
      if (bounds) return apply(bounds, (leading ? words.slice(size) : words.slice(0, -size)).join(" "), phrase);
      if (!leading && months.includes(dateWords[0])) invalidNamed = true;
    }
    if (invalidNamed) continue;
    const dateWord = leading ? words[0] : words.at(-1)!, bounds = strictPeriod(dateWord);
    const operator = leading ? words[0] : words.at(-2);
    const operated = leading ? strictPeriod(words[1] ?? "") : bounds;
    if (["before", "after", "since"].includes(operator ?? "") && operated) {
      const rest = (leading ? words.slice(2) : words.slice(0, -2)).join(" ");
      return {text: remaining(rest), phrase: operator + " " + (leading ? words[1] : dateWord), ...(operator === "before" ? {until: operated.from} : {from: operator === "after" ? operated.until : operated.from})};
    }
    if (bounds) return apply(bounds, (leading ? words.slice(1) : words.slice(0, -1)).join(" "), dateWord);
  }
  return result;
}
