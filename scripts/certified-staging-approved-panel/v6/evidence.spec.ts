import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
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
  readV6Evidence,
  V6_ROOT,
} from "./evidence.ts";
import { generationChildEnvironment, prepareGeneration, publishGeneration } from "./generate.ts";
import {
  PREVIOUS_PINS_SHA,
  readFirstPublication,
  readHistorical,
  readPreviousPublication,
  readV4Publication,
  readV5Publication,
  sha256,
  sourceIdentity,
  V5_ARCHIVE_FILES,
  V5_PINS_SHA,
  V5_ROOT,
} from "./history.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixtureRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "v6-evidence-test-"));
  roots.push(root);
  for (const path of [...EVIDENCE_FILES, "package-lock.json", "biome.json"]) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    copyFileSync(path, resolve(root, path));
  }
  return root;
}
it("regenerates v1–v5 24 rows with normalized rates, prices, actions and gaps", () => {
  const current = readV6Evidence();
  const generated = generateIndependentApprovedPanel();
  for (const panel of [
    current.panel,
    readHistorical().panel,
    readFirstPublication().panel,
    readPreviousPublication().panel,
    readV4Publication().panel,
    readV5Publication().panel,
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
it("authenticates the complete unchanged v5 publication and thirteen committed source blobs", () => {
  const previous = readV5Publication();
  expect(previous.provenance.version).toBe("approved24-independent-evidence-v5");
  expect(previous.provenance.generation.sources).toHaveLength(13);
  expect(previous.provenance.generation.sourceHash).toBe(
    "b3e2986a141aeef831549264dbdb59b3a14239e098ba5ab284624e97e186c3f2",
  );
  expect(sha256(readFileSync(`${V5_ROOT}/pins.json.txt`))).toBe(V5_PINS_SHA);
});
it("refuses to replace an existing seal before starting generation", () => {
  const root = fixtureRoot();
  const before = sourceIdentity(EVIDENCE_FILES, root);
  expect(() => prepareGeneration(root)).toThrow(/Refusing to replace v6/);
  expect(sourceIdentity(EVIDENCE_FILES, root)).toEqual(before);
});
it.each([
  "historical",
  "previous",
  "v4",
  "v5",
  "waiting",
  "physical-path",
  "source",
  "panel-path",
  "environment",
])("rejects %s provenance mismatch despite a recomputed envelope hash", (kind) => {
  const root = fixtureRoot();
  const { provenance } = readV6Evidence(root);
  if (kind === "historical") provenance.historical.firstPinsSha256 = "0".repeat(64);
  if (kind === "previous") provenance.historical.previousPinsSha256 = "0".repeat(64);
  if (kind === "v4") provenance.historical.v4PinsSha256 = "0".repeat(64);
  if (kind === "v5") provenance.historical.v5PinsSha256 = "0".repeat(64);
  if (kind === "environment") provenance.generationEnvironment.packageLockSha256 = "invalid";
  if (kind === "waiting") Reflect.set(provenance.generation, "independentWaiting", "PASS");
  if (kind === "physical-path") provenance.physicalEnumeration.path = "legacy.json";
  if (kind === "source") provenance.physicalEnumeration.sourceHash = "0".repeat(64);
  if (kind === "panel-path") provenance.panel.path = "legacy.json";
  const bytes = JSON.stringify(provenance);
  writeFileSync(resolve(root, V6_ROOT, "provenance.json"), bytes);
  const pins = JSON.parse(readFileSync(resolve(root, V6_ROOT, "pins.json"), "utf8"));
  pins.provenance.sha256 = sha256(bytes);
  writeFileSync(resolve(root, V6_ROOT, "pins.json"), JSON.stringify(pins));
  expect(() => readV6Evidence(root)).toThrow();
});
it("rejects an unrelated publication directory rather than reading arbitrary draft paths", () => {
  expect(() => publishGeneration("scripts")).toThrow(/Draft must be a direct v6 child/);
});
it.each(["existing", "forged-artifact-pin", "forged-envelope-pin"])(
  "publication rejects %s without changing any existing seal",
  (kind) => {
    const root = fixtureRoot();
    const workspace = mkdtempSync(resolve(tmpdir(), "v6-publication-fixture-"));
    roots.push(workspace);
    const draft = mkdtempSync(resolve(root, V6_ROOT, "draft-"));
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
      copyFileSync(resolve(root, V6_ROOT, name), resolve(draft, name));
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
        generationEnvironment: {
          nodeVersion: process.version,
          packageLockSha256: sha256(readFileSync(resolve(root, "package-lock.json"))),
          biomeSha256: sha256(readFileSync(resolve(root, "biome.json"))),
        },
        calculation: { nodeVersion: process.version, fixtureOnly: true },
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
          (name) => path === `${V6_ROOT}/${name}`,
        ),
    );
    if (kind !== "existing")
      for (const name of [
        "independent-physical-cohorts.json",
        "panel.json",
        "provenance.json",
        "pins.json",
      ])
        rmSync(resolve(root, V6_ROOT, name));
    const before = sourceIdentity(kind === "existing" ? EVIDENCE_FILES : retained, root);
    expect(() => publishGeneration(draft, root)).toThrow();
    expect(sourceIdentity(kind === "existing" ? EVIDENCE_FILES : retained, root)).toEqual(before);
    if (kind !== "existing")
      expect(() => readFileSync(resolve(root, V6_ROOT, "pins.json"))).toThrow(/ENOENT/);
  },
);
it.each(V5_ARCHIVE_FILES)("rejects a missing v5 archive file: %s", (path) => {
  const root = fixtureRoot();
  rmSync(resolve(root, path));
  expect(() => readV6Evidence(root)).toThrow();
});
it.each([`${V5_ROOT}/extra.json.txt`, `${V5_ROOT}/source/extra.ts.txt`])(
  "rejects an extra v5 archive file: %s",
  (path) => {
    const root = fixtureRoot();
    writeFileSync(resolve(root, path), "extra");
    expect(() => readV6Evidence(root)).toThrow(/archive inventory drift/);
  },
);
it.each(["version", "coordinated-reseal"])("rejects v5 archive %s", (kind) => {
  const root = fixtureRoot();
  const pinsPath = resolve(root, V5_ROOT, "pins.json.txt");
  const pins = JSON.parse(readFileSync(pinsPath, "utf8"));
  if (kind === "version") pins.version = "approved24-independent-evidence-v6";
  else {
    const path = resolve(root, V5_ROOT, "provenance.json.txt");
    const provenance = JSON.parse(readFileSync(path, "utf8"));
    provenance.version = "approved24-independent-evidence-v6";
    const bytes = JSON.stringify(provenance);
    writeFileSync(path, bytes);
    pins.provenance.sha256 = sha256(bytes);
  }
  writeFileSync(pinsPath, JSON.stringify(pins));
  expect(() => readV6Evidence(root)).toThrow(/hash drift/);
});
it.each(["nodeVersion", "packageLockSha256", "biomeSha256", "extra", "missing"])(
  "validates generation environment schema after coordinated envelope resealing: %s",
  (field) => {
    const root = fixtureRoot();
    const { provenance } = readV6Evidence(root);
    if (field === "missing") Reflect.deleteProperty(provenance, "generationEnvironment");
    else Reflect.set(provenance.generationEnvironment, field, "invalid");
    const bytes = JSON.stringify(provenance);
    writeFileSync(resolve(root, V6_ROOT, "provenance.json"), bytes);
    const pins = JSON.parse(readFileSync(resolve(root, V6_ROOT, "pins.json"), "utf8"));
    pins.provenance.sha256 = sha256(bytes);
    writeFileSync(resolve(root, V6_ROOT, "pins.json"), JSON.stringify(pins));
    expect(() => readV6Evidence(root)).toThrow();
  },
);
it("allowlists only the required child environment", () => {
  expect(
    generationChildEnvironment(
      { SystemRoot: "C:\\Windows", TEMP: "temporary", PATH: "ignored", SECRET: "ignored" },
      [],
    ),
  ).toEqual({ SystemRoot: "C:\\Windows", TEMP: "temporary" });
});
it.each([
  "NODE_OPTIONS",
  "node_options",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "CUSTOM_LOADER",
])("rejects inherited preload/loader options: %s", (key) => {
  expect(() => generationChildEnvironment({ [key]: "poison" }, [])).toThrow(/forbids/);
});
it("rejects parent Node CLI options instead of allowing a loader-influenced generation", () => {
  expect(() => generationChildEnvironment({}, ["--import=poison"])).toThrow(/execution options/);
});
