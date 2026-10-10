import type { ComponentProps } from "react";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import { AppShell } from "../AppLayout";
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

export default function CertifiedCalculator() {
  const { locale } = useI18n();
  const words = certifiedMessages[locale];
  const controller = useCertifiedCalculatorApp();
  const shell = useAppShellNavigation<() => void>();
  const theme = useTheme(controller.statePanel.grade);
  const stats = useStatsQuery(shell.statsVisible);
  const ui = useCertifiedShellInteractions(controller, shell);
  const chrome = { controller, ui, words };

  return (
    <AppShell
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
