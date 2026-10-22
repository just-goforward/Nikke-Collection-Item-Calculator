import { add, mul, type Q, q, toNumber, ZERO } from "./certifiedRational.ts";
import {
  assertCertifiedRuntimeSupplySnapshot,
  type CertifiedSupplyEvent,
  type CertifiedSupplySnapshot,
  certifiedCohortWeights,
  expectedCertifiedRefs,
  isCertifiedEventModeled,
  viewCertifiedSupplySnapshot,
} from "./certifiedSupply.ts";
import { isCoherentSnapshot } from "./certifiedSupplyCoherence.ts";
import {
  CERTIFIED_SUPPLY_HISTORY_DAYS,
  dateStart,
  isDeeplyFrozen,
  ruleAt,
  timestamp,
  withSupplyDateCache,
} from "./certifiedSupplyModel.ts";
import { assertV3RuntimeLaws } from "./certifiedSupplyValidation.ts";
import {
  CURRENT_FORECAST_RULES_VERSION,
  certifiedVersionPolicy,
} from "./certifiedVersionPolicy.ts";
import { GAME_DAY_MS, gameDayStartMs } from "./gameDay.ts";

export type SupplyGain = { blue: number; purple: number; yellow: number };
export type SupplyForecastProfile = {
  id: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  scheduleStatus: "confirmed" | "estimated";
  expectedGain: SupplyGain;
  referenceFrom?: string | undefined;
  referenceUntil?: string | undefined;
  referenceDays?: number | undefined;
};
export type CollaborationPeriod = { effectiveFrom: string; effectiveUntil: string };
export type ScheduledRewardPeriod = CollaborationPeriod & {
  scheduleStatus: "confirmed" | "estimated";
};
export type ScheduleProfileInput = {
  forecastId: string;
  effectiveFrom: string;
  /** Older callers must supply approved authority before producing v3 profiles. */
  certifiedSnapshot?: CertifiedSupplySnapshot;
  soloPeriods?: readonly ScheduledRewardPeriod[];
  collaborationPeriods?: readonly CollaborationPeriod[];
};
export type SupplyReferenceWindow = {
  from: number;
  until: number;
  scheduleStatus: "confirmed" | "estimated";
};
export type SupplyProjection =
  | { available: true; window: SupplyReferenceWindow; expected: readonly [Q, Q, Q] }
  | { available: false; reason: string };
type ProjectionCache = {
  gains: Map<string, readonly [Q, Q, Q]>;
  weights?: ReturnType<typeof certifiedCohortWeights>;
  events?: Map<number, { event: CertifiedSupplyEvent; gain?: readonly [Q, Q, Q] }[]>;
};

export const SUPPLY_PROFILE_HORIZON_DAYS = 56;
export const SUPPLY_RULES_VERSION = CURRENT_FORECAST_RULES_VERSION;
export const DISPATCH_POLICY_ID = "dispatch-policy-v1";
/** This selects dates only. Rewards always come from the approved event ledger. */
export function supplyReferenceWindow(
  snapshot: Pick<CertifiedSupplySnapshot, "soloRounds">,
  at: number,
): SupplyReferenceWindow | null {
  const today = gameDayStartMs(at);
  const segmented = snapshot.soloRounds.find(
    (round) =>
      round.segments &&
      at >= dateStart(round.startGameDate) &&
      round.endGameDate &&
      at < dateStart(round.endGameDate),
  );
  if (segmented) {
    const segment = segmented.segments?.find(
      (entry) => at >= timestamp(entry.effectiveFrom) && at < timestamp(entry.effectiveUntil),
    );
    return segment
      ? {
          from: dateStart(segment.rewardFromGameDate),
          until: dateStart(segment.rewardUntilGameDate),
          scheduleStatus: segmented.status === "confirmed" ? "confirmed" : "estimated",
        }
      : null;
  }
  const rounds = snapshot.soloRounds
    .map((round) => {
      const start = dateStart(round.startGameDate);
      return {
        start,
        end: round.endGameDate ? dateStart(round.endGameDate) : start + 7 * GAME_DAY_MS,
        status: round.status,
      };
    })
    .sort((a, b) => a.start - b.start);
  const activeIndex = rounds.findIndex((round) => today >= round.start && today < round.end);
  const active = rounds[activeIndex];
  if (active && today < active.start + 2 * GAME_DAY_MS) {
    const previous = rounds[activeIndex - 1];
    if (!previous) return null;
    return {
      from: previous.start + 2 * GAME_DAY_MS,
      until: today + GAME_DAY_MS,
      scheduleStatus:
        previous.status === "confirmed" && active.status === "confirmed"
          ? "confirmed"
          : "estimated",
    };
  }
  const next = rounds.find((round) => round.start > today);
  if (!next) return null;
  return {
    from: today,
    until: next.start + 2 * GAME_DAY_MS,
    scheduleStatus:
      next.status === "confirmed" && (!active || active.status === "confirmed")
        ? "confirmed"
        : "estimated",
  };
}

