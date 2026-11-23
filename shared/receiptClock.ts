import { GAME_DAY_MS } from './gameDay.ts';

/** D0 is entered stock; Dd is the inclusive endpoint asOf + d * 24h. */
export const receiptDay = (asOf: number, at: number) => Math.ceil((at - asOf) / GAME_DAY_MS);

/** First future instant at which a receipt moves across a D0..D14 cutoff. */
export function nextReceiptPhase(asOf: number, at: number): number {
  if (at <= asOf) return Infinity;
  const offset = Math.min(14, receiptDay(asOf, at) - 1);
  return at - offset * GAME_DAY_MS;
}
