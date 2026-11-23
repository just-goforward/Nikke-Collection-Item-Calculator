import { adaptiveShell } from "../lib/rootCandidate";
import { useLayoutEffect, type ReactNode } from "react";
import { useDecisionReceipt } from "../analytics/DecisionPresentation";
import { useI18n } from "../i18n/locale";
import type { DetailView } from "../ui-types";

export default function WaitingMetric({ view, loading, fallback = false, help }: {
  view: DetailView; loading: boolean; fallback?: boolean; help?: ReactNode;
}) {
  const { t, text } = useI18n();
  const preview = adaptiveShell;
  const days = view.type === "metrics" ? view.recommendedWaitDays : undefined;
  const at = preview && view.type === "metrics" ? view.recommendedWaitAt : undefined;
  const running = loading || view.type === "loading";
  const showDays = !running && typeof days === "number" &&
    Number.isInteger(days) && days > 0 && days <= 14;
  const showWait = showDays && (!preview || (!!at && Number.isFinite(Date.parse(at))));
  const receiptRef = useDecisionReceipt("wait", showWait && !fallback);
  const focusSummary = !running && view.type === "metrics" && view.focusRequestedSummary;
  useLayoutEffect(() => {
    const summary = receiptRef.current;
    if (!focusSummary || !summary?.getClientRects().length) return;
    const bounds = summary.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0, left = viewport?.offsetLeft ?? 0;
    if (bounds.top >= top && bounds.bottom <= top + (viewport?.height ?? window.innerHeight) &&
        bounds.left >= left && bounds.right <= left + (viewport?.width ?? window.innerWidth)) return;
    summary.focus({ preventScroll: true });
    summary.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  }, [focusSummary, receiptRef]);
  const label = view.type === "loading" ? undefined : view.waitingLabel;
  const previewLabel = preview && label && (
    label.key === "detail.wait.noBenefit" || label.key === "detail.wait.smallBenefit" ||
    label.key === "detail.wait.noMaterialBenefit" || label.key === "detail.wait.benefitUncertain"
  ) ? t("detail.wait.notApplicable") : undefined;
  return (
    <div ref={receiptRef}
      className="metric flex min-w-0 flex-col items-center justify-center rounded-card border border-border bg-surface-strong p-3 text-center max-tablet:px-2 max-tablet:py-2.5 max-mobile:rounded-control max-mobile:p-2"
      tabIndex={focusSummary ? -1 : undefined}
      aria-live="polite" data-testid="waiting-metric">
      <span className="metric-copy block text-[12px] font-semibold text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px] max-mobile:flex max-mobile:items-center max-mobile:justify-center max-mobile:whitespace-normal max-mobile:text-[9.5px] max-mobile:leading-[1.25]">
        <span className={help
          ? "relative max-mobile:[overflow-wrap:anywhere] max-mobile:[&>.info-tip]:static max-mobile:[&>.info-tip]:ml-[3px] max-mobile:[&>.info-tip]:inline-grid max-mobile:[&>.info-tip]:translate-y-0 max-mobile:[&>.info-tip]:align-middle"
          : "relative"}>{t(preview ? "detail.recommendedWaitAt" : "detail.recommendedWaitDays")}{help}</span>
      </span>
      <strong className={`mt-[5px] block text-[24px] font-semibold leading-[1.16] text-text-strong max-tablet:text-[clamp(16px,3.5vw,20px)] max-mobile:text-[16px]${
        preview ? " max-w-full whitespace-normal [overflow-wrap:anywhere]" : ""
      }`}>
        {showWait ? (preview ? (
          <time dateTime={at}>{t(days === 1 ? "detail.wait.recommendOneDay" : "detail.wait.recommendDays", { days })}</time>
        ) : t(days === 1 ? "detail.waitOneDay" : "detail.waitAfterDays", { days })) :
          running ? t("detail.wait.running") :
          previewLabel ?? (label ? text(label) : t("detail.wait.idle"))}
      </strong>
      {!preview && showWait && label && (
        <span data-testid="wait-strength" className="mt-1 text-[11px] text-muted max-mobile:text-[9.5px]">
          {text(label)}
        </span>
      )}
      {!preview && !help && showWait && days === 14 && (
        <span className="mt-1 text-[11px] text-muted max-mobile:text-[9.5px]">
          {t("detail.waitHorizonQualifier")}
        </span>
      )}
    </div>
  );
}
