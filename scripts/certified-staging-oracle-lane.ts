import { AssertionError } from "node:assert";
import { dateStart, ruleAt } from "../shared/certifiedSupplyModel.ts";
import { gameDayKey } from "../shared/supplyForecastModel.ts";
import type {
  CertifiedCurrent,
  CertifiedInput,
  CertifiedOutput,
  CertifiedValue,
  CertifiedWaiting,
} from "../src/certified/types.ts";
import {
  frozenIndependentCohorts,
  independentApprovedPricing,
} from "./certified-staging-approved-panel.ts";
import {
  add,
  canonicalState,
  cmp,
  compareValue,
  type ExactQ,
  fromWire,
  independentFailure,
  independentProbability,
  ONE,
  type OracleAction,
  type OracleInput,
  type OracleResult,
  type QTriple,
  q,
  type Triple,
} from "./certified-staging-oracle.ts";
import {
  type CertificateCheck,
  verifyActualWaiting,
} from "./certified-staging-oracle-certificates.ts";
import { independentCurrentCoverage } from "./certified-staging-oracle-current-coverage.ts";
import { solveIntegerOracle } from "./certified-staging-oracle-integer.ts";
import { independentLargeCappedOracle } from "./certified-staging-oracle-large-capped.ts";
import { independentLargeIntegerOracle } from "./certified-staging-oracle-large-integer.ts";
import { independentLayeredOracle } from "./certified-staging-oracle-layered.ts";
import { mapTriple } from "./certified-staging-oracle-tuples.ts";
import { createIndependentUnlimited } from "./certified-staging-oracle-witness.ts";

/** Certified solver validation lane. Expected values come only from public rules,
 * authenticated tracked evidence and independent oracles; candidate output is
 * compared, never trusted. No cache, report or other file is written: the
 * <=30-use DP runs in memory instead of through cachedOriginalOracle, and
 * prices come from tracked evidence instead of the physical rates cache. */

export type LaneStatus = CertificateCheck["status"];
export type LaneCheck = { status: LaneStatus; reason: string };
const pass = (reason: string): LaneCheck => ({ status: "PASS", reason });
const fail = (reason: string): LaneCheck => ({ status: "FAIL", reason });
const notrun = (reason: string): LaneCheck => ({ status: "NOTRUN", reason });

const KITS = ["blue", "purple", "yellow"] as const;
const DEFAULT_PRIORS: QTriple = [q(1, 3), q(1, 3), q(1, 3)];
// independentApprovedPricing models exactly these solo-day laws.
const PRICED_SOLO_LAWS = new Set(["regular-box-v1", "box-ii-v1"]);
type StateInput = Pick<CertifiedInput, "grade" | "level" | "exp" | "stock">;
type Evaluator = (input: OracleInput) => OracleResult;
// Memo/live-state limits are the existing documented test contract of these
// oracles (nonnull-core, large-integer and nonnull-layered specs). Their 150-use,
// numeric-key and 15,000,000 state-box guards remain inside each oracle.
const EXPANDED: readonly (readonly [string, Evaluator])[] = [
  [
    "independent_large_integer_uncapped_le150_memo50000",
    (input) => independentLargeIntegerOracle(input, { maxMemoEntries: 50_000, check() {} }),
  ],
  [
    "independent_large_public_caps_le150_memo50000",
    (input) => independentLargeCappedOracle(input, { maxMemoEntries: 50_000, check() {} }),
  ],
  [
    "independent_layered_uncapped_le150_live50000",
    (input) => independentLayeredOracle(input, { maxMemoEntries: 50_000, check() {} }),
  ],
];
const ADMISSION = /^(large_oracle|independent_public_cap|independent_layered)_\w*admission/;

