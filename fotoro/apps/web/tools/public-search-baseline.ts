type Result = {query: string; expected: string[]; actual: string[]; passed: boolean};
type Summary = {queries: number; exactSetPassed: number; falsePositives: number; falseNegatives: number; positiveQueryTop1: {correct: number; total: number}; results: Result[]};
export interface PublicSearchBaseline {
  lexicalTasks: number;
  combinedTasks: number;
  positiveQueries: number;
  maximumFalsePositives: number;
  knownFailures: {query: string; allowedFalsePositiveIDs: string[]; reason: string}[];
}

// Improvements pass; unknown failures or a worse result on any declared case do not.
export function publicSearchBaselineFailures(lexical: Summary, combined: Summary, baseline: PublicSearchBaseline) {
  const failures: string[] = [];
  if (lexical.queries !== baseline.lexicalTasks || lexical.results.length !== baseline.lexicalTasks
    || lexical.exactSetPassed !== baseline.lexicalTasks || lexical.results.some(result => !result.passed)) failures.push("All declared lexical/filter cases must pass.");
  if (combined.queries !== baseline.combinedTasks || combined.results.length !== baseline.combinedTasks) failures.push("The full declared combined corpus must run.");
  if (combined.positiveQueryTop1.total !== baseline.positiveQueries || combined.positiveQueryTop1.correct !== baseline.positiveQueries) failures.push("Every positive combined query must have a relevant first result.");
  if (combined.falseNegatives !== 0) failures.push("Combined retrieval must have no false negatives.");
  if (combined.falsePositives > baseline.maximumFalsePositives) failures.push("Combined false positives exceeded the declared ceiling.");
  const known = new Map(baseline.knownFailures.map(failure => [failure.query, failure]));
  for (const result of combined.results) {
    const allowed = known.get(result.query)?.allowedFalsePositiveIDs ?? [];
    if (result.expected.some(id => !result.actual.includes(id))) failures.push(`Missing relevant result: ${result.query}`);
    if (result.actual.some(id => !result.expected.includes(id) && !allowed.includes(id))) failures.push(`Undeclared false positive: ${result.query}`);
  }
  return failures;
}
