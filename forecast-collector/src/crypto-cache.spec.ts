import { expect, it } from "vitest";
import { freezeJson } from "../../shared/certifiedSupplyModel";
import { stableJson } from "./crypto";

it("reuses only deeply frozen JSON and preserves canonical bytes", () => {
  const cache = new WeakMap<object, string>();
  const snapshot = freezeJson({ z: [1, 2], a: { value: "한글" } });
  const expected = stableJson({ snapshot, revision: 1 });
  stableJson(snapshot, cache);
  expect(stableJson({ snapshot, revision: 1 }, cache)).toBe(expected);
  const mutable = { value: 1 };
  const shallow = Object.freeze({ mutable });
  stableJson(shallow, cache);
  mutable.value = 2;
  expect(stableJson(shallow, cache)).toBe(stableJson(shallow));
});
