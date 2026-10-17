import test from "node:test";
import assert from "node:assert/strict";
import corpus from "../../../fixtures/search/public-relevance-v1.json";
import {publicSearchBaselineFailures} from "../tools/public-search-baseline";
const results = (tasks: typeof corpus.semantic) => tasks.map(task => ({...task, actual: [...task.expected], passed: true}));
function fixture() {
  const lexical = {queries: 25, exactSetPassed: 25, falsePositives: 0, falseNegatives: 0, positiveQueryTop1: {correct: 20, total: 20}, results: results(corpus.lexical)};
  const combined = {queries: 10, exactSetPassed: 6, falsePositives: 6, falseNegatives: 0, positiveQueryTop1: {correct: 7, total: 7}, results: results(corpus.semantic)};
  for (const failure of corpus.baseline.knownFailures) {
    const result = combined.results.find(result => result.query === failure.query)!;
    result.actual.push(...failure.allowedFalsePositiveIDs); result.passed = false;
  }
  return {lexical, combined};
}
test("declared known failures pass baseline while remaining visible; improvements also pass", () => {
  const {lexical, combined} = fixture();
  assert.equal(combined.results.filter(result => !result.passed).length, 4);
  assert.deepEqual(publicSearchBaselineFailures(lexical, combined, corpus.baseline), []);
  combined.results = results(corpus.semantic); combined.falsePositives = 0; combined.exactSetPassed = 10;
  assert.deepEqual(publicSearchBaselineFailures(lexical, combined, corpus.baseline), []);
});
test("baseline rejects lexical failures and an omitted case", () => {
  const {lexical, combined} = fixture();
  lexical.results[0].passed = false;
  assert.ok(publicSearchBaselineFailures(lexical, combined, corpus.baseline).length);
  lexical.results[0].passed = true; lexical.results.pop();
  assert.ok(publicSearchBaselineFailures(lexical, combined, corpus.baseline).length);
});
test("baseline rejects lost recall, worse first result, and excess false positives", () => {
  for (const change of ["recall", "first", "precision"]) {
    const {lexical, combined} = fixture();
    if (change === "recall") {combined.falseNegatives = 1; combined.results[0].actual = [];}
    if (change === "first") combined.positiveQueryTop1.correct = 6;
    if (change === "precision") combined.falsePositives = 7;
    assert.ok(publicSearchBaselineFailures(lexical, combined, corpus.baseline).length, change);
  }
});
test("baseline rejects changed false positives even within the aggregate ceiling", () => {
  const {lexical, combined} = fixture();
  combined.results.find(result => result.query === "receipt")!.actual = ["receipt", "singapore"];
  combined.falsePositives = 5;
  assert.match(publicSearchBaselineFailures(lexical, combined, corpus.baseline).join(" "), /Undeclared false positive: receipt/);
});
