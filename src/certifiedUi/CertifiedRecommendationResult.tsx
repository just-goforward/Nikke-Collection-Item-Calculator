import { formatRational, fromWire, toNumber, sub } from "../../shared/certifiedRational";
import type { StableRuntimeRecommendation } from "../certifiedRecommendation/stableRuntime";
import { GAME_DAY_MS, gameDayKey } from "../../shared/gameDay";
import { useI18n } from "../i18n/locale";
import type { CertifiedOutput } from "../certified/types";
import type { LiveRecommendationGuidance } from "../certifiedRecommendation/liveGuidance";
import type { RecommendationResult } from "../certifiedRecommendation/policy";

const copy = {
  ko: {
    title: "강화 안내", NOW: "지금 강화해도 괜찮아요", WAIT: "선택 날짜의 보상을 받은 후 강화하는 편을 추천해요",
    ERROR: "대기 효과를 확인할 수 없습니다. 입력과 데이터를 확인해 주세요.",
    pending: "대기 효과를 비교하고 있습니다.",
    COMPLETE: "이미 강화를 완료했어요.", CLAIM_REQUIRED: "먼저 보상 수령 여부를 확인해 주세요.",
    INCOMPLETE: "대기 효과 비교가 완료되지 않아 아직 추천할 수 없습니다.",
    WITHHELD: "예측 데이터가 불확실하여 추천을 보류합니다.",
    PRESERVE: "지금은 재료를 보존하세요.", UNAVAILABLE: "현재 가능한 강화 행동이 없습니다.",
    reason: "기다림에 따른 확률 이득이 작아요.", probability: "최종 SR15 도달 확률",
    certainNow: "지금 강화해도 괜찮아요.",
    certainReason: "현재 재고만으로 모델상 목표에 도달할 수 있습니다. 이후 기다림의 효과까지 보장하는 안내는 아닙니다.",
    certainDetail: "미래 수급 예측의 불확실성은 그대로입니다. 이 안내는 현재 재고의 모델상 성공확률만을 근거로 하며, 자원 절약의 유불리를 판단하지 않습니다.",
    day: "보상 수령 날짜", exact: "반올림하지 않은 정확한 확률입니다.",
  },
  en: {
    title: "Upgrade guidance", NOW: "It is okay to upgrade now", WAIT: "Upgrade after collecting rewards",
    ERROR: "The waiting comparison could not be verified. Check your inputs and data.",
    pending: "Comparing the benefit of waiting.",
    COMPLETE: "Already complete.", CLAIM_REQUIRED: "Confirm reward collection first.",
    INCOMPLETE: "The waiting comparison is incomplete; no recommendation yet.",
    WITHHELD: "Recommendation withheld because forecast data is uncertain.",
    PRESERVE: "Preserve your materials for now.", UNAVAILABLE: "No upgrade action is currently available.",
    reason: "Waiting offers only a small probability benefit.", probability: "Final SR15 probability",
    certainNow: "It is okay to upgrade now.",
    certainReason: "Current inventory alone can reach the goal under the model. This does not guarantee the benefit of any subsequent wait.",
    certainDetail: "Future supply forecasts remain uncertain. This advice relies only on modeled success with current inventory, not the advantages of saving resources.",
    day: "Reward collection day", exact: "Exact probabilities, without rounding.",
  },
  ja: {
    title: "強化の案内", NOW: "今強化しても大丈夫です", WAIT: "報酬を受け取ってから強化しましょう",
    ERROR: "待機効果を確認できません。入力とデータを確認してください。",
    pending: "待機効果を比較しています。",
    COMPLETE: "すでに強化が完了しています。", CLAIM_REQUIRED: "先に報酬の受取状況を確認してください。",
    INCOMPLETE: "待機効果の比較が未完了のため、まだ推奨できません。",
    WITHHELD: "予測データが不確かなため、推奨を保留します。",
    PRESERVE: "今は素材を温存してください。", UNAVAILABLE: "現在可能な強化行動はありません。",
    reason: "待機による確率の改善はわずかです。", probability: "最終 SR15 到達確率",
    certainNow: "今強化しても大丈夫です。",
    certainReason: "現在の在庫だけでモデル上の目標に到達できます。その後の待機効果まで保証する案内ではありません。",
    certainDetail: "将来の供給予測の不確実性は変わりません。この案内は現在の在庫によるモデル上の成功確率のみを根拠とし、資源節約の有利・不利は判断しません。",
    day: "報酬受取日", exact: "丸めていない正確な確率です。",
  },
};

export interface CertifiedRecommendationResultProps {
  /** Internal opt-in only. Pass the hook's finished value, never partial results. */
  enabled?: boolean;
  stableRequested?: boolean;
  finished: {
    output: Pick<CertifiedOutput, "current"> & {
      autoRecommendation?: { context: { asOf: string } };
    };
    recommendation?: RecommendationResult | null;
    recommendationGuidance?: LiveRecommendationGuidance;
    stableRequested?: boolean;
    stableRecommendation?: StableRuntimeRecommendation;
  } | null;
  busy: boolean;
  error?: boolean | string;
  locale: keyof typeof copy;
  /** Bound request timestamp only; never use the viewer's current clock. */
  boundAsOf?: string;
}

