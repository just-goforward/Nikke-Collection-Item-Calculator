const DAY_MS = 86_400_000;
const NAVER_DETAIL_PREFIX = "https://game.naver.com/lounge/nikke/board/detail/";

export type SoloRaidRoundStatus =
  | "as_announced"
  | "rescheduled"
  | "schedule_changed"
  | "reconstructed";

export type SoloRaidRound = {
  round: number;
  startGameDate: string;
  status: SoloRaidRoundStatus;
  sourceFeedId: number;
};

// New rounds only. Interrupted and reopened segments stay attached to their original round.
export const SOLO_RAID_ROUND_HISTORY = [
  round(1, "2023-05-11", "as_announced", 1950871),
  round(2, "2023-06-08", "as_announced", 2055448),
  round(3, "2023-07-13", "as_announced", 2336639),
  round(4, "2023-08-10", "as_announced", 2501590),
  round(5, "2023-09-14", "as_announced", 2744161),
  round(6, "2023-10-12", "as_announced", 2878411),
  round(7, "2023-11-09", "as_announced", 3022731),
  round(8, "2023-12-14", "rescheduled", 3276396),
  round(9, "2024-01-04", "as_announced", 3354291),
  round(10, "2024-02-09", "as_announced", 3523796),
  round(11, "2024-03-08", "as_announced", 3668690),
  round(12, "2024-04-04", "as_announced", 3841536),
  round(13, "2024-05-02", "as_announced", 3975245),
  round(14, "2024-06-06", "as_announced", 4191267),
  round(15, "2024-07-11", "as_announced", 4375422),
  round(16, "2024-08-02", "as_announced", 4514386),
  round(17, "2024-09-05", "as_announced", 4691557),
  round(18, "2024-10-03", "as_announced", 4823662),
  round(19, "2024-10-31", "schedule_changed", 5013873),
  round(20, "2024-12-12", "as_announced", 5250302),
  round(21, "2025-01-09", "as_announced", 5414775),
  round(22, "2025-02-06", "as_announced", 5558577),
  round(23, "2025-03-06", "as_announced", 5689969),
  round(24, "2025-04-03", "as_announced", 5815120),
  round(25, "2025-05-08", "as_announced", 5968589),
  round(26, "2025-06-19", "schedule_changed", 6225681),
  round(27, "2025-07-24", "as_announced", 6383981),
  round(28, "2025-08-21", "schedule_changed", 6579018),
  round(29, "2025-09-16", "as_announced", 6674249),
  round(30, "2025-10-09", "as_announced", 6748668),
  round(31, "2025-11-13", "as_announced", 6916387),
  round(32, "2025-12-11", "as_announced", 7034442),
  round(33, "2026-01-08", "as_announced", 7138616),
  round(34, "2026-02-19", "as_announced", 7298679),
  round(35, "2026-03-20", "as_announced", 7409051),
  round(36, "2026-04-30", "as_announced", 7576019),
  round(37, "2026-05-28", "reconstructed", 7699562),
  round(38, "2026-06-18", "schedule_changed", 7833931),
  round(39, "2026-07-16", "as_announced", 7911818),
  round(40, "2026-08-20", "as_announced", 8060044),
] as const satisfies readonly SoloRaidRound[];

export type SoloRaidCadenceSummary = {
  rounds: number;
  intervals: number;
  medianDays: number;
  meanDays: number;
  minimumDays: number;
  maximumDays: number;
  frequency: Readonly<Record<number, number>>;
};

export const SOLO_RAID_CADENCE_SUMMARY = summarizeSoloRaidCadence(
  SOLO_RAID_ROUND_HISTORY.map((entry) => entry.startGameDate),
);

/** The unreduced observed numerator/count retains the frequency's provenance. */
export type ExactSoloRaidCadence = {
  version: "observed-mean-thursday-v1";
  numerator: number;
  denominator: number;
  rounds: number;
  intervals: number;
  fromGameDate: string;
  untilGameDate: string;
  minimumDays: number;
  maximumDays: number;
  sourceStatuses: Readonly<Record<SoloRaidRoundStatus, number>>;
  sourceUrls: readonly string[];
};

