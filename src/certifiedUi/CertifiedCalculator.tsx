import type { ComponentProps } from "react";
import { useState } from "react";
// Chunk layout only: the pure-data authority is evaluated first so that it does not split
// the calculator code across gzip windows (lazy-certified budget). It has no side effects.
import "../../shared/generated/certifiedForecastAuthority";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import { AppShell } from "../AppLayout";
import { AccountControl } from "../account/AccountControl";
import { accountFeatureEnabled } from "../account/config";
import { useAppShellNavigation } from "../hooks/useAppShellNavigation";
import { useStatsQuery } from "../hooks/useStatsQuery";
import { useStatsSubmission } from "../hooks/useStatsSubmission";
import { useTheme } from "../hooks/useTheme";
import { useI18n } from "../i18n/locale";
import { createCertifiedAccountPort } from "./accountSession";
import {
  CertifiedBanner,
  CertifiedMobileActions,
  CertifiedResultRegion,
} from "./CertifiedShellChrome";
import { CohortPanel } from "./CertifiedSupplyPanels";
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
      </>
    ),
  };
}

/** While the optional account control locks inputs, every session-changing action is inert. */
function readOnlyInteractions(ui: CertifiedShellInteractions): CertifiedShellInteractions {
  const idle = () => undefined;
  return { ...ui, onCalculate: idle, onReset: idle, onConvert: idle, onOutcome: idle };
}

export default function CertifiedCalculator() {
  const { locale } = useI18n();
  const words = certifiedMessages[locale];
  const shell = useAppShellNavigation<() => void>();
  const stats = useStatsQuery(shell.statsVisible);
  const queueStatsEvent = useStatsSubmission(stats.markSubmitted);
  const app = useCertifiedCalculatorApp(queueStatsEvent);
  // With the flag off this stays false and no account code runs (only the constant flag check).
  const [accountLocked, setAccountLocked] = useState(accountFeatureEnabled);
  // The account binding keeps the engine's own lock; only the shown inputs are read-only.
  const controller = accountLocked ? { ...app, inputLocked: true, calculateDisabled: true } : app;
  const theme = useTheme(controller.statePanel.grade);
  const interactions = useCertifiedShellInteractions(controller, shell);
  const ui = accountLocked ? readOnlyInteractions(interactions) : interactions;
  const chrome = { controller, ui, words };

  return (
    <AppShell
      accountControl={
        accountFeatureEnabled() ? (
          <AccountControl
            kind="certified-session"
            changeToken={app.accountToken}
            createPort={createCertifiedAccountPort}
            deps={app.accountDeps}
            inputLocked={app.run.busy || app.modal.open}
            onLockChange={setAccountLocked}
            onSwitched={shell.clearResetToast}
          />
        ) : null
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
