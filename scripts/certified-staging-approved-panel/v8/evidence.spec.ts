import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { wire } from "../../certified-staging-oracle.ts";
import { normalizeExact } from "../v6/evidence.ts";
import { sha256 } from "../v6/history.ts";
import { V7_PINS_SHA } from "../v7/evidence.ts";
import { V8_PINS_SHA } from "./anchor.ts";
import {
  ANCHOR_FILE,
  ARCHIVE_FILES,
  EVIDENCE_FILES,
  GENERATION_SOURCES,
  POPULATION,
  readV8Evidence,
  SNAPSHOT_SOURCES,
  V8_ARCHIVE_ROOT,
  V8_ROOT,
} from "./evidence.ts";
import { generatePublication } from "./generate.ts";
import { frozenApprovedSnapshot } from "./panel.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** Evidence-only copy: no current product or generation source is present in this root. */
function evidenceRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "approved24-v8-mutation-"));
  roots.push(root);
  for (const path of EVIDENCE_FILES) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    copyFileSync(path, resolve(root, path));
  }
  return root;
}

it("authenticates the tracked v8 approved24 publication as sealed history", () => {
  expect(sha256(readFileSync(`${V8_ROOT}/pins.json`))).toBe(V8_PINS_SHA);
  expect(readFileSync(ANCHOR_FILE, "utf8")).toContain(`"${V8_PINS_SHA}"`);
  const { snapshot, physical, panel, provenance } = readV8Evidence();
  expect(snapshot.version).toBe("certified-daily-v3");
  // The historical v8 accessor still serves exactly the sealed snapshot bytes.
  expect(frozenApprovedSnapshot()).toEqual(snapshot);
  expect(panel).toHaveLength(24);
  expect(normalizeExact(physical.population)).toEqual(normalizeExact(POPULATION.map(wire)));
  expect(provenance.generation.sources.map(({ path }) => path)).toEqual(GENERATION_SOURCES);
  expect(provenance.snapshot.sources.map(({ path }) => path)).toEqual(SNAPSHOT_SOURCES);
  for (const source of [...provenance.generation.sources, ...provenance.snapshot.sources])
    expect(sha256(readFileSync(`${V8_ARCHIVE_ROOT}/${source.path}.txt`))).toBe(source.sha256);
  expect(ARCHIVE_FILES).toHaveLength(
    provenance.generation.sources.length + provenance.snapshot.sources.length,
  );
});

it("authenticates v8 from an evidence-only root without current sources", () => {
  const root = evidenceRoot();
  for (const path of [
    "src/lib/certifiedForecast.ts",
    "shared/certifiedSupply.ts",
    `${V8_ROOT}/evidence.ts`,
  ])
    expect(() => readFileSync(resolve(root, path))).toThrow();
  expect(readV8Evidence(root).panel).toHaveLength(24);
});

it("refuses to overwrite the sealed publication", async () => {
  await expect(generatePublication()).rejects.toThrow("Refusing to replace sealed evidence");
});

it.each([
  "snapshot.json",
  "panel.json",
  "independent-physical-cohorts.json",
  "provenance.json",
  "pins.json",
  "source/scripts/certified-staging-approved-panel/v8/evidence.ts.txt",
  "source/scripts/certified-staging-oracle-four-cohort-pricing.ts.txt",
  "source/shared/certifiedSupply.ts.txt",
  "source/src/lib/certifiedForecast.ts.txt",
])("rejects changed %s bytes", (name) => {
  const root = evidenceRoot();
  writeFileSync(resolve(root, V8_ROOT, name), "changed");
  expect(() => readV8Evidence(root)).toThrow();
});

it("rejects a missing or extra archived source", () => {
  const missing = evidenceRoot();
  unlinkSync(resolve(missing, V8_ARCHIVE_ROOT, "shared/certifiedSupplyModel.ts.txt"));
  expect(() => readV8Evidence(missing)).toThrow();
  const extra = evidenceRoot();
  writeFileSync(resolve(extra, V8_ARCHIVE_ROOT, "shared/extra.ts.txt"), "extra");
  expect(() => readV8Evidence(extra)).toThrow("v8 archive drift");
});

it("pins the unchanged v7 seal as history", () => {
  const { provenance } = readV8Evidence();
  expect(sha256(readFileSync("scripts/certified-staging-approved-panel/v7/pins.json"))).toBe(
    provenance.historical.v7PinsSha256,
  );
  expect(provenance.historical.v7PinsSha256).toBe(V7_PINS_SHA);
  expect(provenance.historical.cohortMigration).toBe("four-prior-positive-cohort3-population-v3");
  expect(provenance.generation.independentWaiting).toBe("UNVERIFIED_NOT_REGENERATED");
});
