export type SupplyGain = { blue: number; purple: number; yellow: number };

export type SupplyForecastProfile = {
  id: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  scheduleStatus: "confirmed" | "estimated";
  expectedGain: SupplyGain;
};

export type CollaborationPeriod = {
  effectiveFrom: string;
  effectiveUntil: string;
};

export type ScheduledRewardPeriod = CollaborationPeriod & {
  scheduleStatus: "confirmed" | "estimated";
};

export type ScheduleProfileInput = {
  forecastId: string;
  effectiveFrom: string;
  soloPeriods: readonly ScheduledRewardPeriod[];
  collaborationPeriods: readonly CollaborationPeriod[];
};

const DAY_MS = 86_400_000;
const KST_SHIFT_TO_GAME_DATE_MS = 4 * 60 * 60 * 1000;
export const SUPPLY_PROFILE_HORIZON_DAYS = 56 as const;

export const SUPPLY_RULES_VERSION = "schedule-kit-v2" as const;
export const DISPATCH_POLICY_ID = "dispatch-policy-v1" as const;

type DispatchReward = {
  count: number;
  probability: number;
  gain: SupplyGain;
  keep: boolean;
};

const DISPATCH_REWARDS: readonly DispatchReward[] = [
  { count: 4, probability: 0.0375, gain: { blue: 2, purple: 0, yellow: 0 }, keep: false },
  { count: 4, probability: 0.0375, gain: { blue: 3, purple: 0, yellow: 0 }, keep: false },
  { count: 4, probability: 0.015, gain: { blue: 0, purple: 2, yellow: 0 }, keep: true },
  { count: 4, probability: 0.0075, gain: { blue: 0, purple: 3, yellow: 0 }, keep: true },
  { count: 4, probability: 0.01, gain: { blue: 0, purple: 0, yellow: 1 }, keep: true },
  { count: 4, probability: 0.005, gain: { blue: 0, purple: 0, yellow: 2 }, keep: true },
  { count: 4, probability: 0.0375, gain: { blue: 2.4, purple: 0.2, yellow: 0 }, keep: false },
  { count: 4, probability: 0.02, gain: { blue: 4.8, purple: 0.4, yellow: 0 }, keep: true },
  { count: 4, probability: 0.02, gain: { blue: 3.5, purple: 0.4, yellow: 0.2 }, keep: true },
  { count: 4, probability: 0.01, gain: { blue: 7, purple: 0.8, yellow: 0.4 }, keep: true },
  { count: 4, probability: 0.0075, gain: { blue: 0, purple: 0, yellow: 0 }, keep: false },
  { count: 4, probability: 0.0175, gain: { blue: 0, purple: 0, yellow: 0 }, keep: false },
  { count: 4, probability: 0.0175, gain: { blue: 0, purple: 0, yellow: 0 }, keep: false },
  { count: 4, probability: 0.0075, gain: { blue: 0, purple: 0, yellow: 0 }, keep: false },
] as const;

export const PURPLE_BOX_GAIN = { blue: 2.4, purple: 0.2, yellow: 0 } as const;
export const YELLOW_BOX_GAIN = { blue: 3.5, purple: 0.4, yellow: 0.2 } as const;

export const SOLO_DAILY_EXPECTED_GAIN = {
  day1: { blue: 28.8, purple: 2.4, yellow: 0 },
  day2: { blue: 37.6, purple: 4, yellow: 1.6 },
  day3AndLater: { blue: 42, purple: 4.8, yellow: 2.4 },
} as const;

export const DISPATCH_COHORT_EXPECTED_GAIN = {
  noReroll: { blue: 8.175245784822751, purple: 1.3645465917413264, yellow: 0.4590244585161533 },
  oneReroll: { blue: 9.057043144564652, purple: 2.1022801740689987, yellow: 0.7481680585372852 },
  twoRerolls: { blue: 9.609910117853328, purple: 2.576813704937056, yellow: 0.9354319621848267 },
} as const;

export const DISPATCH_DAILY_EXPECTED_GAIN = averageGain([
  DISPATCH_COHORT_EXPECTED_GAIN.noReroll,
  DISPATCH_COHORT_EXPECTED_GAIN.oneReroll,
  DISPATCH_COHORT_EXPECTED_GAIN.twoRerolls,
]);

