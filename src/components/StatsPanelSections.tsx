import { useI18n } from "../i18n/locale";
import type { MessageKey } from "../i18n/messages.ko";
import type { Kit } from "../types";
import type { KitStat, SegmentStat, StatsPanelModel } from "../ui-types";
import { RateBar } from "./StatsRateBar";
import type {
  IntervalTooltipHandlers,
  UsageTooltipHandlers,
  UsageTooltipItem,
} from "./StatsTooltip";
import { comparisonState, normalizeSegmentLabel, weightedTheoryRate } from "./statsPanelModel";
import {
  classes,
  INTERVAL_TOOLTIP_ID,
  joinClasses,
  KIT_ORDER,
  kitDotClass,
} from "./statsPanelStyles";

const KIT_LABEL_KEYS: Record<Kit, MessageKey> = {
  blue: "kit.blue",
  purple: "kit.purple",
  yellow: "kit.yellow",
};

function IntervalLegend() {
  const { t } = useI18n();
  return (
    <p className={classes.intervalLegend}>
      <span aria-hidden="true" className={classes.intervalLegendSwatch}></span>
      {t("stats.intervalLegend")}
    </p>
  );
}

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
  const { formatCount, t } = useI18n();
  const activeItems = items.filter((item) => item.pieces > 0);
  const tooltipItems = activeItems.length ? activeItems : items;
  const formattedPieces = formatCount(pieces, "piece");
  return (
    <button
      className={classes.usageTrigger}
      type="button"
      aria-describedby={INTERVAL_TOOLTIP_ID}
      aria-label={t("stats.piecesUsedBreakdown", { pieces: formattedPieces })}
      onBlur={tooltipHandlers.onUsageBlur}
      onFocus={(event) => tooltipHandlers.onUsageFocus(event, tooltipItems)}
      onPointerDown={(event) => tooltipHandlers.onUsagePointerDown(event, tooltipItems)}
      onPointerEnter={(event) => tooltipHandlers.onUsagePointerEnter(event, tooltipItems)}
      onPointerLeave={tooltipHandlers.onUsagePointerLeave}
      onPointerMove={(event) => tooltipHandlers.onUsagePointerMove(event, tooltipItems)}
    >
      {formattedPieces}
    </button>
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
  const { formatInteger, formatPercent, t } = useI18n();
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
          {t("stats.summaryCounts", {
            attempts: formatInteger(attempts),
            events: formatInteger(events),
            successes: formatInteger(greatSuccesses),
          })}
        </span>
      </div>
      <div className={classes.overallRateGrid}>
        <div className={`${classes.statsCard} actual`}>
          <span className={classes.statsCardLabel}>{t("stats.measuredRate")}</span>
          <strong className={`${classes.statsCardValue} ${classes.actualValue}`}>
            {attempts ? formatPercent(actualRate, 1) : "-"}
          </strong>
        </div>
        <div className={`${classes.statsCard} expected`}>
          <span className={classes.statsCardLabel}>{t("stats.expected")}</span>
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
  const { formatInteger, t } = useI18n();
  const cumulative = stats.cumulative;
  const cumulativeSummary = cumulative?.summary;
  const cumulativeByKit = Array.isArray(cumulative?.byKit) ? cumulative.byKit : [];

  return (
    <section className={`${classes.section} stats-overall-section`}>
      <div className={classes.sectionTitle}>
        <h3 className={classes.sectionHeading}>{t("stats.overallRate")}</h3>
        {cumulativeSummary ? (
          <span className={classes.sectionMeta}>
            {t("stats.cumulativeCounts", {
              attempts: formatInteger(Number(cumulativeSummary.attempts || 0)),
              successes: formatInteger(Number(cumulativeSummary.greatSuccesses || 0)),
            })}
          </span>
        ) : null}
      </div>
      <div className={classes.overallStack}>
        <OverallStatsWindow
          byKit={cumulativeByKit}
          title={t("stats.cumulativeSample")}
          {...(cumulative ? {} : { note: t("stats.cumulativeUnavailable") })}
          {...(cumulativeSummary ? { summary: cumulativeSummary } : {})}
        />
      </div>
      <p className={classes.note}>{t("stats.expectedHelp")}</p>
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
  const { formatInteger, t } = useI18n();
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
          {t(KIT_LABEL_KEYS[kit])}
        </span>
        <span className={classes.kitRateMeta}>
          {t("stats.piecesUsed", { pieces: formatInteger(pieces) })}
        </span>
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
  const { t } = useI18n();
  const byKit = Array.isArray(stats.byKit) ? stats.byKit : [];
  return (
    <section className={`${classes.section} stats-kit-section`}>
      <div className={classes.sectionTitle}>
        <h3 className={classes.sectionHeading}>{t("stats.kitRates")}</h3>
        <span className={classes.sectionMeta}>{t("stats.axisMeta")}</span>
      </div>
      <IntervalLegend />
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
        <p className={classes.empty}>{t("stats.noKitStats")}</p>
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
  const { t } = useI18n();
  const rows = Array.isArray(stats.segmentStats) ? stats.segmentStats : [];
  return (
    <section className={classes.section}>
      <div className={classes.sectionTitle}>
        <h3 className={classes.sectionHeading}>{t("stats.segmentDifficulty")}</h3>
        <span className={classes.sectionMeta}>{t("stats.axisMeta")}</span>
      </div>
      <IntervalLegend />
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
        <p className={classes.empty}>{t("stats.noSegmentStats")}</p>
      )}
    </section>
  );
}
