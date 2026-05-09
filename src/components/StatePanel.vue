<template>
  <section class="panel state-panel">
    <div class="section-heading">
      <h2>현재 소장품</h2>
    </div>

    <div class="grade-row" role="group" aria-label="소장품 등급">
      <button class="seg-button active" type="button" data-grade="R">R</button>
      <button class="seg-button" type="button" data-grade="SR">SR</button>
    </div>

    <div id="levelGrid" class="level-grid" aria-label="현재 단계"></div>

    <div class="field-grid exp-grid">
      <label>
        <span>현재 경험치</span>
        <input id="currentExp" type="number" min="0" max="900" step="100" inputmode="numeric" value="0" />
      </label>
      <div class="exp-divider" aria-hidden="true">/</div>
      <label class="readonly-field">
        <span>레벨업 필요 경험치</span>
        <strong id="requiredExpLabel">1,000</strong>
      </label>
    </div>
  </section>
</template>
