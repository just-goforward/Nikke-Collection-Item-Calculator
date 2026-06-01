# Solver 3단계 슬라이더 캘리브레이션 — 플랜 전체 완성본

> 다회 비판적 검토(라운드 9~14)로 수렴한 설계에, 감독 중 발견한 6개 수정과 누락돼 있던 **최종 선정
> 단계**를 합쳐 **실행 가능한 완성 사양**으로 정리한 문서입니다. 구현 파일은 이 폴더에 있으며, 무엇이 왜
> 바뀌었는지는 `REPORT.ko.md`를 함께 보세요.

## Context (배경)

원 요청은 from-scratch solver 재설계의 7개 전제 검토였다: ① 단일 키트가 아니라 R0→SR15 전체
키트소비 + 28일 기대수급에 근거한 3단계 슬라이더, ② 전 단계 선택형 전문가 모드, ③ WASM/MDP 변형
검토, ④ 잔량·고갈·자율일수 tail, ⑤ 동적 수급 압박, ⑥ 분산/tail 위험(trajectory 수집기 vs 2차 모멘트),
⑦ 비용함수 변형. 핵심은 **슬라이더가 "확률 포기 y/n"이 아니라 성공확률↔수급안정 효용함수를 선택**하며,
3개 점을 임의값이 아니라 데이터로 고른다는 것이다. 직전 `shadow-price` 후보 B/C는 fail-fast로 거부됐고
(`benchmarks/SHADOW_PILOT_FINDINGS.md`), 본 실험은 이론적으로 건전한 다른 레버 —
**매개변수화된 availability 비용 `(τ, H, p)`** 를 쓴다.

목적: `(τ, H)` 그리드 + `p` probe를 돌려 **단계 분리성, 희소키트 소비 단조성, exact 재계산 성공확률
손실, tail-risk 개선**을 함께 측정하고 그 결과로 3개 슬라이더 점을 고른다. **production `solve()`는 본
실험에서 바뀌지 않는다.**

## 확정 설계 (수렴 결론)

| 항목 | 결정 |
|---|---|
| 슬라이더 의미 | 효용함수(확률↔수급안정) 선택. UX는 1축, 내부적으로 `(H, τ)` 단조 schedule에 매핑 |
| 근거 축 | probability tolerance `τ`, availability horizon `H`. `p`는 전역 기본 `3`, `{4,∞}`는 보존 단계 escalation probe, `2`는 최저 우선순위 민감도 |
| 아키텍처 | **β v1** = online **mean** 비용 MDP + offline tail 평가. α v2(tail-in-loop)는 보류 |
| 위험측도 이론 | 전체 trajectory 비용의 static CVaR는 Bellman 비분해(`CVaR[Σc]≠ΣCVaR`) → 루프 내 위험비용 미사용은 속도가 아니라 의미론적 근거 |
| tail 평가 | **CRN trajectory가 1차**(전 그리드). exact 결합 잔량분포는 sentinel MC 무편향 검증자. held-out seed는 최종 후보 winner's-curse 방어(MC 대체 시) |
| 차단 gate | **exact interactive-replan 성공확률 손실(vs A)** 만. **MC fallback 없음**(timeout=판정불가=통과 아님) |
| `F`(p-norm 목적) | 차단 gate 아님(A 편향). 싼 screen + 해석용만 |
| y축 측도 | `CVaR90(max_k supplyDebtDays_k | S28=E[S28])`, **완주충분 journey panel에서만** 측정 |
| 전문가 모드 | 폐루프 greedy(매 사용 후 재계산). 첫 추천은 여전히 myopic. **최종 3점에서만 계약 재확인** |
| S28 | v1 `E[S28]` 점추정(`EXPECTED_28_DAY_GAIN`). v1.5 convolution은 범위 밖 |
| null result | 정상 결론(3단계/2단계/A유지/증거부족). 억지로 3점 만들지 않음 |

핵심 지표 정의:
- `supplyDebtDays_k = max(0, journeyConsumption_k − G_k) / (G_k/28)` (pieces→days),
  `G = {blue:473.912, purple:55.808, yellow:24.736}`.
- y축 = `CVaR90(max_k supplyDebtDays_k)`, 보조 `deficitVolumeDays`(Σ).
- `availability_i = stock_i + H·G_i`, `cost = (Σ(E[consume_i]/availability_i)^p)^(1/p)`.
- `τ_s`(solver 내부 결정 band, 실험 입력 레버) ≠ `ΔP_budget`(end-to-end exact P 손실 허용, 출력 임계, 기본 0.005).

## 구현 (연구 전용, production 불변)

### 연구 API (`src/solver.ts` — 무변경 복사, 이미 반영됨)
- `ResearchCostModel`의 availability 변형에 `horizonFactor`, `normPower`(∞ 지원). 기본값에서
  `solve()`와 **관측 결과 동일**(rooted p-norm 동일, `availability≤0` 분기는 H=0.5에서 도달 불가).
