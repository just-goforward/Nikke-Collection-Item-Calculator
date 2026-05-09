<template>
  <main class="app-shell">
    <TopBar />
    <section class="workspace-grid">
      <StatePanel />
      <StockPanel />
      <SolvePanel />
      <ResultPanel />
      <DetailPanel />
      <StatsPanel />
    </section>
  </main>
  <PrivacyFooter />
  <LoadingOverlay />
</template>

<script setup lang="ts">
import DetailPanel from "./components/DetailPanel.vue";
import LoadingOverlay from "./components/LoadingOverlay.vue";
import PrivacyFooter from "./components/PrivacyFooter.vue";
import ResultPanel from "./components/ResultPanel.vue";
import SolvePanel from "./components/SolvePanel.vue";
import StatePanel from "./components/StatePanel.vue";
import StatsPanel from "./components/StatsPanel.vue";
import StockPanel from "./components/StockPanel.vue";
import TopBar from "./components/TopBar.vue";
</script>
