import { message } from "../i18n/locale";
import type { MessageKey } from "../i18n/messages.ko";
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
  const key: Record<Kit, MessageKey> = {
    blue: "result.stockAfterUseBlue",
    purple: "result.stockAfterUsePurple",
    yellow: "result.stockAfterUseYellow",
  };
  return message(key[kit], { before: beforeStock, after: afterStock });
}
