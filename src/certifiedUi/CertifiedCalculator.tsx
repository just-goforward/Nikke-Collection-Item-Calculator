import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";
import { CERTIFIED_STAGING_ENGINE_PROFILE } from "../../shared/certifiedEngineProfile";
import { fromWire, toNumber, type WireQ } from "../../shared/certifiedRational";
import {
  type CertifiedSupplyComparison,
  type CertifiedSupplyEvent,
  type CertifiedSupplySnapshot,
  compareCertifiedSupplyPeriods,
  isCertifiedEventClaimable,
} from "../../shared/certifiedSupply";
import { KIT_ORDER, type Kit, MAX_STOCK_PIECES, REQUIRED_EXP } from "../../shared/game";
import { gameDayKey } from "../../shared/supplyForecastModel";
import type { CertifiedOutput } from "../certified/types";
import { useI18n } from "../i18n/locale";
import { prepareCertifiedForecast } from "../lib/certifiedForecast";
import { ForecastReviewNotice } from "./ForecastReviewNotice";
import { certifiedMessages } from "./messages";
import { certifiedCurrentRefusal, showCertifiedRunResults } from "./runStatus";
import {
  acknowledgeCertifiedReceipt,
  CERTIFIED_SESSION_STORAGE_KEY,
  type CertifiedSession,
  certifiedClaimableEvents,
  convertCertifiedSession,
  createCertifiedSession,
  reconcileCertifiedSession,
  recordCertifiedOutcome,
  recordCertifiedReceipt,
  restoreCertifiedSession,
} from "./session";
import { useCertifiedRun } from "./useCertifiedRun";
import "./certified.css";

