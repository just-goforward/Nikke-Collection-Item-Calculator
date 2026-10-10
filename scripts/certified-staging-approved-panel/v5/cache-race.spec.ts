import assert from "node:assert/strict";
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
import { dirname, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  add,
  fromWire,
  makeTriple,
  mapTriple,
  mul,
  q,
  wire,
} from "../../certified-staging-oracle.ts";
import { prepareIndependentPhysicalRatesCache } from "../../certified-staging-oracle-cache.ts";
import {
  EVIDENCE_FILES,
  EVIDENCE_VERSION,
  type EvidenceProvenance,
  GENERATION_SOURCES,
  normalizeExact,
  PHYSICAL_CACHE,
  PHYSICAL_SOURCES,
  PHYSICAL_VERSION,
  type PhysicalEvidence,
  PUBLICATION_FILES,
  readV5Evidence,
  V5_ROOT,
} from "./evidence.ts";
import {
  ARCHIVED_SOURCES,
  FIRST_PINS_SHA,
  HISTORICAL_FILES,
  PREVIOUS_PINS_SHA,
  readV4Publication,
  sha256,
  sourceIdentity,
  V4_PINS_SHA,
} from "./history.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** Synthetic unit-test publication, never proposed migration evidence. Values
 * come from authenticated v4 data; the expensive enumerator alone is bounded. */
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "v5-cache-race-"));
  roots.push(root);
  for (const path of EVIDENCE_FILES.filter((path) => !PUBLICATION_FILES.includes(path))) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    copyFileSync(path, resolve(root, path));
  }
  const previous = readV4Publication(root);
  const physical: PhysicalEvidence = {
    ...JSON.parse(previous.physicalBytes.toString()),
    version: PHYSICAL_VERSION,
    ...sourceIdentity(PHYSICAL_SOURCES, root),
  };
  const physicalBytes = Buffer.from(`${JSON.stringify(physical, null, 2)}\n`);
  const panelBytes = Buffer.from(`${JSON.stringify(previous.panel, null, 2)}\n`);
  const provenance: EvidenceProvenance = {
    version: EVIDENCE_VERSION,
    generation: {
      ...sourceIdentity(GENERATION_SOURCES, root),
      isolatedCacheEmpty: true,
      physicalEnumeration: "full-ordered",
      oracleRows: 24,
      independentWaiting: "UNVERIFIED_NOT_REGENERATED",
    },
    historical: {
      sources: ARCHIVED_SOURCES,
      files: HISTORICAL_FILES,
      firstPinsSha256: FIRST_PINS_SHA,
      previousPinsSha256: PREVIOUS_PINS_SHA,
      v4PinsSha256: V4_PINS_SHA,
    },
    physicalEnumeration: {
      path: `${V5_ROOT}/independent-physical-cohorts.json`,
      cachePath: PHYSICAL_CACHE,
      sha256: sha256(physicalBytes),
      sources: physical.sources,
      sourceHash: physical.sourceHash,
    },
    panel: { path: `${V5_ROOT}/panel.json`, sha256: sha256(panelBytes) },
  };
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
  for (const [name, bytes] of [
    ["independent-physical-cohorts.json", physicalBytes],
    ["panel.json", panelBytes],
    ["provenance.json", provenanceBytes],
    [
      "pins.json",
      Buffer.from(
        JSON.stringify({
          version: EVIDENCE_VERSION,
          provenance: { path: `${V5_ROOT}/provenance.json`, sha256: sha256(provenanceBytes) },
        }),
      ),
    ],
  ] as const)
    writeFileSync(resolve(root, V5_ROOT, name), bytes, { flag: "wx" });
  const authenticated = readV5Evidence(root);
  return { root, authenticated };
}
function controlledHelper(
  root: string,
  physical: PhysicalEvidence,
  beforeWrite: (bytes: Buffer | string) => void = () => {},
) {
  const source = readFileSync(PHYSICAL_SOURCES[0], "utf8");
  const body = stripTypeScriptTypes(
    source
      .slice(source.indexOf("function sourceIdentity()"), source.indexOf("\nif (process.argv[1]"))
      .replace(
        "export function independentPhysicalRecurringRates",
        "function independentPhysicalRecurringRates",
      ),
  );
  let enumerationCalls = 0;
  let writeAttempts = 0;
  const context = {
    assert,
    createHash,
    PHYSICAL_SOURCES,
    PHYSICAL_VERSION,
    PUBLICATION_FILES,
    normalizeExact,
    dirname,
    performance,
    add,
    fromWire,
    makeTriple,
    mapTriple,
    mul,
    q,
    wire,
    readFileSync: (path: string) => readFileSync(resolve(root, path)),
    existsSync: (path: string) => existsSync(resolve(root, path)),
    mkdirSync: (path: string, options: { recursive: boolean }) =>
      mkdirSync(resolve(root, path), options),
    writeFileSync: (path: string, bytes: Buffer | string, options: { flag: string }) => {
      writeAttempts++;
      beforeWrite(bytes);
      writeFileSync(resolve(root, path), bytes, options);
    },
    readV5Evidence: () => readV5Evidence(root),
    independentDispatchExpectations: () => {
      enumerationCalls++;
      return mapTriple(physical.cohorts, (cohort) => mapTriple(cohort, fromWire));
    },
    path: PHYSICAL_CACHE,
    memoizedRates: null,
    memoizedIdentity: null,
  };
  const rates = new Function(
    ...Object.keys(context),
    `${body}\nreturn independentPhysicalRecurringRates;`,
  )(...Object.values(context)) as () => ReturnType<typeof makeTriple<ReturnType<typeof q>>>;
  return { rates, counts: () => ({ enumerationCalls, writeAttempts }) };
}
it.each(["cold-caller", "preparer"])(
  "accepts an identical authenticated %s winner without overwriting it",
  (winner) => {
    const { root, authenticated } = fixture();
    const helper = controlledHelper(root, authenticated.physical, () => {
      if (winner === "preparer")
        expect(prepareIndependentPhysicalRatesCache(root).cacheHit).toBe(false);
      else
        writeFileSync(resolve(root, PHYSICAL_CACHE), authenticated.physicalBytes, { flag: "wx" });
    });
    const result = helper.rates();
    expect(mapTriple(result, wire)).toEqual(authenticated.physical.rate);
    expect(helper.rates()).toBe(result);
    expect(helper.counts()).toEqual({ enumerationCalls: 1, writeAttempts: 1 });
    expect(readFileSync(resolve(root, PHYSICAL_CACHE))).toEqual(authenticated.physicalBytes);
  },
);
it("preserves and rejects an altered-metadata winner even when exact rates are unchanged", () => {
  const { root, authenticated } = fixture();
  const altered = JSON.stringify({
    ...authenticated.physical,
    computeMs: authenticated.physical.computeMs + 1,
  });
  const helper = controlledHelper(root, authenticated.physical, () =>
    writeFileSync(resolve(root, PHYSICAL_CACHE), altered, { flag: "wx" }),
  );
  expect(helper.rates).toThrow(/Existing independent physical cache differs/);
  expect(readFileSync(resolve(root, PHYSICAL_CACHE), "utf8")).toBe(altered);
  expect(helper.counts()).toEqual({ enumerationCalls: 1, writeAttempts: 1 });
});
it("reauthenticates publication after EEXIST and preserves an identical winner on publication drift", () => {
  const { root, authenticated } = fixture();
  const helper = controlledHelper(root, authenticated.physical, () => {
    writeFileSync(resolve(root, PHYSICAL_CACHE), authenticated.physicalBytes, { flag: "wx" });
    const panel = resolve(root, V5_ROOT, "panel.json");
    writeFileSync(panel, Buffer.concat([readFileSync(panel), Buffer.from("\n")]));
  });
  expect(helper.rates).toThrow(/hash drift/);
  expect(readFileSync(resolve(root, PHYSICAL_CACHE))).toEqual(authenticated.physicalBytes);
});
it("propagates non-EEXIST write failures", () => {
  const { root, authenticated } = fixture();
  const failure = Object.assign(new Error("bounded disk failure"), { code: "ENOSPC" });
  const helper = controlledHelper(root, authenticated.physical, () => {
    throw failure;
  });
  expect(() => helper.rates()).toThrow(failure);
  expect(existsSync(resolve(root, PHYSICAL_CACHE))).toBe(false);
});
it("raw isolated producers still reject an identical EEXIST winner", () => {
  const { root, authenticated } = fixture();
  for (const path of PUBLICATION_FILES) rmSync(resolve(root, path));
  mkdirSync(dirname(resolve(root, PHYSICAL_CACHE)), { recursive: true });
  let winner: Buffer | string = "";
  const helper = controlledHelper(root, authenticated.physical, (bytes) => {
    winner = bytes;
    writeFileSync(resolve(root, PHYSICAL_CACHE), bytes, { flag: "wx" });
  });
  expect(helper.rates).toThrow(/EEXIST/);
  expect(readFileSync(resolve(root, PHYSICAL_CACHE))).toEqual(Buffer.from(winner));
});
it("retains the publication-less fresh-process ENOENT diagnostic without deleting producer output", () => {
  const { root, authenticated } = fixture();
  for (const path of PUBLICATION_FILES) rmSync(resolve(root, path));
  mkdirSync(dirname(resolve(root, PHYSICAL_CACHE)), { recursive: true });
  const producer = controlledHelper(root, authenticated.physical);
  producer.rates();
  const raw = readFileSync(resolve(root, PHYSICAL_CACHE));
  const newProcess = controlledHelper(root, authenticated.physical);
  expect(newProcess.rates).toThrow(/ENOENT.*pins\.json/);
  expect(newProcess.counts()).toEqual({ enumerationCalls: 0, writeAttempts: 0 });
  expect(readFileSync(resolve(root, PHYSICAL_CACHE))).toEqual(raw);
});
