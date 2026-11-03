import { useDecisionReceipt } from "../analytics/DecisionPresentation";
import { useI18n } from "../i18n/locale";
import type { DetailView } from "../ui-types";

export default function WaitingMetric({ view, loading }: { view: DetailView; loading: boolean }) {
  const { t, text } = useI18n();
  const days = view.type === "metrics" ? view.recommendedWaitDays : undefined;
  const running = loading || view.type === "loading";
  const showDate = !running && typeof days === "number" &&
    Number.isInteger(days) && days > 0 && days <= 14;
  const receiptRef = useDecisionReceipt("wait", showDate);
  const label = view.type === "loading" ? undefined : view.waitingLabel;
  return (
    <div ref={receiptRef}
      className="metric flex min-w-0 flex-col items-center justify-center rounded-card border border-border bg-surface-strong p-3 text-center max-tablet:px-2 max-tablet:py-2.5 max-mobile:rounded-control max-mobile:p-2"
      aria-live="polite" data-testid="waiting-metric">
      <span className="metric-copy block text-[12px] font-semibold text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px] max-mobile:flex max-mobile:items-center max-mobile:justify-center max-mobile:whitespace-normal max-mobile:text-[9.5px] max-mobile:leading-[1.25]">
        {t("detail.recommendedWaitDays")}
      </span>
      <strong className="mt-[5px] block text-[24px] font-semibold leading-[1.16] text-text-strong max-tablet:text-[clamp(16px,3.5vw,20px)] max-mobile:text-[16px]">
        {showDate ? t("detail.waitAfterDays", { days }) :
          running ? t("detail.wait.running") :
          label ? text(label) : t("detail.wait.idle")}
      </strong>
    </div>
  );
}
