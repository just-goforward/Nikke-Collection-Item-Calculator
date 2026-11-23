import { useI18n } from "../i18n/locale";
import { forecastTimeFormatter } from "../i18n/forecastTime";
import type { PreviewEvidence, PreviewTimedSupply } from "../ui-types";
import { KIT_LABEL_KEYS } from "./kitPresentation";
import type { PublicationView } from "./watchPreviewPublication";

const labels = {
  ko: {
    result: "계산에 사용한 14일 키트 조각 예보", live: "앞으로 14일의 예상 키트 조각",
    colors: "파랑 / 보라 / 노랑", asOf: "예보 기준 시각", time: "수급 가능 시각 (KST)",
    pieces: "이 시각의 조각", total: "누적 조각", checking: "서명 확인 중",
    updating: "직전 검증 예보 · 갱신 중",
    note: "기댓값이며 입력한 현재 재고는 포함하지 않습니다.",
    conditional: "확인된 수급만 반영한 조건부 기댓값이며 입력한 현재 재고는 포함하지 않습니다.",
    empty: "이 기간에 모델에 반영된 추가 수급이 없습니다.",
    withheld: "검증된 수급 예보를 표시할 수 없습니다. 수급이 0이라는 뜻은 아닙니다.",
  },
  en: {
    result: "14-day kit piece forecast used for this calculation", live: "Expected kit pieces over the next 14 days",
    colors: "Blue / Purple / Yellow", asOf: "Forecast as of", time: "Reward available (KST)",
    pieces: "Pieces at this time", total: "Cumulative pieces", checking: "Checking signature",
    updating: "Previously verified forecast · updating",
    note: "Expected values, excluding the current stock you entered.",
    conditional: "Conditional expectations from modeled rewards only, excluding the current stock you entered.",
    empty: "No additional modeled rewards in this window.",
    withheld: "No verified supply forecast is available. This does not mean zero supply.",
  },
  ja: {
    result: "計算に使用した14日間のキット素材予報", live: "今後14日間の予想キット素材",
    colors: "青 / 紫 / 黄", asOf: "予報の基準時刻", time: "受取可能時刻 (KST)",
    pieces: "この時刻の素材", total: "累計素材", checking: "署名を確認中",
    updating: "前回検証した予報 · 更新中",
    note: "期待値です。入力した現在の在庫は含みません。",
    conditional: "モデルで扱う報酬のみの条件付き期待値です。入力した現在の在庫は含みません。",
    empty: "この期間にモデルの対象となる追加報酬はありません。",
    withheld: "検証済みの供給予報は表示できません。供給がゼロという意味ではありません。",
  },
};

type SupplyProps = { live: PublicationView<PreviewTimedSupply> } | { supply: PreviewTimedSupply | null };
export default function PreviewSupply(props: SupplyProps) {
  const { locale, formatNumber } = useI18n();
  const copy = labels[locale];
  const live = "live" in props ? props.live : null;
  const supply = "supply" in props ? props.supply : props.live.value;
  const title = live ? copy.live : copy.result;
  const arrivals = supply?.arrivals ?? [];
  const date = forecastTimeFormatter(locale, arrivals.some(r => !r.at.endsWith(":00.000Z")),
    arrivals.some(r => !r.at.endsWith(".000Z")));
  const content = <>
    {live?.status === "updating" && <p role="status">{copy.updating}</p>}
    {!supply ? <p>{live?.status === "checking" ? copy.checking : copy.withheld}</p> : <>
      <p className="text-muted">{copy.asOf}: <time dateTime={supply.asOf}>
        {forecastTimeFormatter(locale, true, !supply.asOf.endsWith(".000Z")).format(Date.parse(supply.asOf))} KST</time></p>
      <p className="text-muted">{supply.conditional ? copy.conditional : copy.note}</p>
      {arrivals.length === 0 ? <p>{copy.empty}</p> :
        <table className="w-full table-fixed text-center text-xs tabular-nums">
          <caption>{copy.colors}</caption>
          <thead><tr>{[copy.time, copy.pieces, copy.total].map(h => <th scope="col" key={h}>{h}</th>)}</tr></thead>
          <tbody>{arrivals.map(row => <tr className="border-t border-border" key={row.at}>
            <th scope="row"><time dateTime={row.at}>{date.format(Date.parse(row.at))}</time></th>
            <td>{row.pieces.map(n => formatNumber(n, 2)).join(" / ")}</td>
            <td>{row.cumulative.map(n => formatNumber(n, 2)).join(" / ")}</td>
          </tr>)}</tbody>
        </table>}
    </>}
  </>;
  return <section aria-label={title} data-testid={live ? "conditional-supply" : "preview-expected-supply"}
    data-publication-state={live?.status} className="min-w-0 rounded-card border border-border p-3 text-sm [overflow-wrap:anywhere]">
    {live ? <details>
      <summary className="cursor-pointer py-2"><h2 className="inline font-semibold">{title}</h2></summary>
      {content}
    </details> : <><h3 className="font-semibold">{title}</h3>{content}</>}
  </section>;
}

