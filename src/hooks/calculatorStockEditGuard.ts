import { useCallback } from "react";

import type { Stock } from "../types";
import { clampStock } from "./calculatorShared";

type GuardedStockOptions = {
  setStock: (stock: Stock) => void;
};

export function useGuardedStockSetter({ setStock }: GuardedStockOptions) {
  return useCallback(
    (nextStock: Stock) => {
      setStock(clampStock(nextStock));
    },
    [setStock],
  );
}
