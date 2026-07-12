import { type Dispatch, type SetStateAction, useCallback } from "react";

import { formatInteger } from "../format";
import type { ProgressEvent } from "../types";
import type { LoadingView } from "../ui-types";

const STICKY_LOADING_PREFIXES = ["대성공 X를 반영"];

function preserveStickyLoadingText(current: LoadingView, nextText: string): LoadingView {
  if (STICKY_LOADING_PREFIXES.some((prefix) => current.text.includes(prefix))) {
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
          preserveStickyLoadingText(current, `${formatInteger(scanned)}개 상태를 평가했습니다.`),
        );
        return;
      }
      if (progress.phase === "done") {
        setLoading((current) => preserveStickyLoadingText(current, "결과를 정리하고 있습니다."));
      }
    },
    [setLoading],
  );
}
