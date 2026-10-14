import type { ComponentProps } from "react";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import { AppShell } from "../AppLayout";
import { AccountControl } from "../account/AccountControl";
import { useAccountBootLocked } from "../account/bootGate";
import { useAppShellNavigation } from "../hooks/useAppShellNavigation";
import { useStatsQuery } from "../hooks/useStatsQuery";
import { useTheme } from "../hooks/useTheme";
import { useI18n } from "../i18n/locale";
import {
  CertifiedBanner,
  CertifiedMobileActions,
  CertifiedResultRegion,
} from "./CertifiedShellChrome";
import { ClaimsPanel, CohortPanel } from "./CertifiedSupplyPanels";
import type { CertifiedCalculatorController } from "./calculatorController";
import { type CertifiedWords, certifiedMessages } from "./messages";
import { useCertifiedCalculatorApp } from "./useCertifiedCalculatorApp";
import {
  type CertifiedShellInteractions,
  useCertifiedShellInteractions,
} from "./useCertifiedShellInteractions";
import "./certified.css";

/** Shared StatePanel/StockPanel plus the certified-only reroll type and receipt inputs. */
function certifiedInputPanels(
  controller: CertifiedCalculatorController,
  ui: CertifiedShellInteractions,
  words: CertifiedWords,
): ComponentProps<typeof AppShell>["inputPanels"] {
  const { actions } = controller;
  return {
    state: {
      disabled: ui.inputSessionLocked,
      state: controller.statePanel,
      onGradeChange: actions.setGrade,
      onLevelChange: actions.setLevel,
      onExpChange: actions.setExp,
    },
    stock: {
      stock: controller.stock,
      // Malformed storage is recovered globally; only a real pending correction needs a stock edit.
      needsStockEdit: ui.pendingCorrection,
      correction: controller.stockCorrection,
      isStale: false,
      stockStale: false,
      notice: { key: "stock.notice" },
      onStockChange: actions.setStock,
      description: { key: "solver.strategySupply" },
      calculateDisabled: controller.calculateDisabled,
      loading: controller.run.busy,
      disabled: controller.inputLocked,
      onCalculate: ui.onCalculate,
      onReset: ui.onReset,
    },
    extra: (
      <>
        <CohortPanel
          disabled={ui.inputSessionLocked}
          session={controller.session}
          onUpdate={controller.updateSession}
          words={words}
        />
        {controller.snapshot && (
          <ClaimsPanel
            claims={controller.claims}
            disabled={ui.inputSessionLocked}
            snapshot={controller.snapshot}
            session={controller.session}
            onUpdate={controller.updateSession}
            words={words}
          />
        )}
      </>
    ),
  };
}

/** While the optional account check runs, every session-changing action is inert. */
function readOnlyInteractions(ui: CertifiedShellInteractions): CertifiedShellInteractions {
  const idle = () => undefined;
  return { ...ui, onCalculate: idle, onReset: idle, onConvert: idle, onOutcome: idle };
}

export default function CertifiedCalculator() {
  const { locale } = useI18n();
  const words = certifiedMessages[locale];
  const app = useCertifiedCalculatorApp();
  const accountChecking = useAccountBootLocked();
  // The account binding keeps the engine's own lock; only the shown inputs are read-only.
  const controller = accountChecking ? { ...app, inputLocked: true, calculateDisabled: true } : app;
  const shell = useAppShellNavigation<() => void>();
  const theme = useTheme(controller.statePanel.grade);
  const stats = useStatsQuery(shell.statsVisible);
  const interactions = useCertifiedShellInteractions(controller, shell);
  const ui = accountChecking ? readOnlyInteractions(interactions) : interactions;
  const chrome = { controller, ui, words };

  return (
    <AppShell
      accountControl={
        <AccountControl
          kind="certified-session"
          changeToken={app.accountToken}
          inputLocked={app.run.busy || app.modal.open}
          port={app.accountPort}
          onSwitched={shell.clearResetToast}
        />
      }
      banner={<CertifiedBanner {...chrome} />}
      engineProfile={CERTIFIED_STAGING_ENGINE_PROFILE.id}
      hasResult={ui.current !== null}
      inputPanels={certifiedInputPanels(controller, ui, words)}
      mobileActions={<CertifiedMobileActions {...chrome} />}
      mobileTab={shell.mobileTab}
      modal={controller.modal}
      onSubmitSuccessAttempt={ui.onSubmitSuccessAttempt}
      onTabChange={(tab) => shell.setMobileViewTab(tab)}
      onThemeModeChange={theme.setThemeMode}
      onViewTabChange={shell.setViewTab}
      resetToast={ui.resetToast}
      result={<CertifiedResultRegion {...chrome} />}
      stateFeedback={null}
      stats={{ view: stats.statsView, onRetry: stats.retryStats }}
      themeMode={theme.themeMode}
      viewTab={shell.viewTab}
    />
  );
}
