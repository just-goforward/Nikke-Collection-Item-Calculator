import { type ReactNode, useState } from "react";
import { fromWire, toNumber, type WireQ } from "../../shared/certifiedRational";
import type {
  CertifiedSupplyComparison,
  CertifiedSupplyEvent,
  CertifiedSupplySnapshot,
} from "../../shared/certifiedSupply";
import { KIT_ORDER, type Kit, MAX_STOCK_PIECES } from "../../shared/game";
import { gameDayKey } from "../../shared/supplyForecastModel";
import { KIT_PANEL_LABEL_KEYS, kitDotClass } from "../components/kitPresentation";
import { useI18n } from "../i18n/locale";
import type { CertifiedWords } from "./messages";
import {
  acknowledgeCertifiedReceipt,
  type CertifiedSession,
  recordCertifiedReceipt,
} from "./session";

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
  return session.cohortWeights.findIndex((w) => w.numerator === w.denominator);
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
  return (
    <CertifiedPanel headingId="certified-cohort-title" title={words.cohort}>
      <div className="cert-field">
        <select
          aria-label={words.cohort}
          disabled={disabled}
          value={cohortIndex(session)}
          onChange={(e) => {
            const cohort = Number(e.target.value);
            const weight = (i: number) => ({
              numerator: cohort < 0 || i === cohort ? "1" : "0",
              denominator: cohort < 0 ? "3" : "1",
            });
            onUpdate((current) => ({
              ...current,
              cohortWeights: [weight(0), weight(1), weight(2)],
            }));
          }}
        >
          <option value="-1">{words.mixture}</option>
          <option value="0">{words.reroll0}</option>
          <option value="1">{words.reroll1}</option>
          <option value="2">{words.reroll2}</option>
        </select>
      </div>
    </CertifiedPanel>
  );
}

const EVENT_NAMES = {
  ko: { dispatch: "파견", shop: "상점", solo: "솔로 레이드" },
  en: { dispatch: "Dispatch", shop: "Shop", solo: "Solo Raid" },
  ja: { dispatch: "派遣", shop: "ショップ", solo: "ソロレイド" },
} as const;

function ClaimEditor({
  disabled,
  event,
  snapshot,
  session,
  onUpdate,
  words,
}: {
  disabled: boolean;
  event: CertifiedSupplyEvent;
  snapshot: CertifiedSupplySnapshot;
  session: CertifiedSession;
  onUpdate: (next: CertifiedSession) => void;
  words: CertifiedWords;
}) {
  const { locale } = useI18n();
  const kitLabel = useKitLabel();
  const [pieces, setPieces] = useState<[number, number, number]>([0, 0, 0]);
  const [error, setError] = useState(false);
  const title = `${event.gameDate} · ${EVENT_NAMES[locale][event.kind]}`;
  // Only the user's explicit receipt is recorded; the approved event law validates the pieces.
  const claim = (already: boolean) => {
    let next: CertifiedSession;
    try {
      next = already
        ? acknowledgeCertifiedReceipt(session, event, new Date().toISOString())
        : recordCertifiedReceipt(session, event, pieces, new Date().toISOString(), false, {
            laws: snapshot.laws,
          });
    } catch {
      setError(true);
      return;
    }
    setError(false);
    onUpdate(next);
  };
  return (
    <fieldset className="cert-claim" disabled={disabled}>
      <legend>{title}</legend>
      <div className="cert-claim-fields">
        {KIT_ORDER.map((kit, i) => (
          <label className="cert-field" key={kit}>
            <span className="cert-kit-label">
              <span className={`cert-kit-dot ${kitDotClass[kit]}`} aria-hidden="true" />
              {kitLabel(kit)}
            </span>
            <input
              aria-label={`${words.received} ${kitLabel(kit)}`}
              type="number"
              inputMode="numeric"
              min="0"
              max={MAX_STOCK_PIECES}
              value={pieces[i]}
              onChange={(e) => {
                const next: [number, number, number] = [...pieces];
                next[i] = Math.max(
                  0,
                  Math.min(MAX_STOCK_PIECES, Math.floor(Number(e.target.value) || 0)),
                );
                setPieces(next);
              }}
            />
          </label>
        ))}
      </div>
      <div className="cert-actions">
        <button type="button" className="cert-button" onClick={() => claim(false)}>
          {words.record}
        </button>
        <button type="button" className="cert-button" onClick={() => claim(true)}>
          {words.already}
        </button>
      </div>
      {error && (
        <p role="alert" className="cert-notice cert-notice-danger">
          {words.modelMismatch}
        </p>
      )}
    </fieldset>
  );
}

export function ClaimsPanel({
  claims,
  disabled,
  snapshot,
  session,
  onUpdate,
  words,
}: {
  claims: readonly CertifiedSupplyEvent[];
  disabled: boolean;
  snapshot: CertifiedSupplySnapshot;
  session: CertifiedSession;
  onUpdate: (next: CertifiedSession) => void;
  words: CertifiedWords;
}) {
  return (
    <CertifiedPanel
      headingId="certified-claims-title"
      title={words.claims}
      testId="certified-claims"
    >
      <p className="cert-muted">{words.claimExplain}</p>
      {claims.length ? (
        claims.map((event) => (
          <ClaimEditor
            key={event.id}
            disabled={disabled}
            event={event}
            snapshot={snapshot}
            session={session}
            onUpdate={onUpdate}
            words={words}
          />
        ))
      ) : (
        <p className="cert-muted">{words.expired}</p>
      )}
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
