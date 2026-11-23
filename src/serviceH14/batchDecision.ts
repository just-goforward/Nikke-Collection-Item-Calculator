import { cmp, fromBinary64, q } from '../../shared/certifiedRational.ts';
import type { ApproxDate, BatchDecision } from './types.ts';

/** Binary endpoints are exact dyadics. Do not round h or 9/10 before comparison. */
export function batchDecision(records: readonly Pick<ApproxDate,'batchEvidence'>[]): BatchDecision {
  if (records.length !== 15) return { status: 'unavailable', day: null };
  if (!records[1]!.batchEvidence) return { status: 'no_action', day: null };
  for (let day = 1; day <= 14; day++) {
    const { mean, mass, thresholdTicks } = records[day]!.batchEvidence!;
    const h = q(thresholdTicks, 10000), quorum = q(9, 10);
    if (cmp(fromBinary64(mean.upper), h) <= 0 || cmp(fromBinary64(mass.upper), quorum) < 0) continue;
    if (cmp(fromBinary64(mean.lower), h) > 0 && cmp(fromBinary64(mass.lower), quorum) >= 0) return { status: 'wait', day };
    return { status: 'unresolved', day: null };
  }
  return { status: 'no_wait_basis', day: null };
}
