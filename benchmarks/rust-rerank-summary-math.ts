export function mean(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

export function weightedSum<T extends { weight: number }>(
  items: T[],
  valueFor: (item: T) => number,
) {
  return items.reduce((total, item) => total + valueFor(item) * item.weight, 0);
}
