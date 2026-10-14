import { describe, expect, it } from "vitest";
import {
  CALCULATOR_INPUT_ITEM_TYPE,
  calculatorInputKey,
  DEFAULT_CALCULATOR_INPUT,
  EMPTY_WORKSPACE_DOCUMENT,
  parseCalculatorInput,
  parseWorkspaceDocument,
  readCalculatorInput,
  writeCalculatorInput,
} from "./workspaceDocument";
import { createMemoryWorkspaceStore, parseAccountRecord, parseGuestRecord } from "./workspaceStore";

const INPUT = {
  grade: "SR" as const,
  level: 7,
  exp: 300,
  stock: { blue: 1, purple: 2, yellow: 3 },
};
const STAGE = {
  itemId: "item-1",
  stage: "stage-1",
  lifetimeAttempts: 1,
  lifetimeIncome: 2,
  preSignupIncome: 0,
  manualEntry: false,
  verified: true,
};

describe("workspace document adapter", () => {
  it("writes one versioned calculator item and reads it back", () => {
    const document = writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, INPUT);
    expect(document).toEqual({
      schemaVersion: 1,
      items: [{ type: CALCULATOR_INPUT_ITEM_TYPE, version: 1, input: INPUT }],
      lifetimeStages: [],
    });
    expect(readCalculatorInput(document)).toEqual(INPUT);
    expect(readCalculatorInput(writeCalculatorInput(document, DEFAULT_CALCULATOR_INPUT))).toEqual(
      DEFAULT_CALCULATOR_INPUT,
    );
    expect(writeCalculatorInput(document, INPUT).items).toHaveLength(1);
  });

  it("preserves foreign items, newer item versions and lifetime stages", () => {
    const foreign = { type: "certified-session", version: 1, text: "{}" };
    const newer = { type: CALCULATOR_INPUT_ITEM_TYPE, version: 2, input: { future: true } };
    const document = writeCalculatorInput(
      { schemaVersion: 1, items: [foreign, newer], lifetimeStages: [STAGE] },
      INPUT,
    );
    expect(document.items.slice(0, 2)).toEqual([foreign, newer]);
    expect(document.lifetimeStages).toEqual([STAGE]);
    expect(readCalculatorInput({ ...document, items: [newer] })).toBeNull();
  });

  it("rejects invalid calculator inputs instead of applying them", () => {
    expect(parseCalculatorInput({ ...INPUT, level: 16 })).toBeNull();
    expect(parseCalculatorInput({ ...INPUT, exp: -1 })).toBeNull();
    expect(parseCalculatorInput({ ...INPUT, grade: "SSR" })).toBeNull();
    expect(
      parseCalculatorInput({ ...INPUT, stock: { blue: 1.5, purple: 0, yellow: 0 } }),
    ).toBeNull();
    const broken = {
      schemaVersion: 1 as const,
      items: [{ type: CALCULATOR_INPUT_ITEM_TYPE, version: 1, input: { grade: "R" } }],
      lifetimeStages: [],
    };
    expect(readCalculatorInput(broken)).toBeNull();
  });

  it("validates whole documents from storage or the network", () => {
    expect(
      parseWorkspaceDocument({ schemaVersion: 1, items: [], lifetimeStages: [STAGE] }),
    ).toEqual({ schemaVersion: 1, items: [], lifetimeStages: [STAGE] });
    expect(parseWorkspaceDocument({ schemaVersion: 2, items: [], lifetimeStages: [] })).toBeNull();
    expect(
      parseWorkspaceDocument({
        schemaVersion: 1,
        items: [],
        lifetimeStages: [{ ...STAGE, lifetimeIncome: -1 }],
      }),
    ).toBeNull();
  });

  it("keys inputs by value only", () => {
    expect(calculatorInputKey({ ...INPUT, stock: { ...INPUT.stock } })).toBe(
      calculatorInputKey(INPUT),
    );
    expect(calculatorInputKey({ ...INPUT, exp: 400 })).not.toBe(calculatorInputKey(INPUT));
    expect(calculatorInputKey(null)).toBe("none");
  });
});

describe("device workspace store", () => {
  it("keeps guest and per-account copies apart", async () => {
    const store = createMemoryWorkspaceStore();
    const document = writeCalculatorInput(EMPTY_WORKSPACE_DOCUMENT, INPUT);
    await store.writeGuest({ document, restoreOnReturn: false, updatedAt: 1 });
    await store.writeAccount({ userId: "a", baseRevision: 2, document, dirty: true, updatedAt: 1 });
    expect(await store.readAccount("b")).toBeNull();
    await store.removeAccount("a", false);
    expect(await store.readAccount("a")).toBeNull();
    expect(await store.readGuest()).toMatchObject({ restoreOnReturn: false });
  });

  it("refuses malformed or mismatched records", () => {
    const document = EMPTY_WORKSPACE_DOCUMENT;
    const record = { userId: "a", baseRevision: 0, document, dirty: false, updatedAt: 1 };
    expect(parseAccountRecord(record, "a")).toEqual(record);
    expect(parseAccountRecord(record, "b")).toBeNull();
    expect(parseAccountRecord({ ...record, baseRevision: -1 }, "a")).toBeNull();
    expect(parseGuestRecord({ document, restoreOnReturn: "yes", updatedAt: 1 })).toBeNull();
  });
});
