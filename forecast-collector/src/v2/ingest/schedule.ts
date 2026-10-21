export const streams = {
  A: { board: 11, keyword: "관리 키트" },
  B: { board: 11, keyword: "솔로 레이드" },
  "C-open": { board: 56, keyword: "솔로 레이드 오픈" },
  "C-reopen": { board: 56, keyword: "솔로 레이드 재오픈" },
  D: { board: 56, keyword: "콜라보" },
  E: { board: 48, keyword: "솔로 레이드 시즌" },
  F: { board: 48, keyword: "관리 키트" },
  G: { board: 48, keyword: null },
} as const;
export type Stream = keyof typeof streams;
export const EDIT_SCAN_INTERVAL_MS = 6 * 60 * 60_000;
const slots: Readonly<Record<number, Stream>> = {
  0: "A",
  3: "G",
  6: "B",
  12: "C-open",
  18: "C-reopen",
  24: "D",
  33: "G",
  36: "F",
};
export function scheduledStream(time: number): Stream | null {
  return slots[new Date(time).getUTCMinutes()] ?? null;
}
export function v2Mode(env: { FORECAST_V2_MODE?: string }): "off" | "hold" | "on" {
  return env.FORECAST_V2_MODE === "on" || env.FORECAST_V2_MODE === "hold"
    ? env.FORECAST_V2_MODE
    : "off";
}
export function budgetGameDay(time: number): string {
  return new Date(time + 4 * 3_600_000).toISOString().slice(0, 10);
}
