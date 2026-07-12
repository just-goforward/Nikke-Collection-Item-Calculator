import { useEffect, useRef } from "react";

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
  const containsTargetRef = useRef(containsTarget);
  const onDismissRef = useRef(onDismiss);
  containsTargetRef.current = containsTarget;
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!escapeEnabled) return undefined;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onDismissRef.current();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [escapeEnabled]);

  useEffect(() => {
    if (!outsideEnabled) return undefined;
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      if (!containsTargetRef.current(event.target)) onDismissRef.current();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [outsideEnabled]);
}
