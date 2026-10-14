import { useEffect, useLayoutEffect, useState } from "react";
import { accountCheckRemainingMs } from "./accountCheck";
import type { AccountUi } from "./accountController";
import type { AccountView } from "./accountState";

type BootPhase = "checking" | "timing-out" | "done";

/**
 * Input lock inside the account chunk. Inputs stay read-only while the page-load account check
 * runs and until its data (account or guest) is shown; at the bound the controller restores saved
 * guest inputs before the lock lifts. Stale tabs stay read-only, so no edit is stored nowhere.
 * Returns true while the page-load check is still running.
 */
export function useAccountLock(
  controller: AccountUi,
  phase: AccountView["phase"],
  switchPending: boolean,
  shell: { fellBack: boolean; onLockChange: (locked: boolean) => void },
): boolean {
  const { fellBack, onLockChange } = shell;
  const [boot, setBoot] = useState<BootPhase>(() => (fellBack ? "done" : "checking"));
  useEffect(() => {
    // Inputs were released before this chunk loaded: never restore over edits made since.
    if (fellBack) void controller.bootTimedOut(false);
  }, [controller, fellBack]);
  useEffect(() => {
    if (boot !== "checking") return;
    if (phase !== "loading") {
      setBoot("done");
      return;
    }
    const timer = window.setTimeout(() => {
      setBoot("timing-out");
      void controller.bootTimedOut(true).finally(() => setBoot("done"));
    }, accountCheckRemainingMs());
    return () => window.clearTimeout(timer);
  }, [boot, controller, phase]);
  const locked = boot !== "done" || switchPending || phase === "stale";
  // Layout effect: the shell's lock lands in the same synchronous commit as the view or switch
  // that requires it, before any input event can reach the newly shown (or not yet replaced) data.
  useLayoutEffect(() => onLockChange(locked), [locked, onLockChange]);
  return boot !== "done";
}
