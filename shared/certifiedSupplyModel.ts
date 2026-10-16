import { q, toWire, type WireQ } from "./certifiedRational.ts";
import type { CertifiedLawRef, CertifiedSupplyLaw, CohortTuple } from "./certifiedSupplyLaws.ts";
import { gameDayKey, gameDayStartMs } from "./gameDay.ts";
import {
  type ExactSoloRaidCadence,
  estimateCertifiedSoloRounds,
  type SoloRaidRound,
} from "./soloRaidCadence.ts";
export const CERTIFIED_SUPPLY_VERSION = "certified-daily-v3" as const;
export const CERTIFIED_SUPPLY_HISTORY_DAYS = 7;
export const CERTIFIED_WEEKLY_FIXED_LAW_ID = "deterministic:10,10,0";
export type CertifiedSupplyVersion =
  | "certified-daily-v1"
  | "certified-daily-v2"
  | typeof CERTIFIED_SUPPLY_VERSION;
export type PersonalCohortWeights = readonly [WireQ, WireQ, WireQ, WireQ];
export type SnapshotCohortWeights = CohortTuple<WireQ>;
export type CertifiedSourceStatus = "healthy" | "uncertain";
export type CertifiedSoloRound = {
  round: number;
  startGameDate: string;
  endGameDate: string | null;
  status: "confirmed" | "estimated" | "unverified";
  sourceIds: readonly string[];
};
export type CertifiedSoloDelayState = {
  anchorRound: number;
  anchorGameDate: string;
  offsetDays: number;
};
export type CertifiedSupplyEvent = {
  id: string;
  gameDate: string;
  at: string;
  kind: "dispatch" | "shop" | "solo" | "weekly-kits";
  status: "confirmed" | "estimated";
  refs: readonly CertifiedLawRef[];
  ruleId: string;
  round?: number;
  dayNumber?: number;
  /** Sourced exclusive claim deadline; null/omitted means the deadline is unknown. */
  expiresAt?: string | null;
  cancelled?: boolean;
  sourceIds?: readonly string[];
};
export type CertifiedSupplyRule = {
  id: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  dispatch: readonly CertifiedLawRef[];
  normalShop: readonly CertifiedLawRef[];
  collaborationShop: readonly CertifiedLawRef[];
  /** Absent only in historical v1/v2 rules. */
  weeklyFixed?: readonly CertifiedLawRef[];
  soloDays: readonly (readonly CertifiedLawRef[])[];
  provenance: readonly string[];
};
export type CertifiedHistoryCoverage = {
  from: string;
  until: string;
  raidDurations: boolean;
  collaborationPeriods: boolean;
  rewardRules: boolean;
};
export type CertifiedSupplyCoverageWindow = {
  from: string;
  until: string;
  days: number;
  complete: boolean;
  missing: readonly string[];
};
export type CertifiedSupplySnapshot = {
  version: CertifiedSupplyVersion;
  futureLawSemantics: "independent_given_cohort-v1";
  revision: string;
  sourceHash: string;
  asOf: string;
  sourceStatus: CertifiedSourceStatus;
  rules: readonly CertifiedSupplyRule[];
  laws: readonly CertifiedSupplyLaw[];
  events: readonly CertifiedSupplyEvent[];
  soloRounds: readonly CertifiedSoloRound[];
  cadence: ExactSoloRaidCadence;
  delayState: CertifiedSoloDelayState;
  coverage: {
    from: string;
    until: string;
    past: CertifiedSupplyCoverageWindow;
    future: CertifiedSupplyCoverageWindow;
    currentDay: string;
  };
  warnings: readonly string[];
  provenance: readonly string[];
};
export type CertifiedSupplyBuildInput = {
  asOf: string;
  revision: string;
  sourceHash: string;
  soloPeriods: readonly {
    effectiveFrom: string;
    effectiveUntil: string;
    scheduleStatus: "confirmed" | "estimated";
    round?: number;
  }[];
  collaborationPeriods: readonly { effectiveFrom: string; effectiveUntil: string }[];
  confirmedRounds?: readonly SoloRaidRound[];
  historyCoverage?: CertifiedHistoryCoverage;
  sourceStatus?: CertifiedSourceStatus;
  delayState?: CertifiedSoloDelayState;
  rules?: readonly CertifiedSupplyRule[];
  laws?: readonly CertifiedSupplyLaw[];
  horizonDays?: number;
  provenance?: readonly string[];
};
export type CertifiedDailySupply = {
  gameDate: string;
  at: string;
  offset: number;
  events: readonly CertifiedSupplyEvent[];
  expectedGain: readonly [WireQ, WireQ, WireQ];
  complete: boolean;
  estimated: boolean;
};
export type CertifiedSupplyPeriod = {
  from: string;
  until: string;
  days: number;
  total: readonly [WireQ, WireQ, WireQ];
  dailyAverage: readonly [WireQ, WireQ, WireQ];
  shopDays: number;
  confirmedRaidDays: number;
  estimatedRaidDays: number;
  unverifiedRounds: readonly number[];
  complete: boolean;
  missing: readonly string[];
};
export type CertifiedSupplyComparison = {
  past: CertifiedSupplyPeriod;
  future: CertifiedSupplyPeriod;
  currentDay: CertifiedDailySupply;
  percentChange: readonly [WireQ | null, WireQ | null, WireQ | null];
  comparisonBasis: "modeled_available_rewards";
  partial: boolean;
};

