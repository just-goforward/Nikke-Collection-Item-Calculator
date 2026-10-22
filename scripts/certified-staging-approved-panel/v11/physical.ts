import { independentDispatchExpectations } from "../../certified-staging-oracle-physical-supply.ts";

export type ThreeCohorts = ReturnType<typeof independentDispatchExpectations>;
let enumerated: ThreeCohorts | undefined;

/** Exhaustive independent 0/1/2-reroll histories, never a fourth zero-weight cohort.
 * Reuse immutable enumeration within a reader process; artifact bytes are always rechecked. */
export function independentThreeCohorts(): ThreeCohorts {
  if (!enumerated) {
    enumerated = independentDispatchExpectations();
    for (const row of enumerated) {
      for (const value of row) Object.freeze(value);
      Object.freeze(row);
    }
    Object.freeze(enumerated);
  }
  return enumerated;
}
