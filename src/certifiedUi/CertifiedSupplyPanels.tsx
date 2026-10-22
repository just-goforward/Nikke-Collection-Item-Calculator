import type { ReactNode } from "react";
import { eq, fromWire, ONE, toNumber, type WireQ } from "../../shared/certifiedRational";
import {
  type CertifiedSupplyComparison,
  DEFAULT_PERSONAL_COHORT_WEIGHTS,
} from "../../shared/certifiedSupply";
import { KIT_ORDER, type Kit } from "../../shared/game";
import { gameDayKey } from "../../shared/gameDay";
import { KIT_PANEL_LABEL_KEYS } from "../components/kitPresentation";
import { useI18n } from "../i18n/locale";
import type { CertifiedWords } from "./messages";
import type { CertifiedSession } from "./session";

/** Positions shared by KIT_ORDER and every engine triple, typed so tuple reads stay defined. */
export const KIT_INDICES = [0, 1, 2] as const;

export function wireNumber(value: WireQ) {
  return toNumber(fromWire(value));
}

export function useKitLabel() {
  const { t } = useI18n();
  return (kit: Kit) => t(KIT_PANEL_LABEL_KEYS[kit]);
}

const panelClasses = {
  panel:
    "panel cert-panel relative min-w-0 rounded-card border border-border bg-surface shadow-panel min-[661px]:max-tablet:col-span-full",
  heading:
    "section-heading flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  body: "grid min-w-0 gap-3 p-[18px] max-mobile:px-3.5 max-mobile:py-3",
} as const;

/** A certified section rendered with the shared panel frame of the calculator shell. */
export function CertifiedPanel({
  action,
  busy,
  children,
  className = "",
  headingId,
  testId,
  title,
}: {
  action?: ReactNode;
  busy?: boolean;
  children: ReactNode;
  className?: string;
  headingId: string;
  testId?: string;
  title: string;
}) {
  return (
    <section
      className={`${panelClasses.panel} ${className}`}
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
      data-testid={testId}
    >
      <div className={panelClasses.heading}>
        <h2 id={headingId}>{title}</h2>
        {action}
      </div>
      <div className={panelClasses.body}>{children}</div>
    </section>
  );
}

function cohortIndex(session: CertifiedSession) {
  const selected = session.cohortWeights.findIndex((weight) => eq(fromWire(weight), ONE));
  if (selected >= 0) return selected;
  const prior = ([0, 1, 2, 3] as const).every((cohort) =>
    eq(fromWire(session.cohortWeights[cohort]), fromWire(DEFAULT_PERSONAL_COHORT_WEIGHTS[cohort])),
  );
  return prior ? -1 : -2;
}

export function CohortPanel({
  disabled,
  session,
  onUpdate,
  words,
}: {
  disabled: boolean;
  session: CertifiedSession;
  onUpdate: (update: (current: CertifiedSession) => CertifiedSession) => void;
  words: CertifiedWords;
}) {
  const selected = cohortIndex(session);
  return (
    <CertifiedPanel headingId="certified-cohort-title" title={words.cohort}>
      <div className="cert-field">
        <select
          aria-label={words.cohort}
          disabled={disabled}
          value={selected}
          onChange={(e) => {
            const cohort = Number(e.target.value);
            if (cohort === -2) return;
            const weight = (i: number) => ({
              numerator: i === cohort ? "1" : "0",
              denominator: "1",
            });
            onUpdate((current) => ({
              ...current,
              cohortWeights:
                cohort < 0
                  ? DEFAULT_PERSONAL_COHORT_WEIGHTS
                  : [weight(0), weight(1), weight(2), weight(3)],
            }));
          }}
        >
          <option value="-1">{words.mixture}</option>
          {selected === -2 && (
            <option value="-2" disabled>
              {words.learnedMixture}
            </option>
          )}
          <option value="0">{words.reroll0}</option>
          <option value="1">{words.reroll1}</option>
          <option value="2">{words.reroll2}</option>
          <option value="3">{words.reroll3}</option>
        </select>
      </div>
    </CertifiedPanel>
  );
}

function periodText(period: { from: string; until: string }) {
  return `${gameDayKey(Date.parse(period.from))} — ${gameDayKey(Date.parse(period.until) - 1)}`;
}

export function SupplyComparison({
  comparison,
  words,
}: {
  comparison: CertifiedSupplyComparison;
  words: CertifiedWords;
}) {
  const { formatNumber } = useI18n();
  const kitLabel = useKitLabel();
  return (
    <CertifiedPanel
      className="cert-supply"
      headingId="certified-supply-title"
      title={words.comparison}
    >
      {comparison.partial && <p className="cert-notice">{words.incomplete}</p>}
      {/* Fixed columns wrap on narrow screens, so the table never needs a keyboard scroller. */}
      <table aria-labelledby="certified-supply-title">
        <thead>
          <tr>
            <th scope="col">{words.stock}</th>
            <th scope="col">
              {words.past}
              <small>{periodText(comparison.past)}</small>
            </th>
            <th scope="col">
              {words.future}
              <small>{periodText(comparison.future)}</small>
            </th>
            <th scope="col">{words.change}</th>
            <th scope="col">{words.today}</th>
          </tr>
        </thead>
        <tbody>
          {KIT_INDICES.map((i) => {
            const kit = KIT_ORDER[i];
            const percentChange = comparison.percentChange[i];
            return (
              <tr key={kit}>
                <th scope="row">{kitLabel(kit)}</th>
                <td>
                  {formatNumber(wireNumber(comparison.past.total[i]), 2)}
                  <small>
                    {words.daily}: {formatNumber(wireNumber(comparison.past.dailyAverage[i]), 3)}
                  </small>
                </td>
                <td>
                  {formatNumber(wireNumber(comparison.future.total[i]), 2)}
                  <small>
                    {words.daily}: {formatNumber(wireNumber(comparison.future.dailyAverage[i]), 3)}
                  </small>
                </td>
                <td>
                  {percentChange === null
                    ? words.NA
                    : `${formatNumber(wireNumber(percentChange), 2)}%`}
                </td>
                <td>{formatNumber(wireNumber(comparison.currentDay.expectedGain[i]), 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="cert-muted">{words.estimates}</p>
    </CertifiedPanel>
  );
}
