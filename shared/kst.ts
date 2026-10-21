const WEEKDAYS = "일월화수목금토";

/** Every instant is shown as KST `MM/DD(요일) HH:mm`; never a raw ISO string. */
export function kstLabel(instant: string): string {
  const at = Date.parse(instant);
  if (!Number.isFinite(at)) return "시각 확인 필요";
  return kst(at);
}

export function kst(at: number): string {
  const value = new Date(at + 9 * 3_600_000).toISOString();
  return `${value.slice(5, 7)}/${value.slice(8, 10)}(${WEEKDAYS[new Date(at + 9 * 3_600_000).getUTCDay()]}) ${value.slice(11, 16)}`;
}
