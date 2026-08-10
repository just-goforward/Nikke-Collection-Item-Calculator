import { useEffect, useId, useRef, useState } from "react";

import { MAX_STOCK_PIECES } from "../../shared/game";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { useI18n } from "../i18n/locale";
import type { LocalizedMessage, MessageKey } from "../i18n/messages.ko";
import type { Kit, Stock } from "../types";
import type { StockCorrectionView } from "../ui-types";
import { AlignedText } from "./AlignedText";

type StockPanelProps = {
  stock: Stock;
  needsStockEdit: boolean;
  correction: StockCorrectionView | null;
  isStale: boolean;
  stockStale: boolean;
  notice: LocalizedMessage;
  onStockChange: (stock: Stock) => void;
  description: LocalizedMessage;
  calculateDisabled: boolean;
  loading: boolean;
  disabled: boolean;
  onCalculate: () => void;
  onReset: () => void;
};

type KitInputDefinition = {
  kit: Kit;
  inputId: string;
  labelKey: MessageKey;
  expLabel: string;
};

const KIT_INPUTS: KitInputDefinition[] = [
  {
    kit: "blue",
    inputId: "blueStock",
    labelKey: "kit.bluePanel",
    expLabel: "",
  },
  {
    kit: "purple",
    inputId: "purpleStock",
    labelKey: "kit.purplePanel",
    expLabel: "",
  },
  {
    kit: "yellow",
    inputId: "yellowStock",
    labelKey: "kit.yellowPanel",
    expLabel: "",
  },
];

const KIT_LABEL_KEYS: Record<Kit, MessageKey> = {
  blue: "kit.bluePanel",
  purple: "kit.purplePanel",
  yellow: "kit.yellowPanel",
};

