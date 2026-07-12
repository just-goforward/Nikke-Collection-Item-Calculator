import { useEffect, useState } from "react";

import { FIXED_REQUIRED_EXP } from "../solver/domain";
import type { CollectionState } from "../types";
import type { StateChangeFeedback, StatePanelModel } from "../ui-types";

function stateProgressPercent(state: Pick<StatePanelModel, "exp" | "expDisabled" | "requiredExp">) {
  if (state.expDisabled || state.requiredExp <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((state.exp / state.requiredExp) * 100)));
}

function toPanelState(state: CollectionState): StatePanelModel {
  return {
    grade: state.grade,
    level: state.level,
    exp: state.exp,
    requiredExp: FIXED_REQUIRED_EXP[state.grade],
    expDisabled: state.level >= 15,
  };
}

function nextLevelState(state: CollectionState): CollectionState {
  if (state.level >= 15) return { ...state, exp: 0 };
  return { grade: state.grade, level: state.level + 1, exp: 0 };
}

export function useAnimatedStateProgress(
  state: StatePanelModel,
  feedback: StateChangeFeedback | null,
) {
  const [animated, setAnimated] = useState({
    state,
    progress: stateProgressPercent(state),
    transition: true,
  });

  useEffect(() => {
    if (!feedback || feedback.to.grade !== state.grade || feedback.to.level !== state.level) {
      return undefined;
    }

    const timeouts: number[] = [];
    const schedule = (callback: () => void, delay: number) => {
      const timeoutId = window.setTimeout(callback, delay);
      timeouts.push(timeoutId);
    };

    let cursor = { ...feedback.from };
    const target = { ...feedback.to };
    const initial = toPanelState(cursor);
    setAnimated({ state: initial, progress: stateProgressPercent(initial), transition: false });

    let elapsed = 40;
    while (cursor.grade === target.grade && cursor.level < target.level && cursor.level < 15) {
      schedule(() => {
        setAnimated((current) => ({ ...current, progress: 100, transition: true }));
      }, elapsed);
      elapsed += 140;
      cursor = nextLevelState(cursor);
      const resetState = toPanelState(cursor);
      schedule(() => {
        setAnimated({ state: resetState, progress: 0, transition: false });
      }, elapsed);
      elapsed += 36;
    }

    const finalPanelState = toPanelState(target);
    schedule(() => {
      setAnimated({
        state: finalPanelState,
        progress: stateProgressPercent(finalPanelState),
        transition: true,
      });
    }, elapsed);

    return () => {
      for (const timeoutId of timeouts) window.clearTimeout(timeoutId);
    };
  }, [feedback, state]);

  if (!feedback || feedback.to.grade !== state.grade || feedback.to.level !== state.level) {
    return { state, progress: stateProgressPercent(state), transition: true };
  }

  return animated;
}
