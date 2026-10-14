import { useSyncExternalStore } from "react";
import { accountFeatureEnabled } from "./config";

/** Bound on how long calculator inputs stay read-only while the account check runs. */
export const ACCOUNT_CHECK_TIMEOUT_MS = 5_000;

export type AccountBootStatus = "checking" | "released" | "timed-out";

export type AccountBootGate = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AccountBootStatus;
  /** The account check resolved and its data (account or guest) is shown. */
  release(): void;
};

/**
 * Page-load gate in the main bundle: with the account flag on, inputs start read-only until the
 * lazy account control reports the check resolved, or the timeout falls back to guest data.
 */
export function createAccountBootGate(
  enabled: boolean,
  schedule: (callback: () => void, delayMs: number) => void,
): AccountBootGate {
  let status: AccountBootStatus = enabled ? "checking" : "released";
  const listeners = new Set<() => void>();
  const settle = (next: AccountBootStatus) => {
    if (status !== "checking") return;
    status = next;
    for (const listener of listeners) listener();
  };
  if (enabled) schedule(() => settle("timed-out"), ACCOUNT_CHECK_TIMEOUT_MS);
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => status,
    release: () => settle("released"),
  };
}

let shared: AccountBootGate | null = null;

/** Created on first use, i.e. during the first render of the calculator. */
export function accountBootGate(): AccountBootGate {
  shared ??= createAccountBootGate(accountFeatureEnabled(), (callback, delayMs) => {
    window.setTimeout(callback, delayMs);
  });
  return shared;
}

export function useAccountBootStatus(): AccountBootStatus {
  const gate = accountBootGate();
  return useSyncExternalStore(gate.subscribe, gate.getSnapshot);
}

/** True while calculator inputs must stay read-only; always false with the flag off. */
export function useAccountBootLocked(): boolean {
  return useAccountBootStatus() === "checking";
}