const classes = {
  panel:
    "flex h-full min-w-0 flex-col rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  panelStale: "border-grade-active shadow-[0_0_0_3px_var(--grade-active-soft),var(--shadow)]",
  panelNeedsEdit: "border-yellow-kit shadow-[0_0_0_3px_rgba(230,170,38,0.22),var(--shadow)]",
  heading:
    "flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  editNotice:
    "mx-[18px] mt-3.5 rounded-card border-2 border-yellow-kit bg-outcome px-[13px] py-3 text-[13px] text-outcome-text font-semibold leading-[1.45] max-mobile:mx-3 max-mobile:mt-2.5 max-mobile:px-3 max-mobile:py-2.5 max-mobile:text-[12px]",
  editNoticeText: "m-0",
  kitGrid:
    "grid grid-cols-3 gap-2.5 px-[18px] py-4 min-[661px]:max-tablet:flex-1 min-[661px]:max-tablet:grid-cols-1 min-[661px]:max-tablet:grid-rows-3 min-[661px]:max-tablet:gap-2 min-[661px]:max-tablet:p-3.5 max-mobile:grid-cols-3 max-mobile:gap-2 max-mobile:px-3 max-mobile:pt-2.5 max-mobile:pb-[13px]",
  kitInput:
    "grid gap-[7px] min-[661px]:max-tablet:grid-cols-[minmax(0,1fr)_104px] min-[661px]:max-tablet:items-center min-[661px]:max-tablet:gap-2 max-mobile:grid-cols-1 max-mobile:items-start max-mobile:gap-x-0 max-mobile:gap-y-1.5 max-mobile:p-0",
  kitInputField:
    "relative min-w-0 min-[661px]:max-tablet:min-w-0 max-mobile:col-start-1 max-mobile:row-start-2 max-mobile:min-w-0",
  kitLabel:
    "flex items-center justify-center gap-[7px] text-center text-[12px] font-semibold leading-[1.25] text-muted min-[661px]:max-tablet:justify-start min-[661px]:max-tablet:whitespace-nowrap min-[661px]:max-tablet:text-left max-mobile:col-start-1 max-mobile:row-start-1 max-mobile:min-w-0 max-mobile:whitespace-normal max-mobile:text-[11px] max-mobile:[word-break:keep-all]",
  kitDot: "inline-block size-[11px] flex-none rounded-full",
  kitInputControl:
    "numeric-text-control stock-input-control w-full text-center text-[15px] font-semibold tabular-nums placeholder:text-muted/55 focus:placeholder:text-transparent min-[661px]:px-[10px] min-[661px]:text-[14px] max-mobile:px-1.5 max-mobile:text-center max-mobile:text-sm",
  kitInputInvalid: "border-danger focus:border-danger focus:shadow-[0_0_0_3px_var(--danger-soft)]",
  kitInputNeedsEdit: "border-yellow-kit shadow-[0_0_0_3px_rgba(230,170,38,0.18)]",
  kitTooltip:
    "invisible pointer-events-none absolute bottom-[calc(100%+7px)] right-0 z-[14] box-border w-[min(280px,calc(100vw-32px))] whitespace-normal rounded-card border border-border bg-surface px-[11px] py-2.5 text-left text-xs font-normal leading-[1.45] text-text-soft opacity-0 shadow-panel transition-opacity duration-[160ms] [overflow-wrap:anywhere] [word-break:keep-all]",
  kitTooltipOpen: "visible pointer-events-auto opacity-100",
  kitHint: "hidden",
  help: "sr-only",
  buttonRow:
    "mt-auto grid grid-cols-[82px_minmax(0,1fr)] gap-2.5 px-[18px] pb-4 min-[661px]:max-tablet:grid-cols-[minmax(0,1fr)_76px] min-[661px]:max-tablet:px-3.5 min-[661px]:max-tablet:pt-1 max-mobile:hidden",
  primaryButton:
    "relative order-2 inline-flex min-h-[42px] items-center justify-center gap-2 bg-action text-ice tracking-[0.02em] shadow-[inset_0_0_0_1px_rgba(248,252,254,0.10),0_10px_22px_rgba(21,43,58,0.18)] transition-[filter,box-shadow,transform,background-color] duration-[140ms] enabled:hover:brightness-[1.08] enabled:hover:shadow-[inset_0_0_0_1px_rgba(248,252,254,0.16),0_12px_26px_rgba(21,43,58,0.24)] enabled:active:translate-y-px enabled:active:shadow-[inset_0_0_0_1px_rgba(248,252,254,0.12),0_4px_10px_rgba(21,43,58,0.18)] min-[661px]:max-tablet:order-1 min-[661px]:max-tablet:min-h-[38px] min-[661px]:max-tablet:text-[13px] [body.theme-dark_&]:bg-[#ee7a87] [body.theme-dark_&]:text-[#2a0c12] [body.theme-dark_&]:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22),0_10px_22px_rgba(0,0,0,0.45)] [body.theme-dark_&]:enabled:hover:bg-[#f48f99] [body.theme-dark_&]:enabled:hover:brightness-100 [body.theme-dark_&]:enabled:hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28),0_12px_26px_rgba(0,0,0,0.55)] [body.theme-dark_&]:enabled:active:bg-[#d6646f] [body.theme-dark_&]:enabled:active:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22),0_4px_10px_rgba(0,0,0,0.4)]",
  primaryButtonStale:
    "shadow-[0_0_0_4px_var(--grade-active-soft),inset_0_0_0_1px_rgba(248,252,254,0.10),0_10px_22px_rgba(21,43,58,0.18)]",
  primaryButtonLocked:
    "disabled:opacity-100 disabled:border-2 disabled:border-yellow-kit disabled:bg-warning-soft disabled:text-warning disabled:shadow-[0_0_0_3px_rgba(230,170,38,0.22)]",
  secondaryButton:
    "order-1 inline-flex min-h-[42px] items-center justify-center border-0 bg-transparent px-1 text-[13px] font-semibold leading-none text-muted underline underline-offset-[3px] transition-[color,transform] duration-[140ms] enabled:hover:text-text-strong enabled:active:translate-y-px min-[661px]:max-tablet:order-2 min-[661px]:max-tablet:min-h-[38px] min-[661px]:max-tablet:text-[12px]",
  spinner:
    "inline-block size-[13px] animate-spin rounded-full border-2 border-[color-mix(in_srgb,var(--ice)_32%,transparent)] border-t-ice [body.theme-dark_&]:border-[rgba(42,12,18,0.24)] [body.theme-dark_&]:border-t-[#2a0c12]",
} as const;

