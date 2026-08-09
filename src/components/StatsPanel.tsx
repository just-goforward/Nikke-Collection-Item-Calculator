import { lazy, Suspense } from "react";

import { useI18n } from "../i18n/locale";
import type { StatsView } from "../ui-types";
import { classes } from "./statsPanelStyles";

const StatsPanelBody = lazy(() => import("./StatsPanelBody"));

type StatsPanelProps = {
  onRetry: () => void;
  renderContent?: boolean;
  view: StatsView;
};

function StatsPanelLoading() {
  const { t } = useI18n();
  return (
    <div
      id="globalStatsBox"
      className={classes.panelLoading}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className={classes.panelLoadingInner}>
        <span className={classes.panelLoadingSpinner} aria-hidden="true" />
        <p className={classes.panelLoadingText}>{t("stats.preparing")}</p>
      </div>
    </div>
  );
}

export default function StatsPanel({ onRetry, renderContent = true, view }: StatsPanelProps) {
  const { t } = useI18n();
  return (
    <section id="globalStatsPanel" className={classes.panel} hidden={view.type === "hidden"}>
      <div className={`${classes.heading} ${classes.headingStatic}`}>
        <h2>{t("stats.title")}</h2>
      </div>
      {renderContent ? (
        <Suspense fallback={<StatsPanelLoading />}>
          <StatsPanelBody onRetry={onRetry} view={view} />
        </Suspense>
      ) : null}
    </section>
  );
}
