import { MobileActionBar } from "../components/MobileChrome";
import { useI18n } from "../i18n/locale";
import type { LoadingView, ResultView } from "../ui-types";
import { ResultPanels } from "./CertifiedResultPanels";
import { CertifiedPanel, SupplyComparison } from "./CertifiedSupplyPanels";
import type { CertifiedCalculatorController } from "./calculatorController";
import { ForecastReviewNotice } from "./ForecastReviewNotice";
import type { CertifiedWords } from "./messages";
import type { CertifiedShellInteractions } from "./useCertifiedShellInteractions";

type ChromeProps = {
  controller: CertifiedCalculatorController;
  ui: CertifiedShellInteractions;
  words: CertifiedWords;
};

/** Route-wide notices above the shared top bar, including malformed-storage recovery. */
export function CertifiedBanner({ controller, ui, words }: ChromeProps) {
  const { t } = useI18n();
  return (
    <div className="cert-banner-stack">
      <aside className="cert-banner" aria-label={t("staging.label")}>
        <strong>{words.staging}</strong>
        <span>{words.intro}</span>
        <span className="cert-muted">{words.sessionNotice}</span>
      </aside>
      <ForecastReviewNotice />
      {controller.storageBlocked && (
        <p
          role="alert"
          className="cert-notice cert-notice-danger"
          data-action-error={controller.actionError}
        >
          {words.storageBlocked}
          <button type="button" className="cert-button" onClick={ui.onReset}>
            {t("common.reset")}
          </button>
        </p>
      )}
      {controller.snapshot?.sourceStatus === "uncertain" && (
        <p className="cert-notice">{words.uncertain}</p>
      )}
      {!controller.snapshot && (
        <p role="status" className="cert-notice">
          {controller.prepareError ? words.error : words.ready}
        </p>
      )}
    </div>
  );
}

/** Only the shared calculate/reset toolbar is used; legacy outcome modes stay unreachable. */
const CALCULATE_TOOLBAR_VIEW: ResultView = { type: "empty", message: { key: "result.initial" } };
const LOADING_TEXT: LoadingView["text"] = { key: "result.loadingDefault" };
const ignoreLegacyOutcome = () => {};

/** Mobile bottom actions: native outcome/convert actions, otherwise the shared calculate bar. */
export function CertifiedMobileActions({ controller, ui, words }: ChromeProps) {
  const { actionsDisabled, conversionRequired, current } = ui;
  if (current && !actionsDisabled && conversionRequired) {
    return (
      <div className="mobile-action-bar cert-mobile-actions">
        <button
          type="button"
          className="cert-mobile-button cert-mobile-primary"
          onClick={ui.onConvert}
        >
          {words.convert}
        </button>
      </div>
    );
  }
  if (current?.kit && !actionsDisabled) {
    return (
      <fieldset className="mobile-action-bar cert-mobile-actions">
        <legend className="sr-only">{words.use}</legend>
        <button type="button" className="cert-mobile-button" onClick={() => ui.onOutcome("normal")}>
          {words.normal}
        </button>
        <button type="button" className="cert-mobile-button" onClick={() => ui.onOutcome("great")}>
          {words.great}
        </button>
      </fieldset>
    );
  }
  return (
    <MobileActionBar
      view={CALCULATE_TOOLBAR_VIEW}
      loading={{ active: controller.run.busy, text: LOADING_TEXT }}
      calculateDisabled={controller.calculateDisabled}
      correction={controller.stockCorrection}
      isStale={false}
      needsStockEdit={ui.pendingCorrection}
      onCalculate={ui.onCalculate}
      onReset={ui.onReset}
      onConvert={ui.onConvert}
      onOutcome={ignoreLegacyOutcome}
      pendingOutcome={null}
      onPendingOutcomeChange={ignoreLegacyOutcome}
    />
  );
}

const RUN_FAILURE_WORDS = {
  background: "backgroundInterrupted",
  limit: "limit",
  error: "error",
} as const satisfies Record<"background" | "limit" | "error", keyof CertifiedWords>;

function RunFailureNotice({ controller, words }: Omit<ChromeProps, "ui">) {
  const error = controller.run.error;
  if (!error) return null;
  return (
    <p
      role="alert"
      className={`cert-notice ${error === "background" ? "" : "cert-notice-danger"}`}
      data-testid="certified-run-notice"
      data-run-error={error}
    >
      {words[RUN_FAILURE_WORDS[error]]}
    </p>
  );
}

/** Cancellation, run failures, pending correction and action errors stay distinct. */
function RunStatusNotices({ controller, ui, words }: ChromeProps) {
  return (
    <>
      {ui.cancelled && (
        <p role="status" className="cert-notice" data-testid="certified-run-cancelled">
          {words.cancelled}
        </p>
      )}
      <RunFailureNotice controller={controller} words={words} />
      {ui.pendingCorrection && !controller.storageBlocked && (
        <p role="status" className="cert-notice" data-testid="certified-correction-pending">
          {words.correctionPending}
        </p>
      )}
      {controller.actionError && !controller.storageBlocked && (
        <p
          role="alert"
          className="cert-notice cert-notice-danger"
          data-action-error={controller.actionError}
        >
          {words.actionError}
        </p>
      )}
    </>
  );
}

function CertifiedRunMeta({ controller, words }: Omit<ChromeProps, "ui">) {
  const { formatNumber } = useI18n();
  const finished = controller.run.finished;
  return (
    <div className="cert-meta">
      {finished && (
        <p>
          {words.elapsed}: {formatNumber(finished.timing.totalMs / 1000, 3)}s
        </p>
      )}
      <a
        href="https://game.naver.com/lounge/nikke/board/detail/8060044"
        target="_blank"
        rel="noreferrer"
      >
        {words.source}
      </a>
    </div>
  );
}

/** Result column of the shared shell: native certified output and supply comparison. */
export function CertifiedResultRegion({ controller, ui, words }: ChromeProps) {
  const { t } = useI18n();
  const { run } = controller;
  return (
    <>
      <CertifiedPanel
        action={
          run.busy ? (
            <button type="button" className="cert-button" onClick={ui.onCancel}>
              {words.cancel}
            </button>
          ) : null
        }
        busy={run.busy}
        className="result-panel"
        headingId="certified-result-title"
        testId="certified-result"
        title={t("result.title")}
      >
        <RunStatusNotices controller={controller} ui={ui} words={words} />
        {ui.showResults && (
          <ResultPanels
            output={run.result}
            busy={run.busy}
            words={words}
            conversionRequired={ui.conversionRequired}
            actionsDisabled={ui.actionsDisabled}
            onOutcome={ui.onOutcome}
            onConvert={ui.onConvert}
          />
        )}
      </CertifiedPanel>
      {controller.comparison && (
        <SupplyComparison comparison={controller.comparison} words={words} />
      )}
      <CertifiedRunMeta controller={controller} words={words} />
    </>
  );
}