// Runtime WireQ format of shared/certifiedRational.ts fromWire, with a nonzero
// denominator. Malformed candidate values are mismatches, never parse errors.
const WIRE_NUMERATOR = /^-?\d+$/;
const WIRE_DENOMINATOR = /^\d*[1-9]\d*$/;
function exactWire(value: unknown): ExactQ | null {
  if (typeof value !== "object" || value === null) return null;
  const { numerator, denominator } = value as Record<string, unknown>;
  if (
    typeof numerator !== "string" ||
    typeof denominator !== "string" ||
    !WIRE_NUMERATOR.test(numerator) ||
    !WIRE_DENOMINATOR.test(denominator)
  )
    return null;
  return fromWire({ numerator, denominator });
}
function exactTriple(value: unknown): QTriple | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [first, second, third] = value.map(exactWire);
  return first && second && third ? [first, second, third] : null;
}
function sameTriple(actual: unknown, expected: QTriple): boolean {
  const parsed = exactTriple(actual);
  if (!parsed) return false;
  return mapTriple(parsed, (value, color) => cmp(value, expected[color])).every(
    (comparison) => comparison === 0,
  );
}
function sameValue(actual: unknown, expected: ExactQ): boolean {
  const parsed = exactWire(actual);
  return parsed !== null && cmp(parsed, expected) === 0;
}
function exactValue(actual: CertifiedValue, expected: OracleResult): boolean {
  return (
    sameValue(actual.successP, expected.P) &&
    sameValue(actual.weightedExpectedConsumptionB, expected.B) &&
    sameValue(actual.expectedTotalConsumptionC, expected.C) &&
    sameTriple(actual.expectedConsumed, expected.consumed)
  );
}
function optimalMask(ties: readonly OracleAction[]): number {
  return KITS.reduce((mask, kit, color) => (ties.includes(kit) ? mask | (1 << color) : mask), 0);
}
function firstKit(mask: number): 0 | 1 | 2 | undefined {
  return ([0, 1, 2] as const).find((color) => (mask & (1 << color)) !== 0);
}
function oracleInput(input: StateInput, prices: QTriple): OracleInput {
  return { grade: input.grade, level: input.level, exp: input.exp, stock: input.stock, prices };
}

/** Supported pricing domain. The product refuses a snapshot whose asOf differs
 * from the request (validation.ts) and prices with the rule active at the start
 * of coverage.currentDay (certifiedRecurringRate); snapshot validation ties that
 * day to the game day of asOf. independentApprovedPricing models one rule only.
 * The product honours an explicit finite law for any id, built-in ones included
 * (certifiedSupplyLaws findFiniteLaw), while a zero-count ref contributes nothing;
 * a positive dispatch, normal-shop or solo ref to a finite law is outside the
 * independent model, as in the certificate finite_override contract. */
function pricingDomainRefusal(input: CertifiedInput): string | null {
  const asOf = Date.parse(input.asOf);
  if (asOf !== Date.parse(input.snapshot.asOf)) return "input_asOf_differs_from_snapshot_asOf";
  const currentDay = input.snapshot.coverage.currentDay;
  if (currentDay !== gameDayKey(asOf)) return "snapshot_current_day_not_asOf_game_day";
  if (input.snapshot.rules.length !== 1) return "independent_pricing_rule_count_not_supported";
  const rule = ruleAt(input.snapshot.rules, dateStart(currentDay));
  if (!rule) return "independent_pricing_rule_inactive_on_current_game_day";
  const finite = new Set(
    (input.snapshot.laws ?? []).filter((law) => law.kind === "finite").map((law) => law.id),
  );
  if (
    [...rule.dispatch, ...rule.normalShop, ...rule.soloDays.flat()].some(
      (ref) => ref.count > 0 && finite.has(ref.lawId),
    )
  )
    return "independent_law_not_supported:finite_override";
  return null;
}
function pricingFormatDefect(pricing: NonNullable<CertifiedOutput["pricing"]>): string | null {
  const { basisStock } = pricing as { basisStock: unknown };
  if (
    !Array.isArray(basisStock) ||
    basisStock.length !== 3 ||
    ![0, 1, 2].every((color) => Number.isSafeInteger(basisStock[color]) && basisStock[color] >= 0)
  )
    return "basisStock";
  for (const field of ["recurringRate", "weights", "cohortWeights"] as const)
    if (!exactTriple(pricing[field])) return field;
  return null;
}

