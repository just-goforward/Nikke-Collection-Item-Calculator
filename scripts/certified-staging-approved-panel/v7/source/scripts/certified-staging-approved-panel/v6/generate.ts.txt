import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  EVIDENCE_FILES,
  EVIDENCE_VERSION,
  type EvidenceProvenance,
  GENERATION_SOURCES,
  PHYSICAL_CACHE,
  type PhysicalEvidence,
  readV6Evidence,
  V6_ROOT,
  validateEquivalence,
  validateGenerationEnvironment,
  validatePhysicalEvidence,
} from "./evidence.ts";
import {
  ARCHIVED_SOURCES,
  FIRST_PINS_SHA,
  HISTORICAL_FILES,
  HISTORICAL_ROOT,
  PREVIOUS_PINS_SHA,
  readFirstPublication,
  readHistorical,
  readPreviousPublication,
  readV4Publication,
  readV5Publication,
  sha256,
  sourceIdentity,
  V4_PINS_SHA,
  V5_PINS_SHA,
} from "./history.ts";

const outputs = [
  "independent-physical-cohorts.json",
  "panel.json",
  "provenance.json",
  "pins.json",
] as const;
const newJson = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
type Receipt = {
  workspace: string;
  generation: ReturnType<typeof sourceIdentity>;
  generationEnvironment: EvidenceProvenance["generationEnvironment"];
  calculation: { nodeVersion: string; physicalComputeMs: number; cases: number };
};
/** The calculation child cannot inherit loaders, preloads or executable search paths. */
export function generationChildEnvironment(environment = process.env, execArgv = process.execArgv) {
  for (const [key, value] of Object.entries(environment)) {
    if (/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_AUDIT|DYLD_.+|.*LOADER.*|.*PRELOAD.*)$/i.test(key))
      assert.ok(!value, `Generation forbids preload/loader environment: ${key}`);
  }
  assert.equal(execArgv.length, 0, "Generation forbids Node execution options");
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      /^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key),
    ),
  );
}
function environmentHashes(root: string) {
  return {
    packageLockSha256: sha256(readFileSync(resolve(root, "package-lock.json"))),
    biomeSha256: sha256(readFileSync(resolve(root, "biome.json"))),
  };
}
function checkDraft(directory: string, root: string) {
  assert.equal(
    dirname(resolve(directory)),
    resolve(root, V6_ROOT),
    "Draft must be a direct v6 child",
  );
  const receipt = JSON.parse(readFileSync(resolve(directory, "receipt.json"), "utf8")) as Receipt;
  validateGenerationEnvironment(receipt.generationEnvironment);
  assert.deepEqual(receipt.generationEnvironment, {
    ...environmentHashes(root),
    nodeVersion: receipt.calculation.nodeVersion,
  });
  assert.deepEqual(
    sourceIdentity(GENERATION_SOURCES, root),
    receipt.generation,
    "Active source drift",
  );
  assert.deepEqual(
    sourceIdentity(GENERATION_SOURCES, receipt.workspace),
    receipt.generation,
    "Workspace source drift",
  );
  const physicalBytes = readFileSync(resolve(directory, "independent-physical-cohorts.json"));
  const panelBytes = readFileSync(resolve(directory, "panel.json"));
  const physical = JSON.parse(physicalBytes.toString()) as PhysicalEvidence;
  const panel = JSON.parse(panelBytes.toString()) as unknown[];
  const rawPhysical = JSON.parse(readFileSync(resolve(receipt.workspace, PHYSICAL_CACHE), "utf8"));
  const rawPanel = JSON.parse(readFileSync(resolve(receipt.workspace, "approved24.json"), "utf8"));
  // Formatting is the only permitted transformation of newly calculated output.
  assert.deepEqual(physical, rawPhysical);
  assert.deepEqual(panel, rawPanel);
  validatePhysicalEvidence(physical, root);
  validateEquivalence(physical, panel, root);
  return { receipt, physical, panel, physicalBytes, panelBytes };
}
export function prepareGeneration(
  root = process.cwd(),
  expectedEnvironment?: { packageLockSha256: string; biomeSha256: string },
) {
  for (const name of outputs)
    assert.equal(existsSync(resolve(root, V6_ROOT, name)), false, `Refusing to replace v6 ${name}`);
  const env = generationChildEnvironment();
  const hashes = environmentHashes(root);
  assert.ok(expectedEnvironment, "Supply hashes of HEAD:package-lock.json and staged biome.json");
  assert.deepEqual(
    hashes,
    expectedEnvironment,
    "Generation environment differs from approved Git bytes",
  );
  readHistorical(root);
  readFirstPublication(root);
  readPreviousPublication(root);
  readV4Publication(root);
  readV5Publication(root);
  const generation = sourceIdentity(GENERATION_SOURCES, root);
  const workspace = mkdtempSync(resolve(tmpdir(), "approved24-v6-fresh-"));
  for (const path of [...GENERATION_SOURCES, `${HISTORICAL_ROOT}/snapshot.json`]) {
    const destination = resolve(workspace, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(root, path), destination, constants.COPYFILE_EXCL);
  }
  mkdirSync(resolve(workspace, "benchmarks/results"), { recursive: true });
  assert.deepEqual(sourceIdentity(GENERATION_SOURCES, workspace), generation);
  const calculation = JSON.parse(
    execFileSync(
      process.execPath,
      ["scripts/generate-certified-staging-approved-panel.ts", "--calculate"],
      {
        cwd: workspace,
        env,
        encoding: "utf8",
        timeout: 300_000,
        maxBuffer: 1024 * 1024,
      },
    ),
  );
  const generationEnvironment = { ...hashes, nodeVersion: calculation.nodeVersion };
  validateGenerationEnvironment(generationEnvironment);
  assert.deepEqual(sourceIdentity(GENERATION_SOURCES, root), generation, "Active source drift");
  const directory = mkdtempSync(resolve(root, V6_ROOT, "draft-"));
  copyFileSync(
    resolve(workspace, PHYSICAL_CACHE),
    resolve(directory, outputs[0]),
    constants.COPYFILE_EXCL,
  );
  copyFileSync(
    resolve(workspace, "approved24.json"),
    resolve(directory, outputs[1]),
    constants.COPYFILE_EXCL,
  );
  newJson(resolve(directory, "receipt.json"), {
    workspace,
    generation,
    generationEnvironment,
    calculation,
  });
  checkDraft(directory, root);
  return {
    directory,
    workspace,
    calculation,
    generationEnvironment,
    next: "tidy draft physical/panel before --provenance",
  };
}
export function prepareProvenance(directory: string, root = process.cwd()) {
  const { receipt, physical, physicalBytes, panelBytes } = checkDraft(directory, root);
  const provenance: EvidenceProvenance = {
    version: EVIDENCE_VERSION,
    generationEnvironment: receipt.generationEnvironment,
    generation: {
      ...receipt.generation,
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
      v5PinsSha256: V5_PINS_SHA,
    },
    physicalEnumeration: {
      path: `${V6_ROOT}/independent-physical-cohorts.json`,
      cachePath: PHYSICAL_CACHE,
      sha256: sha256(physicalBytes),
      sources: physical.sources,
      sourceHash: physical.sourceHash,
    },
    panel: { path: `${V6_ROOT}/panel.json`, sha256: sha256(panelBytes) },
  };
  newJson(resolve(directory, "provenance.json"), provenance);
  return { next: "tidy draft provenance before --pins" };
}
export function preparePins(directory: string, root = process.cwd()) {
  checkDraft(directory, root);
  const bytes = readFileSync(resolve(directory, "provenance.json"));
  newJson(resolve(directory, "pins.json"), {
    version: EVIDENCE_VERSION,
    provenance: { path: `${V6_ROOT}/provenance.json`, sha256: sha256(bytes) },
  });
  return { next: "tidy draft pins before --verify; publication requires separate approval" };
}
function verifyProposedPublication(directory: string, root: string) {
  const checked = checkDraft(directory, root);
  const bytes = outputs.map((name) => ({ name, bytes: readFileSync(resolve(directory, name)) }));
  // Validate the complete proposed publication before exposing a commit-marker pin.
  // This verification workspace contains exact source/archive bytes, not live links.
  const verification = mkdtempSync(resolve(tmpdir(), "approved24-v6-verification-"));
  for (const path of EVIDENCE_FILES.filter(
    (path) => !outputs.some((name) => path === `${V6_ROOT}/${name}`),
  )) {
    const destination = resolve(verification, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(resolve(root, path), destination, constants.COPYFILE_EXCL);
  }
  for (const entry of bytes) {
    writeFileSync(resolve(verification, V6_ROOT, entry.name), entry.bytes, { flag: "wx" });
    assert.equal(
      existsSync(resolve(root, V6_ROOT, entry.name)),
      false,
      `Refusing to replace v6 ${entry.name}`,
    );
  }
  const evidence = readV6Evidence(verification);
  assert.deepEqual(
    evidence.provenance.generationEnvironment,
    checked.receipt.generationEnvironment,
  );
  assert.deepEqual(sourceIdentity(GENERATION_SOURCES, root), checked.receipt.generation);
  return { checked, bytes, verification, evidence };
}
export function verifyGeneration(directory: string, root = process.cwd()) {
  const { verification, evidence } = verifyProposedPublication(directory, root);
  return {
    directory,
    verification,
    status: "PROPOSED_NOT_PUBLISHED",
    physicalSha256: evidence.provenance.physicalEnumeration.sha256,
    panelSha256: evidence.provenance.panel.sha256,
  };
}
export function publishGeneration(directory: string, root = process.cwd()) {
  const { checked, bytes, verification } = verifyProposedPublication(directory, root);
  for (const entry of bytes) {
    const path = resolve(root, V6_ROOT, entry.name);
    writeFileSync(path, entry.bytes, { flag: "wx" });
    assert.deepEqual(readFileSync(path), entry.bytes, `Published byte drift: ${entry.name}`);
  }
  const evidence = readV6Evidence(root);
  assert.deepEqual(sourceIdentity(GENERATION_SOURCES, root), checked.receipt.generation);
  return {
    directory,
    verification,
    physicalSha256: evidence.provenance.physicalEnumeration.sha256,
    panelSha256: evidence.provenance.panel.sha256,
    independentWaiting: "UNVERIFIED_NOT_REGENERATED",
  };
}
