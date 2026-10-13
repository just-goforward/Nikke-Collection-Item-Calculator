// Source-only process lifecycle adapter; no spawning or numerical imports.
// A stop request never resolves cleanup. Only the child's actual 'close' event
// does. There is intentionally no cleanup timeout, unref, retry or timer.
export function observeProcessClose(child, onPending) {
  let closeObserved = false;
  let stopRequested = false;
  let pending = null;
  let reported = false;
  let closeInfo = null;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  child.once("close", (code, signal) => {
    closeObserved = true;
    closeInfo = { code, signal };
    resolveClosed(closeInfo);
  });
  const retain = result => {
    // Keep the first known FAIL. Cleanup success cannot erase it.
    if (pending?.status === "FAIL") return;
    if (pending === null || result.status === "FAIL") pending = result;
  };
  return {
    closed,
    get closeObserved() { return closeObserved; },
    get pending() { return pending; },
    get closeInfo() { return closeInfo; },
    state() {
      return { childStarted: Number.isSafeInteger(child.pid) && child.pid > 0,
        closeObserved, stopRequested };
    },
    stop(result) {
      retain(result);
      if (closeObserved) return;
      if (!reported) {
        reported = true;
        try {
          onPending({ kind: "PF2_CLEANUP_PENDING",
            pid: Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null,
            status: pending.status, reason: pending.reason });
        } catch {
          retain({ status: "FAIL", reason: "pf2_cleanup_notice_io", evaluatorCalls: null });
        }
      }
      if (!stopRequested && child.exitCode === null && child.signalCode === null) {
        stopRequested = true;
        try {
          if (!child.kill("SIGKILL"))
            retain({ status: "FAIL", reason: "pf2_termination_request_failed", evaluatorCalls: null });
        } catch {
          retain({ status: "FAIL", reason: "pf2_termination_request_failed", evaluatorCalls: null });
        }
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      // Keep the process referenced while awaiting close. If close never comes,
      // the bounded pending notice names the resource; operator action is needed.
    },
  };
}
