import { formatRational, fromWire, sub, type WireQ } from "../../shared/certifiedRational";
import type { CertifiedOutput } from "../certified/types";
import { certifiedMessages } from "./messages";

const explanations = {
  en: {
    model: "Probability of reaching final SR15 under the current model; this is not a requirement to wait. A small probability gap can still require a long wait.",
    missing: "Some exact dates have not been computed; the first target date is not yet certified.",
    pending: "Target evaluation is in progress; no first target date is certified yet.",
    stopped: "Target evaluation is incomplete. Recalculate to try again.",
    precision: "Values are exact fractions, not rounded decimals. Δ = selected day − current.",
    selected: "Selected day",
  },
  ko: {
    model: "현재 모델 기준 최종 SR15 도달 확률이며 반드시 기다려야 한다는 뜻은 아닙니다. 확률 차이가 작아도 오래 기다려야 할 수 있습니다.",
    missing: "일부 날짜의 정확 계산이 없어 최초 목표 날짜가 아직 인증되지 않았습니다.",
    pending: "목표를 계산 중이며 최초 목표 날짜는 아직 인증되지 않았습니다.",
    stopped: "목표 계산이 완료되지 않았습니다. 다시 계산해 주세요.",
    precision: "반올림 소수가 아닌 정확한 분수입니다. Δ = 선택 날짜 − 현재.",
    selected: "선택 날짜",
  },
  ja: {
    model: "現在のモデルに基づく最終 SR15 到達確率であり、待機の義務ではありません。確率差が小さくても長い待機が必要な場合があります。",
    missing: "未計算の日があるため、最初の目標日はまだ認証されていません。",
    pending: "目標を計算中です。最初の目標日はまだ認証されていません。",
    stopped: "目標計算は未完了です。再計算してください。",
    precision: "丸めた小数ではなく正確な分数です。Δ = 選択日 − 現在。",
    selected: "選択日",
  },
};

const words = {
  en: ["Target", "First certified date", "Every day in the search range is below target.", "Lowest day not excluded (not proven possible)", "Attained by", "Claim required before evaluating the target.", "Exact selected-day probability", "Exact current probability", "Exact Δ probability", "Unavailable", "Calculating"],
  ko: ["목표", "최초 인증 날짜", "검색 범위의 모든 날짜가 목표 미만입니다.", "배제되지 않은 가장 이른 날짜 (가능하다고 증명되지 않음)", "달성이 확인된 날짜", "목표 평가 전에 수령을 확인하세요.", "선택 날짜의 정확 확률", "현재 정확 확률", "정확한 Δ 확률", "확인 불가", "계산 중"],
  ja: ["目標", "最初の認証日", "検索範囲の全日が目標未満です。", "除外されていない最初の日（可能性の証明ではありません）", "達成確認日", "目標評価の前に受取確認が必要です。", "選択日の正確な確率", "現在の正確な確率", "正確な Δ 確率", "利用不可", "計算中"],
};

export function CertifiedTargetResult({ output, busy, locale, requested }: {
  output: Pick<CertifiedOutput, "target" | "current"> | null; busy: boolean; locale: keyof typeof words;
  requested: boolean;
}) {
  if (!requested) return null;
  const w = words[locale];
  const copy = explanations[locale];
  const common = certifiedMessages[locale];
  const target = output?.target;
  const current = output?.current?.value;
  const selected = target?.status === "certified" ? target.value : null;
  const prefixLabel = { en: "Actual completed range of the existing H14 calculation", ko: "기존 H14의 실제 계산 완료 범위", ja: "既存 H14 の実際の計算完了範囲" }[locale];
  const rangeLabel = { en: "Target search range", ko: "목표 검색 범위", ja: "目標検索範囲" }[locale];
  const exact = (value: WireQ | undefined) =>
    value ? formatRational(fromWire(value)) : w[9];
  const reason = target?.reason;
  const reasonText = !reason || target?.status === "claim_required" ? null
    : reason === "missing_exact_dates" ? copy.missing
    : reason === "target_in_progress" ? (busy ? copy.pending : copy.stopped)
    : ["request_budget_exhausted", "worker_total_deadline"].includes(reason) ? common.minimumWaitBudget
    : ["exact_memo_limit", "exact_support_limit", "managed_payload_ceiling"].includes(reason) ? common.minimumWaitGuard
    : reason === "current_claimable_unreceived" ? common.claimRequired
    : reason === "minimum_wait_future_coverage_incomplete" ? common.minimumWaitCoverage
    : copy.stopped;
  return <section className="cert-card" data-testid="certified-target-result" aria-live="polite">
    <h3>{w[0]}</h3>
    <p className="cert-muted">{copy.model}</p>
    {target && <p>α = {exact(target.alpha)} · {rangeLabel}: D0–D{target.maxDays}</p>}
    {!target ? <p>{busy ? w[10] : w[9]}</p> :
      target.status === "claim_required" ? <p>{w[5]}</p> :
      target.status === "certified" ? <p>{w[1]}: D{target.minimumDays}</p> :
      target.status === "not_reached_within_limit" ? <p>{w[2]}</p> :
      <><p>{w[3]}: {target.earliestNotRuledOutDay === null ? w[9] : `D${target.earliestNotRuledOutDay}`}</p>
        <p>{w[4]}: {target.attainedByDay === null ? w[9] : `D${target.attainedByDay}`}</p></>}
    {target && <p>{prefixLabel}: {target.completedThroughDay === null ? w[9] : `D0–D${target.completedThroughDay}`}</p>}
    {reasonText && <p className="cert-notice">{reasonText}</p>}
    <p className="cert-muted">{copy.precision}</p>
    <dl className="cert-metrics">
      <div><dt>{w[6]}</dt><dd>{exact(selected?.successP)}</dd></div>
      <div><dt>{w[7]}</dt><dd>{exact(current?.successP)}</dd></div>
      <div><dt>{w[8]}</dt><dd>{selected && current ? formatRational(sub(fromWire(selected.successP), fromWire(current.successP))) : w[9]}</dd></div>
      {([
        ["weightedExpectedConsumptionB", `B · ${common.burden}`],
        ["expectedTotalConsumptionC", `C · ${common.consumption}`],
      ] as const).map(([key, label]) => <div key={key}>
        <dt>{label}</dt>
        <dd data-testid={`target-${key}`}>
          {copy.selected}: {exact(selected?.[key])}<br />
          {common.current}: {exact(current?.[key])}<br />
          Δ: {selected && current ? formatRational(sub(fromWire(selected[key]), fromWire(current[key]))) : w[9]}
        </dd>
      </div>)}
    </dl>
  </section>;
}
