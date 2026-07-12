import { lazy, Suspense } from "react";

import type { StatsView } from "../ui-types";
import { classes } from "./statsPanelStyles";

const StatsPanelBody = lazy(() => import("./StatsPanelBody"));

type StatsPanelProps = {
  renderContent?: boolean;
  view: StatsView;
};

function StatsPanelLoading({ message = "통계 화면을 준비하고 있습니다." }: { message?: string }) {
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
        <p className={classes.panelLoadingText}>{message}</p>
      </div>
    </div>
  );
}

export default function StatsPanel({ renderContent = true, view }: StatsPanelProps) {
  return (
    <section id="globalStatsPanel" className={classes.panel} hidden={view.type === "hidden"}>
      <div className={`${classes.heading} ${classes.headingStatic}`}>
        <h2>전체 통계</h2>
      </div>
      {renderContent ? (
        <Suspense fallback={<StatsPanelLoading />}>
          <StatsPanelBody view={view} />
        </Suspense>
      ) : null}
    </section>
  );
}
