import {
  add,
  div,
  eq,
  fromWire,
  mul,
  ONE,
  type Q,
  q,
  sub,
  toWire,
  type WireQ,
  ZERO,
} from "./certifiedRational.ts";
import { buildSnapshot } from "./certifiedSupplyBuild.ts";
import {
  type CertifiedLawOptions,
  type CertifiedLawRef,
  convolveCertifiedDistributions,
  type DispatchCohort,
  type ExactSupplyOutcome,
  getCertifiedLawDistribution,
  getCertifiedLawExpectedGain,
  type Triple,
} from "./certifiedSupplyLaws.ts";
import type * as Model from "./certifiedSupplyModel.ts";
import {
  createCertifiedSupplyRule as createRule,
  DAY_MS,
  DEFAULT_PERSONAL_COHORT_WEIGHTS as DEFAULT_COHORT_WEIGHTS,
  dateStart,
  freezeJson,
  iso,
  linkCertifiedSoloAnnouncement as linkAnnouncement,
  ruleAt,
  CERTIFIED_SUPPLY_VERSION as SUPPLY_VERSION,
  timestamp,
  transitionCertifiedSoloDelay as transitionDelay,
} from "./certifiedSupplyModel.ts";
import { assertFutureLawIndependence, validateSnapshot } from "./certifiedSupplyValidation.ts";
import { gameDayKey, gameDayStartMs } from "./supplyForecastModel.ts";

export const CERTIFIED_SUPPLY_VERSION = SUPPLY_VERSION;
export const DEFAULT_PERSONAL_COHORT_WEIGHTS = DEFAULT_COHORT_WEIGHTS;
export type PersonalCohortWeights = Model.PersonalCohortWeights;
export type CertifiedSourceStatus = Model.CertifiedSourceStatus;
export type CertifiedSoloRound = Model.CertifiedSoloRound;
export type CertifiedSoloDelayState = Model.CertifiedSoloDelayState;
export type CertifiedSupplyEvent = Model.CertifiedSupplyEvent;
export type CertifiedSupplyRule = Model.CertifiedSupplyRule;
export type CertifiedHistoryCoverage = Model.CertifiedHistoryCoverage;
export type CertifiedSupplyCoverageWindow = Model.CertifiedSupplyCoverageWindow;
export type CertifiedSupplySnapshot = Model.CertifiedSupplySnapshot;
export type CertifiedSupplyBuildInput = Model.CertifiedSupplyBuildInput;
export type CertifiedDailySupply = Model.CertifiedDailySupply;
export type CertifiedSupplyPeriod = Model.CertifiedSupplyPeriod;
export type CertifiedSupplyComparison = Model.CertifiedSupplyComparison;

export function createCertifiedSupplyRule(
  from: string,
  until: string | null = null,
): CertifiedSupplyRule {
  return createRule(from, until);
}
export function linkCertifiedSoloAnnouncement(
  estimates: Parameters<typeof Model.linkCertifiedSoloAnnouncement>[0],
  date: string,
  round?: number,
): number {
  return linkAnnouncement(estimates, date, round);
}
export function transitionCertifiedSoloDelay(
  input: Parameters<typeof Model.transitionCertifiedSoloDelay>[0],
): CertifiedSoloDelayState {
  return transitionDelay(input);
}
export function buildCertifiedSupplySnapshot(
  input: CertifiedSupplyBuildInput,
): CertifiedSupplySnapshot {
  return buildSnapshot(input);
}
export const createCertifiedSupplySnapshot = buildCertifiedSupplySnapshot;
export function isCertifiedEventModeled(
  snapshot: CertifiedSupplySnapshot,
  event: CertifiedSupplyEvent,
  asOf: string = snapshot.asOf,
): boolean {
  if (event.cancelled) return false;
  if (event.kind !== "solo") return true;
  const round = snapshot.soloRounds.find((candidate) => candidate.round === event.round);
  if (!round) return true; // Explicit finite-law fixtures may omit a round ledger.
  return (
    round.status !== "unverified" &&
    !(round.status === "estimated" && dateStart(round.startGameDate) <= timestamp(asOf))
  );
}

