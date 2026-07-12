import { formatInteger, formatPercent } from "../format";
import type { KitStat, SegmentStat, StatsPanelModel } from "../ui-types";
import { RateBar } from "./StatsRateBar";
import type {
  IntervalTooltipHandlers,
  UsageTooltipHandlers,
  UsageTooltipItem,
} from "./StatsTooltip";
import { comparisonState, normalizeSegmentLabel, weightedTheoryRate } from "./statsPanelModel";
import { classes, joinClasses, KIT_LABELS, KIT_ORDER, kitDotClass } from "./statsPanelStyles";

function DifficultyRow({
  index,
  item,
  levelKitStats,
  tooltipHandlers,
  usageTooltipHandlers,
}: {
  index: number;
  item: SegmentStat;
  levelKitStats: StatsPanelModel["levelKitStats"];
  tooltipHandlers: IntervalTooltipHandlers;
  usageTooltipHandlers: UsageTooltipHandlers;
}) {
  const attempts = Number(item.attempts || 0);
  const pieces = piecesFromStat(item);
  const actualRate = Number(item.greatSuccessRate || 0);
  const theoreticalRate = Number(item.theoreticalGreatSuccessRate || 0);
  const greatSuccesses = Number(item.greatSuccesses || 0);
  const comparison = comparisonState(greatSuccesses, attempts, theoreticalRate);
  const usageItems = segmentUsageItems(item, levelKitStats);

  return (
    <div
      className={joinClasses(
        classes.difficultyRow,
        index > 0 && classes.difficultyRowBorder,
        comparison.className,
      )}
    >
      <div className={classes.difficultyHead}>
        <span className={classes.difficultySegment}>{normalizeSegmentLabel(item.label)}</span>
        <span className={classes.difficultyTags}>
          <UsageAmount pieces={pieces} items={usageItems} tooltipHandlers={usageTooltipHandlers} />
        </span>
      </div>
      <RateBar
        actualRate={actualRate}
        attempts={attempts}
        comparison={comparison}
        {...tooltipHandlers}
        theoreticalRate={theoreticalRate}
      />
    </div>
  );
}

function piecesFromStat(item: Pick<KitStat, "attempts" | "pieces">) {
  return Number(item.pieces ?? Number(item.attempts || 0) * 10);
}

function usageItemsFromStats(items: KitStat[] | undefined): UsageTooltipItem[] {
  return KIT_ORDER.map((kit) => {
    const item = Array.isArray(items) ? items.find((row) => row.kit === kit) : undefined;
    return { kit, pieces: item ? piecesFromStat(item) : 0 };
  });
}

function segmentUsageItems(
  item: SegmentStat,
  _levelKitStats: StatsPanelModel["levelKitStats"],
): UsageTooltipItem[] {
  return usageItemsFromStats(item.byKit);
}

function UsageAmount({
  items,
  pieces,
  tooltipHandlers,
}: {
  items: UsageTooltipItem[];
  pieces: number;
  tooltipHandlers: UsageTooltipHandlers;
}) {
  const activeItems = items.filter((item) => item.pieces > 0);
  const tooltipItems = activeItems.length ? activeItems : items;
  return (
    <span
      className={classes.usageTrigger}
      onPointerDown={(event) => tooltipHandlers.onUsagePointerDown(event, tooltipItems)}
      onPointerEnter={(event) => tooltipHandlers.onUsagePointerEnter(event, tooltipItems)}
      onPointerLeave={tooltipHandlers.onUsagePointerLeave}
      onPointerMove={(event) => tooltipHandlers.onUsagePointerMove(event, tooltipItems)}
    >
      {formatInteger(pieces)}개
    </span>
  );
}

type OverallStatsSummary = StatsPanelModel["summary"];

function OverallStatsWindow({
  byKit,
  note,
  summary,
  title,
}: {
  byKit: KitStat[];
  note?: string;
  summary?: Partial<OverallStatsSummary>;
  title: string;
}) {
  const attempts = Number(summary?.attempts || 0);
  const events = Number(summary?.events || 0);
  const greatSuccesses = Number(summary?.greatSuccesses || 0);
  const actualRate = Number(summary?.greatSuccessRate || 0);
  const theoreticalRate = weightedTheoryRate(byKit);

  return (
    <article className={classes.overallWindow}>
      <div className={classes.overallWindowHead}>
        <strong className={classes.overallWindowTitle}>{title}</strong>
        <span className={classes.overallWindowMeta}>
          {formatInteger(attempts)}시도 / {formatInteger(events)}입력 · 대성공{" "}
          {formatInteger(greatSuccesses)}회
        </span>
      </div>
      <div className={classes.overallRateGrid}>
        <div className={`${classes.statsCard} actual`}>
          <span className={classes.statsCardLabel}>실측 대성공률</span>
          <strong className={`${classes.statsCardValue} ${classes.actualValue}`}>
            {attempts ? formatPercent(actualRate, 1) : "-"}
          </strong>
        </div>
        <div className={`${classes.statsCard} expected`}>
          <span className={classes.statsCardLabel}>기대값</span>
          <strong className={`${classes.statsCardValue} ${classes.neutralValue}`}>
            {attempts ? formatPercent(theoreticalRate, 1) : "-"}
          </strong>
        </div>
      </div>
      {note ? <p className={classes.note}>{note}</p> : null}
    </article>
  );
}

