import { useEffect, useEffectEvent, useRef } from "react";

function visibleFocusableElements(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null);
}

function focusFallbackControl() {
  Array.from(
    document.querySelectorAll<HTMLElement>(
      ".outcome-panel button:not([disabled]), .mobile-action-bar button:not([disabled]), #calculateButton:not([disabled]), button:not([disabled])",
    ),
  )
    .find((element) => element.offsetParent !== null)
    ?.focus();
}

function restorePreviousFocus(previouslyFocused: HTMLElement | null) {
  window.requestAnimationFrame(() => {
    if (previouslyFocused?.isConnected && previouslyFocused.offsetParent !== null) {
      previouslyFocused.focus();
    } else {
      focusFallbackControl();
    }
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        !(active instanceof HTMLElement) ||
        active === document.body ||
        !active.isConnected ||
        active.offsetParent === null
      ) {
        focusFallbackControl();
      }
    });
  });
}

export function useDialogFocusTrap(
  open: boolean,
  dialogRef: React.RefObject<HTMLDivElement | null>,
  firstFocusRef: React.RefObject<HTMLButtonElement | null>,
  onDismiss: () => void,
  returnFocus: HTMLElement | null,
) {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const dismiss = useEffectEvent(onDismiss);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = returnFocus;
    const dialog = dialogRef.current;
    const siblings = dialog?.parentElement
      ? Array.from(dialog.parentElement.children).filter(
          (element): element is HTMLElement => element instanceof HTMLElement && element !== dialog,
        )
      : [];
    const previouslyInert = new Map(
      siblings.map((element) => [element, element.hasAttribute("inert")] as const),
    );
    for (const sibling of siblings) sibling.setAttribute("inert", "");
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstFocusRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = visibleFocusableElements(dialogRef.current);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      for (const [sibling, wasInert] of previouslyInert) {
        if (!wasInert) sibling.removeAttribute("inert");
      }
      document.body.style.overflow = previousBodyOverflow;
      const previouslyFocused = previouslyFocusedRef.current;
      restorePreviousFocus(previouslyFocused);
      previouslyFocusedRef.current = null;
    };
  }, [dialogRef, firstFocusRef, open, returnFocus]);
}
