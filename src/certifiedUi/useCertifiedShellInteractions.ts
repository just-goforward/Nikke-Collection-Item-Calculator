import { useState } from "react";
import type { useAppShellNavigation } from "../hooks/useAppShellNavigation";
import type { CertifiedOutcome } from "./CertifiedResultPanels";
import type { CertifiedCalculatorController } from "./calculatorController";
import { showCertifiedRunResults } from "./runStatus";
import type { CertifiedSession } from "./session";

type ShellNavigation = ReturnType<typeof useAppShellNavigation<() => void>>;

/**
 * Bridges the certified controller to the shared shell: which native result may be shown,
 * which actions are permitted, and how each action moves the mobile tabs.
 */
export function useCertifiedShellInteractions(
  controller: CertifiedCalculatorController,
  shell: ShellNavigation,
) {
  const [cancelledSession, setCancelledSession] = useState<CertifiedSession | null>(null);
  const { actions, run } = controller;
  const { setMobileViewTab } = shell;
  const showResults = showCertifiedRunResults(run.error, run.result);
  // Malformed storage also blocks the session, but it is recovered through the global banner;
  // only an actual pending stock correction asks the user to edit stock.
  const pendingCorrection = controller.stockCorrection !== null;
  const correctionRequired = controller.stockCorrectionRequired;
  const toast = shell.resetToast;

  return {
    showResults,
    current: showResults ? (run.result?.current ?? null) : null,
    pendingCorrection,
    inputSessionLocked: controller.inputLocked || correctionRequired,
    actionsDisabled:
      run.busy || controller.inputLocked || correctionRequired || controller.modal.open,
    conversionRequired: controller.statePanel.grade === "R" && controller.statePanel.level === 15,
    // A user cancellation is silent in the run hook; show it until the session or run changes.
    // Any exact current result already delivered stays visible through showCertifiedRunResults.
    cancelled: cancelledSession === controller.session && !run.busy && !run.error,
    resetToast: toast
      ? {
          secondsLeft: toast.secondsLeft,
          onUndo: () => {
            toast.payload();
            setMobileViewTab("input", true);
            shell.clearResetToast();
          },
        }
      : null,
    onCalculate: () => {
      if (controller.calculateDisabled) return;
      setCancelledSession(null);
      setMobileViewTab("result", true);
      void actions.calculate();
    },
    onCancel: () => {
      setCancelledSession(controller.session);
      run.cancel();
    },
    onReset: () => {
      if (run.busy || controller.modal.open) return;
      const undo = actions.reset();
      setMobileViewTab("input", true);
      shell.showResetToast(undo);
    },
    onOutcome: (outcome: CertifiedOutcome) => {
      actions.applyOutcome(outcome);
      setMobileViewTab("result", true);
    },
    onConvert: () => {
      actions.convert();
      setMobileViewTab("result", true);
    },
    onSubmitSuccessAttempt: (attempt: number | null) => {
      actions.submitSuccessAttempt(attempt);
      // An unknown success attempt leaves a stock correction that is resolved on the input tab.
      setMobileViewTab(attempt === null ? "input" : "result", true);
    },
  };
}

export type CertifiedShellInteractions = ReturnType<typeof useCertifiedShellInteractions>;
