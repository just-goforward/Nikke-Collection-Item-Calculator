import { MAX_STOCK_PIECES, REQUIRED_EXP } from "../../shared/game";
import type { AppLocale } from "../i18n/locale";
import type { CollectionState, Stock } from "../types";

export type LegacyRecoveryInput = CollectionState & { stock: Stock };
export type LegacyRecoveryNotice = Record<AppLocale, string>;
export const LEGACY_PENDING_RECOVERY_NOTICE: LegacyRecoveryNotice = {
  ko: "미확정 입력은 복원하지 않습니다. 게임의 현재 등급·단계·재고를 확인해 입력하세요.",
  en: "Unconfirmed inputs won't be restored. Check and enter the game's current rarity, phase and inventory.",
  ja: "未確定の入力は復元しません。ゲームの現在の等級・段階・在庫を確認し入力してください。",
};
type RecoveryStorage = Pick<Storage, "getItem" | "removeItem">;
const KEY = "nikke:legacy-reload-input:v1";
const REVISION = "legacy-input-v1";
const TTL_MS = 5 * 60_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function validStock(value: unknown): value is Stock {
  if (!record(value) || !exactKeys(value, ["blue", "purple", "yellow"])) return false;
  return Object.values(value).every(
    (count) =>
      typeof count === "number" &&
      Number.isInteger(count) &&
      count >= 0 &&
      count <= MAX_STOCK_PIECES,
  );
}

function validInput(value: unknown): value is LegacyRecoveryInput {
  if (!record(value) || !exactKeys(value, ["grade", "level", "exp", "stock"])) return false;
  const { grade, level, exp, stock } = value;
  if (grade !== "R" && grade !== "SR") return false;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 15)
    return false;
  if (typeof exp !== "number" || !Number.isInteger(exp) || exp < 0 || exp % 100 !== 0) return false;
  if (level === 15 ? exp !== 0 : exp >= REQUIRED_EXP[grade]) return false;
  return validStock(stock);
}

function freshTimestamp(savedAt: unknown, now: number) {
  return (
    typeof savedAt === "number" &&
    Number.isSafeInteger(savedAt) &&
    Number.isSafeInteger(now) &&
    now >= savedAt &&
    now - savedAt < TTL_MS
  );
}

export function consumeLegacyInputRecovery(
  storage: RecoveryStorage,
  url: string,
  now = Date.now(),
): LegacyRecoveryInput | "pending" | null {
  try {
    const raw = storage.getItem(KEY);
    storage.removeItem(KEY);
    if (!raw || raw.length > 2048) return null;
    const value: unknown = JSON.parse(raw);
    if (!record(value) || !exactKeys(value, ["schema", "revision", "savedAt", "url", "input"]))
      return null;
    const { schema, revision, url: savedUrl, savedAt, input } = value;
    if (schema !== 1 || revision !== REVISION || savedUrl !== url) return null;
    if (!freshTimestamp(savedAt, now)) return null;
    return input === "pending" || validInput(input) ? input : null;
  } catch {
    return null;
  }
}
