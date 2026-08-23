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

export type ScheduleProfileInput = {
  forecastId: string;
  effectiveFrom: string;
  nextSoloStart: string;
  scheduleStatus: "confirmed" | "estimated";
  collaborationPeriods: readonly CollaborationPeriod[];
};

const DAY_MS = 86_400_000;
const KST_SHIFT_TO_GAME_DATE_MS = 4 * 60 * 60 * 1000;

export const SUPPLY_RULES_VERSION = "schedule-kit-v1" as const;
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

export const SOLO_REMAINING_GAIN = {
  beforeStart: { blue: 108.4, purple: 11.2, yellow: 4 },
  afterDay1: { blue: 79.6, purple: 8.8, yellow: 4 },
  afterDay2: { blue: 42, purple: 4.8, yellow: 2.4 },
  afterDay3: { blue: 0, purple: 0, yellow: 0 },
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
  const soloStart = parseTimestamp(input.nextSoloStart, "nextSoloStart");

  const soloDay1Start = gameDayStartMs(soloStart);
  const soloDay2Start = soloDay1Start + DAY_MS;
  const soloDay3Start = soloDay2Start + DAY_MS;
  const cutoff = soloDay3Start + DAY_MS;
  if (cutoff <= effectiveFrom) {
    return [
      {
        id: `${input.forecastId}@${new Date(effectiveFrom).toISOString()}`,
        effectiveFrom: new Date(effectiveFrom).toISOString(),
        effectiveUntil: null,
        scheduleStatus: input.scheduleStatus,
        expectedGain: { ...SOLO_REMAINING_GAIN.afterDay3 },
      },
    ];
  }
  if (cutoff - effectiveFrom > 56 * DAY_MS) {
    throw new Error("Forecast cycle must span at most 56 days.");
  }

  const collaborationPeriods = input.collaborationPeriods.map((period, index) => {
    const start = parseTimestamp(
      period.effectiveFrom,
      `collaborationPeriods[${index}].effectiveFrom`,
    );
    const end = parseTimestamp(
      period.effectiveUntil,
      `collaborationPeriods[${index}].effectiveUntil`,
    );
    if (end <= start) throw new Error(`collaborationPeriods[${index}] is inverted.`);
    return { start, end };
  });

  const boundaries = new Set<number>([effectiveFrom, soloStart, cutoff]);
  for (let reset = nextGameDayStartMs(effectiveFrom); reset < cutoff; reset += DAY_MS) {
    boundaries.add(reset);
  }
  const ordered = [...boundaries]
    .filter((value) => value >= effectiveFrom && value <= cutoff)
    .sort((a, b) => a - b);
  const profiles: SupplyForecastProfile[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const from = ordered[index];
    const until = ordered[index + 1];
    if (from === undefined || until === undefined) {
      throw new Error("Forecast boundary sequence is incomplete.");
    }
    const futureResets = gameDayStartsBetween(from, cutoff);
    const dispatch = scaleGain(DISPATCH_DAILY_EXPECTED_GAIN, futureResets.length);
    const coopBoxCount = futureResets.reduce((count, reset) => {
      if (!isKstTuesday(reset)) return count;
      const collaboration = collaborationPeriods.some(
        (period) => reset >= period.start && reset < period.end,
      );
      return count + (collaboration ? 10 : 5);
    }, 0);
    const gain = addGains(
      dispatch,
      scaleGain(YELLOW_BOX_GAIN, coopBoxCount),
      soloGainAt(from, soloStart, soloDay2Start, soloDay3Start),
    );
    profiles.push({
      id: `${input.forecastId}@${new Date(from).toISOString()}`,
      effectiveFrom: new Date(from).toISOString(),
      effectiveUntil: new Date(until).toISOString(),
      scheduleStatus: input.scheduleStatus,
      expectedGain: roundGain(gain),
    });
  }
  const finalProfile = profiles.at(-1);
  if (!finalProfile) throw new Error("Forecast cycle did not produce any profiles.");
  finalProfile.effectiveUntil = null;
  assertMonotonicProfiles(profiles);
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

function gameDayStartsBetween(fromExclusive: number, untilExclusive: number) {
  const result: number[] = [];
  for (let reset = nextGameDayStartMs(fromExclusive); reset < untilExclusive; reset += DAY_MS)
    result.push(reset);
  return result;
}

function isKstTuesday(timestampMs: number) {
  return new Date(timestampMs + 9 * 60 * 60 * 1000).getUTCDay() === 2;
}

function soloGainAt(
  from: number,
  soloStart: number,
  day2Start: number,
  day3Start: number,
): SupplyGain {
  if (from < soloStart) return { ...SOLO_REMAINING_GAIN.beforeStart };
  if (from < day2Start) return { ...SOLO_REMAINING_GAIN.afterDay1 };
  if (from < day3Start) return { ...SOLO_REMAINING_GAIN.afterDay2 };
  return { ...SOLO_REMAINING_GAIN.afterDay3 };
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

function assertMonotonicProfiles(profiles: readonly SupplyForecastProfile[]) {
  for (let index = 1; index < profiles.length; index += 1) {
    const previousProfile = profiles[index - 1];
    const currentProfile = profiles[index];
    if (!previousProfile || !currentProfile) {
      throw new Error("Forecast profile sequence is incomplete.");
    }
    const previous = previousProfile.expectedGain;
    const current = currentProfile.expectedGain;
    if (
      current.blue > previous.blue ||
      current.purple > previous.purple ||
      current.yellow > previous.yellow
    ) {
      throw new Error(`Forecast profiles are not monotonic at ${currentProfile.id}.`);
    }
  }
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
