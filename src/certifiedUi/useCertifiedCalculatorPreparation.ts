import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import { prepareCertifiedForecast } from "../lib/certifiedForecast";
import { type CertifiedSession, reconcileCertifiedSession } from "./session";
import type { CertifiedSessionStore } from "./useCertifiedCalculatorSession";

export function useCertifiedCalculatorSnapshot() {
  const [snapshot, setSnapshot] = useState<CertifiedSupplySnapshot | null>(null);
  const [prepareError, setPrepareError] = useState<
    "unsupported_forecast_version" | "preparation_failed" | null
  >(null);
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
    let runtime: typeof import("../lib/runtimeForecast").runtimeForecast | undefined;
    let unwatch: (() => void) | undefined;
    const prepare = async () => {
      if (calculating.current) return;
      try {
        const asOf = new Date().toISOString();
        const next = runtime?.peek(asOf)?.snapshot ?? (await prepareCertifiedForecast(asOf));
        if (!active || calculating.current) return;
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
        if (!active) return;
        if (failure instanceof Error && failure.message === "unsupported_forecast_version") {
          retire();
          snapshotRef.current = null;
          setSnapshot(null);
          setPrepareError("unsupported_forecast_version");
        } else {
          setPrepareError("preparation_failed");
        }
      }
    };
    void prepare();
    if (import.meta.env.VITE_FORECAST_RUNTIME === "staging")
      void import("../lib/runtimeForecast").then((module) => {
        if (!active) return;
        runtime = module.runtimeForecast;
        unwatch = runtime.watch(document, () => {
          void prepare();
        });
      });
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
