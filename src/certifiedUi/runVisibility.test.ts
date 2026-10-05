import { describe, expect, it, vi } from "vitest";
import { cancelCertifiedRunWhenHidden, isCertifiedVisibilityAbort } from "./runVisibility";

// Synthetic events test the lifecycle policy; actual browser events have a separate E2E trace.
function source(initial: DocumentVisibilityState = "visible") {
  const events = new EventTarget();
  return {
    visibilityState: initial,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    change(state: DocumentVisibilityState) {
      this.visibilityState = state;
      events.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

describe("request visibility cancellation", () => {
  it("binds a visible-to-hidden transition to exactly one request abort", () => {
    const visibility = source();
    const controller = new AbortController();
    const abort = vi.spyOn(controller, "abort");
    const pending = cancelCertifiedRunWhenHidden(controller, 7, () => true, visibility);
    visibility.change("hidden");
    expect(controller.signal.reason).toBe(pending.cause);
    expect(pending.cause).toMatchObject({ kind: "certified_visibility_hidden", run: 7 });
    visibility.change("visible");
    visibility.change("hidden");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(isCertifiedVisibilityAbort({ signal: controller.signal, cause: pending.cause })).toBe(
      true,
    );
    pending.dispose();
  });

  it("explicitly cancels an initially hidden request with its own cause", () => {
    const visibility = source("hidden");
    const controller = new AbortController();
    const pending = cancelCertifiedRunWhenHidden(controller, 1, () => true, visibility);
    visibility.change("hidden");
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(pending.cause);
    expect(pending.cause).toMatchObject({ kind: "certified_visibility_hidden", run: 1 });
    pending.dispose();
  });

  it("does not relabel manual cancellation or an already completed request", () => {
    const visibility = source();
    const controller = new AbortController();
    const pending = cancelCertifiedRunWhenHidden(controller, 2, () => false, visibility);
    visibility.change("hidden");
    expect(controller.signal.aborted).toBe(false);
    controller.abort("user_cancel");
    visibility.change("visible");
    visibility.change("hidden");
    expect(pending.cause).toBeUndefined();
    pending.dispose();
  });

  it("removes the exact listener and ignores late events after cleanup", () => {
    const visibility = source();
    const controller = new AbortController();
    const pending = cancelCertifiedRunWhenHidden(controller, 3, () => true, visibility);
    pending.dispose();
    expect(visibility.removeEventListener).toHaveBeenCalledOnce();
    visibility.change("hidden");
    expect(controller.signal.aborted).toBe(false);
  });

  it("leaves a new request untouched when the retired request receives an event", () => {
    const oldSource = source();
    const old = new AbortController();
    const retired = cancelCertifiedRunWhenHidden(old, 4, () => false, oldSource);
    const newer = new AbortController();
    oldSource.change("hidden");
    expect(old.signal.aborted).toBe(false);
    expect(newer.signal.aborted).toBe(false);
    retired.dispose();
  });
});
