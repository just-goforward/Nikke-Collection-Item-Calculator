import { formatInteger } from "../format";
import { KIT_META } from "../solver/domain";
import type { Kit, Stock } from "../types";

export function stockAfterKitUse(
  currentStock: Stock,
  kit: Kit,
  beforeStock: number,
  usedCount: number,
): Stock {
  return {
    ...currentStock,
    [kit]: Math.max(0, beforeStock - usedCount),
  };
}

export function kitStockChangeMessage(kit: Kit, beforeStock: number, afterStock: number) {
  return `${KIT_META[kit].label} 보유량은 ${formatInteger(beforeStock)}개에서 ${formatInteger(
    afterStock,
  )}개가 되었습니다.`;
}
