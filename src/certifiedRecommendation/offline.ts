import { createHash } from "node:crypto";
import { cmp, fromWire, ONE, type Q, ZERO } from "../../shared/certifiedRational";
import {
  type ExactProbabilityRecord,
  type RecommendationContext,
  type RecommendationEvidence,
  RecommendationEvidenceError,
  type RecommendationEvidenceErrorCode,
} from "./evidence";
import { type RecommendationResult, selectRecommendation } from "./policy";

export interface OfflineCaptureBytes {
  readonly raw: Uint8Array;
  readonly request: Uint8Array;
  readonly receipt: Uint8Array;
}

/**
 * Independent trusted pins for the three saved files, NOT hashes read from raw.
 * The owner must authenticate the capture's origin before supplying these pins.
 * Hash equality establishes byte identity, not the producer's mathematics.
 */
export interface TrustedOfflineCapture {
  readonly rawSha256: string;
  readonly requestSha256: string;
  readonly receiptSha256: string;
}

export interface OfflineRecommendation {
  readonly context: RecommendationContext;
  readonly evidence: RecommendationEvidence;
  readonly recommendation: RecommendationResult;
}

function requireThat(
  condition: unknown,
  message: string,
  code: RecommendationEvidenceErrorCode = "corrupt_evidence",
): asserts condition {
  if (!condition) throw new RecommendationEvidenceError(code, message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  requireThat(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  requireThat(typeof value === "string" && value.trim().length > 0, `${label} must be a nonempty string.`);
  return value;
}

// The saved harness's cases.mjs canonicalBytes convention: recursively sort
// object keys; preserve arrays and JSON primitive representations.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, canonical(row[key])]));
  }
  requireThat(typeof value !== "number" || Number.isFinite(value), "Nonfinite JSON number.");
  return value;
}

function encoded(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function same(actual: unknown, expected: unknown, label: string): void {
  requireThat(encoded(actual) === encoded(expected), `${label} does not match.`, "binding_mismatch");
}

function pinnedJson(bytes: Uint8Array, expectedHash: string, label: string): Record<string, unknown> {
  requireThat(bytes instanceof Uint8Array, `${label} bytes are required.`, "invalid_input");
  requireThat(typeof expectedHash === "string" && /^[0-9a-f]{64}$/.test(expectedHash),
    `${label} needs an independent lowercase SHA-256 pin.`, "invalid_input");
  requireThat(hash(bytes) === expectedHash, `${label} source hash mismatch.`, "binding_mismatch");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new RecommendationEvidenceError("corrupt_evidence", `${label} is not valid UTF-8 JSON.`, { cause });
  }
  return object(value, label);
}

function probability(value: unknown): Q {
  const wire = object(value, "Wire probability");
  const numerator = wire["numerator"];
  const denominator = wire["denominator"];
  requireThat(typeof numerator === "string" && /^-?\d+$/.test(numerator) &&
    typeof denominator === "string" && /^\d+$/.test(denominator) && BigInt(denominator) > 0n,
    "Probability requires integer strings and a positive denominator.");
  const p = fromWire({ numerator, denominator });
  requireThat(cmp(p, ZERO) >= 0 && cmp(p, ONE) <= 0, "Probability is outside [0, 1].");
  return Object.freeze(p);
}

function successP(value: unknown): Q {
  return probability(object(value, "Exact value")["successP"]);
}

function day(value: unknown): number {
  requireThat(typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 14,
    "Completed day must be an integer in 0..14.");
  return value;
}

function equalProbability(actual: Q, expected: Q, label: string): void {
  requireThat(cmp(actual, expected) === 0, `${label} contradicts another exact probability.`);
}

/**
 * Node-side, synchronous byte admission and selection only. No filesystem,
 * solver, network, worker, cache, CLI, or import-time execution.
 */
