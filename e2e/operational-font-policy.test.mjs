import { deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { isExpectedBlockedFont } from "./operational-font-policy.mjs";

const urls = [
  "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css",
  "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-std-dynamic-subset.min.css",
  "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-jp-dynamic-subset.min.css",
];
test("only existing exact locale stylesheet GETs receive the blocked-font classification", () => {
  for (const url of urls)
    deepStrictEqual(isExpectedBlockedFont({ url, method: "GET", resourceType: "stylesheet" }), true);
});
test("mutations, other resource types and nonexact external URLs remain unexpected", () => {
  for (const method of ["POST", "PUT", "HEAD"])
    deepStrictEqual(isExpectedBlockedFont({ url: urls[0], method, resourceType: "stylesheet" }), false);
  for (const resourceType of ["font", "fetch", "script", "image"])
    deepStrictEqual(isExpectedBlockedFont({ url: urls[0], method: "GET", resourceType }), false);
  for (const url of [urls[0] + "?extra=1", urls[0].replace("@v1.3.9", "@latest"),
    "https://cdn.jsdelivr.net/unrelated.css", "https://other.invalid/font.css",
    "http://127.0.0.1:4290/api/stats"])
    deepStrictEqual(isExpectedBlockedFont({ url, method: "GET", resourceType: "stylesheet" }), false);
});