function supplyReferenceUnavailableReason(
  snapshot: CertifiedSupplySnapshot,
  from: number,
  until: number,
): string | null {
  const historyFrom = Math.max(
    timestamp(snapshot.coverage.from),
    gameDayStartMs(timestamp(snapshot.asOf)) - CERTIFIED_SUPPLY_HISTORY_DAYS * GAME_DAY_MS,
  );
  if (
    from < historyFrom ||
    until > timestamp(snapshot.coverage.until) ||
    until <= from ||
    from !== gameDayStartMs(from) ||
    until !== gameDayStartMs(until)
  )
    return "authority_coverage";
  if (
    from < gameDayStartMs(timestamp(snapshot.asOf)) &&
    snapshot.coverage.past.missing.some((reason) => reason !== "authority_coverage")
  )
    return "history_incomplete";
  if (
    snapshot.soloRounds.some(
      (round) =>
        round.status === "unverified" &&
        dateStart(round.startGameDate) < until &&
        dateStart(round.startGameDate) + 7 * GAME_DAY_MS > from,
    )
  )
    return "unverified_solo_round";
  for (let day = from; day < until; day += GAME_DAY_MS)
    if (!ruleAt(snapshot.rules, day)) return "reward_rules";
  return null;
}

/** Exact population expectation, never partial data disguised as a zero gain. */
function projectReference(
  snapshot: CertifiedSupplySnapshot,
  window: SupplyReferenceWindow,
  cache: ProjectionCache,
): SupplyProjection {
  const { from, until } = window;
  const reason = supplyReferenceUnavailableReason(snapshot, from, until);
  if (reason !== null) return { available: false, reason };
  cache.weights ??= certifiedCohortWeights(undefined, snapshot.version);
  if (!cache.events) {
    cache.events = new Map();
    for (const event of snapshot.events) {
      const day = dateStart(event.gameDate);
      const rows = cache.events.get(day) ?? [];
      rows.push({ event });
      cache.events.set(day, rows);
    }
  }
  const repetitions = new Map<readonly [Q, Q, Q], number>();
  for (let day = from; day < until; day += GAME_DAY_MS) {
    for (const row of cache.events.get(day) ?? []) {
      const { event } = row;
      if (!isCertifiedEventModeled(snapshot, event)) continue;
      let gain = row.gain;
      if (!gain) {
        const key = JSON.stringify(event.refs);
        gain = cache.gains.get(key);
        if (!gain) {
          gain = expectedCertifiedRefs(event.refs, cache.weights, { laws: snapshot.laws });
          cache.gains.set(key, gain);
        }
        row.gain = gain;
      }
      repetitions.set(gain, (repetitions.get(gain) ?? 0) + 1);
    }
  }
  return { available: true, window, expected: sumRepeatedGains(repetitions) };
}

function sumRepeatedGains(repetitions: ReadonlyMap<readonly [Q, Q, Q], number>): [Q, Q, Q] {
  const total: [Q, Q, Q] = [ZERO, ZERO, ZERO];
  // Cross-cancel the small repetition count before adding reduced expectations.
  // A final normalization of the unreduced dispatch numerator is much costlier.
  for (const [gain, count] of repetitions) {
    const multiplier = q(count);
    for (const color of [0, 1, 2] as const)
      total[color] = add(total[color], mul(gain[color], multiplier));
  }
  return total;
}

export function projectSupplyAt(snapshot: CertifiedSupplySnapshot, at: number): SupplyProjection {
  return projectAt(snapshot, at, { gains: new Map() });
}

export function projectSupplyReference(
  snapshot: CertifiedSupplySnapshot,
  window: SupplyReferenceWindow,
): SupplyProjection {
  return projectReference(snapshot, window, { gains: new Map() });
}

function projectAt(
  snapshot: CertifiedSupplySnapshot,
  at: number,
  cache: ProjectionCache,
): SupplyProjection {
  const view = viewCertifiedSupplySnapshot(snapshot, new Date(at).toISOString());
  const window = supplyReferenceWindow(view, at);
  return window
    ? projectReference(view, window, cache)
    : { available: false, reason: "reference_schedule" };
}

