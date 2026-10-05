import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { freemem } from "node:os";
import type { CertifiedInput, CertifiedOutput } from "../src/certified/types.ts";
import { makeTriple, type QTriple, q } from "./certified-staging-oracle.ts";
import type { CertificateCheck } from "./certified-staging-oracle-certificates.ts";
import { independentPhysicalRecurringRates } from "./certified-staging-oracle-physical-supply.ts";
import {
  evidenceHash,
  RELAXATION_POPULATION,
} from "./certified-staging-oracle-relaxation-population.ts";
import {
  type WaitingProofCacheDocument,
  type WaitingProofEntry,
  type WaitingProofSource,
  waitingCacheBuilderSources,
  waitingProofMathSources,
  waitingProofSignature,
} from "./certified-staging-oracle-waiting-cache.ts";

type Row = {
  id: string;
  input: Omit<CertifiedInput, "snapshot">;
  output: CertifiedOutput;
  waitingCertificate: CertificateCheck;
  independentCurrent: { checked: boolean; pass: boolean };
  independentPricing: { status: string };
};
type Original = {
  sources: WaitingProofSource[];
  reports: { rows: Row[] }[];
  integrity: { engineProfileCodeHashes: string[]; snapshotHashes: string[] };
};
type Expanded = {
  sourcesCurrentAtEnd: boolean;
  engineProfileCodeHash: string;
  snapshotSha256: string;
  originalSourceClosureSha256: string;
  rows: { id: string; status: string; inputSha256: string; witnessSha256: string }[];
};
function load(record: WaitingProofSource): string {
  const bytes = readFileSync(record.path);
  if (evidenceHash(bytes) !== record.sha256)
    throw new Error("Frozen proof source drift: " + record.path);
  return bytes.toString("utf8");
}
function assertOriginal(original: Original): void {
  if (
    JSON.stringify(original.integrity.engineProfileCodeHashes) !==
    JSON.stringify([RELAXATION_POPULATION.profile])
  )
    throw new Error("Waiting cache historical profile drift");
  if (
    JSON.stringify(original.integrity.snapshotHashes) !==
    JSON.stringify([RELAXATION_POPULATION.snapshot])
  )
    throw new Error("Waiting cache historical snapshot drift");
  for (const source of waitingProofMathSources()) {
    if (source.path === "shared/game.ts") {
      if (source.sha256 !== "79a7563059171121b0331687fc2caab8563f03a6cb64060b475d1fe7d8a96850")
        throw new Error("Historical game/cache-key anchor drift");
    } else if (original.sources.find((old) => old.path === source.path)?.sha256 !== source.sha256)
      throw new Error("Waiting cache historical mathematical source mismatch: " + source.path);
  }
}
function fixedPrices(row: Row, rates: QTriple): QTriple {
  const basis = row.input.priceBasisStock ?? row.input.stock;
  if (row.input.cohortWeights !== undefined)
    throw new Error("Historical physical cache requires its original default equal cohort prior");
  return makeTriple((color) =>
    q(rates[color]!.d, BigInt(basis[color]!) * rates[color]!.d + rates[color]!.n),
  );
}
function entry(
  row: Row,
  check: CertificateCheck,
  sourceProof: WaitingProofSource,
  rates: QTriple,
): WaitingProofEntry {
  if (
    !row.independentCurrent.checked ||
    !row.independentCurrent.pass ||
    row.independentPricing.status !== "PASS"
  )
    throw new Error("Waiting reuse prerequisite current/pricing not independently verified");
  if (check.status !== "PASS" || row.output.waiting.status !== "certified")
    throw new Error("Waiting reuse prerequisite certificate was not verified");
  return {
    ...waitingProofSignature(
      row.input,
      row.output,
      fixedPrices(row, rates),
      RELAXATION_POPULATION.snapshot,
    ),
    originalId: row.id,
    check,
    sourceProof,
  };
}
function expandedEntries(original: Original, rows: Map<string, Row>, rates: QTriple) {
  const union = JSON.parse(load(RELAXATION_POPULATION.remaining)) as {
    proofFiles: WaitingProofSource[];
  };
  const entries: WaitingProofEntry[] = [];
  let attempted = 0;
  for (const source of union.proofFiles) {
    const report = JSON.parse(load(source)) as Expanded;
    if (
      !report.sourcesCurrentAtEnd ||
      report.engineProfileCodeHash !== RELAXATION_POPULATION.profile ||
      report.snapshotSha256 !== RELAXATION_POPULATION.snapshot ||
      report.originalSourceClosureSha256 !== evidenceHash(JSON.stringify(original.sources))
    )
      throw new Error("Expanded same-case proof identity mismatch");
    for (const proof of report.rows) {
      attempted++;
      const row = rows.get(proof.id);
      if (!row) throw new Error("Expanded proof outside original population");
      const signature = waitingProofSignature(
        row.input,
        row.output,
        fixedPrices(row, rates),
        RELAXATION_POPULATION.snapshot,
      );
      if (
        signature.inputSha256 !== proof.inputSha256 ||
        signature.witnessSha256 !== proof.witnessSha256
      )
        throw new Error("Expanded full input/witness same-case join mismatch: " + proof.id);
      if (proof.status !== "PASS") continue;
      entries.push(
        entry(
          row,
          {
            status: "PASS",
            reason: "independent_exact_finite_endpoints_and_strict_lex_improvement",
            finiteBeforeParity: true,
            finiteAfterParity: true,
            probabilityIntervalValidity: "PASS",
            receiptCount: row.output.waiting.strictBoundaryWitness!.receipts.length,
          },
          source,
          rates,
        ),
      );
    }
  }
  if (attempted !== 294 || entries.length !== 210)
    throw new Error("Expanded immutable proof coverage drift");
  return { entries, sources: union.proofFiles };
}
function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}
function main(): void {
  const minimumFreeHostBytes = 896 * 1024 * 1024 + 1024 * 1024 * 1024;
  if (freemem() < minimumFreeHostBytes)
    throw new Error("Waiting cache preparation host memory admission NOTRUN");
  const before = waitingProofMathSources();
  const builderBefore = waitingCacheBuilderSources();
  const original = JSON.parse(load(RELAXATION_POPULATION.original)) as Original;
  assertOriginal(original);
  const rows = original.reports.flatMap((report) => report.rows);
  if (rows.length !== 2000 || new Set(rows.map((row) => row.id)).size !== 2000)
    throw new Error("Waiting cache original population is not exactly2000");
  const rates = independentPhysicalRecurringRates();
  const defaults = rows
    .filter((row) => row.waitingCertificate.status === "PASS")
    .map((row) => entry(row, row.waitingCertificate, RELAXATION_POPULATION.original, rates));
  const expanded = expandedEntries(original, new Map(rows.map((row) => [row.id, row])), rates);
  const entries = [...defaults, ...expanded.entries];
  if (
    defaults.length !== 1706 ||
    entries.length !== 1916 ||
    new Set(entries.map((item) => item.key)).size !== 1916
  )
    throw new Error("Waiting cache independently verified unique proof count drift");
  const after = waitingProofMathSources();
  const document: WaitingProofCacheDocument = {
    version: "independent_waiting_exact_signature_cache_v1",
    oldProductProfile: RELAXATION_POPULATION.profile,
    snapshotSha256: RELAXATION_POPULATION.snapshot,
    mathSources: before,
    cacheBuilderSources: builderBefore,
    sourceReports: [
      RELAXATION_POPULATION.original,
      RELAXATION_POPULATION.remaining,
      ...expanded.sources,
    ],
    entries,
    sourcesCurrentAtEnd:
      JSON.stringify(before) === JSON.stringify(after) &&
      JSON.stringify(builderBefore) === JSON.stringify(waitingCacheBuilderSources()),
  };
  const output = argument(
    "--out",
    "benchmarks/results/certified-staging-validation-waiting-proof-cache-" + Date.now() + ".json",
  );
  if (existsSync(output)) throw new Error("Immutable waiting cache already exists");
  const bytes =
    JSON.stringify(
      {
        ...document,
        generatedAt: new Date().toISOString(),
        signatureContract:
          "SHA256 recursively key-sorted canonical JSON of full original input, snapshot, exact fixed prices, entire current value, entire waiting envelope including all witness fields; no product-code hash in mathematical key, old-to-new lineage explicit in consumer report",
        preparation: {
          processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
          minimumFreeHostBytes,
          oracleEvaluations: 0,
        },
        historicalGameSourceGap:
          "The original manual actual-run source list omitted transitive shared/game.ts. Its unchanged SHA256 is anchored by the preserved original current-oracle cache key/manifest; this does not retroactively claim an original explicit start/end game check.",
      },
      null,
      2,
    ) + "\n";
  if (!document.sourcesCurrentAtEnd || process.resourceUsage().maxRSS * 1024 > 896 * 1024 * 1024)
    throw new Error("Waiting cache preparation source/resource guard NOTRUN");
  writeFileSync(output, bytes);
  console.log(
    JSON.stringify({
      path: output,
      sha256: evidenceHash(bytes),
      defaults: defaults.length,
      expanded: expanded.entries.length,
      total: entries.length,
      sourcesCurrentAtEnd: document.sourcesCurrentAtEnd,
    }),
  );
}
main();
