import { useCallback, useEffect, useRef, useState } from "react";

import { STATE_FEEDBACK_VISIBLE_MS } from "../components/stateFeedbackAnimations";
import type { StateChangeFeedback } from "../ui-types";

function stateFeedbackType(
  from: StateChangeFeedback["from"],
  to: StateChangeFeedback["to"],
): StateChangeFeedback["type"] {
  if (from.grade !== to.grade) return "grade";
  if (Math.floor(from.level / 5) !== Math.floor(to.level / 5)) return "segment";
  return "level";
}

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
      setStateFeedback({
        id: nextId,
        type: stateFeedbackType(from, to),
        from: { ...from },
        to: { ...to },
      });
    },
    [],
  );

  return { stateFeedback, recordStateFeedback };
}
