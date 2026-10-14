import { useEffect, useRef } from "react";

/** Refresh a changed game day once, using the current session's actual stock.
 * The existing preparation poll supplies the day; no supply is added to stock.
 * Hidden or unresolved-edit states defer until visible/settled, not a new prior.
 */
export function useCertifiedDailyRecompute(
  day: string | null,
  blocked: boolean,
  calculate: () => Promise<void>,
) {
  const observed = useRef<string | null>(null);
  useEffect(() => {
    if (!day) return;
    if (observed.current === null) observed.current = day;
    const refresh = () => {
      if (blocked || document.visibilityState === "hidden" || observed.current === day) return;
      observed.current = day;
      void calculate();
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [day, blocked, calculate]);
}
