import { lazy, Suspense } from "react";

import type { StatsView } from "../ui-types";
import { classes } from "./statsPanelStyles";

const StatsPanelBody = lazy(() => import("./StatsPanelBody"));

type StatsPanelProps = {
  renderContent?: boolean;
  view: StatsView;
};

function StatsPanelLoading() {
  return (
    <div id="globalStatsBox" className={classes.panelEmpty} role="status" aria-live="polite">
      통계를 준비 중입니다.
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