export function deriveExactSoloRaidCadence(
  confirmedRounds: readonly SoloRaidRound[] = SOLO_RAID_ROUND_HISTORY,
): ExactSoloRaidCadence {
  const ordered = [...confirmedRounds].sort((a, b) => a.round - b.round);
  const summary = summarizeSoloRaidCadence(ordered.map((entry) => entry.startGameDate));
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.round !== ordered[index - 1]!.round + 1) {
      throw new Error("solo_raid_history_round_gap");
    }
  }
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const sourceStatuses: Record<SoloRaidRoundStatus, number> = {
    as_announced: 0,
    rescheduled: 0,
    schedule_changed: 0,
    reconstructed: 0,
  };
  for (const entry of ordered) sourceStatuses[entry.status] += 1;
  return {
    version: "observed-mean-thursday-v1",
    numerator: (dateEpoch(last.startGameDate) - dateEpoch(first.startGameDate)) / DAY_MS,
    denominator: summary.intervals,
    rounds: summary.rounds,
    intervals: summary.intervals,
    fromGameDate: first.startGameDate,
    untilGameDate: last.startGameDate,
    minimumDays: summary.minimumDays,
    maximumDays: summary.maximumDays,
    sourceStatuses,
    sourceUrls: ordered.filter((entry) => entry.sourceFeedId > 0).map(soloRaidSourceUrl),
  };
}

export type CertifiedSoloEstimate = { round: number; startGameDate: string };

/** Snap anchor + k * mean independently; never recur from an already rounded date. */
export function estimateCertifiedSoloRounds(input: {
  anchor: Pick<SoloRaidRound, "round" | "startGameDate">;
  cadence: Pick<ExactSoloRaidCadence, "numerator" | "denominator">;
  count: number;
  offsetDays?: number;
}): CertifiedSoloEstimate[] {
  const { numerator, denominator } = input.cadence;
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  )
    throw new Error("solo_raid_cadence_invalid");
  if (!Number.isSafeInteger(input.count) || input.count < 0 || input.count > 10000)
    throw new Error("solo_raid_estimate_count_invalid");
  const offset = input.offsetDays ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("solo_raid_delay_invalid");
  const anchorDay = BigInt(dateEpoch(input.anchor.startGameDate) / DAY_MS);
  const den = BigInt(denominator);
  const week = 7n * den;
  return Array.from({ length: input.count }, (_, index) => {
    const target = anchorDay * den + BigInt(numerator) * BigInt(index + 1);
    let quotient = target / week;
    if (target < 0n && target % week !== 0n) quotient -= 1n;
    const earlier = quotient * 7n;
    const later = earlier + 7n;
    const snapped = target - earlier * den < later * den - target ? earlier : later;
    return {
      round: input.anchor.round + index + 1,
      startGameDate: new Date((Number(snapped) + offset) * DAY_MS).toISOString().slice(0, 10),
    };
  });
}

export function soloRaidSourceUrl(entry: SoloRaidRound) {
  return `${NAVER_DETAIL_PREFIX}${entry.sourceFeedId}`;
}

export function deriveSoloRaidCadenceDays(additionalStartGameDates: readonly string[] = []) {
  const latestKnown = dateEpoch(SOLO_RAID_ROUND_HISTORY.at(-1)?.startGameDate ?? "");
  const starts = [
    ...SOLO_RAID_ROUND_HISTORY.map((entry) => entry.startGameDate),
    ...additionalStartGameDates.filter((value) => dateEpoch(value) > latestKnown),
  ];
  return summarizeSoloRaidCadence([...new Set(starts)]).medianDays;
}

export function summarizeSoloRaidCadence(
  startGameDates: readonly string[],
): SoloRaidCadenceSummary {
  if (startGameDates.length < 2) throw new Error("solo_raid_history_too_short");
  const epochs = startGameDates.map(dateEpoch);
  for (let index = 1; index < epochs.length; index += 1) {
    if ((epochs[index] ?? 0) <= (epochs[index - 1] ?? 0)) {
      throw new Error("solo_raid_history_not_strictly_increasing");
    }
  }
  const intervals = epochs.slice(1).map((value, index) => {
    const days = (value - (epochs[index] ?? value)) / DAY_MS;
    if (!Number.isInteger(days) || days <= 0) throw new Error("solo_raid_interval_invalid");
    return days;
  });
  const sorted = [...intervals].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianDays =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const frequency: Record<number, number> = {};
  for (const days of intervals) frequency[days] = (frequency[days] ?? 0) + 1;
  return {
    rounds: epochs.length,
    intervals: intervals.length,
    medianDays,
    meanDays: intervals.reduce((sum, days) => sum + days, 0) / intervals.length,
    minimumDays: Math.min(...intervals),
    maximumDays: Math.max(...intervals),
    frequency,
  };
}

function round(
  roundNumber: number,
  startGameDate: string,
  status: SoloRaidRoundStatus,
  sourceFeedId: number,
): SoloRaidRound {
  return { round: roundNumber, startGameDate, status, sourceFeedId };
}

function dateEpoch(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("solo_raid_game_date_invalid");
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value)
    throw new Error("solo_raid_game_date_invalid");
  return epoch;
}
