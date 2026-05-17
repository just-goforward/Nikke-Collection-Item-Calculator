import type { ReactNode } from "react";

import type { Kit } from "../types";
import type { ResultKit, ResultView } from "../ui-types";

type ResultPanelProps = {
  view: ResultView;
  onConvert: () => void;
  onOutcome: (outcome: "success" | "fail") => void;
};

const KIT_LABELS: Record<ResultKit, string> = {
  blue: "초심자용 관리 키트",
  purple: "중급자용 관리 키트",
  yellow: "상급자용 관리 키트",
  convert: "SR 등급으로 교체",
};

function ActionChip({
  kit,
  count,
  large = false,
}: {
  kit: ResultKit;
  count?: number;
  large?: boolean;
}) {
  const className = `action-chip ${large ? "action-chip-large " : ""}${kit === "convert" ? "" : kit}`;

  if (!large || kit === "convert") {
    return (
      <span className={className.trim()}>
        <i></i>
        {KIT_LABELS[kit]}
      </span>
    );
  }

  return (
    <span className={className}>
      <i></i>
      <span className="action-chip-text">
        <span className="action-chip-name">{KIT_LABELS[kit]}</span>
        <span className="action-chip-count">{count || 1}회</span>
      </span>
    </span>
  );
}

function RecommendationBlock({
  kit,
  count = 1,
  title,
  children,
}: {
  kit: ResultKit;
  count?: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="recommendation">
      <div className="next-action">
        <div>
          <span className="action-label">추천 행동</span>
          <strong>
            <ActionChip kit={kit} count={count} large={kit !== "convert"} />
          </strong>
        </div>
      </div>
      <div className="outcome-panel">
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function ConvertRecommendation({ onConvert }: { onConvert: () => void }) {
  return (
    <RecommendationBlock kit="convert" title="등급 교체">
      <div className="outcome-buttons">
        <button className="convert-button" type="button" data-convert="sr" onClick={onConvert}>
          교체 적용
        </button>
      </div>
    </RecommendationBlock>
  );
}

function renderView(
  view: ResultView,
  onConvert: () => void,
  onOutcome: (outcome: "success" | "fail") => void,
) {
  if (view.type === "empty") return <>{view.message}</>;

  if (view.type === "callout") {
    return (
      <div className="result-content">
        <div className="callout">{view.message}</div>
      </div>
    );
  }

  if (view.type === "error") {
    return (
      <div className="result-content">
        <div className="error">{view.message}</div>
      </div>
    );
  }

  if (view.type === "convertRecommendation") {
    return (
      <div className="result-content">
        <ConvertRecommendation onConvert={onConvert} />
      </div>
    );
  }

  if (view.type === "recommendation") {
    return (
      <div className="result-content">
        <RecommendationBlock kit={view.kit} count={view.count} title="대성공 여부">
          {view.multiUse ? (
            <p className="change-note">
              다회 사용 중 대성공이 발생하면 몇 번째 사용에서 발생했는지 알 수 없으므로, 레벨만
              이동하고 보유 키트는 직접 수정해야 합니다.
            </p>
          ) : null}
          <div className="outcome-buttons">
            <button className="success-button" type="button" onClick={() => onOutcome("success")}>
              대성공 O
            </button>
            <button className="fail-button" type="button" onClick={() => onOutcome("fail")}>
              대성공 X
            </button>
          </div>
        </RecommendationBlock>
      </div>
    );
  }

  return (
    <div className="result-content">
      <div className="callout">
        적용 완료: {KIT_LABELS[view.kit as Kit]} {view.count}회 사용, {view.outcomeLabel} 결과로{" "}
        {view.stateText}가 반영되었습니다. {view.stockMessage}
      </div>
      {view.showConvertRecommendation ? <ConvertRecommendation onConvert={onConvert} /> : null}
    </div>
  );
}

export default function ResultPanel({ view, onConvert, onOutcome }: ResultPanelProps) {
  return (
    <section className="panel result-panel">
      <div className="section-heading">
        <h2>결과</h2>
      </div>
      <div id="resultBox" className={view.type === "empty" ? "empty-result" : ""}>
        {renderView(view, onConvert, onOutcome)}
      </div>
    </section>
  );
}
