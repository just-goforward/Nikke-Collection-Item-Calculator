import { lazy, Suspense, useCallback, useState } from "react";

import { useI18n } from "../i18n/locale";
import type { StatsView } from "../ui-types";
import { LazySectionErrorBoundary } from "./LazySectionErrorBoundary";
import { classes } from "./statsPanelStyles";

type StatsPanelBodyModule = typeof import("./StatsPanelBody");

let statsPanelBodyLoad: Promise<StatsPanelBodyModule> | null = null;

function loadStatsPanelBody() {
  statsPanelBodyLoad ??= import("./StatsPanelBody");
  return statsPanelBodyLoad;
}

function createStatsPanelBody() {
  return lazy(loadStatsPanelBody);
}

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

function StatsPanelFailure({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className={classes.panelLoading} role="alert">
      <div className={classes.errorMessage}>
        <p>{t("error.sectionDetail")}</p>
        <button className={classes.retryButton} type="button" onClick={onRetry}>
          {t("error.retrySection")}
        </button>
      </div>
    </div>
  );
}

export default function StatsPanel({ onRetry, renderContent = true, view }: StatsPanelProps) {
  const { t } = useI18n();
  const [StatsPanelBody, setStatsPanelBody] = useState(createStatsPanelBody);
  const retryStatsPanelBody = useCallback(() => {
    statsPanelBodyLoad = null;
    setStatsPanelBody(createStatsPanelBody());
  }, []);
  return (
    <section id="globalStatsPanel" className={classes.panel} hidden={view.type === "hidden"}>
      <div className={`${classes.heading} ${classes.headingStatic}`}>
        <h2>{t("stats.title")}</h2>
      </div>
      {renderContent ? (
        <LazySectionErrorBoundary
          name="StatsPanelBody"
          onRetry={retryStatsPanelBody}
          fallback={(retry) => <StatsPanelFailure onRetry={retry} />}
        >
          <Suspense fallback={<StatsPanelLoading />}>
            <StatsPanelBody onRetry={onRetry} view={view} />
          </Suspense>
        </LazySectionErrorBoundary>
      ) : null}
    </section>
  );
}