export function OverallStats({ stats }: { stats: StatsPanelModel }) {
  const cumulative = stats.cumulative;
  const cumulativeSummary = cumulative?.summary;
  const cumulativeByKit = Array.isArray(cumulative?.byKit) ? cumulative.byKit : [];

  return (
    <section className={`${classes.section} stats-overall-section`}>
      <div className={classes.sectionTitle}>
        <h3 className={classes.sectionHeading}>전체 대성공률</h3>
        {cumulativeSummary ? (
          <span className={classes.sectionMeta}>
            {formatInteger(Number(cumulativeSummary.attempts || 0))}시도 · 대성공{" "}
            {formatInteger(Number(cumulativeSummary.greatSuccesses || 0))}회
          </span>
        ) : null}
      </div>
      <div className={classes.overallStack}>
        <OverallStatsWindow
          byKit={cumulativeByKit}
          title="누적 입력 표본"
          {...(cumulative ? {} : { note: "누적 통계는 최신 Worker 배포 후 표시됩니다." })}
          {...(cumulativeSummary ? { summary: cumulativeSummary } : {})}
        />
      </div>
      <p className={classes.note}>
        기대값은 실제 기록된 레벨·키트 조합의 이론 확률을 시도수로 가중평균한 값입니다.
      </p>
    </section>
  );
}

function KitRateRow({
  index,
  item,
  tooltipHandlers,
}: {
  index: number;
  item: KitStat;
  tooltipHandlers: IntervalTooltipHandlers;
}) {
  const kit = item.kit;
  if (!kit) return null;
  const attempts = Number(item.attempts || 0);
  const pieces = piecesFromStat(item);
  const greatSuccesses = Number(item.greatSuccesses || 0);
  const actualRate = Number(item.greatSuccessRate || 0);
  const theoreticalRate = Number(item.theoreticalGreatSuccessRate || 0);
  const comparison = comparisonState(greatSuccesses, attempts, theoreticalRate);

  return (
    <div
      className={joinClasses(
        classes.kitRateRow,
        index > 0 && classes.kitRateRowBorder,
        comparison.className,
      )}
    >
      <div className={classes.kitRateHead}>
        <span className={joinClasses(classes.kitRateName, kit)}>
          <i aria-hidden="true" className={`${classes.kitRateDot} ${kitDotClass[kit]}`}></i>
          {KIT_LABELS[kit]}
        </span>
        <span className={classes.kitRateMeta}>{formatInteger(pieces)}개 사용</span>
      </div>
      <RateBar
        actualRate={actualRate}
        attempts={attempts}
        barClassName={classes.kitRateBar}
        comparison={comparison}
        {...tooltipHandlers}
        theoreticalRate={theoreticalRate}
      />
    </div>
  );
}

export function KitStats({
  stats,
  tooltipHandlers,
}: {
  stats: StatsPanelModel;
  tooltipHandlers: IntervalTooltipHandlers;
}) {
  const byKit = Array.isArray(stats.byKit) ? stats.byKit : [];
  return (
    <section className={`${classes.section} stats-kit-section`}>
      <div className={classes.sectionTitle}>
        <h3 className={classes.sectionHeading}>키트별 대성공률</h3>
        <span className={classes.sectionMeta}>중앙 = 기대값 · 축 ±5%p</span>
      </div>
      {byKit.length ? (
        <div className={classes.kitRateList}>
          {KIT_ORDER.map((kit, index) => {
            const item = byKit.find((row) => row.kit === kit);
            if (!item) return null;
            return (
              <KitRateRow index={index} item={item} key={kit} tooltipHandlers={tooltipHandlers} />
            );
          })}
        </div>
      ) : (
        <p className={classes.empty}>아직 키트별 통계가 없습니다.</p>
      )}
    </section>
  );
}

export function DifficultyStats({
  stats,
  tooltipHandlers,
  usageTooltipHandlers,
}: {
  stats: StatsPanelModel;
  tooltipHandlers: IntervalTooltipHandlers;
  usageTooltipHandlers: UsageTooltipHandlers;
}) {
  const rows = Array.isArray(stats.segmentStats) ? stats.segmentStats : [];
  return (
    <section className={classes.section}>
      <div className={classes.sectionTitle}>
        <h3 className={classes.sectionHeading}>구간별 체감 난이도</h3>
        <span className={classes.sectionMeta}>중앙 = 기대값 · 축 ±5%p</span>
      </div>
      {rows.length ? (
        <div className={classes.difficultyList}>
          {rows.map((row, index) => (
            <DifficultyRow
              index={index}
              item={row}
              key={row.key}
              levelKitStats={stats.levelKitStats}
              tooltipHandlers={tooltipHandlers}
              usageTooltipHandlers={usageTooltipHandlers}
            />
          ))}
        </div>
      ) : (
        <p className={classes.empty}>아직 구간별 통계가 없습니다.</p>
      )}
    </section>
  );
}
