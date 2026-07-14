import { useEffect, useEffectEvent } from "react";

type DismissableLayerOptions = {
  escapeEnabled: boolean;
  outsideEnabled: boolean;
  containsTarget: (target: EventTarget | null) => boolean;
  onDismiss: () => void;
};

export function useDismissableLayer({
  escapeEnabled,
  outsideEnabled,
  containsTarget,
  onDismiss,
}: DismissableLayerOptions) {
  const containsLatestTarget = useEffectEvent(containsTarget);
  const dismiss = useEffectEvent(onDismiss);

  useEffect(() => {
    if (!escapeEnabled) return undefined;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [escapeEnabled]);

  useEffect(() => {
    if (!outsideEnabled) return undefined;
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      if (!containsLatestTarget(event.target)) dismiss();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [outsideEnabled]);
}
