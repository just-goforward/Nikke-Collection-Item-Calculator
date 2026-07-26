import { type Dispatch, type SetStateAction, useCallback } from "react";

import { message } from "../i18n/locale";
import type { ProgressEvent } from "../types";
import type { LoadingView } from "../ui-types";

function preserveStickyLoadingText(
  current: LoadingView,
  nextText: LoadingView["text"],
): LoadingView {
  if (
    current.text.key === "result.loadingApplyFailure" ||
    current.text.key === "result.loadingApplySuccess"
  ) {
    return { active: true, text: current.text };
  }
  return { active: true, text: nextText };
}

export function useSolverProgressLoading(setLoading: Dispatch<SetStateAction<LoadingView>>) {
  return useCallback(
    (progress: ProgressEvent) => {
      const scanned = Math.trunc(Number(progress.scanned || 0));
      if (progress.phase === "mdp") {
        setLoading((current) =>
          preserveStickyLoadingText(current, message("result.loadingStates", { count: scanned })),
        );
        return;
      }
      if (progress.phase === "done") {
        setLoading((current) =>
          preserveStickyLoadingText(current, message("result.loadingFinalize")),
        );
      }
    },
    [setLoading],
  );
}
