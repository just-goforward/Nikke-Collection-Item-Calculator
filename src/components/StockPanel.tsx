import { useEffect, useState } from "react";

import type { Kit, Stock } from "../types";

type StockPanelProps = {
  stock: Stock;
  needsStockEdit: boolean;
  notice: string;
  onStockChange: (stock: Stock) => void;
};

type KitInputDefinition = {
  kit: Kit;
  inputId: string;
  label: string;
  expLabel: string;
};

const KIT_INPUTS: KitInputDefinition[] = [
  {
    kit: "blue",
    inputId: "blueStock",
    label: "초심자용 관리 키트",
    expLabel: "1회 경험치 200",
  },
  {
    kit: "purple",
    inputId: "purpleStock",
    label: "중급자용 관리 키트",
    expLabel: "1회 경험치 500",
  },
  {
    kit: "yellow",
    inputId: "yellowStock",
    label: "상급자용 관리 키트",
    expLabel: "1회 경험치 1,000",
  },
];

const classes = {
  panel:
    "min-w-0 rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  panelNeedsEdit: "border-yellow-kit shadow-[0_0_0_3px_rgba(230,170,38,0.22),var(--shadow)]",
  heading:
    "flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  editNotice:
    "mx-[18px] mt-3.5 rounded-card border-2 border-yellow-kit bg-outcome px-[13px] py-3 text-[13px] text-outcome-text font-semibold leading-[1.45]",
  kitGrid:
    "grid grid-cols-3 gap-2.5 px-[18px] py-4 min-[981px]:max-[1099px]:grid-cols-1 min-[981px]:max-[1099px]:gap-2 min-[981px]:max-[1099px]:p-3 max-mobile:grid-cols-3 max-mobile:gap-2 max-mobile:px-3 max-mobile:pt-2.5 max-mobile:pb-[13px]",
  kitInput:
    "grid gap-[7px] min-[981px]:max-[1099px]:grid-cols-[minmax(0,1fr)_auto] min-[981px]:max-[1099px]:items-center min-[981px]:max-[1099px]:gap-2 max-mobile:grid-cols-1 max-mobile:grid-rows-[auto_auto_auto] max-mobile:items-start max-mobile:gap-x-0 max-mobile:gap-y-1.5 max-mobile:p-0",
  kitLabel:
    "flex items-center gap-[7px] text-[13px] text-muted font-semibold min-[981px]:max-[1099px]:min-w-0 min-[981px]:max-[1099px]:whitespace-nowrap max-mobile:col-start-1 max-mobile:row-start-1 max-mobile:min-w-0 max-mobile:whitespace-normal max-mobile:text-[11px] max-mobile:leading-[1.25] max-mobile:[word-break:keep-all]",
  kitDot: "inline-block size-3 flex-none rounded-full",
  kitInputControl:
    "min-[981px]:max-[1099px]:col-span-full min-[981px]:max-[1099px]:min-w-0 placeholder:text-muted/55 max-mobile:col-start-1 max-mobile:row-start-2 max-mobile:min-w-0 max-mobile:px-1.5 max-mobile:py-2 max-mobile:text-center max-mobile:text-sm",
  kitInputNeedsEdit: "border-yellow-kit shadow-[0_0_0_3px_rgba(230,170,38,0.18)]",
  kitHint:
    "text-muted text-xs font-medium min-[981px]:max-[1099px]:min-w-0 min-[981px]:max-[1099px]:justify-self-end min-[981px]:max-[1099px]:whitespace-nowrap min-[981px]:max-[1099px]:text-[11px] max-tablet:justify-self-end max-tablet:text-right max-mobile:col-start-1 max-mobile:row-start-3 max-mobile:text-[10px]",
  help: "mx-[18px] mb-4 mt-[-2px] text-muted text-xs font-normal leading-[1.45] min-[981px]:max-[1099px]:mx-3 min-[981px]:max-[1099px]:mb-3 min-[981px]:max-[1099px]:text-[11px] max-mobile:hidden",
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

function stockValueToText(value: number) {
  return value > 0 ? String(value) : "";
}

type KitInputProps = {
  definition: KitInputDefinition;
  needsStockEdit: boolean;
  value: string;
  onChange: (kit: Kit, value: string) => void;
  onCommit: () => void;
};

function KitInput({ definition, needsStockEdit, value, onChange, onCommit }: KitInputProps) {
  return (
    <label className={classes.kitInput}>
      <span className={classes.kitLabel}>
        <i aria-hidden="true" className={`${classes.kitDot} ${kitDotClass[definition.kit]}`}></i>
        {definition.label}
      </span>
      <input
        id={definition.inputId}
        className={`${classes.kitInputControl} ${needsStockEdit ? classes.kitInputNeedsEdit : ""}`}
        type="number"
        min="0"
        step="1"
        inputMode="numeric"
        placeholder="0"
        value={value}
        onChange={(event) => onChange(definition.kit, event.currentTarget.value)}
        onBlur={onCommit}
      />
      <small className={classes.kitHint}>{definition.expLabel}</small>
    </label>
  );
}

export default function StockPanel({
  stock,
  needsStockEdit,
  notice,
  onStockChange,
}: StockPanelProps) {
  const [stockText, setStockText] = useState<Record<Kit, string>>({
    blue: stockValueToText(stock.blue),
    purple: stockValueToText(stock.purple),
    yellow: stockValueToText(stock.yellow),
  });

  useEffect(() => {
    setStockText({
      blue: stockValueToText(stock.blue),
      purple: stockValueToText(stock.purple),
      yellow: stockValueToText(stock.yellow),
    });
  }, [stock.blue, stock.purple, stock.yellow]);

  const updateStockText = (kit: Kit, value: string) => {
    setStockText((current) => ({ ...current, [kit]: value }));
  };

  const commitStock = () => onStockChange(toStock(stockText));
  const panelClassName = `${classes.panel} ${needsStockEdit ? classes.panelNeedsEdit : ""}`;

  return (
    <section className={panelClassName}>
      <div className={classes.heading}>
        <h2>보유 키트</h2>
      </div>

      <div id="stockEditNotice" className={classes.editNotice} hidden={!needsStockEdit}>
        {notice}
      </div>

      <div className={classes.kitGrid}>
        {KIT_INPUTS.map((definition) => (
          <KitInput
            definition={definition}
            key={definition.kit}
            needsStockEdit={needsStockEdit}
            value={stockText[definition.kit]}
            onChange={updateStockText}
            onCommit={commitStock}
          />
        ))}
      </div>
      <p className={classes.help}>현재 보유 중인 키트의 수량을 입력하는 칸입니다.</p>
    </section>
  );
}
