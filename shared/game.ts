export type Grade = "R" | "SR";

export const KIT_ORDER = ["blue", "purple", "yellow"] as const;
export type Kit = (typeof KIT_ORDER)[number];
export type Strategy = "single" | "supply";
export type KitRecord<T> = Record<Kit, T>;

export type CollectionState = {
  grade: Grade;
  level: number;
  exp: number;
};

export type Stock = KitRecord<number>;

export type SolverInput = {
  start: CollectionState;
  stock: Stock;
  strategy?: Strategy;
  monteCarloRuns?: number;
  monteCarloSeed?: number;
};

export const KIT_EXP: KitRecord<number> = { blue: 200, purple: 500, yellow: 1000 };
export const REQUIRED_EXP: Record<Grade, number> = { R: 1000, SR: 3000 };

export const GREAT_SUCCESS: Record<Grade, Record<Kit, Array<number | null>>> = {
  R: {
    blue: [
      17.6, 20.8, 24.0, 27.2, 40.0, 16.0, 19.2, 22.4, 27.2, 40.0, 14.4, 17.6, 22.4, 27.2,
      40.0,
    ],
    purple: [
      55.0, 65.0, 75.0, 85.0, 100.0, 50.0, 60.0, 70.0, 85.0, 100.0, 45.0, 55.0, 70.0, 85.0,
      100.0,
    ],
    yellow: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
  },
  SR: {
    blue: [3.6, 5.9, 7.8, 11.3, 15.0, 2.2, 3.3, 4.9, 7.6, 12.5, 1.2, 2.2, 3.1, 4.7, 10.0],
    purple: [11.0, 19.8, 28.7, 41.3, 55.0, 8.0, 12.0, 18.0, 28.0, 50.0, 5.4, 9.9, 14.4, 21.6, 45.0],
    yellow: [
      25.0, 40.0, 55.0, 75.0, 100.0, 20.0, 30.0, 45.0, 70.0, 100.0, 15.0, 27.5, 40.0, 60.0,
      100.0,
    ],
  },
};

export function nextBoundary(level: number) {
  if (level < 5) return 5;
  if (level < 10) return 10;
  return 15;
}

export function greatSuccessState(state: CollectionState): CollectionState {
  return { grade: state.grade, level: nextBoundary(state.level), exp: 0 };
}

export function failOnce(state: CollectionState, kit: Kit): CollectionState {
  if (state.level >= 15) return { grade: state.grade, level: 15, exp: 0 };
  let level = state.level;
  let exp = state.exp + KIT_EXP[kit];
  const required = REQUIRED_EXP[state.grade];

  while (exp >= required && level < 15) {
    exp -= required;
    level += 1;
    if (level === 5 || level === 10 || level === 15) {
      exp = 0;
      break;
    }
  }

  return { grade: state.grade, level, exp };
}

export function failAfterUses(state: CollectionState, kit: Kit, uses: number) {
  let next = { ...state };
  for (let index = 0; index < uses; index += 1) next = failOnce(next, kit);
  return next;
}
