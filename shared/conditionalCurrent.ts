import { GREAT_SUCCESS, KIT_ORDER, REQUIRED_EXP, failOnce, nextBoundary, type CollectionState, type Kit } from './game.ts';
import type { Triple } from '../src/certified/types.ts';
import type { ServiceH14Output } from '../src/serviceH14/types.ts';

export type ConditionalActionKind = 'strict' | 'practical' | 'conditional-current' | 'conditional-progress';

/** Derive the action from the request and audited final evidence, never from a wait date. */
export function conditionalCurrent(out: ServiceH14Output, board: CollectionState, stock: Triple,
  {legacyD0 = false, verifiedPrefix = false, currentBatch = true, batchLimit = 10} = {}):
  { kit: Kit; uses: number; kind: ConditionalActionKind } | null {
  const eligible = legacyD0
    ? out.status === 'withheld' && out.reason === 'legacy_current_only' &&
      out.records.length === 1 && out.records[0]!.day === 0
    : verifiedPrefix ? out.status === 'incomplete' && out.decision.status === 'unavailable' &&
      !out.adaptive && out.records.length > 0 && out.records.every((row, day) => row.day === day)
    : out.status === 'complete' && out.reason === null && out.accuracy.practical &&
      out.records.length === 15 && out.records.every((row, day) => row.day === day);
  if (!eligible || out.profile.policy !== 'adaptive-next-batch-balanced-v1' || !out.current ||
      out.current.status === 'complete' || board.level >= 15) return null;

  const a = legacyD0 ? undefined : out.adaptive;
  const strict = a?.mathematical === 'use_now' ? a.firstKit : null;
  const proven = a?.actionable === 'no_material_wait' ? strict ?? a.practicalFirstKit : null;
  const kit = proven ?? out.current.kit;
  if (kit) {
    const prefix = proven ? a!.practicalBatchUses : 0;
    if (proven && (!Number.isSafeInteger(prefix) || prefix < 1))
      throw Error('service_certified_action_contract');
    const current = out.current;
    const matches = kit === current.kit;
    // A longer exact current-stock run is executable, not a longer H14 proof.
    const uses = matches && (legacyD0 || currentBatch) ? Math.max(current.uses, prefix) : prefix || 1;
    const index = KIT_ORDER.indexOf(kit);
    if (!Number.isSafeInteger(uses) || uses < 1 || uses > batchLimit || index < 0 || stock[index]! < 10 * uses ||
        (matches && (current.status !== 'use_certified' || !(current.optimalActionMask & (1 << index)) ||
          !Number.isSafeInteger(current.uses) || current.uses < 1 || current.pieces !== 10 * current.uses)))
      throw Error('service_certified_action_contract');
    return {kit, uses, kind: proven && prefix === uses ? (strict ? 'strict' : 'practical') : 'conditional-current'};
  }

  // Exact D0 STOP has P=0, so every affordable forced first color also has
  // P=0. Instead maximize expected *one-use board progress* (in-grade XP),
  // saving the higher rarity on a tie. Never claim this is H14 optimal.
  if (out.current.status !== 'preserve' || out.current.value.successP.numerator !== '0') return null;
  const required = REQUIRED_EXP[board.grade];
  const greatGain = (nextBoundary(board.level) - board.level) * required - board.exp;
  let best: Kit | undefined, score = -1;
  for (const [k, color] of KIT_ORDER.entries()) {
    if (stock[k]! < 10) continue;
    const rate = Math.round(10 * GREAT_SUCCESS[board.grade][color][board.level]!);
    const normal = failOnce(board, color);
    const normalGain = (normal.level - board.level) * required + normal.exp - board.exp;
    const progress = rate * greatGain + (1000 - rate) * normalGain;
    if (progress > score) { best = color; score = progress; }
  }
  return best === undefined ? null : {kit:best, uses:1, kind:'conditional-progress'};
}
