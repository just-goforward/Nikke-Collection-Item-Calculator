import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import type { CertifiedSupplySnapshot } from "../../shared/certifiedSupply";
import type { Grade, Stock } from "../types";
import {
  type CertifiedCalculatorSession,
  restoreCertifiedCalculatorSession,
  serializeCertifiedCalculatorSession,
} from "./calculatorSessionPersistence";
import {
  CERTIFIED_SESSION_STORAGE_KEY,
  type CertifiedSession,
  createCertifiedSession,
  LEGACY_CERTIFIED_SESSION_STORAGE_KEY,
  reconcileCertifiedSession,
} from "./session";
import {
  type CertifiedSessionStore,
  initialBridge,
  settledCertifiedBridge,
} from "./useCertifiedCalculatorSession";

export type CertifiedSessionInputs = { grade: Grade; level: number; exp: number; stock: Stock };

/**
 * Account read/apply API for the certified session. Text is always the guest storage format
 * (settled session or pending-correction envelope) and every read passes the same restore
 * validation as a reload: corrupt bytes are rejected whole, never partially applied.
 */
export type CertifiedAccountPort = {
  /** Validated, re-serialized text, or null when the bytes fail restore validation. */
  validate(text: string): string | null;
  summary(text: string): CertifiedSessionInputs;
  /** True for a fresh session: default state, empty stock, ledgers and cohort weights. */
  isEmpty(text: string): boolean;
  /** A fresh session for an account without a certified item. */
  emptyText(): string;
  /** The live session in storage format. */
  current(): string;
  /** The guest session from the guest storage key; null when absent or quarantined. */
  readGuest(): string | null;
  /** Shows an account session; guest storage writes stay suspended until `showGuest`. */
  applyAccount(text: string): boolean;
  /** Leaves account data: the guest session is reloaded through the startup restore path. */
  showGuest(): void;
};

const EMPTY_STATE = { grade: "R", level: 0, exp: 0 } as const;

function restoreText(text: string | null): CertifiedCalculatorSession | null {
  try {
    return restoreCertifiedCalculatorSession(text);
  } catch {
    return null;
  }
}

function serialize(restored: CertifiedCalculatorSession) {
  return serializeCertifiedCalculatorSession(restored.session, restored.correction);
}

export function validateCertifiedSessionText(text: string): string | null {
  const restored = restoreText(text);
  return restored ? serialize(restored) : null;
}

function restoredOrThrow(text: string): CertifiedCalculatorSession {
  const restored = restoreText(text);
  if (!restored) throw new Error("invalid_certified_calculator_storage");
  return restored;
}

export function certifiedSessionSummary(text: string): CertifiedSessionInputs {
  const { state, stock } = restoredOrThrow(text).session;
  return {
    grade: state.grade,
    level: state.level,
    exp: state.exp,
    stock: { blue: stock[0], purple: stock[1], yellow: stock[2] },
  };
}

export function isEmptyCertifiedSession(text: string): boolean {
  const restored = restoreText(text);
  if (!restored || restored.correction) return false;
  const { id, snapshotRevision } = restored.session;
  const blank = { ...createCertifiedSession(snapshotRevision, EMPTY_STATE, [0, 0, 0]), id };
  return serialize(restored) === serialize({ session: blank, correction: null });
}

/** Mirrors the startup read: current key first, then the legacy key. */
export function readGuestCertifiedSessionText(): string | null {
  let text: string | null;
  try {
    text =
      localStorage.getItem(CERTIFIED_SESSION_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_CERTIFIED_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  return text === null ? null : validateCertifiedSessionText(text);
}

export type CertifiedAccountDeps = Pick<
  CertifiedSessionStore,
  "latest" | "publish" | "accountMode"
> & {
  retire: () => void;
  snapshotRef: { readonly current: CertifiedSupplySnapshot | null };
  updateSession: Dispatch<SetStateAction<CertifiedSession>>;
};

export function createCertifiedAccountPort(deps: () => CertifiedAccountDeps): CertifiedAccountPort {
  return {
    validate: validateCertifiedSessionText,
    summary: certifiedSessionSummary,
    isEmpty: isEmptyCertifiedSession,
    emptyText: () =>
      serialize({
        session: createCertifiedSession(
          deps().snapshotRef.current?.revision ?? "initial",
          EMPTY_STATE,
          [0, 0, 0],
        ),
        correction: null,
      }),
    current: () => {
      const { session, correction } = deps().latest.current;
      return serializeCertifiedCalculatorSession(session, correction);
    },
    readGuest: readGuestCertifiedSessionText,
    applyAccount: (text) => {
      const restored = restoreText(text);
      if (!restored) return false;
      const { accountMode, retire, publish, snapshotRef, updateSession } = deps();
      accountMode.current = true;
      retire();
      publish({ ...settledCertifiedBridge(restored.session), correction: restored.correction });
      // The same snapshot reconciliation the startup preparation applies to a restored session.
      const snapshot = snapshotRef.current;
      if (
        snapshot &&
        !restored.correction &&
        restored.session.snapshotRevision !== snapshot.revision
      )
        updateSession((old) =>
          reconcileCertifiedSession(
            old,
            snapshot.revision,
            snapshot.events.map((event) => event.id),
          ),
        );
      return true;
    },
    showGuest: () => {
      const { accountMode, retire, publish } = deps();
      accountMode.current = false;
      retire();
      publish(initialBridge());
    },
  };
}

/** Stable port for the account control; it always acts on the latest session store. */
export function useCertifiedAccountPort(deps: CertifiedAccountDeps): CertifiedAccountPort {
  const latest = useRef(deps);
  useEffect(() => {
    latest.current = deps;
  });
  const [port] = useState(() => createCertifiedAccountPort(() => latest.current));
  return port;
}
