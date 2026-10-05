type CertifiedVisibilityAbortCause = {
  kind: "certified_visibility_hidden";
  run: number;
  hiddenAtMs: number;
};

export type CertifiedVisibilityAbortContext = {
  signal: AbortSignal;
  cause: CertifiedVisibilityAbortCause | undefined;
};

type VisibilitySource = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

/** A hidden observation becomes a cause only when this request explicitly aborts. */
export function cancelCertifiedRunWhenHidden(
  controller: AbortController,
  run: number,
  isActive: () => boolean,
  visibility: VisibilitySource = document,
) {
  let disposed = false;
  let cause: CertifiedVisibilityAbortCause | undefined;
  const changed = () => {
    if (
      disposed ||
      visibility.visibilityState !== "hidden" ||
      !isActive() ||
      controller.signal.aborted
    )
      return;
    cause = Object.freeze({
      kind: "certified_visibility_hidden",
      run,
      hiddenAtMs: performance.now(),
    });
    controller.abort(cause);
  };
  visibility.addEventListener("visibilitychange", changed);
  // A submit in an already hidden document must explicitly cancel this request too.
  changed();
  return {
    get cause() {
      return cause;
    },
    dispose() {
      disposed = true;
      visibility.removeEventListener("visibilitychange", changed);
    },
  };
}

/** Preparation shares the submit deadline; late settlement is observed and discarded. */
export function awaitCertifiedRunPreparation<T>(
  preparation: Promise<T>,
  signal: AbortSignal,
  remainingMs: number,
) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      return true;
    };
    const aborted = () => {
      if (cleanup()) reject(signal.reason);
    };
    const timedOut = () => {
      if (cleanup()) reject(new Error("certified_total_deadline"));
    };
    timer = setTimeout(timedOut, Math.max(0, remainingMs));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else if (remainingMs <= 0) timedOut();
    preparation.then(
      (value) => {
        if (cleanup()) resolve(value);
      },
      (failure) => {
        if (cleanup()) reject(failure);
      },
    );
  });
}

export function isCertifiedVisibilityAbort(context: CertifiedVisibilityAbortContext | undefined) {
  return (
    context?.cause !== undefined &&
    context.signal.aborted &&
    context.signal.reason === context.cause
  );
}