export function enumerateDispatchExpectedGain(maxRerolls: 0 | 1 | 2): SupplyGain {
  type State = { kept: number[]; probability: number };
  let states: State[] = [{ kept: Array<number>(DISPATCH_REWARDS.length).fill(0), probability: 1 }];

  for (let round = 0; round <= maxRerolls; round += 1) {
    const next = new Map<string, State>();
    const expected = zeroGain();
    for (const state of states) {
      const drawCount = 4 - state.kept.reduce((sum, count) => sum + count, 0);
      for (const draw of enumerateWeightedDraws(state.kept, drawCount)) {
        const probability = state.probability * draw.probability;
        if (round === maxRerolls) {
          addFinalDispatchDraw(expected, state.kept, draw.counts, probability);
          continue;
        }
        const kept = keptDispatchRewards(state.kept, draw.counts);
        const key = kept.join(",");
        const current = next.get(key);
        if (current) current.probability += probability;
        else next.set(key, { kept, probability });
      }
    }
    if (round === maxRerolls) return expected;
    states = [...next.values()];
  }
  throw new Error("Dispatch enumeration did not terminate.");
}

function addFinalDispatchDraw(
  expected: SupplyGain,
  kept: readonly number[],
  drawn: readonly number[],
  probability: number,
) {
  for (const [index, reward] of DISPATCH_REWARDS.entries()) {
    addScaled(expected, reward.gain, probability * (countAt(kept, index) + countAt(drawn, index)));
  }
}

function keptDispatchRewards(kept: readonly number[], drawn: readonly number[]): number[] {
  const result = kept.slice();
  for (const [index, reward] of DISPATCH_REWARDS.entries()) {
    if (reward.keep) result[index] = countAt(result, index) + countAt(drawn, index);
  }
  return result;
}

export function buildScheduleForecastProfiles(
  input: ScheduleProfileInput,
): SupplyForecastProfile[] {
  const effectiveFrom = parseTimestamp(input.effectiveFrom, "effectiveFrom");
  const profileUntil = effectiveFrom + SUPPLY_PROFILE_HORIZON_DAYS * DAY_MS;
  const soloPeriods = parseScheduledPeriods(input.soloPeriods, "soloPeriods");
  const collaborationPeriods = parsePeriods(input.collaborationPeriods, "collaborationPeriods");
  assertOrderedNonOverlapping(soloPeriods, "soloPeriods");

  const boundaries = new Set<number>([effectiveFrom, profileUntil]);
  for (let reset = nextGameDayStartMs(effectiveFrom); reset < profileUntil; reset += DAY_MS) {
    boundaries.add(reset);
  }
  for (const period of soloPeriods) {
    const activeFrom = gameDayStartMs(period.start);
    if (activeFrom > effectiveFrom && activeFrom < profileUntil) boundaries.add(activeFrom);
    const activeUntil = periodActiveUntil(period);
    if (activeUntil > effectiveFrom && activeUntil < profileUntil) boundaries.add(activeUntil);
  }
  const ordered = [...boundaries]
    .filter((value) => value >= effectiveFrom && value <= profileUntil)
    .sort((a, b) => a - b);
  const profiles: SupplyForecastProfile[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const from = ordered[index];
    const until = ordered[index + 1];
    if (from === undefined || until === undefined) {
      throw new Error("Forecast boundary sequence is incomplete.");
    }
    const reference = referenceWindowAt(from, soloPeriods);
    const rewardDays = gameDayStartsInclusive(reference.start, reference.end);
    const dispatch = scaleGain(DISPATCH_DAILY_EXPECTED_GAIN, rewardDays.length);
    const coopBoxCount = rewardDays.reduce((count, reset) => {
      if (!isKstTuesday(reset)) return count;
      const collaborationMultiplier = collaborationPeriods.some(
        (period) => reset >= period.start && reset < period.end,
      )
        ? 2
        : 1;
      return count + 5 * collaborationMultiplier;
    }, 0);
    const soloGain = soloPeriods.reduce(
      (gain, period) => addGains(gain, soloGainWithin(period, reference.start, reference.end)),
      zeroGain(),
    );
    const gain = addGains(dispatch, scaleGain(YELLOW_BOX_GAIN, coopBoxCount), soloGain);
    profiles.push({
      id: `${input.forecastId}@${new Date(from).toISOString()}`,
      effectiveFrom: new Date(from).toISOString(),
      effectiveUntil: new Date(until).toISOString(),
      scheduleStatus: reference.scheduleStatus,
      expectedGain: roundGain(gain),
    });
  }
  const finalProfile = profiles.at(-1);
  if (!finalProfile) throw new Error("Forecast cycle did not produce any profiles.");
  finalProfile.effectiveUntil = null;
  return profiles;
}

