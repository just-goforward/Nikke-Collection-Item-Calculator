import { add, div, mul, q, ZERO, type Q } from '../../shared/certifiedRational.ts';
import { getCertifiedLawExpectedGain } from '../../shared/certifiedSupplyLaws.ts';
import type { JointSourceDescriptor } from './types.ts';

/** Use admitted, unprojected raw pieces. Omit axes with no horizon supply;
 * when all axes are inactive the supply component is zero (time still counts). */
export function balancedThresholdTicks(source: JointSourceDescriptor, priors: readonly Q[], check: () => void): number[] {
  const axes = [0, 1, 2] as const;
  const gains = Array.from({length: 15}, (): [Q,Q,Q] => [ZERO,ZERO,ZERO]);
  const cache = new Map<string, [Q,Q,Q]>();
  for (const {day, refs} of source.events) {
    if (day < 0 || day > 14) continue;
    for (const {lawId, count} of refs) {
      check();
      if (!count) continue;
      let gain = cache.get(lawId);
      if (!gain) {
        gain = [ZERO,ZERO,ZERO];
        for (const c of [0,1,2,3] as const) {
          const weight = priors[c];
          if (!weight?.n) continue;
          const pieces = getCertifiedLawExpectedGain({lawId,count:1}, c, {laws:source.laws,checkBudget:check});
          for (const k of axes) gain[k] = add(gain[k], mul(weight,pieces[k]));
        }
        cache.set(lawId,gain);
      }
      for (const k of axes) gains[day]![k] = add(gains[day]![k],mul(q(count),gain[k]));
    }
  }
  for (let d=1; d<=14; d++) for (const k of axes) gains[d]![k] = add(gains[d-1]![k],gains[d]![k]);
  const total = gains[14]!, active = axes.filter(k => total[k].n !== 0n);
  return gains.map((pieces,day) => {
    check();
    const fraction = active.length ? div(active.reduce((sum,k) => add(sum,div(pieces[k],total[k])),ZERO),q(active.length)) : ZERO;
    const ticks = add(q(50),mul(q(175),add(q(day,14),fraction)));
    return Number((2n*ticks.n + ticks.d)/(2n*ticks.d));
  });
}
