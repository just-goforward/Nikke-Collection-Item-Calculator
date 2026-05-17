import DetailPanel from "./components/DetailPanel";
import LoadingOverlay from "./components/LoadingOverlay";
import PrivacyFooter from "./components/PrivacyFooter";
import ResultPanel from "./components/ResultPanel";
import SolvePanel from "./components/SolvePanel";
import StatePanel from "./components/StatePanel";
import StatsPanel from "./components/StatsPanel";
import StockPanel from "./components/StockPanel";
import SuccessAttemptModal from "./components/SuccessAttemptModal";
import TopBar from "./components/TopBar";
import { useCalculatorApp } from "./hooks/useCalculatorApp";

export default function App() {
  const calculator = useCalculatorApp();
  const { actions } = calculator;

  return (
    <>
      <main className="app-shell">
        <TopBar themeMode={calculator.themeMode} onThemeModeChange={actions.setThemeMode} />
        <section className="workspace-grid">
          <StatePanel
            state={calculator.statePanel}
            onGradeChange={actions.setGrade}
            onLevelChange={actions.setLevel}
            onExpChange={actions.setExp}
          />
          <StockPanel
            stock={calculator.stockPanel.stock}
            needsStockEdit={calculator.stockPanel.needsStockEdit}
            notice={calculator.stockPanel.notice}
            onStockChange={actions.setStock}
          />
          <SolvePanel
            strategy={calculator.solvePanel.strategy}
            description={calculator.solvePanel.description}
            calculateDisabled={calculator.solvePanel.calculateDisabled}
            onStrategyChange={actions.setStrategy}
            onCalculate={actions.calculate}
            onReset={actions.reset}
          />
          <ResultPanel
            view={calculator.resultView}
            onConvert={actions.applyConvert}
            onOutcome={actions.applyOutcome}
          />
          <DetailPanel
            view={calculator.detailView}
            validation={calculator.validationView}
            onRunValidation={actions.runMonteCarloValidation}
          />
          <StatsPanel view={calculator.statsView} />
        </section>
      </main>
      <PrivacyFooter />
      <SuccessAttemptModal
        modal={calculator.modal}
        onAttemptChange={actions.setModalAttempt}
        onSubmit={actions.submitSuccessAttempt}
      />
      <LoadingOverlay loading={calculator.loading} />
    </>
  );
}