const kitDotClass: Record<Kit, string> = {
  blue: "bg-blue-kit",
  purple: "bg-purple-kit",
  yellow: "bg-yellow-kit",
};

function stockValueToText(value: number) {
  return value > 0 ? String(value) : "";
}

function stockToText(stock: Stock): Record<Kit, string> {
  return {
    blue: stockValueToText(stock.blue),
    purple: stockValueToText(stock.purple),
    yellow: stockValueToText(stock.yellow),
  };
}

type StockFeedback = {
  reason: "invalid" | "max";
  value: number;
};

function stockDraftExceedsMax(value: string) {
  const normalized = value.replace(/^0+/, "") || "0";
  const maximum = String(MAX_STOCK_PIECES);
  return (
    normalized.length > maximum.length ||
    (normalized.length === maximum.length && normalized > maximum)
  );
}

function normalizeStockDraft(value: string, previousValue: number) {
  const trimmed = value.trim();
  if (trimmed === "") return { feedback: null, value: 0 };
  if (!/^\d+$/.test(trimmed)) {
    return {
      feedback: { reason: "invalid", value: previousValue } satisfies StockFeedback,
      value: previousValue,
    };
  }
  if (stockDraftExceedsMax(trimmed)) {
    return {
      feedback: { reason: "max", value: MAX_STOCK_PIECES } satisfies StockFeedback,
      value: MAX_STOCK_PIECES,
    };
  }
  return { feedback: null, value: Number(trimmed) };
}

type KitInputProps = {
  definition: KitInputDefinition;
  calculateDisabled: boolean;
  disabled: boolean;
  needsStockEdit: boolean;
  value: string;
  onChange: (kit: Kit, value: string) => void;
  onCommit: (kit: Kit, value: string) => StockFeedback | null;
  onCalculate: () => void;
};

function KitInput({
  definition,
  calculateDisabled,
  disabled,
  needsStockEdit,
  value,
  onChange,
  onCommit,
  onCalculate,
}: KitInputProps) {
  const { formatInteger, t } = useI18n();
  const fieldRef = useRef<HTMLSpanElement>(null);
  const calculateAfterCommitRef = useRef(false);
  const tooltipId = useId();
  const [feedback, setFeedback] = useState<StockFeedback | null>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const trimmed = value.trim();
  const draftInvalid = trimmed !== "" && (!/^\d+$/.test(trimmed) || stockDraftExceedsMax(trimmed));

  useDismissableLayer({
    escapeEnabled: tooltipOpen,
    outsideEnabled: tooltipOpen,
    containsTarget: (target) =>
      target instanceof Node && Boolean(fieldRef.current?.contains(target)),
    onDismiss: () => setTooltipOpen(false),
  });

  const commit = () => {
    const nextFeedback = onCommit(definition.kit, value);
    setFeedback(nextFeedback);
    setTooltipOpen(Boolean(nextFeedback));
    if (!calculateAfterCommitRef.current) return;
    calculateAfterCommitRef.current = false;
    if (!calculateDisabled) window.setTimeout(onCalculate, 0);
  };

  const tooltipMessage =
    feedback?.reason === "max"
      ? t("stock.adjustedMax", {
          max: formatInteger(MAX_STOCK_PIECES),
          value: formatInteger(feedback.value),
        })
      : t("stock.invalid");

  return (
    <label className={classes.kitInput}>
      <span className={classes.kitLabel}>
        <i aria-hidden="true" className={`${classes.kitDot} ${kitDotClass[definition.kit]}`}></i>
        {t(definition.labelKey)}
      </span>
      <span ref={fieldRef} className={classes.kitInputField}>
        <input
          id={definition.inputId}
          className={`${classes.kitInputControl} ${
            needsStockEdit ? classes.kitInputNeedsEdit : ""
          } ${draftInvalid ? classes.kitInputInvalid : ""}`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          placeholder="0"
          value={value}
          disabled={disabled}
          aria-describedby={tooltipOpen ? tooltipId : undefined}
          aria-invalid={draftInvalid || undefined}
          onChange={(event) => {
            onChange(definition.kit, event.currentTarget.value);
            setFeedback(null);
            setTooltipOpen(false);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            calculateAfterCommitRef.current = true;
            event.currentTarget.blur();
          }}
        />
        <span
          id={tooltipId}
          className={`${classes.kitTooltip} ${tooltipOpen ? classes.kitTooltipOpen : ""}`}
          role="tooltip"
          aria-live="polite"
        >
          {tooltipMessage}
        </span>
      </span>
      <small className={classes.kitHint}>{definition.expLabel}</small>
    </label>
  );
}

function commitFocusedInput() {
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLSelectElement ||
    activeElement instanceof HTMLTextAreaElement
  ) {
    activeElement.blur();
  }
}

