import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  EVIDENCE_FILES,
  normalizeExact,
  PHYSICAL_CACHE,
  PHYSICAL_SOURCES,
  PHYSICAL_VERSION,
  PUBLICATION_FILES,
  readV5Evidence,
  V5_ROOT,
} from "./certified-staging-approved-panel/v5/evidence.ts";
import { add, fromWire, makeTriple, mapTriple, mul, q, wire } from "./certified-staging-oracle.ts";
import { prepareIndependentPhysicalRatesCache } from "./certified-staging-oracle-cache.ts";

const fixturePath = `${V5_ROOT}/independent-physical-cohorts.json`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "independent-cache-v5-"));
  roots.push(root);
  for (const path of EVIDENCE_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(path, join(root, path));
  }
  return root;
}
function direct(root: string, body: string, timeout = 10_000) {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
    import { independentPhysicalRecurringRates as rates } from "./scripts/certified-staging-oracle-physical-supply.ts";
    const path = ${JSON.stringify(PHYSICAL_CACHE)};
    ${body}
  `,
    ],
    { cwd: root, encoding: "utf8", timeout, stdio: "pipe" },
  );
}
/** Only the expensive enumeration is stubbed for cold failure/memo guards.
 * Real cold enumeration/equivalence is covered by the sealed source suite. */
function boundedColdHelper(root: string) {
  const source = readFileSync(PHYSICAL_SOURCES[0], "utf8");
  const body = stripTypeScriptTypes(
    source
      .slice(source.indexOf("function sourceIdentity()"), source.indexOf("\nif (process.argv[1]"))
      .replace(
        "export function independentPhysicalRecurringRates",
        "function independentPhysicalRecurringRates",
      ),
  );
  let calls = 0;
  const context = {
    assert,
    createHash,
    PHYSICAL_SOURCES,
    PHYSICAL_VERSION,
    PUBLICATION_FILES,
    normalizeExact,
    dirname,
    readFileSync: (path: string) => readFileSync(resolve(root, path)),
    existsSync: (path: string) => existsSync(resolve(root, path)),
    mkdirSync: (path: string, options: { recursive: boolean }) =>
      mkdirSync(resolve(root, path), options),
    writeFileSync: (path: string, bytes: Buffer | string, options: { flag: string }) =>
      writeFileSync(resolve(root, path), bytes, options),
    readV5Evidence: () => readV5Evidence(root),
    independentDispatchExpectations: () => {
      calls++;
      return [makeTriple(() => q(1)), makeTriple(() => q(2)), makeTriple(() => q(3))];
    },
    path: PHYSICAL_CACHE,
    memoizedRates: null,
    memoizedIdentity: null,
    performance,
    add,
    fromWire,
    makeTriple,
    mapTriple,
    mul,
    q,
    wire,
  };
  const rates = new Function(
    ...Object.keys(context),
    `${body}\nreturn independentPhysicalRecurringRates;`,
  )(...Object.values(context)) as () => ReturnType<typeof makeTriple<ReturnType<typeof q>>>;
  return { rates, calls: () => calls };
}
it("retains cold ENOENT on a missing cache directory without requiring a published seal", () => {
  const root = fixtureRoot();
  for (const path of PUBLICATION_FILES) rmSync(join(root, path));
  const helper = boundedColdHelper(root);
  expect(helper.rates).toThrow(/ENOENT/);
  expect(helper.calls()).toBe(1);
  expect(existsSync(join(root, PHYSICAL_CACHE))).toBe(false);
});
it.each(["cache", "source", "missing"])(
  "a freshly computed unpublished memo rejects %s drift without another enumeration",
  (kind) => {
    const root = fixtureRoot();
    for (const path of PUBLICATION_FILES) rmSync(join(root, path));
    mkdirSync(dirname(join(root, PHYSICAL_CACHE)), { recursive: true });
    const helper = boundedColdHelper(root);
    const rates = helper.rates();
    expect(helper.rates()).toBe(rates);
    expect(helper.calls()).toBe(1);
    let target = join(root, PHYSICAL_CACHE);
    if (kind === "source") target = join(root, "shared/game.ts");
    if (kind === "missing") rmSync(target);
    else writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from("\n")]));
    expect(helper.rates).toThrow(/cache\/source changed after memoization/);
    expect(helper.calls()).toBe(1);
  },
);
it("prepares authenticated v5 bytes and direct warm/memoized calls agree without writes", () => {
  const root = fixtureRoot();
  const first = prepareIndependentPhysicalRatesCache(root);
  expect(first.cacheHit).toBe(false);
  expect(first.sha256).toBe(readV5Evidence().provenance.physicalEnumeration.sha256);
  expect(prepareIndependentPhysicalRatesCache(root).cacheHit).toBe(true);
  expect(readFileSync(join(root, PHYSICAL_CACHE))).toEqual(readFileSync(fixturePath));
  direct(
    root,
    `
    const before = readFileSync(path);
    const first = rates();
    assert.equal(rates(), first);
    assert.deepEqual(readFileSync(path), before);
  `,
  );
});
it("a clean checkout genuinely computes cold, then a second process and preparer accept canonical bytes", () => {
  const root = fixtureRoot();
  expect(existsSync(join(root, "benchmarks"))).toBe(false);
  direct(
    root,
    `
    const first = rates();
    assert.equal(rates(), first);
    assert.deepEqual(readFileSync(path), readFileSync(${JSON.stringify(fixturePath)}));
    // Cold memoization must retain published-evidence authentication.
    const evidencePath = ${JSON.stringify(`${V5_ROOT}/panel.json`)};
    const evidence = readFileSync(evidencePath);
    writeFileSync(evidencePath, Buffer.concat([evidence, Buffer.from("\\n")]));
    assert.throws(rates);
    assert.deepEqual(readFileSync(evidencePath), Buffer.concat([evidence, Buffer.from("\\n")]));
    writeFileSync(evidencePath, evidence);
  `,
    120_000,
  );
  const bytes = readFileSync(join(root, PHYSICAL_CACHE));
  expect(bytes).toEqual(readFileSync(fixturePath));
  // This process has no producer memo and a bounded warm-only deadline.
  direct(
    root,
    `rates(); assert.deepEqual(readFileSync(path), readFileSync(${JSON.stringify(fixturePath)}));`,
  );
  expect(prepareIndependentPhysicalRatesCache(root).cacheHit).toBe(true);
  expect(readFileSync(join(root, PHYSICAL_CACHE))).toEqual(bytes);
}, 150_000);
it.each(PUBLICATION_FILES)(
  "a cold call rejects partial publication missing %s before enumeration",
  (path) => {
    const root = fixtureRoot();
    rmSync(join(root, path));
    const helper = boundedColdHelper(root);
    expect(helper.rates).toThrow();
    expect(helper.calls()).toBe(0);
    expect(existsSync(join(root, "benchmarks"))).toBe(false);
  },
);
it("a cold call rejects invalid publication without falling back to producer output", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, fixturePath), "invalid physical publication");
  const helper = boundedColdHelper(root);
  expect(helper.rates).toThrow(/hash drift/);
  expect(helper.calls()).toBe(0);
  expect(readFileSync(join(root, fixturePath), "utf8")).toBe("invalid physical publication");
  expect(existsSync(join(root, "benchmarks"))).toBe(false);
});
it("a published cold calculation must match authenticated values before any cache write", () => {
  const root = fixtureRoot();
  const helper = boundedColdHelper(root);
  expect(helper.rates).toThrow(/Fresh physical cohorts differ/);
  expect(helper.calls()).toBe(1);
  expect(existsSync(join(root, "benchmarks"))).toBe(false);
});
it.each(["wrong-rate", "wrong-source", "version", "unparseable", "metadata", "sourceHash-only"])(
  "both preparation and direct calls reject and preserve %s cache bytes",
  (kind) => {
    const root = fixtureRoot();
    const physical = JSON.parse(readFileSync(fixturePath, "utf8"));
    if (kind === "wrong-rate" || kind === "sourceHash-only") physical.rate[0].numerator = "1";
    if (kind === "wrong-source") physical.sourceHash = "0".repeat(64);
    if (kind === "version") physical.version = "independent-ordered-physical-supply-rates-v4";
    if (kind === "metadata") physical.computeMs++;
    let bytes = JSON.stringify(physical);
    if (kind === "unparseable") bytes = "unparsed research evidence\n";
    if (kind === "sourceHash-only")
      bytes = JSON.stringify({ sourceHash: physical.sourceHash, rate: physical.rate });
    mkdirSync(dirname(join(root, PHYSICAL_CACHE)), { recursive: true });
    writeFileSync(join(root, PHYSICAL_CACHE), bytes);
    expect(() => prepareIndependentPhysicalRatesCache(root)).toThrow(
      /existing independent physical cache differs/i,
    );
    direct(root, `assert.throws(rates, /Existing independent physical cache differs/);`);
    expect(readFileSync(join(root, PHYSICAL_CACHE), "utf8")).toBe(bytes);
  },
);
it.each(["cache", "source", "missing-cache", "evidence", "missing-evidence"])(
  "rejects %s mutation after memoization without replacement",
  (kind) => {
    const root = fixtureRoot();
    prepareIndependentPhysicalRatesCache(root);
    let target = PHYSICAL_CACHE;
    if (kind === "source") target = "shared/game.ts";
    else if (kind.includes("evidence")) target = `${V5_ROOT}/panel.json`;
    direct(
      root,
      `
      rates();
      const target = ${JSON.stringify(target)};
      if (${JSON.stringify(kind)}.startsWith("missing")) unlinkSync(target);
      else writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from("\\n")]));
      assert.throws(rates);
    `,
    );
  },
);
it.each(EVIDENCE_FILES)(
  "rejects missing %s before cache creation and during a direct warm call",
  (path) => {
    const root = fixtureRoot();
    prepareIndependentPhysicalRatesCache(root);
    const bytes = readFileSync(join(root, PHYSICAL_CACHE));
    rmSync(join(root, path));
    expect(() => direct(root, "rates();")).toThrow();
    expect(readFileSync(join(root, PHYSICAL_CACHE))).toEqual(bytes);
    rmSync(join(root, PHYSICAL_CACHE));
    expect(() => prepareIndependentPhysicalRatesCache(root)).toThrow(/ENOENT/);
    expect(existsSync(join(root, PHYSICAL_CACHE))).toBe(false);
  },
);
it.each(EVIDENCE_FILES)("rejects tampered %s without creating a cache", (path) => {
  const root = fixtureRoot();
  if (path === `${V5_ROOT}/pins.json`) {
    const pins = JSON.parse(readFileSync(join(root, path), "utf8"));
    pins.provenance.sha256 = "0".repeat(64);
    writeFileSync(join(root, path), JSON.stringify(pins));
  } else
    writeFileSync(
      join(root, path),
      Buffer.concat([readFileSync(join(root, path)), Buffer.from("\n")]),
    );
  expect(() => prepareIndependentPhysicalRatesCache(root)).toThrow();
  expect(existsSync(join(root, "benchmarks"))).toBe(false);
});
