import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { prepareCertifiedForecast } from "../lib/certifiedForecast";
import type { RuntimeForecastStatus } from "../lib/runtimeForecast";
import { type CertifiedSession, reconcileCertifiedSession } from "./session";
import type { CertifiedSessionStore } from "./useCertifiedCalculatorSession";

export type CertifiedPrepareError =
  | "unsupported_forecast_version"
  | "preparation_failed"
  | "forecast_unavailable";

type RuntimeForecast = typeof import("../lib/runtimeForecast").runtimeForecast;

/** Staging fails closed: only a verified runtime publication may supply the calculator.
 * Returns null while the first check is pending; never substitutes the bundled authority.
 */
export function stagingRuntimeSnapshot(
  runtime: RuntimeForecast | undefined,
  status: RuntimeForecastStatus,
  asOf: string,
): CertifiedSupplySnapshot | null {
  if (!runtime || status === "checking") return null;
  const accepted = runtime.peek(asOf);
  if (!accepted) throw new Error("forecast_unavailable");
  return accepted.snapshot;
}

export function useCertifiedCalculatorSnapshot() {
  const [snapshot, setSnapshot] = useState<CertifiedSupplySnapshot | null>(null);
  const [prepareError, setPrepareError] = useState<CertifiedPrepareError | null>(null);
  const snapshotRef = useRef(snapshot);
  return { snapshot, setSnapshot, prepareError, setPrepareError, snapshotRef };
}

export type CertifiedSnapshotState = ReturnType<typeof useCertifiedCalculatorSnapshot>;

function changedForecast(previous: CertifiedSupplySnapshot | null, next: CertifiedSupplySnapshot) {
  return (
    previous &&
    (previous.revision !== next.revision ||
      previous.sourceHash !== next.sourceHash ||
      previous.coverage.currentDay !== next.coverage.currentDay)
  );
}

export function useCertifiedCalculatorPreparation(
  preparation: CertifiedSnapshotState,
  latest: CertifiedSessionStore["latest"],
  retire: () => void,
  updateSession: Dispatch<SetStateAction<CertifiedSession>>,
  calculating: { current: boolean },
) {
  const { snapshotRef, setSnapshot, setPrepareError } = preparation;
  useEffect(() => {
    let active = true;
    const staging = import.meta.env.VITE_FORECAST_RUNTIME === "staging";
    let runtime: RuntimeForecast | undefined;
    let runtimeStatus: RuntimeForecastStatus = "checking";
    let unwatch: (() => void) | undefined;
    const prepare = async () => {
      if (calculating.current) return;
      try {
        const asOf = new Date().toISOString();
        const next = staging
          ? stagingRuntimeSnapshot(runtime, runtimeStatus, asOf)
          : await prepareCertifiedForecast(asOf);
        if (!next || !active || calculating.current) return;
        const previous = snapshotRef.current;
        if (changedForecast(previous, next)) retire();
        snapshotRef.current = next;
        setSnapshot(next);
        setPrepareError(null);
        const current = latest.current;
        if (
          !current.correction &&
          !current.storageBlocked &&
          !current.modalBatch &&
          current.session.snapshotRevision !== next.revision
        )
          updateSession((old) => reconcileCertifiedSession(old, next.revision, next.events));
      } catch (failure) {
        if (active) fail(failure instanceof Error ? failure.message : "");
      }
    };
    const fail = (message: string) => {
      // Staging never keeps a previously displayed supply after a failed or missing publication.
      if (message === "unsupported_forecast_version" || staging) {
        retire();
        snapshotRef.current = null;
        setSnapshot(null);
      }
      if (message === "unsupported_forecast_version") setPrepareError(message);
      else if (staging && message === "forecast_unavailable") setPrepareError(message);
      else setPrepareError("preparation_failed");
    };
    if (staging)
      void import("../lib/runtimeForecast").then(
        (module) => {
          if (!active) return;
          runtime = module.runtimeForecast;
          unwatch = runtime.watch(document, (status) => {
            runtimeStatus = status;
            void prepare();
          });
        },
        () => {
          // Without the runtime client no publication can be verified; nothing is prepared.
          if (active) setPrepareError("preparation_failed");
        },
      );
    else void prepare();
    const refresh = window.setInterval(() => {
      void prepare();
    }, 60_000);
    return () => {
      active = false;
      unwatch?.();
      window.clearInterval(refresh);
    };
  }, [calculating, latest, retire, setPrepareError, setSnapshot, snapshotRef, updateSession]);
}
