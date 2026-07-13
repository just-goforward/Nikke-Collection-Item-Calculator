import { useEffect, useRef, useState } from "react";

import { useI18n } from "../i18n/locale";
import type { LocalizedMessage, MessageKey } from "../i18n/messages.ko";
import type { Kit, Stock } from "../types";

type StockPanelProps = {
  stock: Stock;
  needsStockEdit: boolean;
  isStale: boolean;
  stockStale: boolean;
  notice: LocalizedMessage;
  onStockChange: (stock: Stock) => void;
  description: LocalizedMessage;
  calculateDisabled: boolean;
  loading: boolean;
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

const classes = {
  panel:
    "flex h-full min-w-0 flex-col rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  panelStale: "border-grade-active shadow-[0_0_0_3px_var(--grade-active-soft),var(--shadow)]",
  panelNeedsEdit: "border-yellow-kit shadow-[0_0_0_3px_rgba(230,170,38,0.22),var(--shadow)]",
  heading:
    "flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  editNotice:
    "mx-[18px] mt-3.5 rounded-card border-2 border-yellow-kit bg-outcome px-[13px] py-3 text-[13px] text-outcome-text font-semibold leading-[1.45] max-mobile:mx-3 max-mobile:mt-2.5 max-mobile:px-3 max-mobile:py-2.5 max-mobile:text-[12px]",
  kitGrid:
    "grid grid-cols-3 gap-2.5 px-[18px] py-4 min-[661px]:max-tablet:flex-1 min-[661px]:max-tablet:grid-cols-1 min-[661px]:max-tablet:grid-rows-3 min-[661px]:max-tablet:gap-2 min-[661px]:max-tablet:p-3.5 max-mobile:grid-cols-3 max-mobile:gap-2 max-mobile:px-3 max-mobile:pt-2.5 max-mobile:pb-[13px]",
  kitInput:
    "grid gap-[7px] min-[661px]:max-tablet:grid-cols-[minmax(0,1fr)_104px] min-[661px]:max-tablet:items-center min-[661px]:max-tablet:gap-2 max-mobile:grid-cols-1 max-mobile:items-start max-mobile:gap-x-0 max-mobile:gap-y-1.5 max-mobile:p-0",
  kitLabel:
    "flex items-center justify-center gap-[7px] text-center text-[12px] font-semibold leading-[1.25] text-muted min-[661px]:max-tablet:justify-start min-[661px]:max-tablet:whitespace-nowrap min-[661px]:max-tablet:text-left max-mobile:col-start-1 max-mobile:row-start-1 max-mobile:min-w-0 max-mobile:whitespace-normal max-mobile:text-[11px] max-mobile:[word-break:keep-all]",
  kitDot: "inline-block size-[11px] flex-none rounded-full",
  kitInputControl:
    "min-h-10 text-center text-[15px] font-semibold tabular-nums placeholder:text-muted/55 focus:placeholder:text-transparent min-[661px]:min-h-9 min-[661px]:px-[10px] min-[661px]:py-[6px] min-[661px]:text-[14px] min-[661px]:max-tablet:min-w-0 max-mobile:col-start-1 max-mobile:row-start-2 max-mobile:min-w-0 max-mobile:px-1.5 max-mobile:py-2 max-mobile:text-center max-mobile:text-sm",
  kitInputNeedsEdit: "border-yellow-kit shadow-[0_0_0_3px_rgba(230,170,38,0.18)]",
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

function normalizeStockValue(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function toStock(stockText: Record<Kit, string>): Stock {
  return {
    blue: normalizeStockValue(stockText.blue),
    purple: normalizeStockValue(stockText.purple),
    yellow: normalizeStockValue(stockText.yellow),
  };
}

function sameStock(a: Stock, b: Stock) {
  return a.blue === b.blue && a.purple === b.purple && a.yellow === b.yellow;
}

function stockValueToText(value: number) {
  return value > 0 ? String(value) : "";
}

function sanitizeStockText(value: string) {
  return value.replace(/\D/g, "");
}

type KitInputProps = {
  definition: KitInputDefinition;
  calculateDisabled: boolean;
  needsStockEdit: boolean;
  value: string;
  onChange: (kit: Kit, value: string) => void;
  onCommit: () => void;
  onCalculate: () => void;
};

function KitInput({
  definition,
  calculateDisabled,
  needsStockEdit,
  value,
  onChange,
  onCommit,
  onCalculate,
}: KitInputProps) {
  const { t } = useI18n();
  return (
    <label className={classes.kitInput}>
      <span className={classes.kitLabel}>
        <i aria-hidden="true" className={`${classes.kitDot} ${kitDotClass[definition.kit]}`}></i>
        {t(definition.labelKey)}
      </span>
      <input
        id={definition.inputId}
        className={`${classes.kitInputControl} ${needsStockEdit ? classes.kitInputNeedsEdit : ""}`}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        placeholder="0"
        value={value}
        onChange={(event) => onChange(definition.kit, sanitizeStockText(event.currentTarget.value))}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onCommit();
          event.currentTarget.blur();
          if (!calculateDisabled) onCalculate();
        }}
      />
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

export default function StockPanel({
  stock,
  needsStockEdit,
  isStale,
  stockStale,
  notice,
  onStockChange,
  description,
  calculateDisabled,
  loading,
  onCalculate,
  onReset,
}: StockPanelProps) {
  const { t, text } = useI18n();
  const [stockText, setStockText] = useState<Record<Kit, string>>({
    blue: stockValueToText(stock.blue),
    purple: stockValueToText(stock.purple),
    yellow: stockValueToText(stock.yellow),
  });
  const committedStockRef = useRef<Stock>(stock);

  useEffect(() => {
    committedStockRef.current = { blue: stock.blue, purple: stock.purple, yellow: stock.yellow };
    setStockText({
      blue: stockValueToText(stock.blue),
      purple: stockValueToText(stock.purple),
      yellow: stockValueToText(stock.yellow),
    });
  }, [stock.blue, stock.purple, stock.yellow]);

  const updateStockText = (kit: Kit, value: string) => {
    const next = { ...stockText, [kit]: value };
    const nextStock = toStock(next);
    setStockText(next);
    if (sameStock(committedStockRef.current, nextStock)) return;
    committedStockRef.current = nextStock;
    onStockChange(nextStock);
  };

  const commitStock = () => {
    const nextStock = toStock(stockText);
    if (sameStock(committedStockRef.current, nextStock)) return;
    committedStockRef.current = nextStock;
    onStockChange(nextStock);
  };
  const handleCalculate = () => {
    commitStock();
    onCalculate();
  };
  const panelClassName = stockPanelClassName(needsStockEdit, stockStale);

  return (
    <section className={panelClassName}>
      <div className={classes.heading}>
        <h2>{t("stock.title")}</h2>
      </div>

      <div id="stockEditNotice" className={classes.editNotice} hidden={!needsStockEdit}>
        {text(notice)}
      </div>
      <div className={classes.editNotice} hidden={!stockStale || needsStockEdit}>
        {t("stock.changed")}
      </div>

      <div className={classes.kitGrid}>
        {KIT_INPUTS.map((definition) => (
          <KitInput
            definition={definition}
            calculateDisabled={calculateDisabled || loading}
            key={definition.kit}
            needsStockEdit={needsStockEdit}
            value={stockText[definition.kit]}
            onChange={updateStockText}
            onCommit={commitStock}
            onCalculate={handleCalculate}
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
          onClick={onReset}
        >
          {t("common.reset")}
        </button>
        <button
          id="calculateButton"
          className={`${classes.primaryButton} ${
            needsStockEdit ? classes.primaryButtonLocked : isStale ? classes.primaryButtonStale : ""
          }`}
          type="button"
          disabled={calculateDisabled || loading}
          aria-describedby="strategyDescription"
          aria-live="polite"
          onPointerDown={commitFocusedInput}
          onClick={handleCalculate}
        >
          {needsStockEdit ? (
            t("common.stockEditRequired")
          ) : loading ? (
            <>
              <span className={classes.spinner} aria-hidden="true" />
              {t("common.calculating")}
            </>
          ) : isStale ? (
            t("common.recalculate")
          ) : (
            t("common.calculate")
          )}
        </button>
      </div>
    </section>
  );
}
