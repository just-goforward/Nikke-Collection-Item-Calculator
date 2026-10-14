import type { WorkspaceDocument } from "../../personal-data/src/contracts";
import {
  CALCULATOR_INPUT_ITEM_TYPE,
  type CalculatorInput,
  calculatorInputKey,
  DEFAULT_CALCULATOR_INPUT,
  readCalculatorInputItem,
  writeCalculatorInput,
} from "./workspaceDocument";

export type WorkspaceItemType = "calculator-input" | "certified-session";

export type ItemRead<T> =
  | { status: "absent" }
  | { status: "value"; value: T }
  /** Present but rejected by validation: never applied, only replaced by an explicit overwrite. */
  | { status: "unreadable" };

/**
 * One engine's item in the shared workspace document. Each engine reads and writes only its own
 * item kind and version; every other item and the lifetime stages are preserved verbatim.
 */
export type WorkspaceItemCodec<T> = {
  type: WorkspaceItemType;
  read(document: WorkspaceDocument): ItemRead<T>;
  write(document: WorkspaceDocument, value: T): WorkspaceDocument;
  /** Value identity used to detect real edits. */
  key(value: T): string;
  /** Inputs shown in conflict and guest-copy summaries. */
  summary(value: T): CalculatorInput;
  /** UTF-8 size shown for items that can grow large; null when not shown. */
  bytes(value: T): number | null;
  /** Untouched defaults are never offered for a guest copy. */
  isEmpty(value: T): boolean;
  /** Shown when the account has no readable item and when guest data is missing. */
  empty(): T;
};

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** An unreadable v1 calculator item is a conflict: only an explicit overwrite replaces it. */
export const calculatorInputCodec: WorkspaceItemCodec<CalculatorInput> = {
  type: CALCULATOR_INPUT_ITEM_TYPE,
  read: readCalculatorInputItem,
  write: writeCalculatorInput,
  key: calculatorInputKey,
  summary: (input) => input,
  bytes: () => null,
  isEmpty: (input) => calculatorInputKey(input) === calculatorInputKey(DEFAULT_CALCULATOR_INPUT),
  empty: () => DEFAULT_CALCULATOR_INPUT,
};
