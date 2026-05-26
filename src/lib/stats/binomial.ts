export type WilsonInterval = {
  high: number;
  low: number;
};

export function wilsonInterval(successes: number, attempts: number, z = 1.96): WilsonInterval {
  const n = Math.max(0, Math.floor(Number(attempts) || 0));
  if (n <= 0) return { high: 0, low: 0 };

  const k = Math.min(n, Math.max(0, Math.floor(Number(successes) || 0)));
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denominator;

  return {
    high: Math.min(1, center + margin),
    low: Math.max(0, center - margin),
  };
}
