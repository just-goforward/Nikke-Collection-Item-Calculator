import { useCallback, useEffect, useRef, useState } from "react";

import { STATE_FEEDBACK_VISIBLE_MS } from "../components/stateFeedbackAnimations";
import type { StateChangeFeedback } from "../ui-types";

export function useStateFeedbackNotifier() {
  const [stateFeedback, setStateFeedback] = useState<StateChangeFeedback | null>(null);
  const stateFeedbackIdRef = useRef(0);

  useEffect(() => {
    if (!stateFeedback) return;
    const timeoutId = window.setTimeout(() => setStateFeedback(null), STATE_FEEDBACK_VISIBLE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [stateFeedback]);

  const recordStateFeedback = useCallback(
    (from: StateChangeFeedback["from"], to: StateChangeFeedback["to"]) => {
      if (from.grade === to.grade && from.level === to.level) return;
      const nextId = stateFeedbackIdRef.current + 1;
      stateFeedbackIdRef.current = nextId;
      const crossesSegment = Math.floor(from.level / 5) !== Math.floor(to.level / 5);
      const type: StateChangeFeedback["type"] =
        from.grade !== to.grade ? "grade" : crossesSegment ? "segment" : "level";
      const label =
        type === "grade"
          ? `${from.grade} → ${to.grade} · Lv ${to.level}`
          : type === "segment"
            ? `구간 이동 Lv ${from.level} → ${to.level}`
            : `Lv ${from.level} → Lv ${to.level}`;
      setStateFeedback({
        id: nextId,
        type,
        label,
        from: { ...from },
        to: { ...to },
      });
    },
    [],
  );

  return { stateFeedback, recordStateFeedback };
}