/** Prior-day claims require a sourced, still-open window; null never implies indefinite claims. */
export function isCertifiedEventClaimable(
  snapshot: CertifiedSupplySnapshot,
  event: CertifiedSupplyEvent,
  asOf: string = snapshot.asOf,
): boolean {
  const now = timestamp(asOf);
  const explicitWindow = event.expiresAt !== undefined && event.expiresAt !== null;
  return (
    isCertifiedEventModeled(snapshot, event, asOf) &&
    timestamp(event.at) <= now &&
    (event.gameDate === gameDayKey(now) || explicitWindow) &&
    (event.expiresAt === undefined || event.expiresAt === null || timestamp(event.expiresAt) > now)
  );
}

export function assertCertifiedFutureLawIndependence(snapshot: CertifiedSupplySnapshot): void {
  assertFutureLawIndependence(snapshot);
}

/** Recompute query windows without generating or extending adopted authority. */
export function viewCertifiedSupplySnapshot(
  snapshot: CertifiedSupplySnapshot,
  asOf: string,
): CertifiedSupplySnapshot {
  const now = timestamp(asOf);
  const today = gameDayStartMs(now);
  const authorityFrom = timestamp(snapshot.coverage.from);
  const authorityUntil = timestamp(snapshot.coverage.until);
  const soloRounds = snapshot.soloRounds.map(
    (round): CertifiedSoloRound =>
      round.status === "estimated" && dateStart(round.startGameDate) <= now
        ? { ...round, status: "unverified", endGameDate: null }
        : round,
  );
  const rewindow = (
    old: CertifiedSupplyCoverageWindow,
    from: number,
    until: number,
  ): CertifiedSupplyCoverageWindow => {
    const missing = old.missing.filter(
      (reason) =>
        !["authority_coverage", "unverified_solo_rounds", "ongoing_unverified_round"].includes(
          reason,
        ),
    );
    if (from < authorityFrom || until > authorityUntil) missing.push("authority_coverage");
    for (
      let at = Math.max(from, authorityFrom);
      at < Math.min(until, authorityUntil);
      at += DAY_MS
    ) {
      if (!ruleAt(snapshot.rules, at) && !missing.includes("reward_rules"))
        missing.push("reward_rules");
    }
    if (
      soloRounds.some(
        (round) =>
          round.status === "unverified" &&
          dateStart(round.startGameDate) >= from &&
          dateStart(round.startGameDate) < until,
      )
    )
      missing.push("unverified_solo_rounds");
    return {
      from: iso(from),
      until: iso(until),
      days: 56,
      complete: missing.length === 0,
      missing,
    };
  };
  const past = rewindow(snapshot.coverage.past, today - 56 * DAY_MS, today);
  const future = rewindow(snapshot.coverage.future, today + DAY_MS, today + 57 * DAY_MS);
  return freezeJson({
    ...snapshot,
    asOf: iso(now),
    soloRounds,
    coverage: { ...snapshot.coverage, currentDay: gameDayKey(today), past, future },
    warnings: [
      ...new Set([
        ...snapshot.warnings,
        ...soloRounds
          .filter(
            (round) =>
              round.status === "unverified" &&
              dateStart(round.startGameDate) >= today - 63 * DAY_MS,
          )
          .map((round) => `unverified_solo_round:r${round.round}`),
        ...(soloRounds.some(
          (round) =>
            round.status === "unverified" &&
            dateStart(round.startGameDate) <= today &&
            dateStart(round.startGameDate) + 7 * DAY_MS > today + DAY_MS,
        )
          ? ["ongoing_unverified_round_excluded"]
          : []),
        ...(past.missing.includes("authority_coverage") ||
        future.missing.includes("authority_coverage")
          ? ["query_outside_adopted_authority_coverage"]
          : []),
      ]),
    ],
  });
}

