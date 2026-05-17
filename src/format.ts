export function formatNumber(value: number, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatInteger(value: number) {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(value);
}

export function formatPercent(value: number, digits = 2) {
  return `${formatNumber(value * 100, digits)}%`;
}

export function formatFlooredPercent(value: number, digits = 1) {
  const unit = 10 ** digits;
  const floored = Math.floor(value * 100 * unit) / unit;
  return `${formatNumber(floored, digits)}%`;
}
