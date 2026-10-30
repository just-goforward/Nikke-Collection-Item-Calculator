import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";
import { validateObserved } from "./operational-report.mjs";

const ids = ["T001", "T002"];
const pass = [{ id: "T001", status: "passed", attempts: 1 }, { id: "T002", status: "passed", attempts: 1 }];
test("accepts the exact once-only complete inventory", () => {
  deepStrictEqual(validateObserved(ids, pass, true), { cases: pass, complete: true });
});
test("rejects unknown or duplicate identity", () => {
  throws(() => validateObserved(ids, [...pass, { id: "T003", status: "passed", attempts: 1 }], true));
  throws(() => validateObserved(ids, [pass[0], pass[0]], true));
});
test("rejects malformed fields and arbitrary state", () => {
  for (const item of [
    { id: "T001", status: "cancelled", attempts: 1 },
    { id: "T001", status: "passed", attempts: "1" },
    { id: "T001", status: "passed", attempts: -1 },
    { id: "T001", status: "passed", attempts: 1, title: "private" },
    null,
  ]) throws(() => validateObserved(ids, [item], true));
});
test("missing, skipped, timeout, cancellation, retry, zero attempts or unfinished never complete", () => {
  deepStrictEqual(validateObserved(ids, [pass[0]], true).complete, false);
  deepStrictEqual(validateObserved(ids, pass, false).complete, false);
  for (const status of ["failed", "skipped", "timedOut", "interrupted"]) {
    deepStrictEqual(validateObserved(ids, [pass[0], { ...pass[1], status }], true).complete, false);
  }
  for (const attempts of [0, 2]) {
    deepStrictEqual(validateObserved(ids, [pass[0], { ...pass[1], attempts }], true).complete, false);
  }
});
