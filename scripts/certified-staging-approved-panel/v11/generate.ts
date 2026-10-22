import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { CERTIFIED_ENGINE_CODE_HASH } from "../../../shared/generated/certifiedEngineBuild.ts";
import { wire } from "../../certified-staging-oracle.ts";
import { sha256 } from "../v6/history.ts";
import type { Provenance } from "../v10/evidence.ts";
import { calculateBoundaries, calculatePanel } from "./calculate.ts";
import { PUBLICATION_FILES, VERSION } from "./evidence.ts";
import { independentThreeCohorts } from "./physical.ts";
import { prepareSnapshot } from "./snapshot.ts";

/** Draft only. A review, trusted anchor and publication admission are separate actions. */
export async function generatePublication(root: string) {
  for (const name of PUBLICATION_FILES)
    assert.equal(existsSync(resolve(root, name)), false, `Refusing overwrite: ${name}`);
  const graph = await build({
    entryPoints: [
      "scripts/certified-staging-approved-panel/v11/dry-run.ts",
      "scripts/certified-staging-approved-panel/v11/engine-check.ts",
      "scripts/certified-staging-approved-panel/v11/regenerate.ts",
    ],
    outdir: ".v11-archive-unused",
    bundle: true,
    platform: "node",
    format: "esm",
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  const { snapshot, sources: preparedSources } = await prepareSnapshot();
  const sources = [
    ...new Set([
      ...Object.keys(graph.metafile.inputs),
      ...preparedSources.map((source) => source.path),
      "package-lock.json",
    ]),
  ]
    .sort()
    .map((path) => {
      const bytes = readFileSync(path);
      return { path, sha256: sha256(bytes), base64: bytes.toString("base64") };
    });
  const cohorts = independentThreeCohorts();
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const files = {
    "snapshot.json": json(snapshot),
    "independent-physical-cohorts.json": json(cohorts.map((row) => row.map(wire))),
    "panel.json": json({
      cases: calculatePanel(snapshot, cohorts),
      boundaries: calculateBoundaries(snapshot, cohorts),
    }),
  };
  const provenance: Provenance = {
    version: VERSION,
    cadenceVersion: snapshot.cadence.version,
    engineBuildHash: CERTIFIED_ENGINE_CODE_HASH,
    sources,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])),
  };
  for (const source of sources)
    assert.equal(sha256(readFileSync(source.path)), source.sha256, "Generation source drift");
  const provenanceBytes = json(provenance);
  const pins = json({ version: VERSION, provenanceSha256: sha256(provenanceBytes) });
  for (const [name, bytes] of Object.entries({
    ...files,
    "provenance.json": provenanceBytes,
    "pins.json": pins,
  }))
    writeFileSync(resolve(root, name), bytes, { flag: "wx" });
  return { root, anchor: sha256(pins), engineBuildHash: CERTIFIED_ENGINE_CODE_HASH };
}