- `availabilityRatio()` 공유 헬퍼로 H=0 edge 안전 처리(accumulator 보존).
- `SolveExecutionOptions.toleranceOverride`(supply 경로 전용; `solve()`는 미설정 → production 0.01 유지).
- gate audit: `eligibleEmptyCount` + 후보 τ 위반 + 고정 0.01 기준 병행.

### 후보 그리드 (`benchmarks/models/availability-grid.ts`)
- A 기준 = `(τ=0.01, H=0.5, p=3)`. `τ∈{0,0.001,0.002,0.005,0.01,0.02,0.03}`, `H∈{0,0.25,0.5,0.75,1.0}`,
  p=3(기본 35) + `{4,∞}`(보존 escalation) + `2`(민감도) → probe 포함 140.

### Screen (`benchmarks/evaluator/availability-screen.ts`, `run-availability-screen.mjs`)
- **ranking/deprioritize 단계**(기각 아님). reject는 root 불가/실행오류/hard-infeasible만.
- 무편향 구조 신호: root feasibility, A 대비 추천 차이(kit/run.count), top1/2 gap, near-boundary,
  `eligibleEmptyCount`, chosenGap. **F·잡음 MC 미사용, "첫 추천 동일"은 우선순위↓일 뿐**.
- deep 집합은 **A 강제 + H/τ 전구간 + off-diagonal + chosenGap low/high + promote 강후보**로 span,
  단계 라벨은 **사후** 배정. top-K(기본 20)로 축소(예산 deprioritize, 재방문 가능).

### Deep (`run-availability-deep-slice.mjs` 권장 / `run-availability-deep.mjs`)
- exact P 손실(vs A): exact interactive-replan **단독**(MC fallback 없음). baseline-first,
  baseline 미완료 시 후보 `baseline_incomplete` skip, 누적 per-job 예산 캡, 체크포인트 재개.
- tail: CRN trajectory(seeds 4 × runs 12,000, 모델 간 동일 난수) + `summarizeTrajectories`.
- **gate/guardrail 시나리오와 journey panel은 disjoint**(런타임 단언).
- **trajectory 단계는 슬라이스에 fit할 때만 시작**(비재개 job 보호; `SLICE_MS ≥ TRAJECTORY_BUDGET_MS`).

### journey-demand y축 (`benchmarks/scenarios/journey-panels.ts`, `run-availability-journey-calibrate.mjs`)
- journey panel = **완주충분**(A completionRate ≥ 0.995) + **shaping 보존**(가상 대형 재고 금지).
- 캘리브레이션이 **per-start-state 최소 완주충분 balanced 재고 + 완주충분 skewed panel** 추천.
- 후보도 panel에서 완주(≥0.995) 못 하면 그 후보 supplyDebt는 `judgement_incomplete`(좋은 점수 불인정).

### 선정 (`run-availability-select.mjs` — capstone)
- 2D Pareto(x=최악 exact P 손실, y=journey `CVaR90(max supplyDebtDays)`).
- 단계 계약:
  - **확률우선**: P 손실 ≤ ε, guardrail 비악화, A보다 확률 엄격 우위일 때만 별도 점.
  - **균형**: = A.
  - **보존**: P 손실 ≤ `ΔP_budget`(상대손실 병기) **AND** supplyDebt가 균형 대비 **유의(統計的) 개선**
    (paired bootstrap + Holm; 유의성 파일 부재 시 점추정 잠정) **AND** ≥1 위험군 guardrail 개선.
- 출력 단조성(확률우선→균형→보존: P손실 비감소, supplyDebt 비증가) 검사 + 사후 라벨 + null-result 판정 +
  보존 미성립 시 p∈{4,∞} escalation 제안. 산출: `availability-selection.json` + `...-report.ko.md`.

### 유의성 검정 (`run-availability-significance.mjs`, plan §4·§7)
- 보존 후보(점추정 supplyDebt < A, 손실 ≤ ΔP_budget)만 journey panel을 한 프로세스에서 재수집해
  per-run `maxSupplyDebt`를 CRN 인덱스 짝짓기 → `cvarUpperTail(·,0.9)` 통계량으로
  `pairedBootstrapImprovement`. 개선 확인은 인자 swap으로 Holm을 "개선 확정"에 맞춤. 산출
  `availability-significance.json`를 select가 소비(`significantImprovement = 전 panel CI>0 AND Holm 확정`).

## 평가 지표 (요약)

| 지표 | 산출 | 역할 |
|---|---|---|
| exact P 손실(vs A) | exact-replan | **유일 차단 gate**(MC 대체 금지) |
| `CVaR90(max supplyDebtDays)` | journey panel CRN trajectory | 2D Pareto y축 |
| 잔량 p05/p10·고갈확률·자율일수 p05/p10 | finite-stock(희소) CRN trajectory | guardrail(별도) |
| `F`(p-norm) | `availabilityPnormObjective` | 싼 screen + 해석용만 |
| gate audit(eligibleEmpty/chosenGap/위반) | solver/exact 증거 | fallback·양보 진단 |
| manual-entry 노출 | exact/trajectory | UX 보고 전용(자동 차단 아님) |
| 유의성 | `tail-statistics.ts` paired bootstrap + Holm (`run-availability-significance.mjs`) | **보존 단계 supplyDebt 유의 개선 게이트** |

