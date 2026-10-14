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

export function useCertifiedCalculatorPreparation(
  preparation: CertifiedSnapshotState,
  latest: CertifiedSessionStore["latest"],
  retire: () => void,
  updateSession: Dispatch<SetStateAction<CertifiedSession>>,
) {
  const { snapshotRef, setSnapshot, setPrepareError } = preparation;
  useEffect(() => {
    let active = true;
    const prepare = async () => {
      try {
        const next = await prepareCertifiedForecast();
        if (!active) return;
        const previous = snapshotRef.current;
        if (
          previous &&
          (previous.revision !== next.revision || previous.sourceHash !== next.sourceHash)
        )
          retire();
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
          updateSession((old) =>
            reconcileCertifiedSession(
              old,
              next.revision,
              next.events.map((e) => e.id),
            ),
          );
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
    const refresh = window.setInterval(() => {
      void prepare();
    }, 60_000);
    return () => {
      active = false;
      window.clearInterval(refresh);
    };
  }, [latest, retire, setPrepareError, setSnapshot, snapshotRef, updateSession]);
}