function historicalPricingPriors(input: CertifiedInput): QTriple | null {
  if (input.snapshot.version !== "certified-daily-v1") return null;
  const weights = input.cohortWeights;
  if (weights && weights.length !== 3) return null;
  return weights ? mapTriple(weights, fromWire) : DEFAULT_PRIORS;
}

/** Fixed prices from public rules and authenticated tracked cohort evidence. */
export function verifyPublicPricing(
  input: CertifiedInput,
  output: CertifiedOutput,
): { check: LaneCheck; prices?: QTriple } {
  const actual = output.pricing;
  if (!actual)
    return {
      check: output.current
        ? fail("API_pricing_missing_while_current_present")
        : notrun(`API_pricing_absent:${output.status}`),
    };
  const defect = pricingFormatDefect(actual);
  if (defect) return { check: fail(`pricing_malformed:${defect}`) };
  const outsideDomain = pricingDomainRefusal(input);
  if (outsideDomain) return { check: notrun(outsideDomain) };
  // A zero-count ref adds nothing to either the product or the independent sums.
  if (
    input.snapshot.rules.some((rule) =>
      rule.soloDays.flat().some((ref) => ref.count > 0 && !PRICED_SOLO_LAWS.has(ref.lawId)),
    )
  )
    return { check: notrun("independent_pricing_solo_law_not_supported") };
  const priors = historicalPricingPriors(input);
  if (!priors) return { check: notrun("independent_pricing_historical_three_cohort_only") };
  // Authenticate first: tracked evidence identity failures propagate, never NOTRUN.
  frozenIndependentCohorts();
  let rates: QTriple;
  try {
    rates = independentApprovedPricing(input.snapshot, priors);
  } catch (error) {
    if (error instanceof AssertionError)
      return { check: notrun("independent_pricing_rule_or_prior_shape_not_supported") };
    throw error;
  }
  const basis = input.priceBasisStock ?? input.stock;
  const denominators = mapTriple(rates, (rate, color) => add(q(basis[color]), rate));
  if (denominators.some((value) => value.n === 0n))
    return { check: notrun("independent_zero_basis_pricing_branch_not_modeled") };
  const prices = mapTriple(denominators, (value) => q(value.d, value.n));
  if (!basis.every((pieces, color) => pieces === actual.basisStock[color]))
    return { check: fail("pricing_basis_stock_mismatch") };
  if (!sameTriple(actual.recurringRate, rates))
    return { check: fail("pricing_recurring_rate_mismatch") };
  if (!sameTriple(actual.weights, prices)) return { check: fail("pricing_weight_mismatch") };
  if (!sameTriple(actual.cohortWeights, priors))
    return { check: fail("pricing_cohort_weights_mismatch") };
  return { check: pass("pricing_exact_public_rules_authenticated_cohorts"), prices };
}

/** Write-free independent current optimum; unsupported or over-limit inputs stay NOTRUN. */
export function independentCurrent(input: OracleInput): { result?: OracleResult; basis: string } {
  const coverage = independentCurrentCoverage(input, solveIntegerOracle);
  if (coverage.result) return coverage;
  const refusals = [coverage.basis];
  for (const [basis, evaluate] of EXPANDED) {
    try {
      return { result: evaluate(input), basis };
    } catch (error) {
      if (!(error instanceof Error) || !ADMISSION.test(error.message)) throw error;
      refusals.push(error.message);
    }
  }
  return { basis: refusals.join(";") };
}

