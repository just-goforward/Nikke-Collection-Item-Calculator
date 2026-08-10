import { useCallback, useRef, useState } from "react";

import type { PendingStatsEvent } from "./calculatorShared";

export function usePendingStatsEvent() {
  const pendingStatsEventRef = useRef<PendingStatsEvent | null>(null);
  const [pendingStatsEvent, setPendingStatsEventState] = useState<PendingStatsEvent | null>(null);
  const setPendingStatsEvent = useCallback((event: PendingStatsEvent | null) => {
    pendingStatsEventRef.current = event;
    setPendingStatsEventState(event);
  }, []);

  return { pendingStatsEvent, pendingStatsEventRef, setPendingStatsEvent };
}
