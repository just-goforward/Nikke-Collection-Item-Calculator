import { q, toWire, type WireQ } from "./certifiedRational.ts";
import type { CertifiedLawRef, CertifiedSupplyLaw } from "./certifiedSupplyLaws.ts";
import {
  type ExactSoloRaidCadence,
  estimateCertifiedSoloRounds,
  type SoloRaidRound,
} from "./soloRaidCadence.ts";
import { gameDayKey, gameDayStartMs } from "./supplyForecastModel.ts";
export const CERTIFIED_SUPPLY_VERSION = "certified-daily-v1" as const;
export type PersonalCohortWeights = readonly [WireQ, WireQ, WireQ];
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
  kind: "dispatch" | "shop" | "solo";
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
  version: typeof CERTIFIED_SUPPLY_VERSION;
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
  toWire(q(1, 3)),
  toWire(q(1, 3)),
  toWire(q(1, 3)),
];

export function timestamp(value: string): number {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("certified_timestamp_offset_required");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error("certified_timestamp_invalid");
  return epoch;
}
export const iso = (epoch: number) => new Date(epoch).toISOString();
export const dateStart = (date: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("certified_game_date_invalid");
  const epoch = timestamp(`${date}T05:00:00+09:00`);
  if (gameDayKey(epoch) !== date) throw new Error("certified_game_date_invalid");
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
    id: "schedule-kit-v2:documented-physical-supply-v1",
    effectiveFrom,
    effectiveUntil,
    dispatch: [{ lawId: "dispatch-board-v1", count: 1 }],
    normalShop: refs(0, 5),
    collaborationShop: refs(0, 10),
    soloDays: [refs(12, 0), refs(4, 8), ...Array.from({ length: 5 }, () => refs(0, 12))],
    provenance: ["shared/supplyForecastModel.ts", "docs/research/kit-expected-gain.ko.md"],
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
  const first = estimateCertifiedSoloRounds({
    anchor: input.anchor,
    cadence: input.cadence,
    count: 1,
    offsetDays,
  })[0]!;
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

export function freezeJson<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
