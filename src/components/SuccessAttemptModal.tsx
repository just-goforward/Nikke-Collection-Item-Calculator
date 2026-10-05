import { useLayoutEffect } from "react";
import { useI18n } from "../i18n/locale";
import type { MessageKey } from "../i18n/messages.ko";
import type { Kit } from "../types";
import type { SuccessAttemptModalState } from "../ui-types";
import { AlignedText } from "./AlignedText";

type SuccessAttemptModalProps = {
  modal: SuccessAttemptModalState;
  onSubmit: (successAttempt: number | null) => void;
  firstFocusRef: React.RefObject<HTMLButtonElement | null>;
};

const KIT_LABEL_KEYS: Record<Kit, MessageKey> = {
  blue: "kit.blue",
  purple: "kit.purple",
  yellow: "kit.yellow",
};

const MODAL_TEXT = {
  ko: {
    instruction: "대성공 회차를 몰라 잔량 확인이 필요합니다. 게임 인벤토리의 현재 수량을 고르세요.",
    genericKit: "관리 키트",
    remaining: "{count}개",
    successAttempt: "{attempt}회차에 대성공",
    why: "왜 필요한가요?",
    question: "남은 {kit}가 몇 개인가요?",
  },
  en: {
    instruction: "Super Success attempt is unknown. Choose your current game inventory amount.",
    genericKit: "Maintenance Kit",
    remaining: "{count} remaining",
    successAttempt: "Super Success on attempt {attempt}",
    why: "Why is this needed?",
    question: "How many {kit} pieces remain?",
  },
  ja: {
    instruction: "大成功が何回目か不明です。ゲーム内インベントリの現在の残数を選んでください。",
    genericKit: "お手入れキット",
    remaining: "残り{count}個",
    successAttempt: "{attempt}回目に大成功",
    why: "なぜ必要ですか？",
    question: "残りの{kit}は何個ですか？",
  },
};

const WHY_DETAIL = {
  ko: "대성공이 나면 남은 사용은 진행하지 않아 실제 소모량이 회차에 따라 달라집니다. 선택한 잔량으로 대성공 시점을 역산해 통계에 반영합니다.",
  en: "Once a Super Success occurs, the remaining planned uses are skipped, so actual consumption depends on the attempt. Your remaining inventory lets us infer that attempt for stats.",
  ja: "大成功すると残りの使用は行われないため、実際の消費量は大成功した回数で変わります。選択した残数から大成功のタイミングを逆算して統計に反映します。",
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
  choiceCaption: "text-[10.5px] font-semibold leading-tight text-text-soft",
  why: "rounded-card border border-border bg-surface-strong",
  whySummary: "cursor-pointer px-3 py-2 text-[11.5px] font-bold text-grade-active-strong",
  whyText: "m-0 px-3 pb-2.5 text-[11.5px] font-medium leading-[1.55] text-muted",
  actions:
    "attempt-modal-actions flex items-center justify-end gap-2 border-t border-[var(--stats-divider-soft)] pt-3",
  directButton:
    "inline-flex min-h-9 items-center justify-center border border-border bg-button px-3.5 text-[12.5px] font-bold leading-none text-text-soft",
} as const;

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
  const { locale, formatInteger } = useI18n();
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
            {MODAL_TEXT[locale].successAttempt.replace("{attempt}", formatInteger(choice.attempt))}
          </strong>
          <span className={classes.choiceCaption}>
            {MODAL_TEXT[locale].remaining.replace("{count}", formatInteger(choice.remaining))}
          </span>
        </button>
      ))}
    </div>
  );
}

function WhyNeeded() {
  const { locale } = useI18n();
  return (
    <details className={classes.why}>
      <summary className={classes.whySummary}>{MODAL_TEXT[locale].why}</summary>
      <p className={classes.whyText}>{WHY_DETAIL[locale]}</p>
    </details>
  );
}

function ModalActions({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div className={classes.actions}>
      <button
        className={`${classes.interactive} ${classes.directButton}`}
        type="button"
        onClick={onDismiss}
      >
        <AlignedText alignmentRole="action">{t("common.cancel")}</AlignedText>
      </button>
    </div>
  );
}

export default function SuccessAttemptModal({
  modal,
  onSubmit,
  firstFocusRef,
}: SuccessAttemptModalProps) {
  const { locale, t } = useI18n();
  const dismiss = () => onSubmit(null);
  useLayoutEffect(() => {
    firstFocusRef.current?.focus();
  }, [firstFocusRef]);

  if (!modal.open) return null;
  const kitLabel = modal.kit ? t(KIT_LABEL_KEYS[modal.kit]) : MODAL_TEXT[locale].genericKit;

  return (
    <div
      className={classes.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="attemptModalTitle"
      aria-describedby="attemptModalDescription"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onSubmit(null);
      }}
    >
      <div className={classes.modal}>
        <span className={classes.handle} aria-hidden="true" />
        <div className={classes.header}>
          <h3 id="attemptModalTitle" className={classes.title}>
            {MODAL_TEXT[locale].question.replace("{kit}", kitLabel)}
          </h3>
          <p id="attemptModalDescription" className={classes.description}>
            {MODAL_TEXT[locale].instruction}
          </p>
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
