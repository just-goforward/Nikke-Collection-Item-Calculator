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
import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import {
  frozenApprovedSnapshot,
  independentApprovedPricing,
} from "./certified-staging-approved-panel.ts";
import { add, fromWire, makeTriple, mapTriple, mul, q, wire } from "./certified-staging-oracle.ts";
import { prepareIndependentPhysicalRatesCache } from "./certified-staging-oracle-cache.ts";

const fixturePath = "scripts/certified-staging-approved-panel/independent-physical-cohorts.json";
const provenancePath = "scripts/certified-staging-approved-panel/provenance.json";
const cachePath = "benchmarks/results/certified-staging-validation-independent-physical-rates.json";
const sourcePaths = [
  "scripts/certified-staging-oracle-physical-supply.ts",
  "scripts/certified-staging-oracle.ts",
] as const;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cleanFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "review13-physical-rates-"));
  roots.push(root);
  for (const path of [fixturePath, provenancePath, ...sourcePaths]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(path, join(root, path));
  }
  return root;
}

/** Execute the actual frozen helper body. Only its expensive enumeration is replaced
 * with a bounded stub; all filesystem calls and independent exact arithmetic remain real. */
function physicalHelper(root: string) {
  const source = readFileSync(sourcePaths[0], "utf8");
  const body = stripTypeScriptTypes(
    source
      .slice(source.indexOf("function sourceIdentity()"), source.indexOf("\nif (process.argv[1]"))
      .replace(
        "export function independentPhysicalRecurringRates",
        "function independentPhysicalRecurringRates",
      ),
  );
  let enumerationCalls = 0;
  const rates = runInNewContext(`${body}\nindependentPhysicalRecurringRates;`, {
    createHash,
    readFileSync: (path: string, encoding?: BufferEncoding) =>
      encoding ? readFileSync(resolve(root, path), encoding) : readFileSync(resolve(root, path)),
    existsSync: (path: string) => existsSync(resolve(root, path)),
    writeFileSync: (path: string, data: string) => writeFileSync(resolve(root, path), data),
    independentDispatchExpectations: () => {
      enumerationCalls++;
      return [makeTriple(() => q(1)), makeTriple(() => q(2)), makeTriple(() => q(3))];
    },
    path: cachePath,
    memoizedRates: null,
    performance,
    add,
    fromWire,
    makeTriple,
    mapTriple,
    mul,
    q,
    wire,
  }) as () => ReturnType<typeof independentApprovedPricing>;
  return { rates, enumerationCalls: () => enumerationCalls };
}

it("reproduces the frozen cache-miss ENOENT with bounded enumeration, not a full recomputation", () => {
  const root = cleanFixtureRoot();
  expect(existsSync(join(root, "benchmarks"))).toBe(false);
  const helper = physicalHelper(root);
  expect(helper.rates).toThrow(/ENOENT/);
  expect(helper.enumerationCalls()).toBe(1);
  expect(existsSync(join(root, cachePath))).toBe(false);
});

it("prepares a clean CI cache byte-for-byte and the unchanged helper uses exact rates and prices without enumeration", () => {
  const root = cleanFixtureRoot();
  const prepared = prepareIndependentPhysicalRatesCache(root);
  expect(prepared.cacheHit).toBe(false);
  expect(readFileSync(join(root, cachePath))).toEqual(readFileSync(fixturePath));
  expect(prepared.sha256).toBe("fed3faab0a2b032deb65f9b892684cb9518c38a67596f8ba066f8e9cc7d8be0a");
  const helper = physicalHelper(root);
  const rates = helper.rates();
  expect(helper.enumerationCalls()).toBe(0);
  const expected = independentApprovedPricing(
    frozenApprovedSnapshot(),
    makeTriple(() => q(1, 3)),
  );
  expect(rates).toEqual(expected);
  for (const stock of [
    [0, 0, 0],
    [600, 100, 40],
    [1000, 200, 100],
    [800, 150, 60],
  ]) {
    const prices = (values: typeof rates) =>
      mapTriple(values, (rate, color) => {
        const raw = stock[color];
        if (raw === undefined) throw new Error("Missing test stock color");
        return q(rate.d, BigInt(raw) * rate.d + rate.n);
      });
    expect(prices(rates)).toEqual(prices(expected));
  }
});

it("runs the actual unchanged physical module against the prepared clean directory, with no enumeration mock", () => {
  const root = cleanFixtureRoot();
  mkdirSync(join(root, "shared"));
  copyFileSync("shared/game.ts", join(root, "shared/game.ts"));
  prepareIndependentPhysicalRatesCache(root);
  const output = execFileSync(process.execPath, [sourcePaths[0]], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
  });
  const reported = JSON.parse(output) as { report: string; approximateRates: number[] };
  expect(reported.report).toBe(cachePath);
  expect(reported.approximateRates).toHaveLength(3);
  expect(readFileSync(join(root, cachePath))).toEqual(readFileSync(fixturePath));
});

it("accepts an identical existing cache without writing it", () => {
  const root = cleanFixtureRoot();
  prepareIndependentPhysicalRatesCache(root);
  expect(prepareIndependentPhysicalRatesCache(root).cacheHit).toBe(true);
  expect(readFileSync(join(root, cachePath))).toEqual(readFileSync(fixturePath));
});

it.each(["wrong-rate", "wrong-source", "unparseable", "different-metadata"])(
  "rejects and preserves existing %s cache bytes",
  (kind) => {
    const root = cleanFixtureRoot();
    const physical = JSON.parse(readFileSync(fixturePath, "utf8"));
    if (kind === "wrong-rate") physical.rate[0].numerator = "1";
    if (kind === "wrong-source") physical.sourceHash = "0".repeat(64);
    if (kind === "different-metadata") physical.computeMs++;
    const bytes =
      kind === "unparseable" ? "unparsed existing research evidence\n" : JSON.stringify(physical);
    mkdirSync(dirname(join(root, cachePath)), { recursive: true });
    writeFileSync(join(root, cachePath), bytes);
    expect(() => prepareIndependentPhysicalRatesCache(root)).toThrow(
      /existing independent physical cache differs/i,
    );
    expect(readFileSync(join(root, cachePath), "utf8")).toBe(bytes);
  },
);

it.each([fixturePath, provenancePath, ...sourcePaths])(
  "rejects tampering in %s before creating any cache",
  (path) => {
    const root = cleanFixtureRoot();
    writeFileSync(join(root, path), `${readFileSync(join(root, path), "utf8")}\n`);
    expect(() => prepareIndependentPhysicalRatesCache(root)).toThrow(
      /independent physical.*(hash|identity)/i,
    );
    expect(existsSync(join(root, "benchmarks"))).toBe(false);
  },
);

it.each([fixturePath, provenancePath, ...sourcePaths])(
  "fails closed for missing tracked %s without running enumeration or writing a cache",
  (path) => {
    const root = cleanFixtureRoot();
    rmSync(join(root, path));
    expect(() => prepareIndependentPhysicalRatesCache(root)).toThrow(/ENOENT/);
    expect(existsSync(join(root, "benchmarks"))).toBe(false);
  },
);