## 시나리오 & 실행

- Hard Safety Grid: `FIXED_SAFETY_GRID` 96(8 states × 12 stocks, balanced 24 + scarcity 72), sentinel 5 — **불변 계약**.
- gate/guardrail 시나리오(희소/현실): `R0/SR0-balanced100`, `R14e900-yellow30`, `SR5-blue30`,
  `SR10-blue10`, `SR10-yellow10`. (balanced300 제외 — 게이트 정보 0 + 최고 비용)
- journey panel(완주충분, 분리 모듈): `balanced150/200/250/300` + `demand300`(skewed), 캘리브레이션이 최소 재고 선택.
- 순서: A 재감사(root gate 위반 0) → p screen probe → `(τ,H)` structural screen → journey 캘리브레이션 →
  exact+CRN deep(슬라이스 재개) → **유의성 검정(보존 후보 supplyDebt paired bootstrap + Holm)** →
  **select(2D Pareto + 단계계약 + 단조성 + null-result)**.
- 예산: `batchSize = max(1, floor(3600/(2·pilotMaxSeconds)))`. 단일 시나리오 60분 초과 →
  `execution_budget_exceeded`. exact 5분 초과 → `verification_incomplete`(통과 취급 금지).

## Acceptance Rules

- **A 감사**: 전 96 시나리오 root + deep 방문 state에서 `probabilityGap > 0.01+1e-12` 위반 0.
- **단계별 후보 수용**(역할 분리):
  - 공통: gate 동일 코드 경로, timeout/cycle/budget 초과 0, 의도치 않은 fallback(eligibleEmpty) 0,
    완료된 deep에서만 판정.
  - 확률우선·균형: 완료 deep 전부 exact `P ≥ A − ε`. balanced·guardrail 비악화.
  - 보존: exact `P` 손실 `≤ ΔP_budget`(사전공시, per-scenario) **AND** supplyDebt가 균형 대비 **유의 개선**
    (paired bootstrap + Holm) + 위험군 ≥1건 개선. balanced 비악화. (유의성 파일 부재 시 점추정 잠정.)
- `F`는 수용 기준 아님(해석용). manual-entry는 보고 전용.
- **production 변경 규칙**: 본 실험은 `solve()` 불변. 채택 승인 시에만 기본 cost model 교체 +
  `solverVersion`/`solverPhase` 동시 갱신.
- **null result 허용**: 3점이 정당화·단조이지 않으면 2단계/A유지/증거부족을 정상 결론으로 보고.

## 전문가 모드

- 정의: 매 사용 후 실제 상태·재고로 다시 solve하는 per-use replan(폐루프 greedy, 첫 추천은 myopic).
- v1 본체와 분리, **최종 3점에서만 계약 재확인**. 뒤집히면 보고 후 재선정 또는 expert 설명 분리.

## Discards
RL, hard-rule 슬라이더, 5~7단계, 루프 내 CVaR/quantile, 정규근사 기반 정책 결정, shadow-price 재시도,
`F`를 차단 gate로 사용, gate의 MC fallback, **balanced300을 exact 게이트 시나리오로 사용**(수정 #1),
**virtual 대형 재고를 journey panel로 사용**(shaping 붕괴).

## Test Plan
- 회귀: `solver.test.ts`(관측 동등성), `a-root-preflight.spec.ts`(전 96 root gate), `a-baseline.spec.ts`
  (exact 분기·resume), `a-trajectory.spec.ts`(supplyDebt/CVaR/결정성), `availability-grid/screen.spec.ts`,
  `tail-statistics.spec.ts`, `shadow-price.spec.ts`, `significance.spec.ts`(유의성 사용 패턴·방향).
- 신규 구조 단언: gate ∩ journeyPanels = ∅; trajectory 슬라이스 fit; journey 캘리브레이션 임계;
  보존=유의 개선(점추정 아님).

## Verification (end-to-end)
`REPORT.ko.md §6` 참조: 단위/회귀 → screen → journey 캘리브레이션 → deep(슬라이스) → select.
재현: seed 고정(20260505–08). 산출: 3점 후보표 + 2D Pareto + 단계계약 충족/위반 + tail 유의성 +
단조성/분리성 + gate audit + 내부-τ vs end-to-end P 단조성.

## Assumptions / Constraints (보존)
- D1 진단 aggregate는 비공개·비커밋. 정확한 사용자 stock 로깅 미추가.
- 사용자는 필요한 수동 재고 입력을 정확히 수행한다고 가정. `manual_entry_exposed`는 UX 보고 지표.
- tail 전용 정책은 측정이 필요성을 입증할 때만 별도 설계(Track T).
- `benchmarks/results/`는 비커밋(gitignore).
