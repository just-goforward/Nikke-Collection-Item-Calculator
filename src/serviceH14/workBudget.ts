import { WorkBudget } from '../certified/budget.ts';
import type { CertifiedOptions } from '../certified/types.ts';
import { serviceH14DeadlineMs } from './deadline.ts';
import type { ServiceH14Input } from './types.ts';

/** One immutable foreground clock, including trust, preparation and final publication. */
export class ServiceH14WorkBudget extends WorkBudget {
  constructor(input: ServiceH14Input, options: CertifiedOptions, started: number) {
    super({ ...options, requestDurationMs: serviceH14DeadlineMs(input), maxManagedPayloadBytes: Math.min(options.maxManagedPayloadBytes ?? 160 * 1024 * 1024, 160 * 1024 * 1024) }, started);
  }
}