function stockPanelClassName(needsStockEdit: boolean, stockStale: boolean) {
  const stateClass = needsStockEdit ? classes.panelNeedsEdit : stockStale ? classes.panelStale : "";
  return `${classes.panel} ${stateClass}`;
}

function correctionMessage(
  correction: StockCorrectionView,
  t: ReturnType<typeof useI18n>["t"],
  formatInteger: ReturnType<typeof useI18n>["formatInteger"],
) {
  const kit = t(KIT_LABEL_KEYS[correction.kit]);
  if (correction.status === "valid") {
    return t("stock.correctionValid", {
      attempt: correction.successAttempt ?? 1,
      kit,
    });
  }
  if (correction.reason === "state_changed") return t("stock.correctionStateChanged");
  if (correction.reason === "other_kit_changed") {
    return t("stock.correctionOtherKitChanged");
  }
  if (correction.reason === "selected_kit_increased") {
    return t("stock.correctionIncreased", { kit });
  }
  if (correction.reason === "invalid_delta") {
    return t("stock.correctionInvalidDelta", { kit });
  }
  if (correction.reason === "too_many_attempts") {
    return t("stock.correctionTooMany", { uses: correction.recommendedUses });
  }
  return t("stock.correctionPrompt", {
    before: formatInteger(correction.beforeStock),
    kit,
    max: formatInteger(correction.allowedMaximum),
    min: formatInteger(correction.allowedMinimum),
  });
}

function StockCorrectionNotice({
  correction,
  needsStockEdit,
  notice,
}: {
  correction: StockCorrectionView | null;
  needsStockEdit: boolean;
  notice: LocalizedMessage;
}) {
  const { formatInteger, t, text } = useI18n();
  return (
    <div
      id="stockEditNotice"
      className={classes.editNotice}
      hidden={!needsStockEdit && !correction}
      role="status"
      aria-live="polite"
    >
      <p className={classes.editNoticeText}>
        {correction ? correctionMessage(correction, t, formatInteger) : text(notice)}
      </p>
      {correction?.status === "invalid" && correction.canCalculate ? (
        <p className={`${classes.editNoticeText} mt-1`}>{t("stock.correctionUntracked")}</p>
      ) : null}
    </div>
  );
}

function StockCalculateLabel({
  correction,
  isStale,
  loading,
  needsStockEdit,
}: Pick<StockPanelProps, "correction" | "isStale" | "loading" | "needsStockEdit">) {
  const { t } = useI18n();
  if (correction?.status === "valid") {
    return t("stock.correctionCalculate", { attempt: correction.successAttempt ?? 1 });
  }
  if (correction?.canCalculate) return t("common.recalculate");
  if (needsStockEdit) return t("common.stockEditRequired");
  if (loading) {
    return (
      <>
        <span className={classes.spinner} aria-hidden="true" />
        {t("common.calculating")}
      </>
    );
  }
  return t(isStale ? "common.recalculate" : "common.calculate");
}

