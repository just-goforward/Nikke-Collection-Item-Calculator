import { describe, expect, it } from "vitest";

import {
  type CollectionState,
  capStockForState,
  convertState,
  isConvertStateNormalized,
  isTerminalNormalized,
  KIT_ORDER,
  type Kit,
  stateIdNormalized,
  transitionNormalized,
} from "../src/solver/domain";

const UNBOUNDED_STOCK = {
  blue: Number.MAX_SAFE_INTEGER,
  purple: Number.MAX_SAFE_INTEGER,
  yellow: Number.MAX_SAFE_INTEGER,
};

function solverStates(): CollectionState[] {
  const states: CollectionState[] = [];
  for (const grade of ["R", "SR"] as const) {
    for (let level = 0; level <= 15; level += 1) {
      for (let exp = 0; exp <= 2_900; exp += 100) {
        states.push({ grade, level, exp });
      }
    }
  }
  return states;
}

function maximumTargetUses(start: CollectionState, target: Kit, memo: Map<number, number>): number {
  const key = stateIdNormalized(start);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  if (isTerminalNormalized(start)) {
    memo.set(key, 0);
    return 0;
  }
  if (isConvertStateNormalized(start)) {
    const value = maximumTargetUses(convertState(), target, memo);
    memo.set(key, value);
    return value;
  }

  let maximum = 0;
  for (const action of KIT_ORDER) {
    const edge = transitionNormalized(start, action);
    const successorMaximum = Math.max(
      maximumTargetUses(edge.success, target, memo),
      maximumTargetUses(edge.fail, target, memo),
    );
    maximum = Math.max(maximum, Number(action === target) + successorMaximum);
  }
  memo.set(key, maximum);
  return maximum;
}

describe("phase2 stock-cap methodology", () => {
  it("matches the independent maximum-use recurrence across every nonterminal encoded state", () => {
    const states = solverStates();
    expect(states).toHaveLength(960);

    for (const target of KIT_ORDER) {
      const memo = new Map<number, number>();
      for (const state of states) {
        if (isTerminalNormalized(state)) continue;
        const exactMaximum = maximumTargetUses(state, target, memo);
        const cap = capStockForState(state, UNBOUNDED_STOCK)[target];
        expect(cap, `${state.grade}${state.level}/${state.exp} ${target}`).toBe(exactMaximum);
      }
    }
  });

  it("leaves terminal stock unchanged instead of manufacturing an empty-stock state", () => {
    expect(capStockForState({ grade: "SR", level: 15, exp: 0 }, UNBOUNDED_STOCK)).toEqual(
      UNBOUNDED_STOCK,
    );
  });
});
