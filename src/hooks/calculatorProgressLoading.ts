import { type Dispatch, type SetStateAction, useCallback } from "react";

import { formatInteger } from "../format";
import type { ProgressEvent } from "../types";
import type { LoadingView } from "../ui-types";

export function useSolverProgressLoading(setLoading: Dispatch<SetStateAction<LoadingView>>) {
  return useCallback(
    (progress: ProgressEvent) => {
      const scanned = Math.trunc(Number(progress.scanned || 0));
      if (progress.phase === "mdp") {
        setLoading({
          active: true,
          text: `${formatInteger(scanned)}개 상태를 평가했습니다.`,
        });
        return;
      }
      if (progress.phase === "done") {
        setLoading({ active: true, text: "결과를 정리하고 있습니다." });
      }
    },
    [setLoading],
  );
}
