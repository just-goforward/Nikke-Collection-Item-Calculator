import { adaptiveShell } from "../lib/rootCandidate";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import { message } from "../i18n/locale";
import { transition } from "../solver/domain";
import type { Grade } from "../types";
import type { DetailView, RecommendationAction, ResultView, ValidationView } from "../ui-types";
import { makeMetricsDetailView } from "../view-models/detailMetrics";
import { makeOutcomePreview } from "../view-models/outcomePresentation";
import { INITIAL_VALIDATION, monteCarloRuns, type SolverResult } from "./calculatorShared";
import { serviceCertifiedViews } from "./serviceCertifiedPresentation";

type MutableRef<T> = { current: T };

type ResultRenderingOptions = {
  actionTransitionIdRef: MutableRef<number>;
  latestResultRef: MutableRef<SolverResult | null>;
  setDetailView: Dispatch<SetStateAction<DetailView>>;
  setResultView: Dispatch<SetStateAction<ResultView>>;
  setValidationView: Dispatch<SetStateAction<ValidationView>>;
};

function withoutActionTransition(current: ResultView, transitionId: number): ResultView {
  if ((current.type !== "recommendation" && current.type !== "convertRecommendation") ||
      current.actionTransition?.id !== transitionId) {
    return current;
  }
  const { actionTransition: _finished, ...settled } = current;
  return settled;
}

function withActionTransition(
  view: ResultView,
  previous: RecommendationAction | null | undefined,
  sequence: MutableRef<number>,
): ResultView {
  const preview = adaptiveShell;
  if (!previous || (view.type !== "recommendation" && !(preview && view.type === "convertRecommendation")))
    return view;
  if (preview && ((view.type === "recommendation" && view.kit === previous.kit && view.count === previous.count) ||
      (view.type === "convertRecommendation" && previous.kit === "convert") ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)) return view;
  return { ...view, actionTransition: { id: ++sequence.current, previous } };
}

export function useCalculatorResultRendering({
  actionTransitionIdRef,
  latestResultRef,
  setDetailView,
  setResultView,
  setValidationView,
}: ResultRenderingOptions) {
  const clearActionTransition = useCallback(
    (transitionId: number) => {
      setResultView((current) => withoutActionTransition(current, transitionId));
    },
    [setResultView],
  );

  const renderMaxLevelState = useCallback(
    (nextGrade: Grade, nextLevel: number) => {
      latestResultRef.current = null;
      setValidationView(INITIAL_VALIDATION);
      if (nextGrade === "R" && nextLevel >= 15) {
        setResultView({ type: "convertRecommendation", reason: "r15_conversion" });
        setDetailView({
          type: "empty",
          message: message("result.convertAvailable"),
        });
        return;
      }
      if (nextGrade === "SR" && nextLevel >= 15) {
        setResultView({
          type: "callout",
          reason: "final_target",
          message: message("result.finalTarget"),
        });
        setDetailView({
          type: "empty", message: message("detail.finalTarget"),
          waitingLabel: message("detail.wait.complete"),
        });
      }
    },
    [latestResultRef, setDetailView, setResultView, setValidationView],
  );

  const renderResult = useCallback(
    (result: SolverResult, previousAction?: RecommendationAction | null) => {
      latestResultRef.current = result;
      if (result.certified && result.input) {
        const views = serviceCertifiedViews(result.input, result.certified);
        setResultView(withActionTransition(views.result, previousAction, actionTransitionIdRef));
        setDetailView(views.detail);
        setValidationView({ ...INITIAL_VALIDATION, disabled: true });
        return;
      }
      if (result.terminal) {
        setResultView({
          type: "callout",
          reason: "final_target",
          message: message("result.complete"),
        });
        setDetailView({
          type: "empty", message: message("result.complete"),
          waitingLabel: message("detail.wait.complete"),
        });
        return;
      }
      if (result.convertOnly) {
        setResultView({
          type: "convertRecommendation",
          reason: "r15_conversion",
        });
        setDetailView({
          type: "empty",
          message: message("result.convertAvailable"),
        });
        return;
      }
      if (!result.possible || !result.best || !result.input) {
        setResultView({
          type: "error",
          reason: "no_action",
          message: message("result.noAction"),
        });
        setDetailView({ type: "empty", message: message("result.noKits") });
        return;
      }

      const best = result.best;
      const edge = transition(result.input.start, best.firstAction);
      const run = best.run || {
        count: 1,
        success: edge.success,
        fail: edge.fail,
        greatSuccessProbability: best.firstProbability,
      };
      setResultView(withActionTransition({
        type: "recommendation",
        kit: best.firstAction,
        count: run.count,
        failPreview: makeOutcomePreview(result.input.start, run.fail),
        successPreview: makeOutcomePreview(result.input.start, run.success),
      }, previousAction, actionTransitionIdRef));
      setDetailView(
        makeMetricsDetailView(
          {
            input: result.input,
            best,
            ...(result.topCandidates ? { topCandidates: result.topCandidates } : {}),
            ...(result.stats ? { stats: result.stats } : {}),
          },
          run,
          monteCarloRuns(),
        ),
      );
      setValidationView(INITIAL_VALIDATION);
    },
    [actionTransitionIdRef, latestResultRef, setDetailView, setResultView, setValidationView],
  );

  return { clearActionTransition, renderMaxLevelState, renderResult };
}
