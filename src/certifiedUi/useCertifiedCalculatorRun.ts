import { useCallback, useEffect, useRef } from "react";
import type { CertifiedSession } from "./session";
import type { CertifiedSnapshotState } from "./useCertifiedCalculatorPreparation";
import type { CertifiedSessionStore } from "./useCertifiedCalculatorSession";
import { useCertifiedRun } from "./useCertifiedRun";

/** Owns native run binding and synchronous retirement, without changing its deadline or cancellation. */
export function useCertifiedCalculatorRun(
  session: CertifiedSession,
  preparation: CertifiedSnapshotState,
) {
  const { snapshot, setSnapshot, snapshotRef } = preparation;
  const native = useCertifiedRun(session, snapshot, setSnapshot);
  const nativeRef = useRef(native);
  const nativeSession = useRef(session);
  const ownedSession = useRef<CertifiedSession | null>(null);
  const recompute = useRef<CertifiedSession | null>(null);
  const calculating = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    nativeRef.current = native;
    nativeSession.current = session;
    snapshotRef.current = snapshot;
  }, [native, session, snapshot, snapshotRef]);
  const retire = useCallback(() => {
    ++generation.current;
    ownedSession.current = null;
    recompute.current = null;
    calculating.current = false;
    nativeRef.current.cancel();
  }, []);
  const canStart = useCallback(
    (current: CertifiedSession) =>
      !calculating.current && !(nativeRef.current.busy && ownedSession.current === current),
    [],
  );
  const calculateNative = useCallback(async (current: CertifiedSession) => {
    if (nativeSession.current !== current) return;
    recompute.current = null;
    ownedSession.current = current;
    calculating.current = true;
    const ticket = ++generation.current;
    try {
      await nativeRef.current.calculate();
    } finally {
      if (ticket === generation.current) calculating.current = false;
    }
  }, []);
  const cancel = () => {
    recompute.current = null;
    nativeRef.current.cancel();
  };
  const view = (calculate: () => Promise<void>) => {
    const currentRun = ownedSession.current === session;
    return {
      ...native,
      result: currentRun ? native.result : null,
      finished: currentRun ? native.finished : null,
      busy: currentRun && native.busy,
      error: currentRun ? native.error : (false as const),
      calculate,
      cancel,
    };
  };
  return {
    nativeRef,
    ownedSession,
    calculating,
    recompute,
    retire,
    canStart,
    calculateNative,
    view,
  };
}

export type CertifiedRunOwnership = ReturnType<typeof useCertifiedCalculatorRun>;

/** Consume a committed action request once, after the new native calculate closure is bound. */
export function useCertifiedActionRecomputation(
  session: CertifiedSession,
  latest: CertifiedSessionStore["latest"],
  recompute: CertifiedRunOwnership["recompute"],
  calculate: () => Promise<void>,
) {
  useEffect(() => {
    const requested = recompute.current;
    if (!requested || requested !== session || requested !== latest.current.session) return;
    recompute.current = null;
    if (document.visibilityState !== "hidden") void calculate();
  }, [session, latest, recompute, calculate]);
}