/** Gaps are unavailable dates, not zero-valued profiles. The final interval is finite. */
export function buildScheduleForecastProfiles(
  input: ScheduleProfileInput,
): SupplyForecastProfile[] {
  const snapshot = input.certifiedSnapshot;
  const key = JSON.stringify([input.forecastId, input.effectiveFrom]);
  const entries =
    projectionMemo && snapshot && isDeeplyFrozen(snapshot)
      ? projectionMemo.get(snapshot)
      : undefined;
  const cached = entries?.get(key);
  if (cached) return copyProfiles(cached);
  const result = withSupplyDateCache(() => buildProfiles(input));
  if (projectionMemo && snapshot && isDeeplyFrozen(snapshot)) {
    const values = entries ?? new Map<string, SupplyForecastProfile[]>();
    values.set(key, copyProfiles(result));
    projectionMemo.set(snapshot, values);
  }
  return result;
}

let projectionMemo:
  | WeakMap<CertifiedSupplySnapshot, Map<string, SupplyForecastProfile[]>>
  | undefined;

/** Synchronous construction scope; never retain authority across invocations. */
export function withForecastProjectionCache<T>(operation: () => T): T {
  if (projectionMemo) return operation();
  projectionMemo = new WeakMap();
  try {
    return withSupplyDateCache(operation);
  } finally {
    projectionMemo = undefined;
  }
}

function copyProfiles(profiles: readonly SupplyForecastProfile[]): SupplyForecastProfile[] {
  return profiles.map((profile) => ({ ...profile, expectedGain: { ...profile.expectedGain } }));
}

function buildProfiles(input: ScheduleProfileInput): SupplyForecastProfile[] {
  if (!input.certifiedSnapshot) throw new Error("certified_snapshot_required");
  const snapshot = isCoherentSnapshot(input.certifiedSnapshot)
    ? input.certifiedSnapshot
    : assertCertifiedRuntimeSupplySnapshot(input.certifiedSnapshot);
  if (isCoherentSnapshot(snapshot)) {
    if (!certifiedVersionPolicy(snapshot.version).physicalLaws)
      throw new Error("unsupported_forecast_version");
    assertV3RuntimeLaws(snapshot);
  }
  const from = timestamp(input.effectiveFrom);
  const until = from + SUPPLY_PROFILE_HORIZON_DAYS * GAME_DAY_MS;
  const profiles: SupplyForecastProfile[] = [];
  const cache: ProjectionCache = { gains: new Map() };
  for (let at = from; at < until; ) {
    const end = Math.min(gameDayStartMs(at) + GAME_DAY_MS, until);
    const result = projectAt(snapshot, at, cache);
    if (result.available)
      profiles.push({
        id: `${input.forecastId}@${new Date(at).toISOString()}`,
        effectiveFrom: new Date(at).toISOString(),
        effectiveUntil: new Date(end).toISOString(),
        scheduleStatus: result.window.scheduleStatus,
        expectedGain: {
          blue: toNumber(result.expected[0]),
          purple: toNumber(result.expected[1]),
          yellow: toNumber(result.expected[2]),
        },
        referenceFrom: new Date(result.window.from).toISOString(),
        referenceUntil: new Date(result.window.until).toISOString(),
        referenceDays: (result.window.until - result.window.from) / GAME_DAY_MS,
      });
    at = end;
  }
  return profiles;
}

export function assertLedgerForecastProfiles(
  forecastId: string,
  snapshot: CertifiedSupplySnapshot,
  profiles: readonly SupplyForecastProfile[],
): void {
  const expected = buildScheduleForecastProfiles({
    forecastId,
    effectiveFrom: snapshot.asOf,
    certifiedSnapshot: snapshot,
  });
  if (
    profiles.length !== expected.length ||
    expected.some((profile, index) => {
      const actual = profiles[index];
      return (
        !actual ||
        profile.id !== actual.id ||
        profile.effectiveFrom !== actual.effectiveFrom ||
        profile.effectiveUntil !== actual.effectiveUntil ||
        profile.scheduleStatus !== actual.scheduleStatus ||
        profile.referenceFrom !== actual.referenceFrom ||
        profile.referenceUntil !== actual.referenceUntil ||
        profile.referenceDays !== actual.referenceDays ||
        (["blue", "purple", "yellow"] as const).some(
          (color) => profile.expectedGain[color] !== actual.expectedGain[color],
        )
      );
    })
  )
    throw new Error("forecast_profiles_do_not_match_ledger");
}
