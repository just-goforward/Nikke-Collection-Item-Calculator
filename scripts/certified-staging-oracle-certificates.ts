import type { CertifiedInput, CertifiedOutput, CertifiedValue } from "../src/certified/types.ts";
import {
  cmp,
  compareValue,
  fromWire,
  type OracleValue,
  type QTriple,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";
import { independentFiniteWitnessInteger } from "./certified-staging-oracle-endpoints-integer.ts";
import { mapTriple } from "./certified-staging-oracle-tuples.ts";
import {
  coversWorstCoordinate,
  createIndependentUnlimited,
  independentBoxMass,
  independentDispatchZeroMass,
} from "./certified-staging-oracle-witness.ts";

export type CertificateCheck = {
  status: "PASS" | "FAIL" | "NOTRUN";
  reason: string;
  receiptCount?: number;
  endpointMemoEntries?: number;
  finiteBeforeParity?: boolean;
  finiteAfterParity?: boolean;
  probabilityIntervalValidity?: "PASS" | "NOTRUN";
};
type Witness = NonNullable<CertifiedOutput["waiting"]["strictBoundaryWitness"]>;
type Receipt = Witness["receipts"][number];
const massCache = new Map<string, ReturnType<typeof q>>();
// cmp reads the right coordinate's denominator first; undefined must keep that
// exact native property-read failure after decoding the left coordinate.
const compareConsumed = cmp as {
  (left: ReturnType<typeof q>, right: undefined): never;
  (left: ReturnType<typeof q>, right: ReturnType<typeof q>): ReturnType<typeof cmp>;
  (left: ReturnType<typeof q>, right: ReturnType<typeof q> | undefined): ReturnType<typeof cmp>;
};
function exactOutputValue(value: CertifiedValue): OracleValue {
  return {
    P: fromWire(value.successP),
    B: fromWire(value.weightedExpectedConsumptionB),
    C: fromWire(value.expectedTotalConsumptionC),
  };
}
function identical(
  actual: CertifiedValue,
  independent: OracleValue & { consumed: QTriple },
): boolean {
  return (
    compareValue(exactOutputValue(actual), independent) === 0 &&
    actual.expectedConsumed.every(
      (value, color) => compareConsumed(fromWire(value), independent.consumed[color]) === 0,
    )
  );
}
function physicalMass(input: CertifiedInput, receipt: Receipt) {
  const event = input.snapshot.events.find((entry) => entry.id === receipt.eventId);
  const ref = event?.refs[receipt.refIndex];
  if (!ref) throw new Error("witness_event_or_ref_missing");
  const descriptor = input.snapshot.laws?.find((entry) => entry.id === ref.lawId);
  if (descriptor?.kind === "finite")
    throw new Error("independent_law_not_supported:finite_override");
  const key = `${ref.lawId}:${ref.count}:${receipt.pieces.join(",")}`;
  const cached = massCache.get(key);
  if (cached) return cached;
  let mass: ReturnType<typeof q>;
  if (ref.lawId === "dispatch-board-v1" && ref.count === 1)
    mass = independentDispatchZeroMass(receipt.pieces);
  else if (ref.lawId === "regular-box-v1" || ref.lawId === "box-ii-v1")
    mass = independentBoxMass(ref.lawId, ref.count, receipt.pieces);
  else throw new Error(`independent_law_not_supported:${ref.lawId}`);
  massCache.set(key, mass);
  return mass;
}
function dateOffset(current: string, date: string): number {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${current}T00:00:00Z`)) / 86400000,
  );
}
function futureRefs(input: CertifiedInput) {
  const received = new Set(input.receivedEventIds);
  return input.snapshot.events
    .filter((event) => {
      const offset = dateOffset(input.snapshot.coverage.currentDay, event.gameDate);
      const laterToday = offset === 0 && Date.parse(event.at) > Date.parse(input.asOf);
      return !received.has(event.id) && (offset > 0 || laterToday) && offset <= 56;
    })
    .flatMap((event) => event.refs.map((_ref, index) => ({ event, index })));
}
function reconstruct(input: CertifiedInput, witness: Witness): CertificateCheck {
  if (witness.cohort !== 0)
    return { status: "NOTRUN", reason: "independent_refresh_cohort_PMF_not_implemented" };
  const prior = input.cohortWeights ? fromWire(input.cohortWeights[0]) : q(1, 3);
  if (cmp(prior, q(0)) <= 0) return { status: "FAIL", reason: "witness_zero_cohort_prior" };
  const receipts = new Map(
    witness.receipts.map((receipt) => [`${receipt.eventId}:${receipt.refIndex}`, receipt]),
  );
  if (receipts.size !== witness.receipts.length)
    return { status: "FAIL", reason: "duplicate_witness_receipt" };
  let before: Triple = input.stock;
  let after: Triple = input.stock;
  let count = 0;
  for (const { event, index } of futureRefs(input)) {
    const receipt = receipts.get(`${event.id}:${index}`);
    if (!receipt) return { status: "FAIL", reason: "missing_modeled_future_receipt" };
    const mass = physicalMass(input, receipt);
    if (cmp(mass, q(0)) <= 0 || cmp(mass, fromWire(receipt.mass)) !== 0)
      return { status: "FAIL", reason: "witness_mass_not_independently_matched" };
    after = mapTriple(after, (pieces, color) => pieces + receipt.pieces[color]);
    if (dateOffset(input.snapshot.coverage.currentDay, event.gameDate) <= 55)
      before = mapTriple(before, (pieces, color) => pieces + receipt.pieces[color]);
    count++;
  }
  const stocksMatch =
    before.every((pieces, color) => pieces === witness.beforeStock[color]) &&
    after.every((pieces, color) => pieces === witness.afterStock[color]);
  if (!stocksMatch || count !== witness.receipts.length)
    return { status: "FAIL", reason: "witness_stock_or_complete_receipt_set_mismatch" };
  return {
    status: "PASS",
    reason: "all_positive_independent_cohort0_physical_masses_and_stocks",
    receiptCount: count,
  };
}
function N0(
  input: CertifiedInput,
  output: CertifiedOutput,
  prices: QTriple,
  currentVerified: boolean,
): CertificateCheck {
  const unlimited = createIndependentUnlimited(prices).solve(input);
  const feasible = input.stock.every((pieces, color) =>
    coversWorstCoordinate(pieces, unlimited.worst[color]),
  );
  if (!currentVerified && !feasible)
    return { status: "NOTRUN", reason: "N0_current_exact_parity_not_established" };
  if (
    !output.current ||
    compareValue(exactOutputValue(output.current.value), { ...unlimited, P: q(1) }) !== 0
  )
    return { status: "FAIL", reason: "N0_does_not_equal_independent_unlimited_PBC" };
  return N0Envelope(output);
}
function N0Envelope(output: CertifiedOutput): CertificateCheck {
  const waiting = output.waiting;
  const interval = waiting.successProbabilityInterval;
  if (
    !waiting.value ||
    !output.current ||
    waiting.rangeBoundary ||
    waiting.bestDayRange?.[0] !== 0 ||
    waiting.bestDayRange[1] !== 0
  )
    return { status: "FAIL", reason: "N0_exact_value_or_recommendation_range_missing" };
  if (
    !identical(waiting.value, {
      ...exactOutputValue(output.current.value),
      consumed: mapTriple(output.current.value.expectedConsumed, fromWire),
    })
  )
    return {
      status: "FAIL",
      reason: "N0_reported_value_differs_from_independently_verified_current",
    };
  if (
    !interval ||
    !waiting.successImprovementUpperBound ||
    cmp(fromWire(interval.lower), q(1)) ||
    cmp(fromWire(interval.upper), q(1)) ||
    cmp(fromWire(waiting.successImprovementUpperBound), q(0))
  )
    return { status: "FAIL", reason: "N0_reported_probability_interval_or_gap_not_exact_P1" };
  return {
    status: "PASS",
    reason: "independently_exact_current_equals_unrestricted_optimum",
    probabilityIntervalValidity: "PASS",
  };
}
function endpoints(input: CertifiedInput, witness: Witness, prices: QTriple): CertificateCheck {
  const budget = { maxMemoEntries: 10000, deadlineAt: performance.now() + 5000 };
  const before = independentFiniteWitnessInteger(
    { ...input, stock: witness.beforeStock, prices },
    budget,
  );
  const after = independentFiniteWitnessInteger(
    { ...input, stock: witness.afterStock, prices },
    budget,
  );
  const finiteBeforeParity = identical(witness.beforeValue, before);
  const finiteAfterParity = identical(witness.afterValue, after);
  if (!finiteBeforeParity || !finiteAfterParity || compareValue(after, before) <= 0)
    return {
      status: "FAIL",
      reason: "witness_endpoint_exact_PBC_vector_or_strictness_mismatch",
      finiteBeforeParity,
      finiteAfterParity,
    };
  return {
    status: "PASS",
    reason: "independent_exact_finite_endpoints_and_strict_lex_improvement",
    endpointMemoEntries: before.nodes + after.nodes,
    finiteBeforeParity,
    finiteAfterParity,
  };
}
function boundaryEnvelope(output: CertifiedOutput): CertificateCheck | null {
  const waiting = output.waiting;
  const interval = waiting.successProbabilityInterval;
  const current = output.current;
  const range = waiting.bestDayRange;
  if (!waiting.rangeBoundary || range?.[0] !== 56 || range[1] !== 56 || waiting.value !== null)
    return { status: "FAIL", reason: "boundary_range_or_unknown_expected_value_misreported" };
  if (!current || !interval || !waiting.successImprovementUpperBound)
    return { status: "FAIL", reason: "boundary_probability_coupling_fields_missing" };
  const P = fromWire(current.value.successP);
  const gap = q(P.d - P.n, P.d);
  if (
    cmp(fromWire(interval.lower), P) ||
    cmp(fromWire(interval.upper), q(1)) ||
    cmp(fromWire(waiting.successImprovementUpperBound), gap)
  )
    return { status: "FAIL", reason: "boundary_probability_interval_or_gap_not_current_coupling" };
  return null;
}
export function verifyActualWaiting(
  input: CertifiedInput,
  output: CertifiedOutput,
  prices: QTriple,
  currentVerified: boolean,
): CertificateCheck {
  if (output.waiting.status !== "certified")
    return { status: "NOTRUN", reason: `API_waiting_not_certified:${output.waiting.status}` };
  if (output.waiting.recommendedDays === 0) return N0(input, output, prices, currentVerified);
  if (
    !input.snapshot.coverage.future.complete ||
    input.snapshot.futureLawSemantics !== "independent_given_cohort-v1"
  )
    return {
      status: "FAIL",
      reason: "waiting_certificate_missing_declared_complete_independent_model",
    };
  if (output.waiting.recommendedDays !== 56 || !output.waiting.strictBoundaryWitness)
    return {
      status: "NOTRUN",
      reason: "independent_full_expectation_for_interior_day_not_computed",
    };
  try {
    const envelope = boundaryEnvelope(output);
    if (envelope) return envelope;
    const path = reconstruct(input, output.waiting.strictBoundaryWitness);
    if (path.status !== "PASS") return path;
    const proof = endpoints(input, output.waiting.strictBoundaryWitness, prices);
    return {
      ...proof,
      ...(path.receiptCount === undefined ? {} : { receiptCount: path.receiptCount }),
      probabilityIntervalValidity: currentVerified ? "PASS" : "NOTRUN",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const unsupported =
      reason.startsWith("independent_endpoint_") ||
      reason.startsWith("independent_law_not_supported:");
    return { status: unsupported ? "NOTRUN" : "FAIL", reason };
  }
}
