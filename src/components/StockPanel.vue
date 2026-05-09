<template>
  <section class="panel stock-panel">
    <div class="section-heading">
      <h2>보유 키트</h2>
    </div>

    <div id="stockEditNotice" class="stock-edit-notice" hidden>
      대성공이 발생했습니다. 보유 키트 수를 직접 수정해 주세요.
    </div>

    <div class="kit-grid">
      <label class="kit-input blue-kit">
        <span><i></i>초심자용 관리 키트</span>
        <input id="blueStock" type="number" min="0" step="1" inputmode="numeric" value="0" />
        <small>1회 경험치 200</small>
      </label>
      <label class="kit-input purple-kit">
        <span><i></i>중급자용 관리 키트</span>
        <input id="purpleStock" type="number" min="0" step="1" inputmode="numeric" value="0" />
        <small>1회 경험치 500</small>
      </label>
      <label class="kit-input yellow-kit">
        <span><i></i>상급자용 관리 키트</span>
        <input id="yellowStock" type="number" min="0" step="1" inputmode="numeric" value="0" />
        <small>1회 경험치 1,000</small>
      </label>
    </div>
    <p class="stock-help">현재 보유 중인 키트의 수량을 입력하는 칸입니다.</p>
  </section>
</template>
