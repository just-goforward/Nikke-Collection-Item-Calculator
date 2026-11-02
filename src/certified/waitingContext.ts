import type { Q } from "../../shared/certifiedRational";
import type { FiniteKernel } from "./kernel";
import type { CertifiedInput, CertifiedValue, CompletedDate } from "./types";
import type { ExactValue } from "./value";

export interface WaitingContext {
  input: CertifiedInput;
  sid: number;
  current: ExactValue;
  kernel: FiniteKernel;
  priors: readonly Q[];
  view: (value: ExactValue) => CertifiedValue;
  completedDates?: CompletedDate[];
}
