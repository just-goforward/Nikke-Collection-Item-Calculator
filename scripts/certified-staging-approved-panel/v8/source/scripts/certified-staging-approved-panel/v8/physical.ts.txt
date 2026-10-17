import { add, cmp, type ExactQ, mul, type QTriple, q } from "../../certified-staging-oracle.ts";

/** Documented physical dispatch board, restated from the public rules rather than
 * imported from product code: 14 card classes with 4 identical cards each, per-card
 * weights in units of 1/400, 4 board slots, and exact regular/II box means folded
 * into each class gain. A reroll keeps the board cards of the keep classes
 * (zero-based 2,3,4,5,7,8,9), returns the rest to the deck and refills to 4. */
const BOARD = [
  { weight: 15, keep: false, gain: [q(2), q(0), q(0)] },
  { weight: 15, keep: false, gain: [q(3), q(0), q(0)] },
  { weight: 6, keep: true, gain: [q(0), q(2), q(0)] },
  { weight: 3, keep: true, gain: [q(0), q(3), q(0)] },
  { weight: 4, keep: true, gain: [q(0), q(0), q(1)] },
  { weight: 2, keep: true, gain: [q(0), q(0), q(2)] },
  { weight: 15, keep: false, gain: [q(12, 5), q(1, 5), q(0)] },
  { weight: 8, keep: true, gain: [q(24, 5), q(2, 5), q(0)] },
  { weight: 8, keep: true, gain: [q(7, 2), q(2, 5), q(1, 5)] },
  { weight: 4, keep: true, gain: [q(7), q(4, 5), q(2, 5)] },
  { weight: 3, keep: false, gain: [q(0), q(0), q(0)] },
  { weight: 7, keep: false, gain: [q(0), q(0), q(0)] },
  { weight: 7, keep: false, gain: [q(0), q(0), q(0)] },
  { weight: 3, keep: false, gain: [q(0), q(0), q(0)] },
] as const;
export const BOARD_COPIES = 4;
export const BOARD_SLOTS = 4;
export const REROLL_COHORTS = 4;
export type BoardState = { counts: readonly number[]; mass: ExactQ };
export type FourCohorts = readonly [QTriple, QTriple, QTriple, QTriple];

function merge(states: Map<string, BoardState>, counts: readonly number[], mass: ExactQ) {
  const key = counts.join(",");
  const previous = states.get(key);
  states.set(key, { counts, mass: previous ? add(previous.mass, mass) : mass });
}

/** Sequential weighted-without-replacement draws. Boards with equal card counts are
 * merged after every draw: the next draw depends only on those counts, so this is
 * the ordered-draw probability space aggregated exactly, not an approximation. */
function fill(start: Map<string, BoardState>) {
  let states = start;
  for (;;) {
    const next = new Map<string, BoardState>();
    let drew = false;
    for (const { counts, mass } of states.values()) {
      const placed = counts.reduce((sum, count) => sum + count, 0);
      if (placed === BOARD_SLOTS) {
        merge(next, counts, mass);
        continue;
      }
      drew = true;
      let total = 0;
      for (const [index, card] of BOARD.entries())
        total += (BOARD_COPIES - (counts[index] ?? 0)) * card.weight;
      for (const [index, card] of BOARD.entries()) {
        const weight = (BOARD_COPIES - (counts[index] ?? 0)) * card.weight;
        if (weight === 0) continue;
        merge(
          next,
          counts.map((count, other) => (other === index ? count + 1 : count)),
          mul(mass, q(weight, total)),
        );
      }
    }
    states = next;
    if (!drew) return [...states.values()];
  }
}

/** Full-board distributions after 0..3 rerolls. */
export function independentBoardDistributions(): readonly (readonly BoardState[])[] {
  let start = new Map<string, BoardState>();
  merge(
    start,
    BOARD.map(() => 0),
    q(1),
  );
  const rounds: BoardState[][] = [];
  for (let reroll = 0; reroll < REROLL_COHORTS; reroll += 1) {
    const boards = fill(start);
    rounds.push(boards);
    start = new Map();
    for (const { counts, mass } of boards)
      merge(
        start,
        counts.map((count, index) => (BOARD[index]?.keep ? count : 0)),
        mass,
      );
  }
  return rounds;
}

/** Exact expected pieces of the final board for cohorts 0..3 (rerolls), each from a
 * distribution whose total mass is asserted to be exactly 1. */
export function independentFourCohorts(
  rounds: readonly (readonly BoardState[])[] = independentBoardDistributions(),
): FourCohorts {
  const cohorts = rounds.map((boards) => {
    let total = q(0);
    const expectation: [ExactQ, ExactQ, ExactQ] = [q(0), q(0), q(0)];
    for (const { counts, mass } of boards) {
      total = add(total, mass);
      for (const color of [0, 1, 2] as const) {
        let gain = q(0);
        for (const [index, card] of BOARD.entries())
          gain = add(gain, mul(q(counts[index] ?? 0), card.gain[color]));
        expectation[color] = add(expectation[color], mul(mass, gain));
      }
    }
    if (cmp(total, q(1)) !== 0) throw new Error("independent_board_mass_not_one");
    return expectation;
  });
  const [c0, c1, c2, c3] = cohorts;
  if (!c0 || !c1 || !c2 || !c3 || cohorts.length !== REROLL_COHORTS)
    throw new Error("independent_board_cohort_count");
  return [c0, c1, c2, c3];
}
