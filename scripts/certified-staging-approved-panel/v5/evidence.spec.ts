import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import {
  generateIndependentApprovedPanel,
  loadIndependentApprovedPanel,
} from "../../certified-staging-approved-panel.ts";
import {
  EVIDENCE_FILES,
  GENERATION_SOURCES,
  normalizeExact,
  PHYSICAL_CACHE,
  readV5Evidence,
  V5_ROOT,
} from "./evidence.ts";
import { prepareGeneration, publishGeneration } from "./generate.ts";
import {
  PREVIOUS_PINS_SHA,
  readFirstPublication,
  readHistorical,
  readPreviousPublication,
  readV4Publication,
  sha256,
  sourceIdentity,
} from "./history.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixtureRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "v5-evidence-test-"));
  roots.push(root);
  for (const path of EVIDENCE_FILES) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    copyFileSync(path, resolve(root, path));
  }
  return root;
}
it("regenerates original, v2, v3 and v4 24 rows with normalized rates, prices, actions and gaps", () => {
  const current = readV5Evidence();
  const generated = generateIndependentApprovedPanel();
  for (const panel of [
    current.panel,
    readHistorical().panel,
    readFirstPublication().panel,
    readPreviousPublication().panel,
    readV4Publication().panel,
  ])
    expect(normalizeExact(generated)).toEqual(normalizeExact(panel));
  expect(loadIndependentApprovedPanel()).toHaveLength(24);
  expect(current.provenance.generation.independentWaiting).toBe("UNVERIFIED_NOT_REGENERATED");
  expect(normalizeExact({ numerator: "2", denominator: "4" })).toEqual(
    normalizeExact({ numerator: "1", denominator: "2" }),
  );
  expect(() => normalizeExact({ numerator: "1", denominator: "0" })).toThrow();
});
it("authenticates unchanged v3 seals and all thirteen generation inputs as archived data", () => {
  const previous = readPreviousPublication();
  expect(previous.provenance.generation.sources).toHaveLength(13);
  expect(previous.provenance.generation.sourceHash).toBe(
    "160a9ed2e38f2469600911c1db32c7ef94f92837f459681000a99eceda6d6e29",
  );
  expect(sha256(previous.physicalBytes)).toBe(
    "f34860fdf917707153777082e5f1dcca51821b32e414927d3bd629500c286554",
  );
  expect(sha256(readFileSync("scripts/certified-staging-approved-panel/v3/pins.json.txt"))).toBe(
    PREVIOUS_PINS_SHA,
  );
});
it("has a real static CLI-to-calculator relationship and a complete independent source closure", async () => {
  const built = await build({
    entryPoints: ["scripts/generate-certified-staging-approved-panel.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const paths = Object.keys(built.metafile.inputs);
  expect(paths).toContain(`${V5_ROOT}/calculate.ts`);
  expect(paths.every((path) => GENERATION_SOURCES.some((source) => source === path))).toBe(true);
  expect(
    paths.some((path) =>
      /src\/certified\/|certifiedRational|certifiedSupplyModel|\/v[234]\//.test(path),
    ),
  ).toBe(false);
});
it("refuses to replace an existing seal before starting generation", () => {
  const root = fixtureRoot();
  const before = sourceIdentity(EVIDENCE_FILES, root);
  expect(() => prepareGeneration(root)).toThrow(/Refusing to replace v5/);
  expect(sourceIdentity(EVIDENCE_FILES, root)).toEqual(before);
});
it.each(["historical", "previous", "v4", "waiting", "physical-path", "source", "panel-path"])(
  "rejects %s provenance mismatch despite a recomputed envelope hash",
  (kind) => {
    const root = fixtureRoot();
    const { provenance } = readV5Evidence(root);
    if (kind === "historical") provenance.historical.firstPinsSha256 = "0".repeat(64);
    if (kind === "previous") provenance.historical.previousPinsSha256 = "0".repeat(64);
    if (kind === "v4") provenance.historical.v4PinsSha256 = "0".repeat(64);
    if (kind === "waiting") Reflect.set(provenance.generation, "independentWaiting", "PASS");
    if (kind === "physical-path") provenance.physicalEnumeration.path = "legacy.json";
    if (kind === "source") provenance.physicalEnumeration.sourceHash = "0".repeat(64);
    if (kind === "panel-path") provenance.panel.path = "legacy.json";
    const bytes = JSON.stringify(provenance);
    writeFileSync(resolve(root, V5_ROOT, "provenance.json"), bytes);
    const pins = JSON.parse(readFileSync(resolve(root, V5_ROOT, "pins.json"), "utf8"));
    pins.provenance.sha256 = sha256(bytes);
    writeFileSync(resolve(root, V5_ROOT, "pins.json"), JSON.stringify(pins));
    expect(() => readV5Evidence(root)).toThrow();
  },
);
it("rejects an unrelated publication directory rather than reading arbitrary draft paths", () => {
  expect(() => publishGeneration("scripts")).toThrow(/Draft must be a direct v5 child/);
});
it.each(["existing", "forged-artifact-pin", "forged-envelope-pin"])(
  "publication rejects %s without changing any existing seal",
  (kind) => {
    const root = fixtureRoot();
    const workspace = mkdtempSync(resolve(tmpdir(), "v5-publication-fixture-"));
    roots.push(workspace);
    const draft = mkdtempSync(resolve(root, V5_ROOT, "draft-"));
    for (const path of GENERATION_SOURCES) {
      mkdirSync(dirname(resolve(workspace, path)), { recursive: true });
      copyFileSync(path, resolve(workspace, path));
    }
    for (const name of [
      "independent-physical-cohorts.json",
      "panel.json",
      "provenance.json",
      "pins.json",
    ])
      copyFileSync(resolve(root, V5_ROOT, name), resolve(draft, name));
    mkdirSync(dirname(resolve(workspace, PHYSICAL_CACHE)), { recursive: true });
    copyFileSync(
      resolve(draft, "independent-physical-cohorts.json"),
      resolve(workspace, PHYSICAL_CACHE),
    );
    copyFileSync(resolve(draft, "panel.json"), resolve(workspace, "approved24.json"));
    writeFileSync(
      resolve(draft, "receipt.json"),
      JSON.stringify({
        workspace,
        generation: sourceIdentity(GENERATION_SOURCES, root),
        calculation: { fixtureOnly: true },
      }),
    );
    if (kind === "forged-artifact-pin") {
      const provenance = JSON.parse(readFileSync(resolve(draft, "provenance.json"), "utf8"));
      provenance.panel.sha256 = "0".repeat(64);
      const bytes = JSON.stringify(provenance);
      writeFileSync(resolve(draft, "provenance.json"), bytes);
      const pins = JSON.parse(readFileSync(resolve(draft, "pins.json"), "utf8"));
      pins.provenance.sha256 = sha256(bytes);
      writeFileSync(resolve(draft, "pins.json"), JSON.stringify(pins));
    }
    if (kind === "forged-envelope-pin") {
      const pins = JSON.parse(readFileSync(resolve(draft, "pins.json"), "utf8"));
      pins.provenance.sha256 = "0".repeat(64);
      writeFileSync(resolve(draft, "pins.json"), JSON.stringify(pins));
    }
    // Remove only the fixture's successor outputs for the forged-publication cases.
    // Production first/current seals and the immutable historical inputs are untouched.
    const retained = EVIDENCE_FILES.filter(
      (path) =>
        !["independent-physical-cohorts.json", "panel.json", "provenance.json", "pins.json"].some(
          (name) => path === `${V5_ROOT}/${name}`,
        ),
    );
    if (kind !== "existing")
      for (const name of [
        "independent-physical-cohorts.json",
        "panel.json",
        "provenance.json",
        "pins.json",
      ])
        rmSync(resolve(root, V5_ROOT, name));
    const before = sourceIdentity(kind === "existing" ? EVIDENCE_FILES : retained, root);
    expect(() => publishGeneration(draft, root)).toThrow();
    expect(sourceIdentity(kind === "existing" ? EVIDENCE_FILES : retained, root)).toEqual(before);
    if (kind !== "existing")
      expect(() => readFileSync(resolve(root, V5_ROOT, "pins.json"))).toThrow(/ENOENT/);
  },
);
