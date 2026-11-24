import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import StockPanel from '../src/components/StockPanel';
import { useCalculatorState } from '../src/hooks/useCalculatorState';
import { I18nProvider, message } from '../src/i18n/locale';

const initial = { grade: 'SR' as const, level: 7, exp: 100, stock: { blue: 13, purple: 31, yellow: 42 } };
function StockForm() {
  const state = useCalculatorState({ onInputChanged() {}, onMaxLevelState() {} });
  const saved = useRef<Parameters<typeof state.restoreInputSnapshot>[0] | null>(null);
  const [submitted, setSubmitted] = useState('');
  return <>
    <button id="seed" onClick={() => state.restoreInputSnapshot(initial)}>Set input</button>
    <StockPanel stock={state.stock} calculateDisabled={state.solvePanel.calculateDisabled} loading={false}
      disabled={false} needsStockEdit={false} correction={null} isStale={false} stockStale={false}
      notice={message('solver.strategySupply')} description={state.solvePanel.description} onStockChange={state.actions.setStock}
      onCalculate={() => setSubmitted(JSON.stringify(state.collectInput().stock))}
      onReset={() => {
        saved.current = { grade: state.grade, level: state.level, exp: state.exp, stock: { ...state.stock } };
        setSubmitted('');
        state.resetState();
      }} />
    <button id="undo" onClick={() => { if (saved.current) state.restoreInputSnapshot(saved.current); }}>Undo</button>
    <output id="submitted">{submitted}</output>
    <output id="model">{JSON.stringify(state.stock)}</output>
  </>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><StockForm /></I18nProvider>);