export function verifyCurrent(
  input: StateInput,
  output: CertifiedOutput,
  prices: QTriple,
): { check: LaneCheck; expected?: OracleResult } {
  const current = output.current;
  if (!current) return { check: notrun(`API_current_absent:${output.status}`) };
  const independent = independentCurrent(oracleInput(input, prices));
  const expected = independent.result;
  if (!expected) return { check: notrun(`independent_current_not_computed:${independent.basis}`) };
  const mask = optimalMask(expected.ties);
  const color = firstKit(mask);
  const kit = color === undefined ? null : KITS[color];
  const start = canonicalState(input.grade, input.level, input.exp);
  let status: CertifiedCurrent["status"] = "preserve";
  if (start.grade === "SR" && start.level === 15) status = "complete";
  else if (kit) status = "use_certified";
  if (!exactValue(current.value, expected))
    return { check: fail("current_exact_PBC_or_consumed_vector_mismatch"), expected };
  if (current.optimalActionMask !== mask)
    return { check: fail("current_optimal_action_mask_mismatch"), expected };
  if (current.kit !== kit || current.status !== status)
    return { check: fail("current_kit_or_status_mismatch"), expected };
  if (current.pieces !== current.uses * 10)
    return { check: fail("current_batch_pieces_not_ten_per_use"), expected };
  return { check: pass(`current_exact:${independent.basis}`), expected };
}

/** Independent normal-path prefix length, or the NOTRUN reason of an unsolved step. */
function normalPathPrefix(
  input: StateInput & Pick<CertifiedInput, "batchLimit">,
  color: 0 | 1 | 2,
  prices: QTriple,
): number | string {
  const kit = KITS[color];
  const limit = input.batchLimit ?? 10;
  const start = canonicalState(input.grade, input.level, input.exp);
  let state = start;
  let stock: Triple = input.stock;
  let uses = 0;
  while (uses < limit) {
    if (uses > 0) {
      const step = independentCurrent({ ...state, stock, prices });
      if (!step.result) return `batch_step_${uses}_not_computed:${step.basis}`;
      if (!step.result.ties.includes(kit)) break;
    }
    uses++;
    stock = mapTriple(stock, (pieces, index) => (index === color ? pieces - 10 : pieces));
    if (cmp(independentProbability(state.grade, state.level, color), ONE) === 0) break;
    state = independentFailure(state.grade, state.level, state.exp, color);
    if (
      (state.grade === "SR" && state.level === 15) ||
      state.grade !== start.grade ||
      state.level !== start.level
    )
      break;
  }
  return uses;
}

/** Contract: the normal-path prefix of the first optimal kit at fixed prices,
 * stopping on a certain great success, a level/grade change or the batch limit. */
export function verifyBatch(
  input: StateInput & Pick<CertifiedInput, "batchLimit">,
  current: CertifiedCurrent,
  prices: QTriple,
  expected: OracleResult,
): LaneCheck {
  if (!Number.isSafeInteger(current.uses) || current.uses < 0)
    return fail("batch_uses_not_nonnegative_integer");
  const color = firstKit(optimalMask(expected.ties));
  if (color === undefined)
    return current.uses === 0
      ? pass("batch_zero_without_optimal_kit")
      : fail("batch_uses_without_optimal_kit");
  const uses = normalPathPrefix(input, color, prices);
  if (typeof uses === "string") return notrun(uses);
  if (current.uses === uses) return pass("batch_equals_independent_normal_path_prefix");
  return current.uses < uses
    ? notrun("batch_shorter_than_independent_prefix_possible_CertifiedLimit_cut")
    : fail("batch_longer_than_independent_normal_path_prefix");
}

/** Day 0 with a verified current P below the unrestricted optimum is checked here;
 * every other case keeps the existing verifyActualWaiting contract unchanged. */
export function verifyWaitingLane(
  input: CertifiedInput,
  output: CertifiedOutput,
  prices: QTriple,
  verifiedCurrent: OracleResult | undefined,
): CertificateCheck {
  const waiting = output.waiting;
  if (waiting.status !== "certified" || waiting.recommendedDays !== 0 || !verifiedCurrent)
    return verifyActualWaiting(input, output, prices, verifiedCurrent !== undefined);
  const unrestricted = createIndependentUnlimited(prices).solve(input);
  if (compareValue(verifiedCurrent, { ...unrestricted, P: ONE }) === 0)
    return verifyActualWaiting(input, output, prices, true);
  return verifyNoArrivalDayZero(input, waiting, verifiedCurrent);
}

