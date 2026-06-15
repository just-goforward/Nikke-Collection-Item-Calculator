import type { CollectionState, KitRecord } from "./domain";
import { REQUIRED_EXP } from "./domain";
import type { UnknownRecord } from "./event-validation-types";
import { HttpError } from "./http-error";

const MAX_STOCK = 100000;

export function asRecord(value: unknown, message: string): UnknownRecord {
  if (!value || typeof value !== "object") throw new HttpError(400, message);
  return value as UnknownRecord;
}

export function field(record: UnknownRecord, key: string): unknown {
  return record[key];
}

export function normalizeState(state: unknown, allowLevel15: boolean): CollectionState {
  const value = asRecord(state, "invalid_state_grade");
  const gradeValue = field(value, "grade");
  if (gradeValue !== "R" && gradeValue !== "SR") throw new HttpError(400, "invalid_state_grade");
  const grade = gradeValue;
  const maxLevel = allowLevel15 ? 15 : 14;
  const level = intInRange(field(value, "level"), 0, maxLevel, "invalid_state_level");
  const required = REQUIRED_EXP[grade];
  const exp = intInRange(field(value, "exp"), 0, required - 100, "invalid_state_exp");
  if (exp % 100 !== 0) throw new HttpError(400, "invalid_state_exp_step");
  if (level === 15 && exp !== 0) throw new HttpError(400, "invalid_level_15_exp");
  return { grade, level, exp };
}

export function normalizeStock(stock: unknown): KitRecord<number> {
  const value = asRecord(stock, "invalid_stock");
  return {
    blue: intInRange(field(value, "blue"), 0, MAX_STOCK, "invalid_blue_stock"),
    purple: intInRange(field(value, "purple"), 0, MAX_STOCK, "invalid_purple_stock"),
    yellow: intInRange(field(value, "yellow"), 0, MAX_STOCK, "invalid_yellow_stock"),
  };
}

export function intInRange(value: unknown, min: number, max: number, message: string) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new HttpError(400, message);
  }
  return numeric;
}

export function sameState(a: CollectionState, b: CollectionState) {
  return a.grade === b.grade && a.level === b.level && a.exp === b.exp;
}
