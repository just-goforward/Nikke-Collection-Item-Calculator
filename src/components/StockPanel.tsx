import { useEffect, useState } from "react";

import type { Kit, Stock } from "../types";

type StockPanelProps = {
  stock: Stock;
  needsStockEdit: boolean;
  notice: string;
  onStockChange: (stock: Stock) => void;
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

export default function StockPanel({
  stock,
  needsStockEdit,
  notice,
  onStockChange,
}: StockPanelProps) {
  const [stockText, setStockText] = useState<Record<Kit, string>>({
    blue: String(stock.blue),
    purple: String(stock.purple),
    yellow: String(stock.yellow),
  });

  useEffect(() => {
    setStockText({
      blue: String(stock.blue),
      purple: String(stock.purple),
      yellow: String(stock.yellow),
    });
  }, [stock.blue, stock.purple, stock.yellow]);

  const updateStockText = (kit: Kit, value: string) => {
    setStockText((current) => ({ ...current, [kit]: value }));
  };

  const commitStock = () => onStockChange(toStock(stockText));
  const panelClassName = needsStockEdit
    ? "panel stock-panel needs-stock-edit"
    : "panel stock-panel";

  return (
    <section className={panelClassName}>
      <div className="section-heading">
        <h2>보유 키트</h2>
      </div>

      <div id="stockEditNotice" className="stock-edit-notice" hidden={!needsStockEdit}>
        {notice}
      </div>

      <div className="kit-grid">
        <label className="kit-input blue-kit">
          <span>
            <i></i>초심자용 관리 키트
          </span>
          <input
            id="blueStock"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={stockText.blue}
            onChange={(event) => updateStockText("blue", event.currentTarget.value)}
            onBlur={commitStock}
          />
          <small>1회 경험치 200</small>
        </label>
        <label className="kit-input purple-kit">
          <span>
            <i></i>중급자용 관리 키트
          </span>
          <input
            id="purpleStock"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={stockText.purple}
            onChange={(event) => updateStockText("purple", event.currentTarget.value)}
            onBlur={commitStock}
          />
          <small>1회 경험치 500</small>
        </label>
        <label className="kit-input yellow-kit">
          <span>
            <i></i>상급자용 관리 키트
          </span>
          <input
            id="yellowStock"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={stockText.yellow}
            onChange={(event) => updateStockText("yellow", event.currentTarget.value)}
            onBlur={commitStock}
          />
          <small>1회 경험치 1,000</small>
        </label>
      </div>
      <p className="stock-help">현재 보유 중인 키트의 수량을 입력하는 칸입니다.</p>
    </section>
  );
}
