import { type CollectionState, REQUIRED_EXP } from "../../shared/game";
import { HttpError } from "./http-error";

export function validateState(state: CollectionState, allowLevel15: boolean): CollectionState {
  const grade = state.grade;
  const maxLevel = allowLevel15 ? 15 : 14;
  const level = state.level;
  if (level > maxLevel) throw new HttpError(400, "invalid_state_level");
  const required = REQUIRED_EXP[grade];
  const exp = state.exp;
  if (exp > required - 100) throw new HttpError(400, "invalid_state_exp");
  if (exp % 100 !== 0) throw new HttpError(400, "invalid_state_exp_step");
  if (level === 15 && exp !== 0) throw new HttpError(400, "invalid_level_15_exp");
  return { grade, level, exp };
}

export function sameState(a: CollectionState, b: CollectionState) {
  return a.grade === b.grade && a.level === b.level && a.exp === b.exp;
}