type Words = (typeof certifiedMessages)[keyof typeof certifiedMessages];
function wireNumber(value: WireQ) {
  return toNumber(fromWire(value));
}
function useCertifiedSession() {
  const [session, setSession] = useState(() => {
    try {
      return (
        restoreCertifiedSession(localStorage.getItem(CERTIFIED_SESSION_STORAGE_KEY)) ??
        createCertifiedSession("initial", { grade: "R", level: 0, exp: 0 }, [0, 0, 0])
      );
    } catch {
      return createCertifiedSession("initial", { grade: "R", level: 0, exp: 0 }, [0, 0, 0]);
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(CERTIFIED_SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch (failure) {
      if (!(failure instanceof DOMException)) throw failure;
    }
  }, [session]);
  return { session, setSession };
}

function InputPanel({
  session,
  update,
  words,
}: {
  session: CertifiedSession;
  update: (next: CertifiedSession) => void;
  words: Words;
}) {
  const setState = (patch: Partial<CertifiedSession["state"]>) => {
    const state = { ...session.state, ...patch };
    state.exp = state.level === 15 ? 0 : Math.min(state.exp, REQUIRED_EXP[state.grade] - 100);
    update({ ...session, state });
  };
  const integer = (text: string, max: number) =>
    Math.max(0, Math.min(max, Math.floor(Number(text) || 0)));
  return (
    <section className="cert-card">
      <h2>{words.state}</h2>
      <div className="cert-state-fields">
        <label>
          R / SR
          <select
            aria-label="R / SR"
            value={session.state.grade}
            onChange={(e) => setState({ grade: e.target.value === "SR" ? "SR" : "R" })}
          >
            <option>R</option>
            <option>SR</option>
          </select>
        </label>
        <label>
          {words.level}
          <input
            type="number"
            min="0"
            max="15"
            step="1"
            value={session.state.level}
            onChange={(e) => setState({ level: integer(e.target.value, 15) })}
          />
        </label>
        <label>
          {words.exp}
          <input
            type="number"
            min="0"
            max={REQUIRED_EXP[session.state.grade] - 100}
            step="100"
            value={session.state.exp}
            onChange={(e) =>
              setState({
                exp:
                  Math.floor(
                    integer(e.target.value, REQUIRED_EXP[session.state.grade] - 100) / 100,
                  ) * 100,
              })
            }
          />
        </label>
      </div>
      <h3>{words.stock}</h3>
      <div className="cert-stock-fields">
        {KIT_ORDER.map((kit, i) => (
          <label className={`cert-kit-${kit}`} key={kit}>
            {words[kit]}
            <input
              aria-label={`${words.stock} ${words[kit]}`}
              type="number"
              min="0"
              max={MAX_STOCK_PIECES}
              step="1"
              value={session.stock[i]}
              onChange={(e) => {
                const stock: [number, number, number] = [...session.stock];
                stock[i] = integer(e.target.value, MAX_STOCK_PIECES);
                update({ ...session, stock });
              }}
            />
          </label>
        ))}
      </div>
      <label className="cert-cohort">
        {words.cohort}
        <select
          aria-label={words.cohort}
          value={session.cohortWeights.findIndex((w) => w.numerator === w.denominator)}
          onChange={(e) => {
            const cohort = Number(e.target.value);
            const weights = [0, 1, 2].map((i) => ({
              numerator: cohort < 0 ? "1" : i === cohort ? "1" : "0",
              denominator: cohort < 0 ? "3" : "1",
            }));
            update({ ...session, cohortWeights: [weights[0]!, weights[1]!, weights[2]!] });
          }}
        >
          <option value="-1">{words.mixture}</option>
          <option value="0">{words.reroll0}</option>
          <option value="1">{words.reroll1}</option>
          <option value="2">{words.reroll2}</option>
        </select>
      </label>
    </section>
  );
}

type ResultPanelsProps = {
  output: CertifiedOutput | null;
  busy: boolean;
  words: Words;
  session: CertifiedSession;
  update: (next: CertifiedSession) => void;
};

export function ResultPanels(props: ResultPanelsProps) {
  const refusal = certifiedCurrentRefusal(props.output);
  if (refusal)
    return (
      <p role="alert" className="cert-notice">
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

function RunFailureNotice({
  error,
  words,
}: {
  error: false | "limit" | "error" | "background";
  words: Words;
}) {
  if (!error) return null;
  const message =
    error === "background"
      ? words.backgroundInterrupted
      : error === "limit"
        ? words.limit
        : words.error;
  return (
    <p role="alert" className="cert-notice" data-testid="certified-run-notice">
      {message}
    </p>
  );
}

function CurrentResult({ output, words, session, update }: ResultPanelsProps) {
  const { formatNumber, formatPercent } = useI18n();
  const current = output?.current;
  const conversionRequired = session.state.grade === "R" && session.state.level === 15;
  const record = (kit: Kit, outcome: "normal" | "great") =>
    update(recordCertifiedOutcome(session, kit, outcome, new Date().toISOString()));
  return (
    <section className="cert-card" data-testid="certified-current">
      <h2>{words.current}</h2>
      {current ? (
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
          {current.kit && !conversionRequired ? (
            <>
              <p className={`cert-recommendation cert-kit-${current.kit}`}>
                {words.use}: {words[current.kit]} · {current.uses}
                {words.uses}
              </p>
              <div className="cert-actions">
                <button type="button" onClick={() => record(current.kit!, "normal")}>
                  {words.normal}
                </button>
                <button type="button" onClick={() => record(current.kit!, "great")}>
                  {words.great}
                </button>
              </div>
            </>
          ) : conversionRequired ? null : (
            <p>{current.status === "complete" ? words.complete : words.preserve}</p>
          )}
          {conversionRequired && (
            <button type="button" onClick={() => update(convertCertifiedSession(session))}>
              {words.convert}
            </button>
          )}
        </>
      ) : (
        <p className="cert-muted">{output?.refusal ? words.error : words.restart}</p>
      )}
    </section>
  );
}

function WaitingResult({ output, busy, words }: ResultPanelsProps) {
  const { formatNumber, formatPercent } = useI18n();
  const wait = output?.waiting;
  return (
    <section className="cert-card" data-testid="certified-waiting">
      <h2>{words.recommend}</h2>
      {wait?.status === "certified" && wait.recommendedDays !== null ? (
        <>
          <p className="cert-wait-day">
            {wait.recommendedDays === 0 ? words.now : `${wait.recommendedDays} ${words.days}`}
          </p>
          {wait.rangeBoundary && <p className="cert-notice">{words.boundary}</p>}
          {wait.successImprovementUpperBound && (
            <p>
              {words.gap}: ≤ {formatPercent(wireNumber(wait.successImprovementUpperBound), 3)}
            </p>
          )}
        </>
      ) : (
        <p className="cert-notice">{waitingMessage(output, busy, words)}</p>
      )}
      <p className="cert-muted">{words.estimates}</p>
      <p className="cert-muted">{words.magnitudeUncomputed}</p>
      {output?.pricing && (
        <>
          <h3>{words.rates}</h3>
          <dl className="cert-metrics">
            {KIT_ORDER.map((kit, i) => (
              <div key={kit}>
                <dt>{words[kit]}</dt>
                <dd>{formatNumber(wireNumber(output.pricing!.recurringRate[i]!), 3)}</dd>
              </div>
            ))}
          </dl>
          <p className="cert-muted">{words.fixed}</p>
        </>
      )}
    </section>
  );
}

function waitingMessage(output: CertifiedOutput | null, busy: boolean, words: Words) {
  if (output?.waiting.status === "claim_required") return words.claimRequired;
  if (busy && output?.current) return words.working;
  return output?.waiting.status === "unresolved" ? words.unresolved : words.restart;
}

function ClaimEditor({
  event,
  snapshot,
  session,
  update,
  words,
}: {
  event: CertifiedSupplyEvent;
  snapshot: CertifiedSupplySnapshot;
  session: CertifiedSession;
  update: (next: CertifiedSession) => void;
  words: Words;
}) {
  const { locale } = useI18n();
  const [pieces, setPieces] = useState<[number, number, number]>([0, 0, 0]);
  const [error, setError] = useState(false);
  const names = {
    ko: { dispatch: "파견", shop: "상점", solo: "솔로 레이드" },
    en: { dispatch: "Dispatch", shop: "Shop", solo: "Solo Raid" },
    ja: { dispatch: "派遣", shop: "ショップ", solo: "ソロレイド" },
  };
  const claim = (already: boolean) => {
    try {
      update(
        already
          ? acknowledgeCertifiedReceipt(session, event, new Date().toISOString())
          : recordCertifiedReceipt(session, event, pieces, new Date().toISOString(), false, {
              laws: snapshot.laws,
            }),
      );
      setError(false);
    } catch {
      setError(true);
    }
  };
  return (
    <div className="cert-claim">
      <strong>
        {event.gameDate} · {names[locale][event.kind]}
      </strong>
      <div className="cert-stock-fields">
        {KIT_ORDER.map((kit, i) => (
          <label key={kit}>
            {words[kit]}
            <input
              aria-label={`${words.received} ${words[kit]}`}
              type="number"
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
        <button type="button" onClick={() => claim(false)}>
          {words.record}
        </button>
        <button type="button" onClick={() => claim(true)}>
          {words.already}
        </button>
      </div>
      {error && <p role="alert">{words.modelMismatch}</p>}
    </div>
  );
}

function SupplyComparison({
  comparison,
  words,
}: {
  comparison: CertifiedSupplyComparison;
  words: Words;
}) {
  const { formatNumber } = useI18n();
  return (
    <section className="cert-card cert-supply">
      <h2>{words.comparison}</h2>
      {comparison.partial && <p className="cert-notice">{words.incomplete}</p>}
      <p className="cert-muted cert-table-hint" id="cert-table-hint">
        {words.scrollTable}
      </p>
      <div className="cert-table-scroll">
        <table aria-describedby="cert-table-hint">
          <thead>
            <tr>
              <th scope="col">{words.stock}</th>
              <th scope="col">
                {words.past}
                <small>
                  {gameDayKey(Date.parse(comparison.past.from))} —{" "}
                  {gameDayKey(Date.parse(comparison.past.until) - 1)}
                </small>
              </th>
              <th scope="col">
                {words.future}
                <small>
                  {gameDayKey(Date.parse(comparison.future.from))} —{" "}
                  {gameDayKey(Date.parse(comparison.future.until) - 1)}
                </small>
              </th>
              <th scope="col">{words.change}</th>
              <th scope="col">{words.today}</th>
            </tr>
          </thead>
          <tbody>
            {KIT_ORDER.map((kit, i) => (
              <tr key={kit}>
                <th scope="row">{words[kit]}</th>
                <td>
                  {formatNumber(wireNumber(comparison.past.total[i]!), 2)}
                  <small>
                    {words.daily}: {formatNumber(wireNumber(comparison.past.dailyAverage[i]!), 3)}
                  </small>
                </td>
                <td>
                  {formatNumber(wireNumber(comparison.future.total[i]!), 2)}
                  <small>
                    {words.daily}: {formatNumber(wireNumber(comparison.future.dailyAverage[i]!), 3)}
                  </small>
                </td>
                <td>
                  {comparison.percentChange[i] === null
                    ? words.NA
                    : `${formatNumber(wireNumber(comparison.percentChange[i]!), 2)}%`}
                </td>
                <td>{formatNumber(wireNumber(comparison.currentDay.expectedGain[i]!), 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cert-muted">{words.estimates}</p>
    </section>
  );
}

function usePreparedSnapshot(setSession: Dispatch<SetStateAction<CertifiedSession>>) {
  const [snapshot, setSnapshot] = useState<CertifiedSupplySnapshot | null>(null),
    [prepareError, setPrepareError] = useState(false);
  useEffect(() => {
    let active = true;
    void prepareCertifiedForecast()
      .then((next) => {
        if (active) {
          setSnapshot(next);
          setSession((old) =>
            reconcileCertifiedSession(
              old,
              next.revision,
              next.events.map((e) => e.id),
            ),
          );
        }
      })
      .catch(() => {
        if (active) setPrepareError(true);
      });
    const refresh = window.setInterval(() => {
      void prepareCertifiedForecast()
        .then((next) => {
          if (active) setSnapshot(next);
        })
        .catch(() => {
          if (active) setPrepareError(true);
        });
    }, 60_000);
    return () => {
      active = false;
      window.clearInterval(refresh);
    };
  }, [setSession]);
  return { snapshot, setSnapshot, prepareError };
}

function CertifiedHeader() {
  const { locale, setLocale } = useI18n();
  const words = certifiedMessages[locale];
  return (
    <header className="cert-header">
      <div>
        <span className="cert-badge">{words.staging}</span>
        <h1>{words.title}</h1>
        <p>{words.intro}</p>
      </div>
      <label>
        {words.language}
        <select
          value={locale}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "ko" || next === "en" || next === "ja") setLocale(next);
          }}
        >
          <option value="ko">한국어</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
        </select>
      </label>
    </header>
  );
}

export default function CertifiedCalculator() {
  const { locale, formatNumber } = useI18n();
  const words = certifiedMessages[locale];
  const { session, setSession } = useCertifiedSession();
  const { snapshot, setSnapshot, prepareError } = usePreparedSnapshot(setSession);
  const run = useCertifiedRun(session, snapshot, setSnapshot);
  const comparison = useMemo(
    () => (snapshot ? compareCertifiedSupplyPeriods(snapshot, session.cohortWeights) : null),
    [snapshot, session.cohortWeights],
  );
  const claims = snapshot
    ? certifiedClaimableEvents(snapshot.events, session, Date.now()).filter((event) =>
        isCertifiedEventClaimable(snapshot, event, new Date().toISOString()),
      )
    : [];
  return (
    <main className="cert-page" data-engine-profile={CERTIFIED_STAGING_ENGINE_PROFILE.id}>
      <CertifiedHeader />
      <InputPanel session={session} update={setSession} words={words} />
      <div className="cert-controls">
        <button
          type="button"
          className="cert-primary"
          disabled={!snapshot}
          onClick={() => {
            void run.calculate();
          }}
        >
          {run.busy ? words.calculating : words.calculate}
        </button>
        {run.busy && (
          <button type="button" onClick={run.cancel}>
            {words.cancel}
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            setSession(
              createCertifiedSession(
                snapshot?.revision ?? "initial",
                { grade: "R", level: 0, exp: 0 },
                [0, 0, 0],
              ),
            )
          }
        >
          {words.reset}
        </button>
      </div>
      {!snapshot && <p role="status">{prepareError ? words.error : words.ready}</p>}
      <RunFailureNotice error={run.error} words={words} />
      {showCertifiedRunResults(run.error, run.result) && (
        <ResultPanels
          output={run.result}
          busy={run.busy}
          words={words}
          session={session}
          update={setSession}
        />
      )}
      {snapshot && (
        <section className="cert-card">
          <h2>{words.claims}</h2>
          <p className="cert-muted">{words.claimExplain}</p>
          {claims.length ? (
            claims.map((event) => (
              <ClaimEditor
                key={event.id}
                event={event}
                snapshot={snapshot}
                session={session}
                update={setSession}
                words={words}
              />
            ))
          ) : (
            <p>{words.expired}</p>
          )}
        </section>
      )}
      {comparison && <SupplyComparison comparison={comparison} words={words} />}
      <ForecastReviewNotice />
      {snapshot?.sourceStatus === "uncertain" && <p className="cert-notice">{words.uncertain}</p>}
      {run.finished && (
        <p className="cert-muted">
          {words.elapsed}: {formatNumber(run.finished.timing.totalMs / 1000, 3)}s
        </p>
      )}
      <footer>
        <p>{words.sessionNotice}</p>
        <a
          href="https://game.naver.com/lounge/nikke/board/detail/8060044"
          target="_blank"
          rel="noreferrer"
        >
          {words.source}
        </a>
      </footer>
    </main>
  );
}