export function certifiedCohortWeights(
  weights: PersonalCohortWeights = DEFAULT_PERSONAL_COHORT_WEIGHTS,
): readonly [Q, Q, Q] {
  if (weights.length !== 3) throw new Error("certified_cohort_weights_invalid");
  const values = weights.map(fromWire) as [Q, Q, Q];
  if (values.some((weight) => weight.n < 0n) || !eq(add(add(values[0], values[1]), values[2]), ONE))
    throw new Error("certified_cohort_weights_invalid");
  return values;
}

function expectedRefs(
  refs: readonly CertifiedLawRef[],
  weights: readonly [Q, Q, Q],
  options: CertifiedLawOptions,
): [Q, Q, Q] {
  const result: [Q, Q, Q] = [ZERO, ZERO, ZERO];
  for (const cohort of [0, 1, 2] as const) {
    if (weights[cohort].n === 0n) continue;
    for (const ref of refs) {
      const gain = getCertifiedLawExpectedGain(ref, cohort, options);
      for (const k of [0, 1, 2] as const) result[k] = add(result[k], mul(weights[cohort], gain[k]));
    }
  }
  return result;
}

export function deriveCertifiedDailySupply(
  snapshot: CertifiedSupplySnapshot,
  weights?: PersonalCohortWeights,
  options: CertifiedLawOptions = {},
): CertifiedDailySupply[] {
  const personal = certifiedCohortWeights(weights);
  const current = dateStart(snapshot.coverage.currentDay);
  const days: CertifiedDailySupply[] = [];
  const expectationCache = new Map<string, readonly [Q, Q, Q]>();
  for (let at = current - 56 * DAY_MS; at <= current + 56 * DAY_MS; at += DAY_MS) {
    options.checkBudget?.();
    const events = snapshot.events.filter(
      (event) => event.gameDate === gameDayKey(at) && isCertifiedEventModeled(snapshot, event),
    );
    const dayRefs = events.flatMap((event) => event.refs);
    const key = JSON.stringify(dayRefs);
    let gain = expectationCache.get(key);
    if (!gain) {
      gain = expectedRefs(dayRefs, personal, { ...options, laws: snapshot.laws });
      expectationCache.set(key, gain);
    }
    const offset = (at - current) / DAY_MS;
    days.push({
      gameDate: gameDayKey(at),
      at: iso(at),
      offset,
      events,
      expectedGain: gain.map(toWire) as [WireQ, WireQ, WireQ],
      complete:
        offset < 0
          ? snapshot.coverage.past.complete
          : offset > 0
            ? snapshot.coverage.future.complete
            : Boolean(ruleAt(snapshot.rules, at)),
      estimated: events.some((event) => event.status === "estimated"),
    });
  }
  return days;
}

