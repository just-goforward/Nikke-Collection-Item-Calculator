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
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { loadIndependentApprovedPanel as historicalPanel } from "../../certified-staging-approved-panel.ts";
import { q, wire } from "../../certified-staging-oracle.ts";
import { sha256 } from "../v6/history.ts";
import {
  ARCHIVE_FILES,
  EVIDENCE_FILES,
  readV7Evidence,
  SNAPSHOT_SOURCES,
  V7_ARCHIVE_ROOT,
  V7_PINS_SHA,
  V7_ROOT,
} from "./evidence.ts";
import { generatePublication } from "./generate.ts";
import { frozenApprovedSnapshot, loadIndependentApprovedPanel } from "./panel.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** Evidence-only copy: no current product source is present in this root. */
function evidenceRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "approved24-v7-mutation-"));
  roots.push(root);
  for (const path of EVIDENCE_FILES) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    copyFileSync(path, resolve(root, path));
  }
  return root;
}

it("keeps the sealed v2 input as authenticated history with preserved source bytes", () => {
  const snapshot = frozenApprovedSnapshot();
  expect(snapshot.version).toBe("certified-daily-v2");
  expect(snapshot.events).toHaveLength(79);
  expect(sha256(readFileSync(`${V7_ROOT}/pins.json`))).toBe(V7_PINS_SHA);
  const { provenance } = readV7Evidence();
  expect(provenance.snapshot.sources.map(({ path }) => path)).toEqual(SNAPSHOT_SOURCES);
  for (const source of [...provenance.generation.sources, ...provenance.snapshot.sources])
    expect(sha256(readFileSync(`${V7_ARCHIVE_ROOT}/${source.path}.txt`))).toBe(source.sha256);
  expect(ARCHIVE_FILES).toHaveLength(
    provenance.generation.sources.length + provenance.snapshot.sources.length,
  );
});

it("authenticates v7 from an evidence-only root without current product sources", () => {
  const root = evidenceRoot();
  expect(() => readFileSync(resolve(root, "src/lib/certifiedForecast.ts"))).toThrow();
  expect(readV7Evidence(root).panel).toHaveLength(24);
});

it("regenerates all 24 independent objectives and gaps with explicit four-prior inputs", () => {
  const panel = loadIndependentApprovedPanel();
  const historical = historicalPanel();
  expect(panel.map((row) => row.originalIndex)).toEqual(historical.map((row) => row.originalIndex));
  for (const [index, row] of panel.entries()) {
    const previous = historical[index];
    expect(previous).toBeDefined();
    expect(row.expected).toEqual({
      ...previous?.expected,
      cohortWeights: [...(previous?.expected.cohortWeights ?? []), wire(q(0))],
    });
    expect(row.input.cohortWeights).toEqual(row.expected.cohortWeights);
    expect(row.input.snapshot.version).toBe("certified-daily-v2");
  }
}, 120_000);

it("keeps product reconstruction outside the independent calculation closure", async () => {
  const result = await build({
    entryPoints: [`${V7_ROOT}/calculate.ts`],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs).toContain("scripts/certified-staging-oracle.ts");
  expect(inputs).toContain("scripts/certified-staging-oracle-physical-supply.ts");
  expect(inputs.filter((path) => path.startsWith("src/"))).toEqual([]);
  expect(inputs.filter((path) => path.startsWith("shared/"))).toEqual(["shared/game.ts"]);
  expect(inputs).not.toContain(`${V7_ROOT}/snapshot.ts`);
});

it("refuses to overwrite the new publication", async () => {
  await expect(generatePublication()).rejects.toThrow("Refusing to replace sealed evidence");
});

it.each([
  "snapshot.json",
  "panel.json",
  "independent-physical-cohorts.json",
  "provenance.json",
  "pins.json",
  "source/scripts/certified-staging-approved-panel/v7/history.ts.txt",
  "source/scripts/certified-staging-oracle-physical-supply.ts.txt",
  "source/shared/certifiedSupply.ts.txt",
  "source/src/lib/certifiedForecast.ts.txt",
])("rejects changed %s bytes", (name) => {
  const root = evidenceRoot();
  writeFileSync(resolve(root, V7_ROOT, name), "changed");
  expect(() => readV7Evidence(root)).toThrow();
});

it("rejects a missing or extra archived source", () => {
  const missing = evidenceRoot();
  unlinkSync(resolve(missing, V7_ARCHIVE_ROOT, "shared/supplyForecastModel.ts.txt"));
  expect(() => readV7Evidence(missing)).toThrow();
  const extra = evidenceRoot();
  writeFileSync(resolve(extra, V7_ARCHIVE_ROOT, "shared/extra.ts.txt"), "extra");
  expect(() => readV7Evidence(extra)).toThrow("v7 archive drift");
});

it("pins the unchanged v6 seal as history, not a silently resealed v1 snapshot", () => {
  const { provenance } = readV7Evidence();
  expect(sha256(readFileSync("scripts/certified-staging-approved-panel/v6/pins.json"))).toBe(
    provenance.historical.v6PinsSha256,
  );
  expect(provenance.historical.cohortMigration).toBe("append-zero-fourth-prior");
  expect(provenance.generation.independentWaiting).toBe("UNVERIFIED_NOT_REGENERATED");
});
