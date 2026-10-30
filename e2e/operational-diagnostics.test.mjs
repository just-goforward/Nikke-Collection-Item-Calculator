import { deepStrictEqual, ok } from "node:assert";
import { test } from "node:test";
import { diagnosticJson, DiagnosticStream } from "./operational-report.mjs";

test("private errors retain expected actual diff and source stack without invoking getters", () => {
  let invoked = false;
  const error = new Error("boundary");
  error.expected = { numerator: "1", denominator: "1" };
  error.actual = { numerator: "1", denominator: "2" };
  error.diff = "-1\n+1/2";
  Object.defineProperty(error, "unsafe", { get() { invoked = true; throw new Error(); } });
  error.cause = error;
  const value = JSON.parse(diagnosticJson(error));
  deepStrictEqual(value.expected, { numerator: "1", denominator: "1" });
  deepStrictEqual(value.actual, { numerator: "1", denominator: "2" });
  deepStrictEqual(value.diff, "-1\n+1/2");
  ok(value.stack.includes("operational-diagnostics.test.mjs"));
  deepStrictEqual(value.cause, "[CYCLE]");
  deepStrictEqual(value.unsafe, "[ACCESSOR]");
  deepStrictEqual(invoked, false);
});
test("private serialization and server streams stay byte bounded", () => {
  const value = JSON.parse(diagnosticJson({ text: "😀".repeat(1024 * 1024), bigint: 9n }));
  ok(Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024);
  deepStrictEqual(value.bigint, { bigint: "9" });
  const stream = new DiagnosticStream();
  stream.push(Buffer.alloc(256 * 1024, 120));
  deepStrictEqual(stream.bytes, 128 * 1024);
  deepStrictEqual(stream.overflow, true);
});