function verifyNoArrivalDayZero(
  input: CertifiedInput,
  waiting: CertifiedWaiting,
  verifiedCurrent: OracleResult,
): CertificateCheck {
  const P = verifiedCurrent.P;
  if (cmp(P, ONE) === 0)
    return {
      status: "NOTRUN",
      reason: "day0_P1_above_unrestricted_cost_not_independently_proved",
    };
  if (!input.snapshot.coverage.future.complete)
    return { status: "NOTRUN", reason: "day0_without_complete_future_not_independently_proved" };
  // Conservative: any positive snapshot ref (even past or received) leaves a tie unproved.
  if (input.snapshot.events.some((event) => event.refs.some((ref) => ref.count !== 0)))
    return {
      status: "NOTRUN",
      reason: "day0_with_snapshot_arrivals_tie_not_independently_proved",
    };
  const interval = waiting.successProbabilityInterval;
  if (
    !waiting.value ||
    waiting.rangeBoundary ||
    waiting.bestDayRange?.[0] !== 0 ||
    waiting.bestDayRange[1] !== 0
  )
    return { status: "FAIL", reason: "day0_exact_value_or_recommendation_range_missing" };
  if (!exactValue(waiting.value, verifiedCurrent))
    return { status: "FAIL", reason: "day0_value_differs_from_independently_verified_current" };
  if (
    !interval ||
    !sameValue(interval.lower, P) ||
    !sameValue(interval.upper, P) ||
    !sameValue(waiting.successImprovementUpperBound, q(P.d - P.n, P.d))
  )
    return { status: "FAIL", reason: "day0_probability_interval_or_gap_not_exact_current_P" };
  return {
    status: "PASS",
    reason: "day0_no_snapshot_arrivals_complete_future_exact_current_invariance",
    probabilityIntervalValidity: "PASS",
  };
}

export type LaneReport = {
  status: LaneStatus;
  api: LaneCheck;
  pricing: LaneCheck;
  current: LaneCheck;
  batch: LaneCheck;
  /** The certificate result as returned, including receiptCount and
   * probabilityIntervalValidity metadata. */
  waiting: CertificateCheck;
};
/** PASS only for a completed response without a refusal whose pricing, current,
 * batch and, when requested, certified waiting all PASS. Partial, refused,
 * unresolved or resource-limited results are never PASS. */
export function verifyCertifiedLane(input: CertifiedInput, output: CertifiedOutput): LaneReport {
  let api = pass("API_completed_without_refusal");
  if (output.status !== "completed") api = notrun(`API_status:${output.status}`);
  else if (output.refusal !== null)
    api = notrun(`API_completed_with_refusal:${output.refusal.phase}:${output.refusal.reason}`);
  const pricing = verifyPublicPricing(input, output);
  const prices = pricing.prices;
  const current: { check: LaneCheck; expected?: OracleResult } = prices
    ? verifyCurrent(input, output, prices)
    : { check: notrun("current_requires_independent_pricing_PASS") };
  const batch =
    prices && current.expected && output.current
      ? verifyBatch(input, output.current, prices, current.expected)
      : notrun("batch_requires_independent_current");
  let waiting: CertificateCheck;
  if (input.computeWaiting === false)
    waiting =
      output.waiting.status === "not_requested"
        ? pass("waiting_not_requested")
        : fail("waiting_returned_when_not_requested");
  else if (!prices) waiting = notrun("waiting_requires_independent_pricing_PASS");
  else {
    // Only a PASS current is handed on as verified; the certificate's own metadata
    // is kept, and any non-PASS part keeps the overall report from PASS.
    const verified = current.check.status === "PASS" ? current.expected : undefined;
    waiting = verifyWaitingLane(input, output, prices, verified);
  }
  const checks = [api, pricing.check, current.check, batch, waiting];
  let status: LaneStatus = "PASS";
  if (checks.some((check) => check.status === "FAIL")) status = "FAIL";
  else if (checks.some((check) => check.status === "NOTRUN")) status = "NOTRUN";
  return { status, api, pricing: pricing.check, current: current.check, batch, waiting };
}