/** Presentation of validated runtime guidance; never selects or solves a recommendation. */
export function CertifiedRecommendationResult({
  enabled = false, finished, busy, error = false, locale, boundAsOf, stableRequested = false,
}: CertifiedRecommendationResultProps) {
  const { formatPercent } = useI18n();
  if (!enabled) return null;
  const words = copy[locale];
  const stableMode = stableRequested || finished?.stableRequested === true;
  const stable = stableMode ? finished?.stableRecommendation : undefined;
  const recommendation = stableMode ? stable?.selection : finished?.recommendation;
  const guidance = stableMode ? stable?.guidance : finished?.recommendationGuidance;
  const current = finished?.output.current;
  let status = error ? "ERROR" as const : busy ? "INCOMPLETE" as const : guidance?.status ?? "INCOMPLETE";
  if (status === "NOW" || status === "WAIT") {
    if (!recommendation || recommendation.status !== status || !current?.value ||
      (recommendation.status === "WAIT" && (!Number.isInteger(recommendation.day) ||
        recommendation.day < 1 || recommendation.day > 14 || !recommendation.probability)) ||
      (stableMode && recommendation.status === "WAIT" &&
        (!stable || stable.selection.status !== "WAIT" ||
          !stable.selection.insufficientGainMass || !stable.selection.renewedWaitUpperBound)) ||
      (status === "WAIT" && guidance?.status === "WAIT" && guidance.day !== recommendation.day)) {
      status = "INCOMPLETE";
    } else if (status === "NOW" &&
      (current.status !== "use_certified" || current.kit === null || current.uses <= 0)) {
      status = current.status === "preserve" ? "PRESERVE" : "UNAVAILABLE";
    }
  }
  const choice = (status === "NOW" || status === "WAIT") &&
    recommendation && (recommendation.status === "NOW" || recommendation.status === "WAIT") && current?.value;
  const currentSuccessCertain = status === "NOW" &&
    guidance?.status === "NOW" && guidance.reason === "current_success_certain";
  const asOf = stableMode ? stable?.context.asOf ?? boundAsOf
    : finished?.output.autoRecommendation?.context.asOf ?? boundAsOf;
  const timestamp = asOf === undefined ? NaN : Date.parse(asOf);
  const date = recommendation && (recommendation.status === "NOW" || recommendation.status === "WAIT")
    ? (Number.isFinite(timestamp)
      ? `${gameDayKey(timestamp + recommendation.day * GAME_DAY_MS)} (D+${recommendation.day})`
      : `D+${recommendation.day}`)
    : null;
  return <section className="cert-card" data-testid="certified-recommendation-result"
    data-status={status}
    data-phase={error ? "error" : busy ? "pending" : !finished ? "absent"
      : stableMode && !stable ? "missing-stable" : "finished"}
    aria-live="polite" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <h3>{words.title}</h3>
    <p><strong>{currentSuccessCertain ? words.certainNow : busy && !error ? words.pending : words[status]}</strong></p>
    {choice && recommendation && current && <>
      {status === "NOW" ? <p className="cert-muted">{currentSuccessCertain ? words.certainReason : words.reason}</p> :
        <p>{words.day}: {date}</p>}
      <dl className="cert-metrics"><div style={{ minWidth: 0 }}>
        <dt>{words.probability}</dt>
        <dd style={{ minWidth: 0, whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {formatPercent(toNumber(fromWire(current.value.successP)), 3)}
          {status === "WAIT" && recommendation.status === "WAIT" && <> → {formatPercent(toNumber(recommendation.probability), 3)}</>}
        </dd>
      </div></dl>
      {status === "WAIT" && recommendation.status === "WAIT" && <p>
        ΔP: {(100 * toNumber(sub(recommendation.probability, fromWire(current.value.successP)))).toLocaleString(locale, { maximumFractionDigits: 3 })}
        {" "}{locale === "ko" ? "퍼센트포인트" : locale === "ja" ? "パーセントポイント" : "percentage points"}
      </p>}
      <details>
        <summary style={{ minHeight: 44, cursor: "pointer" }}>{words.exact}</summary>
        {currentSuccessCertain && <p>{words.certainDetail}</p>}
        <p style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {formatRational(fromWire(current.value.successP))}
          {status === "WAIT" && recommendation.status === "WAIT" && <> → {formatRational(recommendation.probability)}
            <br />ΔP: {formatRational(sub(recommendation.probability, fromWire(current.value.successP)))}
          </>}
        </p>
        {stable?.selection.status === "WAIT" && status === "WAIT" && <p>
          {locale === "ko" ? "이득 부족 위험 / 추가 대기 위험 상한" : locale === "ja" ? "改善不足リスク / 再待機リスク上限" : "Insufficient gain risk / renewed wait risk upper bound"}:
          {" "}{formatRational(stable.selection.insufficientGainMass)} / {formatRational(stable.selection.renewedWaitUpperBound)}
        </p>}
      </details>
    </>}
  </section>;
}
