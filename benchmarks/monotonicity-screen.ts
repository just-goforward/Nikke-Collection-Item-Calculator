import type { Kit } from "../src/types";

export type ActionAtInventory = {
  action: Kit | null;
  availableUses: number;
};

export type ReentrantActionPattern = {
  action: Kit;
  firstIndex: number;
  gapIndex: number;
  returnIndex: number;
};

export function findReentrantActionPatterns(
  records: readonly ActionAtInventory[],
): ReentrantActionPattern[] {
  const patterns: ReentrantActionPattern[] = [];
  for (const action of ["blue", "purple", "yellow"] as const) {
    let firstIndex = -1;
    let gapIndex = -1;
    for (const [index, record] of records.entries()) {
      if (record.action === action) {
        if (firstIndex < 0) firstIndex = index;
        if (gapIndex >= 0) {
          patterns.push({ action, firstIndex, gapIndex, returnIndex: index });
          break;
        }
      } else if (firstIndex >= 0 && gapIndex < 0) {
        gapIndex = index;
      }
    }
  }
  return patterns;
}

export function successIsMonotone(records: readonly { successProbability: number }[]): boolean {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (!previous || !current) return false;
    if (current.successProbability < previous.successProbability - 1e-12) return false;
  }
  return true;
}
