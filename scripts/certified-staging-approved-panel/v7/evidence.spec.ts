import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { assertTrustedCertifiedForecast } from "../../../src/lib/certifiedForecastTrust.ts";
import {
  loadIndependentApprovedPanel as historicalPanel,
  frozenApprovedSnapshot as historicalSnapshot,
} from "../../certified-staging-approved-panel.ts";
import { q, wire } from "../../certified-staging-oracle.ts";
import { sha256 } from "../v6/history.ts";
import { EVIDENCE_FILES, readV7Evidence, V7_ROOT } from "./evidence.ts";
import { generatePublication } from "./generate.ts";
import { frozenApprovedSnapshot, loadIndependentApprovedPanel } from "./panel.ts";
import { prepareSnapshot } from "./snapshot.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("uses the exact approved v2 input while historical v1 remains inadmissible", async () => {
  const snapshot = frozenApprovedSnapshot();
  expect(snapshot).toEqual((await prepareSnapshot()).snapshot);
  await expect(assertTrustedCertifiedForecast(snapshot, () => {})).resolves.toBeDefined();
  await expect(assertTrustedCertifiedForecast(historicalSnapshot(), () => {})).rejects.toThrow(
    "certified_forecast_not_approved",
  );
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

it.each(["snapshot.json", "panel.json", "independent-physical-cohorts.json", "history.ts"])(
  "rejects changed %s bytes",
  (name) => {
    const root = mkdtempSync(resolve(tmpdir(), "approved24-v7-mutation-"));
    roots.push(root);
    const { provenance } = readV7Evidence();
    for (const path of new Set([
      ...EVIDENCE_FILES,
      ...provenance.snapshot.sources.map((row) => row.path),
    ])) {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      copyFileSync(path, resolve(root, path));
    }
    writeFileSync(resolve(root, V7_ROOT, name), "changed");
    expect(() => readV7Evidence(root)).toThrow();
  },
);

it("pins the unchanged v6 seal as history, not a silently resealed v1 snapshot", () => {
  const { provenance } = readV7Evidence();
  expect(sha256(readFileSync("scripts/certified-staging-approved-panel/v6/pins.json"))).toBe(
    provenance.historical.v6PinsSha256,
  );
  expect(provenance.historical.cohortMigration).toBe("append-zero-fourth-prior");
  expect(provenance.generation.independentWaiting).toBe("UNVERIFIED_NOT_REGENERATED");
});
