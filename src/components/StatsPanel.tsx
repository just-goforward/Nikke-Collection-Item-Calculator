import type { PointerEvent } from "react";
import { useMemo, useState } from "react";

import { formatInteger, formatPercent } from "../format";
import type { Kit } from "../types";
import type { GlobalStats, KitStat, LevelKitStat, SegmentStat, StatsView } from "../ui-types";

type StatsPanelProps = {
  view: StatsView;
};

type BreakdownRow = {
  kit: Kit;
  attempts: number;
  greatSuccesses: number;
  actualRate: number;
  theoreticalRate: number;
};

type TooltipState = {
  visible: boolean;
  left: number;
  top: number;
  rows: BreakdownRow[];
};

const KIT_ORDER: Kit[] = ["blue", "purple", "yellow"];

const KIT_LABELS: Record<Kit, string> = {
  blue: "초심자용 관리 키트",
  purple: "중급자용 관리 키트",
  yellow: "상급자용 관리 키트",
};

function weightedTheoryRate(rows: KitStat[] = []) {
  const attempts = rows.reduce((sum, item) => sum + Number(item.attempts || 0), 0);
  if (!attempts) return 0;
  return (
    rows.reduce(
      (sum, item) =>
        sum + Number(item.theoreticalGreatSuccessRate || 0) * Number(item.attempts || 0),
      0,
    ) / attempts
  );
}

function normalizeSegmentLabel(label: string) {
  const text = String(label || "");
  const match = text.match(/^(R|SR)\s*(\d+)\D+(\d+)$/);
  if (match) return `${match[1]} ${match[2]} → ${match[3]}`;
  return text.replace(/->/g, "→").replace(/\s*→\s*/g, " → ");
}

function buildDifficultyKitBreakdown(rows: LevelKitStat[] = []) {
  const segmentDefinitions = [
    { key: "R:1", grade: "R", min: 1, max: 4 },
    { key: "R:5", grade: "R", min: 5, max: 9 },
    { key: "R:10", grade: "R", min: 10, max: 14 },
    { key: "SR:1", grade: "SR", min: 1, max: 4 },
    { key: "SR:5", grade: "SR", min: 5, max: 9 },
    { key: "SR:10", grade: "SR", min: 10, max: 14 },
  ] as const;
  const groups = new Map(
    segmentDefinitions.map((segment) => [
      segment.key,
      {
        ...segment,
        kits: Object.fromEntries(
          KIT_ORDER.map((kit) => [
            kit,
            { attempts: 0, greatSuccesses: 0, expectedGreatSuccesses: 0 },
          ]),
        ) as Record<
          Kit,
          { attempts: number; greatSuccesses: number; expectedGreatSuccesses: number }
        >,
      },
    ]),
  );

  rows.forEach((row) => {
    const level = Number(row.level);
    const segment = Array.from(groups.values()).find(
      (entry) => row.grade === entry.grade && level >= entry.min && level <= entry.max,
    );
    if (!segment) return;
    KIT_ORDER.forEach((kit) => {
      const source = row.kits?.[kit];
      const attempts = Number(source?.attempts || 0);
      const greatSuccesses = Number(source?.greatSuccesses || 0);
      const theoreticalRate = Number(source?.theoreticalGreatSuccessRate || 0);
      segment.kits[kit].attempts += attempts;
      segment.kits[kit].greatSuccesses += greatSuccesses;
      segment.kits[kit].expectedGreatSuccesses += attempts * theoreticalRate;
    });
  });

  const output = new Map<string, BreakdownRow[]>();
  groups.forEach((segment, key) => {
    output.set(
      key,
      KIT_ORDER.map((kit) => {
        const value = segment.kits[kit];
        return {
          kit,
          attempts: value.attempts,
          greatSuccesses: value.greatSuccesses,
          actualRate: value.attempts ? value.greatSuccesses / value.attempts : 0,
          theoreticalRate: value.attempts ? value.expectedGreatSuccesses / value.attempts : 0,
        };
      }),
    );
  });
  return output;
}

