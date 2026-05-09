<template>
  <section class="panel solve-panel">
    <div class="section-heading">
      <h2>계산</h2>
    </div>

    <div class="strategy-control" role="group" aria-label="최적화 방식">
      <button class="strategy-button active" type="button" data-strategy="single">단일 목표</button>
      <button class="strategy-button" type="button" data-strategy="supply">수급량 고려</button>
    </div>

    <div id="strategyDescription" class="solve-note">
      지금 이 소장품을 SR 15로 만들기 위한 최적의 선택
    </div>

    <div class="button-row">
      <button id="calculateButton" class="primary-button" type="button">계산</button>
      <button id="resetButton" class="secondary-button" type="button">초기화</button>
    </div>
  </section>
</template>
