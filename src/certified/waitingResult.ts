import type { Q } from "../../shared/certifiedRational";
import { isCertifiedEventClaimable } from "../../shared/certifiedSupply";
import { waitingBase } from "./events";
import type { FiniteKernel } from "./kernel";
import type { CertifiedInput, CertifiedOutput } from "./types";
import type { ExactValue } from "./value";
import { certifiedValueView } from "./views";
import { solveWaiting } from "./waiting";
export function completeWaiting(
  output: CertifiedOutput,
  input: CertifiedInput,
  sid: number,
  root: ExactValue,
  kernel: FiniteKernel,
  priors: readonly [Q, Q, Q],
): void {
  const received = new Set(input.receivedEventIds ?? []);
  const claimable = input.snapshot.events.filter(
    (event) =>
      isCertifiedEventClaimable(input.snapshot, event, input.asOf) && !received.has(event.id),
  );
  if (claimable.length) {
    output.claimNotice = {
      eventIds: claimable.map((event) => event.id),
      message: "Claim the currently available rewards, update stock, then calculate again.",
    };
    output.waiting = waitingBase("claim_required", "current_claimable_unreceived");
  } else if (input.computeWaiting === false) output.waiting = waitingBase("not_requested", null);
  else
    output.waiting = solveWaiting(input, sid, root, kernel, priors, (value) =>
      certifiedValueView(kernel.actualValue(value)),
    );
  if (input.snapshot.sourceStatus !== "healthy") {
    output.waiting.evidence = [
      ...output.waiting.evidence,
      "modeled_forecast_source_uncertain_no_automatic_delay",
    ];
  }
}
