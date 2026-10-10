import { KIT_ORDER } from "../../shared/game";
import type { CertifiedCurrent, CertifiedOutput } from "../certified/types";
import { kitDotClass } from "../components/kitPresentation";
import { useI18n } from "../i18n/locale";
import { KIT_INDICES, useKitLabel, wireNumber } from "./CertifiedSupplyPanels";
import type { CertifiedWords } from "./messages";
import { certifiedCurrentRefusal } from "./runStatus";

export type CertifiedOutcome = "normal" | "great";

type ResultPanelsProps = {
  output: CertifiedOutput | null;
  busy: boolean;
  words: CertifiedWords;
  /** R 15 must convert to SR 5 before another kit use can be recorded. */
  conversionRequired: boolean;
  /** Stale, running, modal or correction-pending results cannot record actions. */
  actionsDisabled: boolean;
  onOutcome: (outcome: CertifiedOutcome) => void;
  onConvert: () => void;
};

/** Native certified output: current use/preserve/complete and the waiting recommendation. */
export function ResultPanels(props: ResultPanelsProps) {
  const refusal = certifiedCurrentRefusal(props.output);
  if (refusal)
    return (
      <p role="alert" className="cert-notice cert-notice-danger">
        {refusal === "limit" ? props.words.limit : props.words.error}
      </p>
    );
  return (
    <div className="cert-result-grid" aria-live="polite">
      <CurrentResult {...props} />
      <WaitingResult {...props} />
    </div>
  );
}

type CurrentProps = ResultPanelsProps & { current: CertifiedCurrent };

function CurrentAction({
  actionsDisabled,
  conversionRequired,
  current,
  onOutcome,
  words,
}: CurrentProps) {
  const kitLabel = useKitLabel();
  if (conversionRequired) return null;
  if (!current.kit) {
    return <p>{current.status === "complete" ? words.complete : words.preserve}</p>;
  }
  return (
    <>
      <p className="cert-recommendation" data-kit={current.kit} data-uses={current.uses}>
        <span className={`cert-kit-dot ${kitDotClass[current.kit]}`} aria-hidden="true" />{" "}
        {words.use}: {kitLabel(current.kit)} · {current.uses}
        {words.uses}
      </p>
      <div className="cert-actions cert-inline-actions">
        <button
          type="button"
          className="cert-button"
          disabled={actionsDisabled}
          onClick={() => onOutcome("normal")}
        >
          {words.normal}
        </button>
        <button
          type="button"
          className="cert-button"
          disabled={actionsDisabled}
          onClick={() => onOutcome("great")}
        >
          {words.great}
        </button>
      </div>
    </>
  );
}

function ConvertAction({ actionsDisabled, conversionRequired, onConvert, words }: CurrentProps) {
  if (!conversionRequired) return null;
  return (
    <div className="cert-actions cert-inline-actions">
      <button
        type="button"
        className="cert-button cert-button-primary"
        disabled={actionsDisabled}
        onClick={onConvert}
      >
        {words.convert}
      </button>
    </div>
  );
}

function CurrentValue(props: CurrentProps) {
  const { formatNumber, formatPercent } = useI18n();
  const { current, words } = props;
  return (
    <>
      <p className="cert-probability">{formatPercent(current.value.display.successP, 3)}</p>
      <p className="cert-muted">{words.probability}</p>
      <meter
        className="cert-meter"
        aria-label={words.probability}
        value={current.value.display.successP}
        min={0}
        max={1}
      />
      <dl className="cert-metrics">
        <div>
          <dt>{words.burden}</dt>
          <dd>{formatNumber(current.value.display.weightedExpectedConsumptionB, 4)}</dd>
        </div>
        <div>
          <dt>{words.consumption}</dt>
          <dd>{formatNumber(current.value.display.expectedTotalConsumptionC, 3)}</dd>
        </div>
      </dl>
      <CurrentAction {...props} />
      <ConvertAction {...props} />
    </>
  );
}

function missingCurrentMessage(
  output: CertifiedOutput | null,
  busy: boolean,
  words: CertifiedWords,
) {
  if (busy) return words.calculating;
  if (output?.refusal) return words.error;
  return words.restart;
}

function MissingCurrent({ busy, output, words }: ResultPanelsProps) {
  const message = missingCurrentMessage(output, busy, words);
  if (busy)
    return (
      <p className="cert-muted" role="status">
        {message}
      </p>
    );
  return <p className="cert-muted">{message}</p>;
}

function CurrentResult(props: ResultPanelsProps) {
  const current = props.output?.current;
  return (
    <section className="cert-card" data-testid="certified-current">
      <h3>{props.words.current}</h3>
      {current ? <CurrentValue {...props} current={current} /> : <MissingCurrent {...props} />}
    </section>
  );
}

function waitDayText(days: number, words: CertifiedWords) {
  if (days === 0) return words.now;
  return `${days} ${words.days}`;
}

function waitingMessage(output: CertifiedOutput | null, busy: boolean, words: CertifiedWords) {
  if (output?.waiting.status === "claim_required") return words.claimRequired;
  if (busy && output?.current) return words.working;
  if (busy) return words.calculating;
  if (output?.waiting.status === "unresolved") return words.unresolved;
  return words.restart;
}

function WaitingPricing({ output, words }: ResultPanelsProps) {
  const { formatNumber } = useI18n();
  const kitLabel = useKitLabel();
  const pricing = output?.pricing;
  if (!pricing) return null;
  return (
    <>
      <h4>{words.rates}</h4>
      <dl className="cert-metrics">
        {KIT_INDICES.map((i) => (
          <div key={KIT_ORDER[i]}>
            <dt>{kitLabel(KIT_ORDER[i])}</dt>
            <dd>{formatNumber(wireNumber(pricing.recurringRate[i]), 3)}</dd>
          </div>
        ))}
      </dl>
      <p className="cert-muted">{words.fixed}</p>
    </>
  );
}

function WaitingResult(props: ResultPanelsProps) {
  const { formatPercent } = useI18n();
  const { output, busy, words } = props;
  const wait = output?.waiting;
  return (
    <section className="cert-card" data-testid="certified-waiting">
      <h3>{words.recommend}</h3>
      {wait?.status === "certified" && wait.recommendedDays !== null ? (
        <>
          <p className="cert-wait-day">{waitDayText(wait.recommendedDays, words)}</p>
          {wait.rangeBoundary && <p className="cert-notice">{words.boundary}</p>}
          {wait.successImprovementUpperBound && (
            <p>
              {words.gap}: ≤ {formatPercent(wireNumber(wait.successImprovementUpperBound), 3)}
            </p>
          )}
        </>
      ) : (
        <p className="cert-notice" data-waiting-status={wait?.status ?? "none"}>
          {waitingMessage(output, busy, words)}
        </p>
      )}
      <p className="cert-muted">{words.estimates}</p>
      <p className="cert-muted">{words.magnitudeUncomputed}</p>
      <WaitingPricing {...props} />
    </section>
  );
}
