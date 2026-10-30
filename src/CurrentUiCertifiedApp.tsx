import { AppShell } from "./AppLayout";
import type { CertifiedInput } from "./certified/types";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../shared/certifiedEngineProfile";
import { ResultPanels } from "./certifiedUi/CertifiedResultPanels";
import {
  useCurrentUiCertifiedCalculator,
  type CurrentUiCertifiedCalculator,
} from "./hooks/useCurrentUiCertifiedCalculator";
import { useAppShellNavigation } from "./hooks/useAppShellNavigation";
import { useCertifiedShellInteractions } from "./certifiedUi/useCertifiedShellInteractions";
import { CertifiedBanner, CertifiedMobileActions } from "./certifiedUi/CertifiedShellChrome";
import { CertifiedPanel, SupplyComparison } from "./certifiedUi/CertifiedSupplyPanels";
import { certifiedMessages } from "./certifiedUi/messages";
import { useI18n } from "./i18n/locale";
import "./certifiedUi/certified.css";

const localEntryMessages = {
  ko: {
    staging: "현재 화면 · 새 계산기 로컬 테스트",
    intro: "현재 서비스 화면에서 새 계산기를 시험합니다. 운영 서비스에 배포된 화면이 아닙니다.",
    sessionNotice: "계산 입력과 기록은 이 브라우저의 로컬 테스트 전용 저장 공간에 저장됩니다. 기존 계산 세션과 분리되며 계정에 동기화되지 않습니다.",
  },
  en: {
    staging: "Current interface · new solver local test",
    intro: "Test the new solver in the current service interface. This is not a production deployment.",
    sessionNotice: "Calculation inputs and records are saved in this browser's separate local-test storage, isolated from existing calculator sessions and not synced to an account.",
  },
  ja: {
    staging: "現在の画面 · 新計算エンジンのローカルテスト",
    intro: "現在のサービス画面で新しい計算エンジンを試します。本番サービスに公開された画面ではありません。",
    sessionNotice: "計算の入力と記録は、このブラウザーのローカルテスト専用領域に保存されます。既存の計算セッションとは分離され、アカウントには同期されません。",
  },
};

/** Local-test entry only. Never imported by the default service calculator. */
export default function CurrentUiCertifiedApp({ stableRecommendation }: {
  stableRecommendation?: CertifiedInput["stableRecommendation"];
} = {}) {
  const { locale, t } = useI18n();
  const shell = useAppShellNavigation<() => void>();
  const app: CurrentUiCertifiedCalculator = useCurrentUiCertifiedCalculator(shell.statsVisible, stableRecommendation);
  const controller = app;
  const interactions = useCertifiedShellInteractions(controller, shell);
  const actionsDisabled = interactions.actionsDisabled || !app.run.finished;
  const ui = {
    ...interactions,
    actionsDisabled,
    onOutcome: (outcome: Parameters<typeof interactions.onOutcome>[0]) => {
      if (!actionsDisabled) interactions.onOutcome(outcome);
    },
    onConvert: () => {
      if (!actionsDisabled) interactions.onConvert();
    },
  };
  const words = certifiedMessages[locale];
  const chrome = { controller, ui, words };
  return <AppShell
    engineProfile={CERTIFIED_STAGING_ENGINE_PROFILE.id}
    banner={<CertifiedBanner {...chrome} bannerCopy={localEntryMessages[locale]} />}
    hasResult={app.run.result?.current != null}
    inputPanels={{
      state: { state: app.statePanel, disabled: ui.inputSessionLocked,
        onGradeChange: app.actions.setGrade, onLevelChange: app.actions.setLevel,
        onExpChange: app.actions.setExp },
      stock: { stock: app.stock, needsStockEdit: ui.pendingCorrection,
        correction: app.stockCorrection, isStale: false, stockStale: false,
        notice: { key: "stock.notice" }, description: { key: "solver.strategySupply" },
        onStockChange: app.actions.setStock, calculateDisabled: app.calculateDisabled,
        loading: app.run.busy, disabled: app.inputLocked,
        onCalculate: ui.onCalculate, onReset: ui.onReset },
    }}
    mobileActions={<CertifiedMobileActions {...chrome} />}
    mobileTab={shell.mobileTab}
    modal={app.modal}
    onSubmitSuccessAttempt={ui.onSubmitSuccessAttempt}
    onTabChange={shell.setMobileViewTab}
    onThemeModeChange={app.setThemeMode}
    onViewTabChange={shell.setViewTab}
    resetToast={ui.resetToast}
    stateFeedback={null}
    stats={{ view: app.statsView, onRetry: app.retryStats }}
    themeMode={app.themeMode}
    viewTab={shell.viewTab}
    result={<>
      <CertifiedPanel headingId="current-certified-result" title={t("result.title")}
        busy={app.run.busy} action={app.run.busy
          ? <button type="button" className="cert-button" onClick={ui.onCancel}>{words.cancel}</button>
          : null}>
        {ui.cancelled && <p role="status">{words.cancelled}</p>}
        {app.actionError && <p role="alert">{words.actionError}</p>}
        {ui.pendingCorrection && <p role="status">{words.correctionPending}</p>}
        <ResultPanels output={app.run.result} busy={app.run.busy}
          words={words} conversionRequired={ui.conversionRequired}
          actionsDisabled={ui.actionsDisabled}
          onOutcome={ui.onOutcome} onConvert={ui.onConvert}
          autoRecommendation={{ finished: app.run.finished, error: app.run.error, locale,
            stableRequested: stableRecommendation !== undefined }} />
      </CertifiedPanel>
      {app.comparison && <SupplyComparison comparison={app.comparison} words={words} />}
    </>}
  />;
}
