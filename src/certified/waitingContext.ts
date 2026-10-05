import type { Q } from "../../shared/certifiedRational";
import type { FiniteKernel } from "./kernel";
import type { CertifiedInput, CertifiedValue } from "./types";
import type { ExactValue } from "./value";

export interface WaitingContext {
  input: CertifiedInput;
  sid: number;
  current: ExactValue;
  kernel: FiniteKernel;
  priors: readonly [Q, Q, Q];
  view: (value: ExactValue) => CertifiedValue;
}
