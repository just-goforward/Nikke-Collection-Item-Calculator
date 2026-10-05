import { toWire } from "../../shared/certifiedRational";
import type { CertifiedSupplyEvent } from "../../shared/certifiedSupply";
import type { ExactSupplyOutcome } from "../../shared/certifiedSupplyLaws";
import { CertifiedLimit } from "./budget";
import { law } from "./events";
import type { Triple } from "./types";
import type { WaitingContext } from "./waitingContext";

export type Cohort = 0 | 1 | 2;
type Receipt = {
  eventId: string;
  refIndex: number;
  pieces: Triple;
  mass: ReturnType<typeof toWire>;
};
export type Trajectory = { stock: Triple; receipts: Receipt[]; bytes: number };
export function appendReceipt(
  context: WaitingContext,
  path: Trajectory,
  event: CertifiedSupplyEvent,
  refIndex: number,
  selected: ExactSupplyOutcome,
): void {
  const stock: Triple = [
    path.stock[0] + selected.pieces[0],
    path.stock[1] + selected.pieces[1],
    path.stock[2] + selected.pieces[2],
  ];
  if (!stock.every(Number.isSafeInteger))
    throw new CertifiedLimit("witness_stock_not_safe_integer");
  const mass = toWire(selected.mass);
  const bytes = 104 + event.id.length * 2 + (mass.numerator.length + mass.denominator.length) * 2;
  context.kernel.budget.reserve(bytes);
  path.bytes += bytes;
  path.stock = stock;
  path.receipts.push({ eventId: event.id, refIndex, pieces: selected.pieces, mass });
}
export function releaseTrajectory(context: WaitingContext, path: Trajectory): void {
  context.kernel.budget.release(path.bytes);
}
export function trajectory(
  context: WaitingContext,
  events: readonly CertifiedSupplyEvent[],
  cohort: Cohort,
  stock: Triple,
  select: (
    event: CertifiedSupplyEvent,
    refIndex: number,
    outcomes: readonly ExactSupplyOutcome[],
  ) => ExactSupplyOutcome,
): Trajectory {
  const path: Trajectory = { stock, receipts: [], bytes: 0 };
  try {
    for (const event of events) {
      for (let refIndex = 0; refIndex < event.refs.length; refIndex++) {
        appendReceipt(
          context,
          path,
          event,
          refIndex,
          select(
            event,
            refIndex,
            law(context.input, event, refIndex, cohort, context.kernel.budget),
          ),
        );
      }
    }
    return path;
  } catch (error) {
    releaseTrajectory(context, path);
    throw error;
  }
}
