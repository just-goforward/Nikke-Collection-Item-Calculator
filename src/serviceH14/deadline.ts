/** The R0 allowance applies only to a valid grade/level pair; full validation precedes compute. */
export function serviceH14DeadlineMs(state: { grade: unknown; level: unknown }): 15000 | 20000 {
  return state.grade === 'R' && state.level === 0 ? 20_000 : 15_000;
}

/** The absolute original wall-clock deadline was reached. Independent of the
 * caller's budget check, so a clock crossing between the two remains a deadline. */
export class ServiceH14DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceH14DeadlineError';
  }
}
