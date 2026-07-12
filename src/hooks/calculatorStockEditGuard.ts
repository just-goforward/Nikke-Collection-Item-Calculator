import { type RefObject, useCallback } from "react";

import type { CollectionState, Stock } from "../types";
import { clampStock, type PendingStatsEvent } from "./calculatorShared";
import type { SetStockOptions } from "./calculatorStateActions";

type GuardedStockOptions = {
  currentStateSnapshot: () => CollectionState;
  manualStockEditRequired: boolean;
  pendingStatsEventRef: RefObject<PendingStatsEvent | null>;
  setStock: (stock: Stock, options?: SetStockOptions) => void;
};

export function useGuardedStockSetter({ manualStockEditRequired, setStock }: GuardedStockOptions) {
  return useCallback(
    (nextStock: Stock) => {
      const stock = clampStock(nextStock);
      setStock(stock, { clearManualStockEditRequired: manualStockEditRequired });
    },
    [manualStockEditRequired, setStock],
  );
}
