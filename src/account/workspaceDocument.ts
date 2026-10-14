import * as z from "zod/mini";
import type { Json, StageSummary, WorkspaceDocument } from "../../personal-data/src/contracts";
import type { Grade, Stock } from "../types";

/**
 * Workspace document adapter (contract `WorkspaceDocument.schemaVersion: 1`).
 *
 * `items` is calculator-owned. This client owns exactly one item kind:
 *   { type: "calculator-input", version: 1, input: { grade, level, exp, stock } }
 * Every other item (other types or newer versions) is preserved verbatim on save, and
 * `lifetimeStages` is always carried over from the latest server document.
 */
export const CALCULATOR_INPUT_ITEM_TYPE = "calculator-input";
const CALCULATOR_INPUT_ITEM_VERSION = 1;
const MAX_LEVEL = 15;

export type CalculatorInput = { grade: Grade; level: number; exp: number; stock: Stock };

export const DEFAULT_CALCULATOR_INPUT: CalculatorInput = {
  grade: "R",
  level: 0,
  exp: 0,
  stock: { blue: 0, purple: 0, yellow: 0 },
};

export const EMPTY_WORKSPACE_DOCUMENT: WorkspaceDocument = {
  schemaVersion: 1,
  items: [],
  lifetimeStages: [],
};

const COUNT = z.int().check(z.minimum(0));
const ID = z.string().check(z.regex(/^[A-Za-z0-9_-]{1,128}$/));
const FINITE_NONNEGATIVE = z.number().check(z.minimum(0));

const StageSummarySchema = z.object({
  itemId: ID,
  stage: ID,
  lifetimeAttempts: COUNT,
  lifetimeIncome: FINITE_NONNEGATIVE,
  preSignupIncome: FINITE_NONNEGATIVE,
  manualEntry: z.boolean(),
  verified: z.boolean(),
});

export const WorkspaceDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(z.json()),
  lifetimeStages: z.array(StageSummarySchema),
});

const CalculatorInputSchema = z.object({
  grade: z.enum(["R", "SR"]),
  level: z.int().check(z.minimum(0), z.maximum(MAX_LEVEL)),
  exp: COUNT,
  stock: z.object({ blue: COUNT, purple: COUNT, yellow: COUNT }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOwnedItem(item: Json): boolean {
  return (
    isRecord(item) &&
    item["type"] === CALCULATOR_INPUT_ITEM_TYPE &&
    item["version"] === CALCULATOR_INPUT_ITEM_VERSION
  );
}

export function parseWorkspaceDocument(value: unknown): WorkspaceDocument | null {
  const parsed = WorkspaceDocumentSchema.safeParse(value);
  if (!parsed.success) return null;
  const stages: StageSummary[] = parsed.data.lifetimeStages;
  return { schemaVersion: 1, items: parsed.data.items, lifetimeStages: stages };
}

export function parseCalculatorInput(value: unknown): CalculatorInput | null {
  const parsed = CalculatorInputSchema.safeParse(value);
  if (!parsed.success) return null;
  const { grade, level, exp, stock } = parsed.data;
  return {
    grade,
    level,
    exp,
    stock: { blue: stock.blue, purple: stock.purple, yellow: stock.yellow },
  };
}

/** The calculator input stored in a document, or null when absent/unreadable. */
export function readCalculatorInput(document: WorkspaceDocument): CalculatorInput | null {
  const item = document.items.find(isOwnedItem);
  return item !== undefined && isRecord(item) ? parseCalculatorInput(item["input"]) : null;
}

/** Replaces only this client's item; foreign items and lifetime stages are kept as they were. */
export function writeCalculatorInput(
  document: WorkspaceDocument,
  input: CalculatorInput,
): WorkspaceDocument {
  const item: Json = {
    type: CALCULATOR_INPUT_ITEM_TYPE,
    version: CALCULATOR_INPUT_ITEM_VERSION,
    input: {
      grade: input.grade,
      level: input.level,
      exp: input.exp,
      stock: { blue: input.stock.blue, purple: input.stock.purple, yellow: input.stock.yellow },
    },
  };
  return {
    schemaVersion: 1,
    items: [...document.items.filter((entry) => !isOwnedItem(entry)), item],
    lifetimeStages: document.lifetimeStages,
  };
}

/** Value identity used to detect real edits; null means "no calculator item". */
export function calculatorInputKey(input: CalculatorInput | null): string {
  if (!input) return "none";
  const { blue, purple, yellow } = input.stock;
  return JSON.stringify([input.grade, input.level, input.exp, blue, purple, yellow]);
}