export default function StockPanel({
  stock,
  needsStockEdit,
  correction,
  isStale,
  stockStale,
  notice,
  onStockChange,
  description,
  calculateDisabled,
  loading,
  disabled,
  onCalculate,
  onReset,
}: StockPanelProps) {
  const { t, text } = useI18n();
  const [stockText, setStockText] = useState<Record<Kit, string>>(() => stockToText(stock));
  const committedStockRef = useRef<Stock>(stock);

  useEffect(() => {
    committedStockRef.current = stock;
    setStockText(stockToText(stock));
  }, [stock]);

  const updateStockText = (kit: Kit, value: string) => {
    setStockText((current) => ({ ...current, [kit]: value }));
    const trimmed = value.trim();
    if (trimmed !== "" && (!/^\d+$/.test(trimmed) || stockDraftExceedsMax(trimmed))) return;
    const nextValue = trimmed === "" ? 0 : Number(trimmed);
    if (committedStockRef.current[kit] === nextValue) return;
    const nextStock = { ...committedStockRef.current, [kit]: nextValue };
    committedStockRef.current = nextStock;
    onStockChange(nextStock);
  };

  const commitStock = (kit: Kit, value: string) => {
    const result = normalizeStockDraft(value, committedStockRef.current[kit]);
    setStockText((current) => ({ ...current, [kit]: stockValueToText(result.value) }));
    if (committedStockRef.current[kit] !== result.value) {
      const nextStock = { ...committedStockRef.current, [kit]: result.value };
      committedStockRef.current = nextStock;
      onStockChange(nextStock);
    }
    return result.feedback;
  };
  return (
    <section className={stockPanelClassName(needsStockEdit, stockStale)}>
      <div className={classes.heading}>
        <h2>{t("stock.title")}</h2>
      </div>

      <StockCorrectionNotice
        correction={correction}
        needsStockEdit={needsStockEdit}
        notice={notice}
      />
      <div className={classes.editNotice} hidden={!stockStale || needsStockEdit}>
        {t("stock.changed")}
      </div>

      <div className={classes.kitGrid}>
        {KIT_INPUTS.map((definition) => (
          <KitInput
            definition={definition}
            calculateDisabled={calculateDisabled || loading}
            disabled={disabled}
            key={definition.kit}
            needsStockEdit={needsStockEdit && (!correction || correction.kit === definition.kit)}
            value={stockText[definition.kit]}
            onChange={updateStockText}
            onCommit={commitStock}
            onCalculate={onCalculate}
          />
        ))}
      </div>
      <p id="strategyDescription" className={classes.help}>
        {text(description)}
      </p>
      <div className={classes.buttonRow}>
        <button
          id="resetButton"
          className={classes.secondaryButton}
          type="button"
          disabled={disabled}
          onClick={onReset}
        >
          <AlignedText alignmentRole="action">{t("common.reset")}</AlignedText>
        </button>
        <button
          id="calculateButton"
          className={`${classes.primaryButton} ${
            needsStockEdit && !correction?.canCalculate
              ? classes.primaryButtonLocked
              : isStale
                ? classes.primaryButtonStale
                : ""
          }`}
          type="button"
          disabled={calculateDisabled || loading || disabled}
          aria-describedby="strategyDescription"
          aria-live="polite"
          onPointerDown={commitFocusedInput}
          onClick={onCalculate}
        >
          <AlignedText alignmentRole="action" className="gap-2">
            <StockCalculateLabel
              correction={correction}
              isStale={isStale}
              loading={loading}
              needsStockEdit={needsStockEdit}
            />
          </AlignedText>
        </button>
      </div>
    </section>
  );
}
