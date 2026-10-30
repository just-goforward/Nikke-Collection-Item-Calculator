import type { DecisionLifecycle } from "./decisionLifecycle";
import type { SolverInput } from "../types";
import type { SolverResult } from "../hooks/calculatorShared";
import { acquisitionForResult, requestDecisionAcquisition, type PublicAcquisition } from "./decisionAcquisition";

/** Internal correspondence, not a proposed v3 wire schema. Never serialized wholesale. */
type SupplyMetadata = Readonly<{
  contentHash: string;
  expectedSupply: Readonly<{ blue: string; purple: string; yellow: string }>;
}>;
type BoundSupplyMetadata = SupplyMetadata & PublicAcquisition;
export type RunProvider = Readonly<{
  producerVersion: string; producerCodeHash: string;
  forecasts: readonly SupplyMetadata[];
  /** Pure approved public mapping over the pinned source and actual acquired context. */
  bindAcquisition: (source: readonly SupplyMetadata[], actual: PublicAcquisition) => BoundSupplyMetadata | undefined;
}>;
export type RunRecord = {
  readonly provider: RunProvider;
  readonly contentHash: string;
  readonly expectedSupply: Readonly<{ blue: string; purple: string; yellow: string }>;
  readonly current: "blue" | "purple" | "yellow" | null;
  readonly preserve: boolean;
  readonly verifiedWait: number | null;
  currentPresented: boolean;
  waitPresented: boolean;
  outcome: "success" | "fail" | undefined;
  attemptObserved: boolean;
  acceptedAttempt: number | undefined;
  firstAction: "input_edit" | "recalculate" | "reset" | "outcome_open" | "dismiss" | undefined;
};
type Owner = { readonly generation: number; readonly provider: RunProvider; record?: RunRecord };
type Options = {
  enabled?: boolean;
  captureProvider?: (input: SolverInput) => RunProvider | undefined;
  /** True means a client parent was queued, never that the server admitted it. */
  accepted?: (record: Readonly<RunRecord>, input: SolverInput) => boolean;
  changed?: (record: Readonly<RunRecord>) => void;
  retired?: (record: Readonly<RunRecord>, reason: string) => void;
};

/** One run owner, with no fallback to a newer owner and no stored raw input/snapshot. */
export function createDecisionRun(options: Options = {}): DecisionLifecycle {
  let generation = 0;
  let current: Owner | undefined;
  const owns = (owner: unknown): owner is Owner => owner !== undefined && owner === current;
  const retire = (owner: unknown, reason: string) => {
    if (!owns(owner)) return;
    const record = owner.record;
    current = undefined;
    if (record) options.retired?.(record, reason);
  };
  return {
    begin(input) {
      if (options.enabled !== true) return undefined;
      if (current) retire(current, "new_solve");
      const captured = options.captureProvider?.(input);
      if (!captured || typeof captured.bindAcquisition !== "function") return undefined;
      // Pin before acquisition and never reread a later provider or substitute its identity.
      const provider: RunProvider = {
        producerVersion: captured.producerVersion,
        producerCodeHash: captured.producerCodeHash,
        forecasts: structuredClone(captured.forecasts),
        bindAcquisition: captured.bindAcquisition,
      };
      for (const entry of provider.forecasts) {
        Object.freeze(entry.expectedSupply);
        Object.freeze(entry);
      }
      Object.freeze(provider.forecasts);
      Object.freeze(provider);
      current = { generation: ++generation, provider };
      requestDecisionAcquisition(input);
      return current;
    },
    accepted(owner, input, result: SolverResult, origin) {
      if (!owns(owner) || owner.record || origin !== "final" || result.certified?.final !== true) return;
      const acquisition = acquisitionForResult(result);
      if (!acquisition) return;
      const match = owner.provider.bindAcquisition(owner.provider.forecasts, acquisition);
      if (!match || match.contentHash !== acquisition.contentHash ||
          match.runtimeSnapshotHash !== acquisition.runtimeSnapshotHash || match.asOf !== acquisition.asOf)
        return;
      if (!owner.provider.forecasts.some(entry =>
        entry.contentHash === match.contentHash &&
        entry.expectedSupply.blue === match.expectedSupply.blue &&
        entry.expectedSupply.purple === match.expectedSupply.purple &&
        entry.expectedSupply.yellow === match.expectedSupply.yellow)) return;
      const value = result.certified, output = value.output;
      if (input.start.level >= 15 || output.current?.status === "complete") return;
      if (owner.provider.producerCodeHash !== output.runtimeBinding.engineProfile.codeHash) return;
      if (output.status !== "completed" || output.refusal || output.claimNotice ||
          output.waiting.status === "claim_required") return;
      const stable = output.stableRecommendation;
      const selection = stable?.selection, guidance = stable?.guidance;
      const wait = selection?.status === "WAIT" && guidance?.status === "WAIT" &&
        Number.isInteger(selection.day) && selection.day >= 1 && selection.day <= 14 &&
        guidance.day === selection.day ? selection.day : null;
      // Current and verified WAIT remain independent; no A/B/C precedence is applied.
      const kit = value.action?.kit ?? null;
      if (!kit && wait === null && output.current?.status !== "preserve") return;
      const record: RunRecord = {
        provider: owner.provider, contentHash: acquisition.contentHash,
        expectedSupply: Object.freeze({ ...match.expectedSupply }), current: kit,
        preserve: output.current?.status === "preserve", verifiedWait: wait,
        currentPresented: false, waitPresented: false, outcome: undefined,
        attemptObserved: false, acceptedAttempt: undefined, firstAction: undefined,
      };
      if (options.accepted?.(record, input) === true) owner.record = record;
    },
    captureOutcomeOwner: () => current?.record ? current : undefined,
    outcomeConfirmed(owner, outcome) {
      if (!owns(owner) || !owner.record || owner.record.outcome !== undefined) return;
      owner.record.outcome = outcome;
      options.changed?.(owner.record);
    },
    attemptReported(owner, acceptedAttempt) {
      if (!owns(owner) || !owner.record || owner.record.attemptObserved ||
          !Number.isSafeInteger(acceptedAttempt) || acceptedAttempt < 0) return;
      owner.record.acceptedAttempt = acceptedAttempt;
      owner.record.attemptObserved = true;
      options.changed?.(owner.record);
    },
    presented(owner, leaf) {
      if (!owns(owner) || !owner.record) return;
      if (leaf === "current" && (owner.record.current !== null || owner.record.preserve)) owner.record.currentPresented = true;
      else if (leaf === "wait" && owner.record.verifiedWait !== null) owner.record.waitPresented = true;
      else return;
      options.changed?.(owner.record);
    },
    explicitAction(owner, action) {
      if (!owns(owner) || !owner.record || owner.record.firstAction !== undefined) return;
      owner.record.firstAction = action;
      options.changed?.(owner.record);
    },
    retire,
  };
}