export function gameDayKey(timestampMs: number) {
  return new Date(timestampMs + KST_SHIFT_TO_GAME_DATE_MS).toISOString().slice(0, 10);
}

export function gameDayStartMs(timestampMs: number) {
  return Date.parse(`${gameDayKey(timestampMs)}T05:00:00+09:00`);
}

function nextGameDayStartMs(timestampMs: number) {
  const start = gameDayStartMs(timestampMs);
  return start > timestampMs ? start : start + DAY_MS;
}

function gameDayStartsInclusive(fromInclusive: number, untilInclusive: number) {
  const result: number[] = [];
  const first = gameDayStartMs(fromInclusive);
  const last = gameDayStartMs(untilInclusive);
  for (let reset = first; reset <= last; reset += DAY_MS) {
    result.push(reset);
  }
  return result;
}

function isKstTuesday(timestampMs: number) {
  return new Date(timestampMs + 9 * 60 * 60 * 1000).getUTCDay() === 2;
}

type ParsedPeriod = {
  start: number;
  end: number;
};

type ParsedScheduledPeriod = ParsedPeriod & {
  scheduleStatus: "confirmed" | "estimated";
};

function referenceWindowAt(timestampMs: number, soloPeriods: readonly ParsedScheduledPeriod[]) {
  const currentDay = gameDayStartMs(timestampMs);
  const activeIndex = soloPeriods.findIndex(
    (period) =>
      timestampMs >= gameDayStartMs(period.start) && timestampMs < periodActiveUntil(period),
  );
  const active = soloPeriods[activeIndex];
  if (active) {
    const dayNumber = Math.floor((currentDay - gameDayStartMs(active.start)) / DAY_MS) + 1;
    if (dayNumber <= 2) {
      const previous = soloPeriods[activeIndex - 1];
      if (!previous) throw new Error("Solo day 1/2 requires the previous Solo Raid period.");
      return {
        start: gameDayStartMs(previous.start) + 2 * DAY_MS,
        end: currentDay,
        scheduleStatus: combinedScheduleStatus(previous, active),
      };
    }
    const next = soloPeriods[activeIndex + 1];
    if (!next) throw new Error("Solo day 3+ requires the next Solo Raid period.");
    return {
      start: currentDay,
      end: gameDayStartMs(next.start) + DAY_MS,
      scheduleStatus: combinedScheduleStatus(active, next),
    };
  }

  const next = soloPeriods.find((period) => gameDayStartMs(period.start) > timestampMs);
  if (!next) throw new Error("Forecast requires a future Solo Raid period.");
  return {
    start: currentDay,
    end: gameDayStartMs(next.start) + DAY_MS,
    scheduleStatus: next.scheduleStatus,
  };
}

function soloGainWithin(period: ParsedPeriod, from: number, until: number): SupplyGain {
  const firstDay = gameDayStartMs(period.start);
  const activeUntil = periodActiveUntil(period);
  const result = zeroGain();
  for (let day = firstDay, dayNumber = 1; day < activeUntil; day += DAY_MS, dayNumber += 1) {
    if (day < from || day > until) continue;
    addScaled(
      result,
      dayNumber === 1
        ? SOLO_DAILY_EXPECTED_GAIN.day1
        : dayNumber === 2
          ? SOLO_DAILY_EXPECTED_GAIN.day2
          : SOLO_DAILY_EXPECTED_GAIN.day3AndLater,
      1,
    );
  }
  return result;
}

export function gameDayStartCeilMs(timestampMs: number) {
  const start = gameDayStartMs(timestampMs);
  return start >= timestampMs ? start : start + DAY_MS;
}

