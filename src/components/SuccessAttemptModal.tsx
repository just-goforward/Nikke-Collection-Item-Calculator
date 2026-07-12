import { useEffect, useRef } from "react";
import { useI18n } from "../i18n/locale";
import type { MessageKey } from "../i18n/messages.ko";
import type { Kit } from "../types";
import type { SuccessAttemptModalState } from "../ui-types";

type SuccessAttemptModalProps = {
  modal: SuccessAttemptModalState;
  onSubmit: (successAttempt: number | null) => void;
};

const KIT_LABEL_KEYS: Record<Kit, MessageKey> = {
  blue: "kit.blue",
  purple: "kit.purple",
  yellow: "kit.yellow",
};

const classes = {
  overlay:
    "attempt-modal-overlay fixed inset-0 z-30 grid place-items-center bg-[rgba(9,18,28,0.48)] p-6 backdrop-blur-[7px] backdrop-saturate-[1.08] animate-[attempt-overlay-in_180ms_ease-out] motion-reduce:animate-none max-mobile:z-40 max-mobile:place-items-end max-mobile:px-2.5 max-mobile:pt-0 max-mobile:pb-3",
  modal:
    "attempt-modal relative grid w-[min(480px,100%)] gap-3 overflow-hidden rounded-card border border-border [border-color:color-mix(in_srgb,var(--grade-active)_28%,var(--line))] bg-surface p-[22px] shadow-[0_0_0_1px_rgba(248,252,254,0.08),0_26px_70px_rgba(0,0,0,0.28)] animate-[attempt-modal-in_240ms_cubic-bezier(0.16,1,0.3,1)] motion-reduce:animate-none max-mobile:w-[min(100%,420px)] max-mobile:rounded-t-[16px] max-mobile:p-4",
  handle: "hidden h-1 w-9 justify-self-center rounded-pill bg-border max-mobile:block",
  header: "attempt-modal-header grid justify-items-center border-b border-border pb-4 text-center",
  title:
    "m-0 text-center text-[18px] font-semibold leading-[1.25] text-text-strong max-mobile:text-[14px]",
  description:
    "m-0 text-center text-[12.5px] font-semibold leading-[1.5] text-muted max-mobile:text-[11px]",
  form: "attempt-entry-form grid gap-3",
  choices: "grid grid-cols-3 gap-2 max-mobile:grid-cols-1 max-mobile:gap-[7px]",
  interactive:
    "min-h-14 rounded-card border border-border transition-[transform,border-color,background-color,box-shadow] duration-[140ms] ease-[ease] hover:-translate-y-px hover:border-grade-active hover:shadow-[0_8px_20px_rgba(21,43,58,0.12)] hover:outline-none focus-visible:-translate-y-px focus-visible:border-grade-active focus-visible:shadow-[0_8px_20px_rgba(21,43,58,0.12)] focus-visible:outline-none active:translate-y-0 motion-reduce:transition-none",
  choiceButton:
    "attempt-choice-button grid min-h-[54px] content-center gap-0.5 rounded-card border border-yellow-kit bg-surface-strong px-2 py-1.5 text-center hover:bg-grade-active-soft focus-visible:bg-grade-active-soft max-mobile:flex max-mobile:min-h-[46px] max-mobile:items-center max-mobile:justify-between max-mobile:px-3.5",
  choiceValue: "text-[15px] font-extrabold leading-tight text-text-strong max-mobile:text-[14px]",
  choiceCaption: "text-[10.5px] font-semibold leading-tight text-muted",
  why: "rounded-card border border-border bg-surface-strong",
  whySummary: "cursor-pointer px-3 py-2 text-[11.5px] font-bold text-grade-active-strong",
  whyText: "m-0 px-3 pb-2.5 text-[11.5px] font-medium leading-[1.55] text-muted",
  actions:
    "attempt-modal-actions flex items-center justify-between gap-2 border-t border-[var(--stats-divider-soft)] pt-3",
  laterButton:
    "min-h-9 border-0 bg-transparent px-1 text-[12px] font-semibold text-muted underline underline-offset-[3px]",
  directButton:
    "min-h-9 border border-border bg-button px-3.5 text-[12.5px] font-bold text-text-soft",
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
  firstFocusRef: React.RefObject<HTMLButtonElement | null>,
  onDismiss: () => void,
) {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstFocusRef.current?.focus();

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
  }, [dialogRef, firstFocusRef, open]);
}

function residualChoices(modal: SuccessAttemptModalState) {
  const beforeStock = modal.beforeStock ?? modal.maxAttempt * 10;
  return Array.from({ length: modal.maxAttempt }, (_, index) => {
    const attempt = index + 1;
    return {
      attempt,
      remaining: Math.max(0, beforeStock - attempt * 10),
    };
  });
}

function AttemptSelector({
  firstFocusRef,
  modal,
  onSubmit,
}: {
  firstFocusRef: React.RefObject<HTMLButtonElement | null>;
  modal: SuccessAttemptModalState;
  onSubmit: (successAttempt: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div className={classes.choices}>
      {residualChoices(modal).map((choice, index) => (
        <button
          ref={index === 0 ? firstFocusRef : undefined}
          className={`${classes.interactive} ${classes.choiceButton}`}
          type="button"
          key={choice.attempt}
          onClick={() => onSubmit(choice.attempt)}
        >
          <strong className={classes.choiceValue}>
            {t("modal.remaining", { count: choice.remaining })}
          </strong>
          <span className={classes.choiceCaption}>
            {t("modal.successAttempt", { attempt: choice.attempt })}
          </span>
        </button>
      ))}
    </div>
  );
}

function WhyNeeded() {
  const { t } = useI18n();
  return (
    <details className={classes.why}>
      <summary className={classes.whySummary}>{t("modal.why")}</summary>
      <p className={classes.whyText}>{t("modal.whyDetail")}</p>
    </details>
  );
}

function ModalActions({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div className={classes.actions}>
      <button className={`${classes.laterButton}`} type="button" onClick={onDismiss}>
        {t("modal.later")}
      </button>
      <button
        className={`${classes.interactive} ${classes.directButton}`}
        type="button"
        onClick={onDismiss}
      >
        {t("modal.manual")}
      </button>
    </div>
  );
}

export default function SuccessAttemptModal({ modal, onSubmit }: SuccessAttemptModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFocusRef = useRef<HTMLButtonElement | null>(null);
  const dismiss = () => onSubmit(null);
  useDialogFocusTrap(modal.open, dialogRef, firstFocusRef, dismiss);

  if (!modal.open) return null;
  const kitLabel = modal.kit ? t(KIT_LABEL_KEYS[modal.kit]) : t("modal.genericKit");

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
        <span className={classes.handle} aria-hidden="true" />
        <div className={classes.header}>
          <h3 id="attemptModalTitle" className={classes.title}>
            {t("modal.question", { kit: kitLabel })}
          </h3>
          <p className={classes.description}>{t("modal.instruction")}</p>
        </div>
        <form
          className={classes.form}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(modal.attempt);
          }}
        >
          <AttemptSelector firstFocusRef={firstFocusRef} modal={modal} onSubmit={onSubmit} />
          <WhyNeeded />
          <ModalActions onDismiss={dismiss} />
        </form>
      </div>
    </div>
  );
}
