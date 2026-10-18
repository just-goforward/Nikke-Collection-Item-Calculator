import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generationChildEnvironment } from "../v6/generate.ts";
import { sha256, sourceIdentity } from "../v6/history.ts";
import { V8_PINS_SHA } from "../v8/anchor.ts";
import { COHORT_MIGRATION, readV8Evidence } from "../v8/evidence.ts";
import { prepareSnapshot } from "../v8/snapshot.ts";
import type { calculateFresh } from "./calculate.ts";
import {
  EVIDENCE_FILES,
  EVIDENCE_VERSION,
  type EvidenceProvenance,
  GENERATION_SOURCES,
  PUBLICATION_FILES,
  readV9Evidence,
  V9_ROOT,
} from "./evidence.ts";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
/** `target` is the repository root receiving the publication; a disposable copy of
 * the repository may be supplied to exercise the full pipeline without publishing. */
export async function generatePublication(target = process.cwd()) {
  for (const path of PUBLICATION_FILES)
    assert.equal(
      existsSync(resolve(target, path)),
      false,
      `Refusing to replace sealed evidence: ${path}`,
    );
  const env = generationChildEnvironment();
  readV8Evidence();
  const before = sourceIdentity(GENERATION_SOURCES);
  const { snapshot, sources } = await prepareSnapshot();
  const workspace = mkdtempSync(resolve(tmpdir(), "approved24-v9-fresh-"));
  for (const path of EVIDENCE_FILES.filter((path) => !PUBLICATION_FILES.includes(path))) {
    const destination = resolve(workspace, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
  }
  writeFileSync(resolve(workspace, "snapshot-input.json"), json(snapshot), { flag: "wx" });
  const calculation = JSON.parse(
    execFileSync(process.execPath, [`${V9_ROOT}/calculate.ts`], {
      cwd: workspace,
      env,
      encoding: "utf8",
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    }),
  ) as ReturnType<typeof calculateFresh>;
  assert.deepEqual(sourceIdentity(GENERATION_SOURCES), before, "Generation source drift");
  for (const source of sources)
    assert.equal(sha256(readFileSync(source.path)), source.sha256, "Snapshot source drift");
  const bytes = {
    snapshot: json(snapshot),
    physical: json(calculation.physical),
    panel: json(calculation.panel),
  };
  const provenance: EvidenceProvenance = {
    version: EVIDENCE_VERSION,
    generationEnvironment: {
      nodeVersion: process.version,
      packageLockSha256: sha256(readFileSync("package-lock.json")),
      biomeSha256: sha256(readFileSync("biome.json")),
    },
    generation: {
      ...before,
      isolatedCacheEmpty: true,
      physicalEnumeration: "sequential-draw-state-merged",
      oracleRows: 24,
      independentWaiting: "UNVERIFIED_NOT_REGENERATED",
    },
    historical: { v8PinsSha256: V8_PINS_SHA, cohortMigration: COHORT_MIGRATION },
    snapshot: {
      path: `${V9_ROOT}/snapshot.json`,
      sha256: sha256(bytes.snapshot),
      meaning: "approved forecast input only; not an expected solver output",
      sources,
    },
    physicalEnumeration: {
      path: `${V9_ROOT}/independent-physical-cohorts.json`,
      sha256: sha256(bytes.physical),
    },
    panel: { path: `${V9_ROOT}/panel.json`, sha256: sha256(bytes.panel) },
  };
  const provenanceBytes = json(provenance);
  const publication = [
    ["snapshot.json", bytes.snapshot],
    ["independent-physical-cohorts.json", bytes.physical],
    ["panel.json", bytes.panel],
    ["provenance.json", provenanceBytes],
    [
      "pins.json",
      json({
        version: EVIDENCE_VERSION,
        provenance: { path: `${V9_ROOT}/provenance.json`, sha256: sha256(provenanceBytes) },
      }),
    ],
  ] as const;
  // Validate the whole publication before writing the commit-marker pin last.
  for (const source of sources) {
    if (EVIDENCE_FILES.includes(source.path)) continue;
    const destination = resolve(workspace, source.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source.path, destination);
  }
  for (const [name, value] of publication)
    writeFileSync(resolve(workspace, V9_ROOT, name), value, { flag: "wx" });
  const pinsBytes = publication.find(([name]) => name === "pins.json")?.[1];
  assert.ok(pinsBytes);
  readV9Evidence(workspace, sha256(pinsBytes));
  for (const [name, value] of publication)
    writeFileSync(resolve(target, V9_ROOT, name), value, { flag: "wx" });
  return { version: EVIDENCE_VERSION, workspace, cases: calculation.panel.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await generatePublication(process.argv[2])));
