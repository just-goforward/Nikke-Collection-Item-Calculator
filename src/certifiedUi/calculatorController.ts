import type { Dispatch, SetStateAction } from "react";
import type {
  CertifiedSupplyComparison,
  CertifiedSupplyEvent,
  CertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import type { Grade, Stock } from "../types";
import type { StatePanelModel, StockCorrectionView, SuccessAttemptModalState } from "../ui-types";
import type { CertifiedSession } from "./session";
import type { useCertifiedRun } from "./useCertifiedRun";

export type CertifiedCalculatorController = {
  session: CertifiedSession;
  updateSession: Dispatch<SetStateAction<CertifiedSession>>;
  snapshot: CertifiedSupplySnapshot | null;
  prepareError: boolean;
  comparison: CertifiedSupplyComparison | null;
  claims: readonly CertifiedSupplyEvent[];
  run: ReturnType<typeof useCertifiedRun>;
  statePanel: StatePanelModel;
  stock: Stock;
  calculateDisabled: boolean;
  inputLocked: boolean;
  storageBlocked: boolean;
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