export const DAY_MS = 86_400_000;
export const DEFAULT_PERSONAL_COHORT_WEIGHTS: PersonalCohortWeights = [
  toWire(q(1, 7)),
  toWire(q(2, 7)),
  toWire(q(3, 7)),
  toWire(q(1, 7)),
];
export const LEGACY_PERSONAL_COHORT_WEIGHTS = [
  toWire(q(1, 3)),
  toWire(q(1, 3)),
  toWire(q(1, 3)),
] as const;

let dateCache: { timestamps: Map<string, number>; starts: Map<string, number> } | undefined;

/** Reuse pure conversions during a synchronous ledger operation, never across requests. */
export function withSupplyDateCache<T>(operation: () => T): T {
  if (dateCache) return operation();
  dateCache = { timestamps: new Map(), starts: new Map() };
  try {
    return operation();
  } finally {
    dateCache = undefined;
  }
}

export function timestamp(value: string): number {
  const cached = dateCache?.timestamps.get(value);
  if (cached !== undefined) return cached;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("certified_timestamp_offset_required");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error("certified_timestamp_invalid");
  dateCache?.timestamps.set(value, epoch);
  return epoch;
}
export const iso = (epoch: number) => new Date(epoch).toISOString();
export const dateStart = (date: string) => {
  const cached = dateCache?.starts.get(date);
  if (cached !== undefined) return cached;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("certified_game_date_invalid");
  const epoch = timestamp(`${date}T05:00:00+09:00`);
  if (gameDayKey(epoch) !== date) throw new Error("certified_game_date_invalid");
  dateCache?.starts.set(date, epoch);
  return epoch;
};
const refs = (regularBoxes: number, boxII: number): readonly CertifiedLawRef[] => [
  ...(regularBoxes ? [{ lawId: "regular-box-v1", count: regularBoxes }] : []),
  ...(boxII ? [{ lawId: "box-ii-v1", count: boxII }] : []),
];

export function createCertifiedSupplyRule(
  effectiveFrom: string,
  effectiveUntil: string | null = null,
): CertifiedSupplyRule {
  return {
    id: "schedule-kit-v3:documented-physical-supply-v2",
    effectiveFrom,
    effectiveUntil,
    dispatch: [{ lawId: "dispatch-board-v1", count: 1 }],
    normalShop: refs(0, 5),
    collaborationShop: refs(0, 10),
    weeklyFixed: [{ lawId: CERTIFIED_WEEKLY_FIXED_LAW_ID, count: 1 }],
    soloDays: [refs(12, 0), refs(4, 8), ...Array.from({ length: 5 }, () => refs(0, 12))],
    provenance: ["shared/certifiedSupplyModel.ts", "docs/research/kit-expected-gain.ko.md"],
  };
}

/** Round numbers take precedence; otherwise use the nearest independent estimate. */
export function linkCertifiedSoloAnnouncement(
  estimates: readonly { round: number; startGameDate: string }[],
  startGameDate: string,
  explicitRound?: number,
): number {
  if (explicitRound !== undefined) {
    if (!Number.isSafeInteger(explicitRound) || explicitRound < 1)
      throw new Error("certified_solo_round_invalid");
    return explicitRound;
  }
  const start = dateStart(startGameDate);
  const nearest = [...estimates].sort(
    (a, b) =>
      Math.abs(dateStart(a.startGameDate) - start) - Math.abs(dateStart(b.startGameDate) - start) ||
      a.round - b.round,
  )[0];
  if (!nearest) throw new Error("certified_solo_announcement_unlinked");
  return nearest.round;
}

/** Healthy negative evidence delays the same round and every subsequent estimate. */
export function transitionCertifiedSoloDelay(input: {
  anchor: Pick<SoloRaidRound, "round" | "startGameDate">;
  cadence: ExactSoloRaidCadence;
  asOf: string;
  sourceStatus: CertifiedSourceStatus;
  delayState?: CertifiedSoloDelayState;
}): CertifiedSoloDelayState {
  const previous = input.delayState;
  let offsetDays =
    previous?.anchorRound === input.anchor.round &&
    previous.anchorGameDate === input.anchor.startGameDate
      ? previous.offsetDays
      : 0;
  if (!Number.isSafeInteger(offsetDays) || offsetDays < 0 || offsetDays % 7 !== 0)
    throw new Error("certified_solo_delay_invalid");
  // The estimator uses Array.from with this validated count, so the result is a singleton.
  const [first] = estimateCertifiedSoloRounds({
    anchor: input.anchor,
    cadence: input.cadence,
    count: 1,
    offsetDays,
  }) as [ReturnType<typeof estimateCertifiedSoloRounds>[number]];
  const now = timestamp(input.asOf);
  if (input.sourceStatus === "healthy" && dateStart(first.startGameDate) <= now) {
    let future = gameDayStartMs(now);
    while (future <= now || new Date(future + 9 * 3_600_000).getUTCDay() !== 4) future += DAY_MS;
    offsetDays += (future - dateStart(first.startGameDate)) / DAY_MS;
  }
  return {
    anchorRound: input.anchor.round,
    anchorGameDate: input.anchor.startGameDate,
    offsetDays,
  };
}

export function ruleAt(rules: readonly CertifiedSupplyRule[], at: number) {
  return rules.find(
    (rule) =>
      timestamp(rule.effectiveFrom) <= at &&
      (rule.effectiveUntil === null || at < timestamp(rule.effectiveUntil)),
  );
}

// Only this traversal establishes recursive freezing; Object.isFrozen alone
// would incorrectly trust shallow-frozen caller objects. Weak keys do not retain ledgers.
const deeplyFrozen = new WeakSet<object>();
export function freezeJson<T>(value: T): T {
  if (typeof value === "object" && value !== null && !deeplyFrozen.has(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
    deeplyFrozen.add(value);
  }
  return value;
}