function positionTooltip(clientX: number, clientY: number) {
  const padding = 10;
  const gap = 14;
  const width = 320;
  const height = 112;
  let left = clientX + gap;
  if (left + width + padding > window.innerWidth) left = clientX - width - gap;
  left = Math.min(Math.max(padding, left), Math.max(padding, window.innerWidth - width - padding));

  let top = clientY - height - gap;
  if (top < padding) top = clientY + gap;
  top = Math.min(Math.max(padding, top), Math.max(padding, window.innerHeight - height - padding));
  return { left, top };
}

function DifficultyTooltip({ tooltip }: { tooltip: TooltipState }) {
  return (
    <div
      className={`difficulty-tooltip ${tooltip.visible ? "is-visible" : ""}`}
      role="tooltip"
      style={{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }}
    >
      {KIT_ORDER.map((kit) => {
        const item = tooltip.rows.find((row) => row.kit === kit);
        const attempts = Number(item?.attempts || 0);
        const actual = attempts ? formatPercent(Number(item?.actualRate || 0), 1) : "-";
        const theoretical = attempts ? formatPercent(Number(item?.theoreticalRate || 0), 1) : "-";
        return (
          <div className={`difficulty-tooltip-row ${kit}`} key={kit}>
            <i></i>
            <span>
              {KIT_LABELS[kit]} 실측 {actual} <em>/ 기대값 {theoretical}</em>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DifficultyRow({
  item,
  kitBreakdown,
  onTooltipMove,
  onTooltipHide,
}: {
  item: SegmentStat;
  kitBreakdown: BreakdownRow[];
  onTooltipMove: (event: PointerEvent<HTMLDivElement>, rows: BreakdownRow[]) => void;
  onTooltipHide: () => void;
}) {
  const attempts = Number(item.attempts || 0);
  const actualRate = Number(item.greatSuccessRate || 0);
  const theoreticalRate = Number(item.theoreticalGreatSuccessRate || item.theoreticalRate || 0);
  const events = Number(item.events || 0);
  const actualPercent = Math.min(100, Math.max(0, actualRate * 100));
  const theoreticalPercent = Math.min(100, Math.max(0, theoreticalRate * 100));
  const actualWidth = attempts > 0 ? Math.max(1, actualPercent) : 0;
  const deviation = attempts > 0 ? actualRate - theoreticalRate : 0;
  const luckClass =
    events < 30
      ? ""
      : deviation > 0.02
        ? "luck-good"
        : deviation < -0.02
          ? "luck-bad"
          : "luck-neutral";
  const markerEdgeClass =
    theoreticalPercent <= 12 ? " edge-low" : theoreticalPercent >= 88 ? " edge-high" : "";
  const actualEdgeClass = actualWidth <= 12 ? " edge-low" : actualWidth >= 88 ? " edge-high" : "";
  const label = !attempts
    ? "집계 대기"
    : theoreticalRate >= 0.5
      ? "쉬움"
      : theoreticalRate >= 0.15
        ? "보통"
        : "어려움";

  return (
    <div className={`difficulty-row ${luckClass}`}>
      <div className="difficulty-head">
        <span className="difficulty-segment">{normalizeSegmentLabel(item.label)}</span>
        <span className="difficulty-label">{label}</span>
      </div>
      <div
        className="difficulty-bar"
        onPointerEnter={(event) => onTooltipMove(event, kitBreakdown)}
        onPointerMove={(event) => onTooltipMove(event, kitBreakdown)}
        onPointerLeave={onTooltipHide}
      >
        <div className="difficulty-observed" style={{ width: `${actualWidth}%` }}></div>
        <div
          className={`difficulty-theory${markerEdgeClass}`}
          style={{ left: `${theoreticalPercent}%` }}
        >
          <span>기대값 {attempts ? formatPercent(theoreticalRate, 1) : "-"}</span>
        </div>
        <div className={`difficulty-actual${actualEdgeClass}`} style={{ left: `${actualWidth}%` }}>
          <span>실측 {attempts ? formatPercent(actualRate, 1) : "-"}</span>
        </div>
      </div>
    </div>
  );
}

function OverallStats({ stats }: { stats: GlobalStats }) {
  const summary = stats.summary || {};
  const byKit = Array.isArray(stats.byKit) ? stats.byKit : [];
  const attempts = Number(summary.attempts || 0);
  const events = Number(summary.events || 0);
  const greatSuccesses = Number(summary.greatSuccesses || 0);
  const actualRate = Number(summary.greatSuccessRate || 0);
  const theoreticalRate = weightedTheoryRate(byKit);

  return (
    <section className="stats-section stats-overall-section">
      <div className="stats-section-title">
        <h3>전체 대성공률</h3>
        <span>{formatInteger(attempts)}회 기준</span>
      </div>
      <div className="stats-vs-grid">
        <div className="stats-vs-card expected">
          <span>대성공률 기대값</span>
          <strong>{attempts ? formatPercent(theoreticalRate, 1) : "-"}</strong>
        </div>
        <div className="stats-vs-card actual">
          <span>실제 대성공률</span>
          <strong>{formatPercent(actualRate, 1)}</strong>
        </div>
      </div>
      <div className="stats-count-grid">
        <div>
          <span>대성공 횟수</span>
          <strong>{formatInteger(greatSuccesses)}회</strong>
        </div>
        <div>
          <span>결과 입력</span>
          <strong>{formatInteger(events)}건</strong>
        </div>
      </div>
    </section>
  );
}

function StatsContent({ stats }: { stats: GlobalStats }) {
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    left: 0,
    top: 0,
    rows: [],
  });
  const segmentRows = Array.isArray(stats.segmentStats) ? stats.segmentStats : [];
  const levelKitRows = Array.isArray(stats.levelKitStats) ? stats.levelKitStats : [];
  const kitBreakdown = useMemo(() => buildDifficultyKitBreakdown(levelKitRows), [levelKitRows]);

  const moveTooltip = (event: PointerEvent<HTMLDivElement>, rows: BreakdownRow[]) => {
    const { left, top } = positionTooltip(event.clientX, event.clientY);
    setTooltip({ visible: true, left, top, rows });
  };

  return (
    <div className="result-content stats-content">
      <div className="stats-layout">
        <OverallStats stats={stats} />
        <section className="stats-section">
          <div className="stats-section-title">
            <h3>구간별 체감 난이도</h3>
            <span>기록된 키트 조합 기준</span>
          </div>
          {segmentRows.length ? (
            <div className="difficulty-list">
              {segmentRows.map((row) => (
                <DifficultyRow
                  item={row}
                  kitBreakdown={kitBreakdown.get(row.key) || []}
                  key={row.key}
                  onTooltipMove={moveTooltip}
                  onTooltipHide={() => setTooltip((current) => ({ ...current, visible: false }))}
                />
              ))}
            </div>
          ) : (
            <p className="stats-empty">아직 구간별 통계가 없습니다.</p>
          )}
        </section>
      </div>
      <DifficultyTooltip tooltip={tooltip} />
    </div>
  );
}

export default function StatsPanel({ view }: StatsPanelProps) {
  return (
    <section id="globalStatsPanel" className="panel stats-panel" hidden={view.type === "hidden"}>
      <div className="section-heading">
        <h2>전체 통계</h2>
      </div>
      <div
        id="globalStatsBox"
        className={view.type === "empty" || view.type === "hidden" ? "empty-result" : ""}
      >
        {view.type === "stats" ? (
          <StatsContent stats={view.stats} />
        ) : view.type === "empty" ? (
          view.message
        ) : (
          "통계 서버를 연결하면 전체 사용자의 결과가 표시됩니다."
        )}
      </div>
    </section>
  );
}
