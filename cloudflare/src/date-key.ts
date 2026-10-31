const KST_OFFSET_SECONDS = 9 * 60 * 60;
const GAME_DAY_BOUNDARY_SECONDS = 5 * 60 * 60;

export const LEGACY_STATISTICS_DATE_BASIS = "kst_calendar_date_v1" as const;
export const CURRENT_STATISTICS_DATE_BASIS = "kst_game_day_0500_v2" as const;

export const STATISTICS_DATE_CONTRACT = {
  legacy: {
    id: LEGACY_STATISTICS_DATE_BASIS,
    boundary: "00:00:00+09:00",
    acceptsNewWrites: false,
  },
  current: {
    id: CURRENT_STATISTICS_DATE_BASIS,
    boundary: "05:00:00+09:00",
    acceptsNewWrites: true,
  },
} as const;

export function kstDateKeyFromUnixSeconds(seconds: number) {
  return new Date((seconds + KST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

export function kstGameDateKeyFromUnixSeconds(seconds: number) {
  return new Date((seconds + KST_OFFSET_SECONDS - GAME_DAY_BOUNDARY_SECONDS) * 1000)
    .toISOString()
    .slice(0, 10);
}
