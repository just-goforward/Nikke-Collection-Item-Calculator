import { useEffect, useRef } from "react";

import type { SuccessAttemptModalState } from "../ui-types";

type SuccessAttemptModalProps = {
  modal: SuccessAttemptModalState;
  onAttemptChange: (attempt: number) => void;
  onSubmit: (successAttempt: number | null) => void;
};
type AttemptSelectorProps = {
  attempt: number;
  inputRef: React.RefObject<HTMLInputElement | null>;
  maxAttempt: number;
  onAttemptChange: (attempt: number) => void;
};

const classes = {
  overlay:
    "attempt-modal-overlay fixed inset-0 z-30 grid place-items-center bg-[rgba(9,18,28,0.48)] p-6 backdrop-blur-[7px] backdrop-saturate-[1.08] animate-[attempt-overlay-in_180ms_ease-out] motion-reduce:animate-none max-mobile:z-40 max-mobile:place-items-end max-mobile:px-2.5 max-mobile:pt-0 max-mobile:pb-3",
  modal:
    "attempt-modal relative grid w-[min(420px,100%)] gap-[18px] overflow-hidden rounded-card border border-border [border-color:color-mix(in_srgb,var(--grade-active)_28%,var(--line))] bg-surface p-[22px] shadow-[0_0_0_1px_rgba(248,252,254,0.08),0_26px_70px_rgba(0,0,0,0.28)] animate-[attempt-modal-in_240ms_cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none max-mobile:w-[min(100%,420px)]",
  header: "attempt-modal-header grid justify-items-center border-b border-border pb-4 text-center",
  title: "m-0 text-center text-[21px] font-semibold leading-[1.25] text-text-strong",
  form: "attempt-entry-form grid gap-3.5",
  inputRow:
    "attempt-input-row grid grid-cols-[56px_minmax(0,1fr)_56px] items-stretch gap-2.5 max-mobile:grid-cols-[44px_minmax(0,1fr)_44px]",
  interactive:
    "min-h-14 rounded-card border border-border transition-[transform,border-color,background-color,box-shadow] duration-[140ms] ease-[ease] hover:-translate-y-px hover:border-grade-active hover:shadow-[0_8px_20px_rgba(21,43,58,0.12)] hover:outline-none focus-visible:-translate-y-px focus-visible:border-grade-active focus-visible:shadow-[0_8px_20px_rgba(21,43,58,0.12)] focus-visible:outline-none active:translate-y-0 motion-reduce:transition-none",
  stepButton:
    "attempt-step-button bg-surface-raised text-[26px] leading-none text-text-strong hover:bg-grade-active-soft focus-visible:bg-grade-active-soft",
  numberField:
    "attempt-number-field flex min-h-14 items-center justify-center gap-2 rounded-card border border-border bg-surface-raised px-3",
  numberInput:
    "attempt-number-input w-auto min-w-0 flex-[0_1_auto] border-0 bg-transparent p-0 text-center text-[26px] font-bold leading-none text-text-strong [appearance:textfield] focus:border-0 focus:shadow-none max-mobile:text-[22px] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:[-webkit-appearance:none] [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:[-webkit-appearance:none]",
  numberHint: "text-sm font-medium whitespace-nowrap text-muted",
  actions: "attempt-modal-actions grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2",
  submitButton:
    "attempt-submit-button bg-grade-active text-ice hover:brightness-[0.96] focus-visible:brightness-[0.96]",
  unknownButton:
    "attempt-unknown-button grid place-items-center content-center justify-items-center gap-0.5 bg-button text-center text-text-soft hover:bg-grade-active-soft focus-visible:bg-grade-active-soft",
  unknownTitle: "text-sm leading-none text-text-strong",
  unknownCaption: "text-[11px] font-medium leading-[1.2] text-muted",
} as const;

function visibleFocusableElements(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.offsetParent !== null);
}

function focusFallbackControl() {
  document
    .querySelector<HTMLElement>(
      ".outcome-panel button:not([disabled]), .mobile-action-bar button:not([disabled]), #calculateButton:not([disabled]), button:not([disabled])",
    )
    ?.focus();
}

function restorePreviousFocus(previouslyFocused: HTMLElement | null) {
  window.requestAnimationFrame(() => {
    if (previouslyFocused?.isConnected) {
      previouslyFocused.focus();
      return;
    }
    focusFallbackControl();
  });
}

function useDialogFocusTrap(
  open: boolean,
  dialogRef: React.RefObject<HTMLDivElement | null>,
  inputRef: React.RefObject<HTMLInputElement | null>,
  onDismiss: () => void,
) {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissRef.current();
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
      const previouslyFocused = previouslyFocusedRef.current;
      restorePreviousFocus(previouslyFocused);
      previouslyFocusedRef.current = null;
    };
  }, [dialogRef, inputRef, open]);
}

function AttemptSelector({ attempt, inputRef, maxAttempt, onAttemptChange }: AttemptSelectorProps) {
  return (
    <div className={classes.inputRow}>
      <button
        className={`${classes.interactive} ${classes.stepButton}`}
        type="button"
        aria-label="회차 감소"
        onClick={() => onAttemptChange(attempt - 1)}
      >
        -
      </button>
      <label className={classes.numberField}>
        <input
          ref={inputRef}
          className={classes.numberInput}
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          min="1"
          max={maxAttempt}
          step="1"
          value={attempt}
          aria-label="대성공 발생 회차"
          onChange={(event) => onAttemptChange(Number(event.target.value))}
          onBlur={(event) => onAttemptChange(Number(event.target.value))}
        />
        <span className={classes.numberHint}>회 / {maxAttempt}회</span>
      </label>
      <button
        className={`${classes.interactive} ${classes.stepButton}`}
        type="button"
        aria-label="회차 증가"
        onClick={() => onAttemptChange(attempt + 1)}
      >
        +
      </button>
    </div>
  );
}

function ModalActions({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className={classes.actions}>
      <button className={`${classes.interactive} ${classes.submitButton}`} type="submit">
        기록
      </button>
      <button
        className={`${classes.interactive} ${classes.unknownButton}`}
        type="button"
        onClick={onDismiss}
      >
        <strong className={classes.unknownTitle}>모르겠음</strong>
        <small className={classes.unknownCaption}>통계 기록 제외</small>
      </button>
    </div>
  );
}

export default function SuccessAttemptModal({
  modal,
  onAttemptChange,
  onSubmit,
}: SuccessAttemptModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dismiss = () => onSubmit(null);
  useDialogFocusTrap(modal.open, dialogRef, inputRef, dismiss);

  if (!modal.open) return null;

  return (
    <div
      ref={dialogRef}
      className={classes.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="attemptModalTitle"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onSubmit(null);
      }}
    >
      <div className={classes.modal}>
        <div className={classes.header}>
          <h3 id="attemptModalTitle" className={classes.title}>
            대성공이 발생한 시점을 입력해주세요.
          </h3>
        </div>
        <form
          className={classes.form}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(modal.attempt);
          }}
        >
          <AttemptSelector
            attempt={modal.attempt}
            inputRef={inputRef}
            maxAttempt={modal.maxAttempt}
            onAttemptChange={onAttemptChange}
          />
          <ModalActions onDismiss={dismiss} />
        </form>
      </div>
    </div>
  );
}
