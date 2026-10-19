import type { Dispatch, SetStateAction } from "react";
import type {
  CertifiedSupplyComparison,
  CertifiedSupplyEvent,
  CertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import type { Grade, Stock } from "../types";
import type { StatePanelModel, StockCorrectionView, SuccessAttemptModalState } from "../ui-types";
import type { CertifiedAccountDeps } from "./accountSession";
import type { CertifiedSession } from "./session";
import type { CertifiedPrepareError } from "./useCertifiedCalculatorPreparation";
import type { useCertifiedRun } from "./useCertifiedRun";

export type CertifiedCalculatorController = {
  /** Session store references for the optional account control (which creates its port). */
  accountDeps: CertifiedAccountDeps;
  /** Changes identity whenever the persisted session (or pending correction) changes. */
  accountToken: object;
  session: CertifiedSession;
  updateSession: Dispatch<SetStateAction<CertifiedSession>>;
  snapshot: CertifiedSupplySnapshot | null;
  prepareError: CertifiedPrepareError | null;
  comparison: CertifiedSupplyComparison | null;
  claims: readonly CertifiedSupplyEvent[];
  run: ReturnType<typeof useCertifiedRun>;
  statePanel: StatePanelModel;
  stock: Stock;
  calculateDisabled: boolean;
  inputLocked: boolean;
  storageBlocked: boolean;
  /** The latest session write was refused by the browser; cleared by the next successful write. */
  sessionSaveFailed: boolean;
  stockCorrectionRequired: boolean;
  stockCorrection: StockCorrectionView | null;
  modal: SuccessAttemptModalState;
  actionError: string | null;
  actions: {
    setGrade: (grade: Grade) => void;
    setLevel: (level: number) => void;
    setExp: (exp: number) => void;
    setStock: (stock: Stock) => void;
    calculate: () => Promise<void>;
    applyOutcome: (outcome: "normal" | "great") => void;
    submitSuccessAttempt: (attempt: number | null) => void;
    convert: () => void;
    reset: () => () => void;
  };
};