export function compareCertifiedSupplyPeriods(
  snapshot: CertifiedSupplySnapshot,
  weights?: PersonalCohortWeights,
): CertifiedSupplyComparison {
  const daily = deriveCertifiedDailySupply(snapshot, weights);
  const period = (window: CertifiedSupplyCoverageWindow): CertifiedSupplyPeriod => {
    const days = daily.filter(
      (day) =>
        timestamp(day.at) >= timestamp(window.from) && timestamp(day.at) < timestamp(window.until),
    );
    const total: [Q, Q, Q] = [ZERO, ZERO, ZERO];
    for (const day of days)
      for (const k of [0, 1, 2] as const) total[k] = add(total[k], fromWire(day.expectedGain[k]));
    const events = days.flatMap((day) => day.events);
    return {
      from: window.from,
      until: window.until,
      days: days.length,
      total: total.map(toWire) as [WireQ, WireQ, WireQ],
      dailyAverage: total.map((value) => toWire(div(value, q(days.length)))) as [
        WireQ,
        WireQ,
        WireQ,
      ],
      shopDays: events.filter((event) => event.kind === "shop").length,
      confirmedRaidDays: events.filter(
        (event) => event.kind === "solo" && event.status === "confirmed",
      ).length,
      estimatedRaidDays: events.filter(
        (event) => event.kind === "solo" && event.status === "estimated",
      ).length,
      unverifiedRounds: snapshot.soloRounds
        .filter(
          (round) =>
            round.status === "unverified" &&
            dateStart(round.startGameDate) >= timestamp(window.from) &&
            dateStart(round.startGameDate) < timestamp(window.until),
        )
        .map((round) => round.round),
      complete: window.complete,
      missing: window.missing,
    };
  };
  const past = period(snapshot.coverage.past);
  const future = period(snapshot.coverage.future);
  const percentChange = past.total.map((wire, k) => {
    const before = fromWire(wire);
    return before.n === 0n
      ? null
      : toWire(mul(div(sub(fromWire(future.total[k]!), before), before), q(100)));
  }) as [WireQ | null, WireQ | null, WireQ | null];
  return {
    past,
    future,
    currentDay: daily.find((day) => day.offset === 0)!,
    percentChange,
    comparisonBasis: "modeled_available_rewards",
    partial: !past.complete || !future.complete,
  };
}
export const comparePeriods = compareCertifiedSupplyPeriods;
export function certifiedRecurringRate(
  snapshot: CertifiedSupplySnapshot,
  weights?: PersonalCohortWeights,
  options: CertifiedLawOptions = {},
): readonly [Q, Q, Q] {
  const personal = certifiedCohortWeights(weights);
  const rule = ruleAt(snapshot.rules, dateStart(snapshot.coverage.currentDay));
  if (!rule) throw new Error("certified_current_supply_rule_missing");
  const lawOptions = { ...options, laws: snapshot.laws };
  const dispatch = expectedRefs(rule.dispatch, personal, lawOptions);
  const shop = expectedRefs(rule.normalShop, personal, lawOptions);
  const solo = expectedRefs(rule.soloDays.flat(), personal, lawOptions);
  const mean = q(snapshot.cadence.numerator, snapshot.cadence.denominator);
  const rate = dispatch.map((value, k) =>
    add(add(value, div(shop[k]!, q(7))), div(solo[k]!, mean)),
  ) as [Q, Q, Q];
  if (rate.some((value) => value.n < 0n)) throw new Error("negative_recurring_rate");
  return rate;
}
export const recurringRates = certifiedRecurringRate;
export function certifiedFixedPriceWeights(
  snapshot: CertifiedSupplySnapshot,
  weights: PersonalCohortWeights | undefined,
  initialRaw: Triple,
  options: CertifiedLawOptions = {},
): readonly [Q, Q, Q] {
  if (initialRaw.length !== 3 || initialRaw.some((raw) => !Number.isSafeInteger(raw) || raw < 0))
    throw new Error("certified_initial_raw_pieces_invalid");
  const rate = certifiedRecurringRate(snapshot, weights, options);
  return rate.map((value, k) => {
    const denominator = add(q(initialRaw[k]!), value);
    if (denominator.n === 0n) throw new Error("zero_price_denominator");
    return div(ONE, denominator);
  }) as [Q, Q, Q];
}
export function getCertifiedEventDistribution(
  event: CertifiedSupplyEvent,
  cohort: DispatchCohort,
  options: CertifiedLawOptions = {},
): readonly ExactSupplyOutcome[] {
  let rows: readonly ExactSupplyOutcome[] = [{ pieces: [0, 0, 0], mass: ONE }];
  if (event.cancelled) return rows;
  for (const ref of event.refs)
    rows = convolveCertifiedDistributions(
      rows,
      getCertifiedLawDistribution(ref, cohort, options),
      options.checkBudget,
    );
  return rows;
}

export function assertCertifiedSupplySnapshot(
  value: unknown,
  checkBudget?: () => void,
): CertifiedSupplySnapshot {
  return validateSnapshot(value, checkBudget);
}
export function isCertifiedSupplySnapshot(value: unknown): value is CertifiedSupplySnapshot {
  try {
    assertCertifiedSupplySnapshot(value);
    return true;
  } catch {
    return false;
  }
}
