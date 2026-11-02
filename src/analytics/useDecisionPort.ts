import { useEffect } from "react";
import { observeDecision, type DecisionLifecycle } from "./decisionLifecycle";

type Options = {
  enabled?: boolean;
  providerReady?: () => boolean;
  lifecycle?: DecisionLifecycle;
  disable?: () => void;
};

/** The revised wire adapter supplies the explicit port; no inferred results or browser observers. */
export function useDecisionPort(options: Options = {}) {
  let ready = false;
  if (options.enabled === true)
    ready = observeDecision(options.providerReady) === true;
  const lifecycle = ready ? options.lifecycle : undefined;
  const owner = observeDecision(lifecycle ? () => lifecycle.captureOutcomeOwner() : undefined);
  useEffect(() => () => {
    observeDecision(options.disable);
  }, [options.disable]);
  useEffect(() => () => {
    if (owner !== undefined)
      observeDecision(lifecycle ? () => lifecycle.retire(owner, "unmount") : undefined);
  }, [lifecycle, owner]);
  return {
    lifecycle,
    owner,
    explicitAction: (action: "recalculate" | "reset" | "outcome_open" | "dismiss") => {
      if (owner !== undefined) {
        observeDecision(lifecycle ? () => lifecycle.explicitAction?.(owner, action) : undefined);
        if (action === "reset")
          observeDecision(lifecycle ? () => lifecycle.retire(owner, "reset") : undefined);
      }
    },
    contextChanged: () => {
      if (owner !== undefined)
        observeDecision(lifecycle ? () => lifecycle.retire(owner, "superseded") : undefined);
    },
  };
}
