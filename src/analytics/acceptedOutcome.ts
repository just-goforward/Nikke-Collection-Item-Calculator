import type { Stock } from "../types";
import type { OutcomeBest } from "../hooks/calculatorShared";
import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";

/** RAM-only action context; deliberately excludes the solver input and state. */
export type AcceptedOutcomeContext = Readonly<{
  stock: Readonly<Stock>;
  action: OutcomeBest["firstAction"];
  recommendedUses: number;
}>;

type Capture = (context: AcceptedOutcomeContext) => boolean;
let activeCapture: Capture | undefined;
let settlingReport = false;
type SettlementSink = (event: StatsSubmissionEvent) => void;
let settlementSink: SettlementSink | undefined;
const settledPending = new WeakMap<object, SettlementSink>();
export const isOutcomeReportSettlementActive = () => settlingReport;
export const markOutcomeReportPending = (pending: object) => settledPending.set(pending, settlementSink ?? (() => undefined));
export const isOutcomeReportPending = (pending: object) => settledPending.has(pending);
export function retainPendingOutcomeSettlement(pending: object, event: StatsSubmissionEvent) {
  settledPending.get(pending)?.(event);
}
export function interceptOutcomeSettlement(event: StatsSubmissionEvent): boolean {
  if (!settlingReport || event.kind !== "kit_result") return false;
  settlementSink?.(event);
  return true;
}
export function withOutcomeReportSettlement<T>(settled: boolean, apply: () => T, sink?: SettlementSink): T {
  const previous = settlingReport;
  const previousSink = settlementSink;
  settlingReport = settled;
  settlementSink = sink;
  try { return apply(); } finally { settlingReport = previous; settlementSink = previousSink; }
}

/** The application path is synchronous, including its preparation and mutations. */
export function withAcceptedOutcomeCapture<T>(capture: Capture | undefined, apply: () => T, sink?: SettlementSink): T {
  const previous = activeCapture;
  const previousSettlement = settlingReport;
  const previousSink = settlementSink;
  settlementSink = sink;
  activeCapture = capture;
  settlingReport = false;
  try {
    return apply();
  } finally {
    activeCapture = previous;
    settlingReport = previousSettlement;
    settlementSink = previousSink;
  }
}

export function capturePreparedOutcome(stock: Stock, action: OutcomeBest["firstAction"], recommendedUses: number): void {
  if (!activeCapture) return;
  try {
    settlingReport = activeCapture({ stock: Object.freeze({ ...stock }), action, recommendedUses });
  } catch {
    // Optional observation must not interrupt an accepted product action.
  }
}
