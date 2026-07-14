const numberFormatters = new Map<number, Intl.NumberFormat>();
const integerFormatter = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

function numberFormatter(digits: number) {
  const cached = numberFormatters.get(digits);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  numberFormatters.set(digits, formatter);
  return formatter;
}

export function formatNumber(value: number, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return numberFormatter(digits).format(value);
}

export function formatInteger(value: number) {
  return integerFormatter.format(value);
}

export function formatFlooredPercent(value: number, digits = 1) {
  const unit = 10 ** digits;
  const floored = Math.floor(value * 100 * unit) / unit;
  return `${formatNumber(floored, digits)}%`;
}