function periodActiveUntil(period: ParsedPeriod) {
  return gameDayStartCeilMs(period.end);
}

function combinedScheduleStatus(...periods: readonly ParsedScheduledPeriod[]) {
  return periods.some((period) => period.scheduleStatus === "estimated")
    ? ("estimated" as const)
    : ("confirmed" as const);
}

function parseScheduledPeriods(
  periods: readonly ScheduledRewardPeriod[],
  label: string,
): ParsedScheduledPeriod[] {
  return periods.map((period, index) => ({
    ...parsePeriod(period, `${label}[${index}]`),
    scheduleStatus: period.scheduleStatus,
  }));
}

function parsePeriods(periods: readonly CollaborationPeriod[], label: string): ParsedPeriod[] {
  return periods.map((period, index) => parsePeriod(period, `${label}[${index}]`));
}

function parsePeriod(period: CollaborationPeriod, label: string): ParsedPeriod {
  const start = parseTimestamp(period.effectiveFrom, `${label}.effectiveFrom`);
  const end = parseTimestamp(period.effectiveUntil, `${label}.effectiveUntil`);
  if (end <= start) throw new Error(`${label} is inverted.`);
  return { start, end };
}

function assertOrderedNonOverlapping(periods: readonly ParsedPeriod[], label: string) {
  for (let index = 1; index < periods.length; index += 1) {
    const previous = periods[index - 1];
    const current = periods[index];
    if (!previous || !current) throw new Error(`${label} sequence is incomplete.`);
    if (current.start < previous.start) throw new Error(`${label} must be ordered.`);
    if (current.start < previous.end) throw new Error(`${label} must not overlap.`);
  }
}

function enumerateWeightedDraws(kept: readonly number[], drawCount: number) {
  type Draw = { counts: number[]; probability: number };
  let states = new Map<string, Draw>([
    [
      Array(DISPATCH_REWARDS.length).fill(0).join(","),
      {
        counts: Array<number>(DISPATCH_REWARDS.length).fill(0),
        probability: 1,
      },
    ],
  ]);
  for (let drawIndex = 0; drawIndex < drawCount; drawIndex += 1) {
    const next = new Map<string, Draw>();
    for (const state of states.values()) {
      let totalWeight = 0;
      for (const [index, reward] of DISPATCH_REWARDS.entries()) {
        totalWeight +=
          (reward.count - countAt(kept, index) - countAt(state.counts, index)) * reward.probability;
      }
      for (const [index, reward] of DISPATCH_REWARDS.entries()) {
        const available = reward.count - countAt(kept, index) - countAt(state.counts, index);
        if (available <= 0) continue;
        const counts = state.counts.slice();
        counts[index] = countAt(counts, index) + 1;
        const probability = state.probability * ((available * reward.probability) / totalWeight);
        const key = counts.join(",");
        const current = next.get(key);
        if (current) current.probability += probability;
        else next.set(key, { counts, probability });
      }
    }
    states = next;
  }
  return states.values();
}

function parseTimestamp(value: string, label: string) {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error(`${label} must include an offset.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function zeroGain(): SupplyGain {
  return { blue: 0, purple: 0, yellow: 0 };
}

function addScaled(target: SupplyGain, gain: SupplyGain, scale: number) {
  target.blue += gain.blue * scale;
  target.purple += gain.purple * scale;
  target.yellow += gain.yellow * scale;
}

function scaleGain(gain: SupplyGain, scale: number): SupplyGain {
  return { blue: gain.blue * scale, purple: gain.purple * scale, yellow: gain.yellow * scale };
}

function addGains(...gains: readonly SupplyGain[]) {
  const result = zeroGain();
  for (const gain of gains) addScaled(result, gain, 1);
  return result;
}

function averageGain(gains: readonly SupplyGain[]) {
  return scaleGain(addGains(...gains), 1 / gains.length);
}

function roundGain(gain: SupplyGain): SupplyGain {
  return {
    blue: Number(gain.blue.toFixed(9)),
    purple: Number(gain.purple.toFixed(9)),
    yellow: Number(gain.yellow.toFixed(9)),
  };
}

function countAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Dispatch state is missing reward index ${index}.`);
  return value;
}