const evidenceCopy = {
  ko: { current: "현재 재고 기준 최적 행동", tie: "공동 최적 첫 키트", pieces: "조각", verify: "예보 검증", complete: "비교 완료", partial: "부분 결과", withheld: "예보 추천 보류", range: "검증한 날짜", none: "없음", source: "예보 출처", reason: "사유" },
  en: { current: "Best action with current stock", tie: "Other equally optimal first kits", pieces: "pieces", verify: "Forecast verification", complete: "Comparison complete", partial: "Partial result", withheld: "Forecast recommendation withheld", range: "Validated days", none: "None", source: "Forecast source", reason: "Reason" },
  ja: { current: "現在の在庫での最適行動", tie: "同率最適の初回キット", pieces: "個", verify: "予報の検証", complete: "比較完了", partial: "部分結果", withheld: "予報による推奨を保留", range: "検証した日", none: "なし", source: "予報の出典", reason: "理由" },
};

const prefixComparisonCopy = {
  ko: "지금 사용과 다음 수급 비교는 아래 부분 범위에만 해당합니다.",
  en: "The comparison between using now and waiting for the next supply applies only to the partial horizon below.",
  ja: "今すぐ使う場合と次の補給まで待つ場合の比較は、下記の部分範囲に限られます。",
};

const legacyCopy = {
  ko: { title: "오늘(D0)의 계산 근거", source: "조각 가치 산정에 사용한 자료", description: "입력한 현재 재고만 사용했습니다. 색별 조각의 상대 가치는 재고와 서명된 운영 자료의 반복 수급률로 정했습니다. 공식 공지에서 확인한 일정은 이 계산에 사용하지 않습니다.", withheld: "시간대별 예보가 비활성 상태여서 대기일은 계산하지 않았습니다. 별도의 예상 키트 조각 표는 이 판정에 사용하지 않습니다." },
  en: { title: "Basis for today’s result (D0)", source: "Source for piece valuation", description: "Only the inventory you entered is available to use. Relative piece values use that inventory and recurring supply rates from the signed production reference. The official schedule is separate from this calculation.", withheld: "The timed forecast is off, so no wait date was calculated. The separate expected kit pieces table is not used for this decision." },
  ja: { title: "今日（D0）の計算根拠", source: "素材の価値を算出した資料", description: "使用できるのは入力した現在の在庫のみです。色別の素材の相対価値は、在庫と署名済みの本番資料にある定期供給率から算出しました。公式の日程はこの計算には使用していません。", withheld: "時刻別予報が無効のため、待機日数は計算していません。別掲の予想キット素材表はこの判定に使用しません。" },
};

export function PreviewRunEvidence({ evidence }: { evidence: PreviewEvidence }) {
  const { locale, t, formatCount, formatNumber, formatPercent } = useI18n();
  const c = evidenceCopy[locale], { action, lastDay } = evidence;
  const legacy = evidence.legacyD0 ? legacyCopy[locale] : null;
  const box = "min-w-0 rounded-card border border-border p-3 text-sm [overflow-wrap:anywhere]";
  return <>
    {action && <section className={box} aria-label={c.current} data-testid="preview-current-candidate">
      <h3 className="font-semibold">{c.current}</h3>
      <p>{t("detail.firstAction")}: {t(KIT_LABEL_KEYS[action.kit])} × {formatCount(action.count, "use")}</p>
      <p>{t("detail.sr15Probability")}: {action.probability}</p>
      <p>{t("detail.expectedConsumption")}: {formatNumber(action.pieces, 2)} {c.pieces}</p>
      {action.tied.length > 0 && <p>{c.tie}: {action.tied.map(kit => t(KIT_LABEL_KEYS[kit])).join(", ")}</p>}
    </section>}
    <section className={box} aria-label={legacy?.title ?? c.verify} data-testid="preview-verification">
      <h3 className="font-semibold">{evidence.conditional ? {ko:'조건부 모델 검증',en:'Conditional model verification',ja:'条件付きモデルの検証'}[locale] : legacy?.title ?? c.verify}</h3>
      {legacy ? <div data-testid="preview-legacy-d0"><p>{legacy.description}</p><p>{legacy.withheld}</p></div>
        : <p>{evidence.comparison ? t(`detail.wait.evidence.${evidence.comparison}`)
          : evidence.complete ? c.complete : c.partial}{evidence.withheld && ` · ${c.withheld}`}</p>}
      {evidence.prefixComparison && <p data-testid="preview-prefix-comparison">{prefixComparisonCopy[locale]}</p>}
      <p>{c.range}: {lastDay === null ? c.none : lastDay === 0 ? "D0" : `D0–D${lastDay}`}</p>
      {!!evidence.prefixMetrics?.length && (
        <table className="w-full text-left tabular-nums" aria-label={c.partial} data-testid="preview-prefix-metrics">
          <thead><tr>
            <th scope="col">{c.range}</th>
            <th scope="col">{t("detail.sr15Probability")}</th>
            <th scope="col">{t("detail.expectedConsumption")}</th>
          </tr></thead>
          <tbody>{evidence.prefixMetrics.map(({ day, probability, pieces }) => (
            <tr key={day}>
              <th scope="row">D{day}</th>
              <td>≈ {probability.map(value => formatPercent(value, 4)).join("–")}</td>
              <td>≈ {pieces.map(value => formatNumber(value, 2)).join("–")} {c.pieces}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <p>{legacy?.source ?? c.source}: {evidence.source}</p>
      {evidence.reason && <p>{c.reason}: <code>{evidence.reason}</code></p>}
    </section>
  </>;
}
