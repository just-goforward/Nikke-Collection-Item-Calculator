import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CertifiedInput, CertifiedOutput } from "../src/certified/types.ts";
import { cmp, fromWire, type QTriple, wire } from "./certified-staging-oracle.ts";
import type { CertificateCheck } from "./certified-staging-oracle-certificates.ts";

export type WaitingProofSource = { path: string; sha256: string };
export type WaitingProofEntry = {
  key: string;
  originalId: string;
  inputSha256: string;
  witnessSha256: string;
  currentValueSha256: string;
  waitingSha256: string;
  pricesSha256: string;
  check: CertificateCheck;
  sourceProof: WaitingProofSource;
};
export type WaitingProofCacheDocument = {
  version: "independent_waiting_exact_signature_cache_v1";
  oldProductProfile: string;
  snapshotSha256: string;
  mathSources: WaitingProofSource[];
  cacheBuilderSources: WaitingProofSource[];
  sourceReports: WaitingProofSource[];
  entries: WaitingProofEntry[];
  sourcesCurrentAtEnd: boolean;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
    return `{${members.join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Unsupported proof signature value");
  return result;
}
function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function waitingProofSignature(
  input: Omit<CertifiedInput, "snapshot">,
  output: CertifiedOutput,
  prices: QTriple,
  snapshotSha256: string,
) {
  const signature = {
    input,
    snapshotSha256,
    fixedPrices: prices.map(wire),
    currentValue: output.current?.value ?? null,
    waiting: output.waiting,
  };
  return {
    key: digest(canonical(signature)),
    inputSha256: digest(JSON.stringify(input)),
    witnessSha256: digest(JSON.stringify(output.waiting.strictBoundaryWitness ?? null)),
    currentValueSha256: digest(canonical(signature.currentValue)),
    waitingSha256: digest(canonical(signature.waiting)),
    pricesSha256: digest(canonical(signature.fixedPrices)),
  };
}
export function waitingProofMathSources(): WaitingProofSource[] {
  return [
    "scripts/certified-staging-oracle.ts",
    "scripts/certified-staging-oracle-tuples.ts",
    "scripts/certified-staging-oracle-certificates.ts",
    "scripts/certified-staging-oracle-endpoints-integer.ts",
    "scripts/certified-staging-oracle-witness.ts",
    "scripts/certified-staging-oracle-physical-supply.ts",
    "shared/game.ts",
  ].map((path) => ({ path, sha256: digest(readFileSync(path)) }));
}
export function waitingCacheBuilderSources(): WaitingProofSource[] {
  return [
    "scripts/certified-staging-oracle-waiting-cache.ts",
    "scripts/validate-certified-staging-waiting-cache.ts",
    "scripts/certified-staging-oracle-relaxation-population.ts",
  ].map((path) => ({ path, sha256: digest(readFileSync(path)) }));
}
export type LoadedWaitingProofCache = {
  provenance: {
    cache: WaitingProofSource;
    oldProductProfile: string;
    snapshotSha256: string;
    entries: number;
    mathSources: WaitingProofSource[];
    meaning: string;
  };
  find: (
    input: CertifiedInput,
    output: CertifiedOutput,
    prices: QTriple,
    snapshotSha256: string,
    currentVerified: boolean,
  ) => WaitingProofEntry | null;
};
// Preserve cmp's identity and right-coordinate native read, including a fourth
// pricing callback whose matching fixed-price coordinate is absent.
const compareVerifiedPrice = cmp as {
  (left: ReturnType<typeof fromWire>, right: undefined): never;
  (left: ReturnType<typeof fromWire>, right: ReturnType<typeof fromWire>): ReturnType<typeof cmp>;
  (
    left: ReturnType<typeof fromWire>,
    right: ReturnType<typeof fromWire> | undefined,
  ): ReturnType<typeof cmp>;
};
function verifiedPrices(output: CertifiedOutput, prices: QTriple): boolean {
  const pricing = output.pricing;
  if (pricing === null) return false;
  return pricing.weights.every(
    (price, color) => compareVerifiedPrice(fromWire(price), prices[color]) === 0,
  );
}
export function loadWaitingProofCache(path: string, sha256: string): LoadedWaitingProofCache {
  const bytes = readFileSync(path);
  if (digest(bytes) !== sha256) throw new Error("Independent waiting cache hash mismatch");
  const document = JSON.parse(bytes.toString("utf8")) as WaitingProofCacheDocument;
  if (document.version !== "independent_waiting_exact_signature_cache_v1")
    throw new Error("Unsupported waiting cache contract");
  if (!document.sourcesCurrentAtEnd) throw new Error("Waiting cache source closure was unstable");
  if (JSON.stringify(document.mathSources) !== JSON.stringify(waitingProofMathSources()))
    throw new Error("Independent waiting cache mathematics source mismatch");
  if (JSON.stringify(document.cacheBuilderSources) !== JSON.stringify(waitingCacheBuilderSources()))
    throw new Error("Independent waiting cache signature/builder source mismatch");
  const entries = new Map(document.entries.map((entry) => [entry.key, entry]));
  if (
    entries.size !== document.entries.length ||
    document.entries.some((entry) => entry.check.status !== "PASS")
  )
    throw new Error("Waiting cache contains a duplicate or unverified proof");
  return {
    provenance: {
      cache: { path, sha256 },
      oldProductProfile: document.oldProductProfile,
      snapshotSha256: document.snapshotSha256,
      entries: entries.size,
      mathSources: document.mathSources,
      meaning:
        "Previously independently verified exact certificate, joined by full input, snapshot, fixed prices, current exact value and entire waiting envelope. Fresh product API still executes; no fresh independent DP evaluation is claimed on a hit.",
    },
    find(input, output, prices, snapshotSha256, currentVerified) {
      if (!currentVerified || !verifiedPrices(output, prices)) return null;
      if (snapshotSha256 !== document.snapshotSha256) return null;
      const { snapshot: _snapshot, ...fullInput } = input;
      return (
        entries.get(waitingProofSignature(fullInput, output, prices, snapshotSha256).key) ?? null
      );
    },
  };
}