export function selectOfflineRecommendation(
  bytes: OfflineCaptureBytes,
  trusted: TrustedOfflineCapture,
): OfflineRecommendation {
  requireThat(bytes && trusted, "Capture bytes and independent pins are required.", "invalid_input");
  const raw = pinnedJson(bytes.raw, trusted.rawSha256, "raw.json");
  const reference = pinnedJson(bytes.request, trusted.requestSha256, "request.json");
  const receipt = pinnedJson(bytes.receipt, trusted.receiptSha256, "receipt.json");
  requireThat(raw["schema"] === "target-v1-raw-v2", "Unsupported raw capture schema.");

  const request = object(reference["request"], "Trusted request");
  const input = object(request["input"], "Trusted input");
  const snapshot = object(input["snapshot"], "Trusted snapshot");
  const spec = object(receipt["spec"], "Receipt spec");
  const identity = object(receipt["identity"], "Trusted producer identity");
  const requestHash = hash(encoded(request));
  const inputHash = hash(encoded(input));
  same(raw["request"], request, "Raw request");
  same(receipt["request"], request, "Receipt request");
  for (const owner of [raw, reference, spec]) same(owner["requestHash"], requestHash, "Request hash");
  same(spec["inputHash"], inputHash, "Input hash");
  same(raw["receiptHash"], trusted.receiptSha256, "Receipt bytes");
  const caseId = text(request["caseId"], "Request caseId");
  same(raw["caseId"], caseId, "Raw caseId");
  same(spec["id"], caseId, "Receipt caseId");
  same(spec["target"], input["target"] ?? null, "Receipt Target request");
  same(raw["identity"], identity, "Raw producer identity");
  same(reference["identity"], identity, "Request producer identity");
  text(identity["baseline"], "Producer baseline");
  for (const key of ["wasmHash", "sourceHash", "codeHash"]) {
    requireThat(typeof identity[key] === "string" && /^[0-9a-f]{64}$/.test(identity[key] as string),
      `Producer ${key} is missing or malformed.`);
  }
  same(object(identity["wasm"], "WASM identity")["sha256"], identity["wasmHash"], "WASM identity hash");
  same(raw["actualWasmHash"], identity["wasmHash"], "Raw actual WASM hash");
  same(reference["actualWasmHash"], identity["wasmHash"], "Request actual WASM hash");
  requireThat(raw["phase"] === "returned" && raw["preparationFailure"] === null &&
    raw["solverFailure"] === null && raw["solverInvocations"] === 1, "Capture contains an execution failure.");
  const observation = object(raw["observation"], "Capture observation");
  requireThat(Array.isArray(observation["failures"]) && observation["failures"].length === 0,
    "Capture contains an observer failure.");

  const response = object(raw["response"], "Response");
  const provenance = object(response["provenance"], "Response provenance");
  same(provenance["snapshotRevision"], snapshot["revision"], "Snapshot revision");
  same(provenance["snapshotSourceHash"], snapshot["sourceHash"], "Snapshot source hash");
  requireThat(provenance["solverVersion"] === "certified-exact-rust-wasm-v1" &&
    provenance["arithmetic"] === "exact_bigint_ladder_reduced_public_rationals",
    "Unsupported producer probability semantics.");
  const waiting = object(response["waiting"], "Waiting response");
  same(waiting["horizonDays"], 14, "Waiting horizon");
  const current = object(response["current"], "Current response");
  requireThat(current["certification"] === "exact_rational_finite_inventory_v1",
    "Current value is not an exact completed expectation.");
  const currentP = successP(current["value"]);
  const context: RecommendationContext = Object.freeze({
    requestId: requestHash,
    inputFingerprint: inputHash,
    // Include weights as well as the complete snapshot (laws/publication/model).
    modelFingerprint: hash(encoded({ snapshot, cohortWeights: input["cohortWeights"] })),
    // Conservative whole-input binding also covers claims, stock and price basis.
    stateFingerprint: inputHash,
    asOf: text(input["asOf"], "Request asOf"),
    horizonDays: 14,
    engineFingerprint: hash(encoded(identity)),
  });

  const probabilities: ExactProbabilityRecord[] = [];
  const byDay = new Map<number, Q>();
  // Only this actual captured array supplies date records. Current, Target,
  // evaluatedDays, F's selected value and boundary witnesses never fill gaps.
  if (raw["capture"] !== null && raw["capture"] !== undefined) {
    const capture = object(raw["capture"], "Decoded capture");
    requireThat(capture["schema"] === "target-v1-decoded-capture-v1" &&
      capture["source"] === "WasmKernel.waiting.completedDates", "Unsupported completed-record source.");
    const kind = capture["kind"];
    requireThat(kind === "emitted" || kind === "not-requested" || kind === "waiting-disabled",
      "Unknown capture kind.");
    const expectedKind = input["computeWaiting"] === false ? "waiting-disabled" :
      input["target"] ? "emitted" : "not-requested";
    same(kind, expectedKind, "Capture request mode");
    equalProbability(successP(capture["canonicalCurrent"]), currentP, "Captured Current");
    const records = capture["records"];
    const recordCount = capture["recordCount"];
    requireThat(recordCount === undefined || (typeof recordCount === "number" &&
      Number.isInteger(recordCount) && recordCount >= 0 && recordCount <= 15),
      "Invalid completed-record count.");
    if (records === null || records === undefined) {
      requireThat(recordCount === undefined || recordCount === 0,
        "Missing completed records contradict a positive record count.");
    }
    if (records !== null && records !== undefined) {
      requireThat(Array.isArray(records) && records.length <= 15, "Invalid completed-record array.");
      requireThat(recordCount === records.length, "Completed-record count mismatch.");
      requireThat(kind === "emitted" || records.length === 0, "Records contradict capture kind.");
      for (const item of records) {
        const row = object(item, "Completed record");
        requireThat(Object.keys(row).sort().join(",") === "day,value", "Unexpected completed-record fields.");
        const d = day(row["day"]);
        requireThat(!byDay.has(d), "Duplicate completed date.");
        const p = successP(row["value"]);
        if (d === 0) equalProbability(p, currentP, "D0");
        byDay.set(d, p);
        probabilities.push(Object.freeze({ context, day: d, probability: p }));
      }
    }
  }

  // Cross-check overlapping exact projections without treating them as records
  // or requiring a missing capture to be reconstructed from those projections.
  const consistency = new Map(byDay);
  consistency.set(0, currentP);
  if (response["target"] !== undefined) {
    const target = object(response["target"], "Target response");
    const targetRequest = object(input["target"], "Target request");
    for (const key of ["version", "maxDays"]) same(target[key], targetRequest[key], `Target ${key}`);
    equalProbability(probability(target["alpha"]), probability(targetRequest["alpha"]), "Target alpha");
    const projected = target["probabilities"];
    requireThat(Array.isArray(projected) && projected.length <= 15, "Invalid Target probabilities.");
    const seen = new Set<number>();
    for (const item of projected) {
      const row = object(item, "Target probability");
      const d = day(row["day"]);
      requireThat(!seen.has(d), "Duplicate Target date.");
      seen.add(d);
      const p = probability(row["successP"]);
      const known = consistency.get(d);
      if (known !== undefined) equalProbability(p, known, "Target probability");
      consistency.set(d, p);
    }
  }
  if (waiting["value"] !== null && waiting["value"] !== undefined) {
    const p = successP(waiting["value"]);
    const d = day(waiting["recommendedDays"]);
    const known = consistency.get(d);
    if (known !== undefined) equalProbability(p, known, "F selected probability");
  }
  const evidence: RecommendationEvidence = Object.freeze({ probabilities: Object.freeze(probabilities) });
  return { context, evidence, recommendation: selectRecommendation(context, evidence) };
}
