# Rust Phase2 방법론 연구 결과

영문 문서: [`phase2-methodology-findings.md`](./phase2-methodology-findings.md)

분석 일자: 2026-08-08  
기준 커밋: `6251db3` 위의 미커밋 연구 작업  
범위: 연구용 Rust/WASM ABI, TypeScript evaluator, benchmark, notebook

## 최종 판정

[확인] 현재 제품에 바로 채택할 Rust phase2 방법론 후보는 없습니다. 제품 runtime, UI,
Worker protocol, D1 schema, solver 정책 버전은 변경하지 않았습니다.

- cap-offset 상태 확장은 수학적으로 새 정보를 복원하지 못하므로 기각했습니다.
- min-E[f] 행동 순서 변경은 결과 경계를 바꾸지 못하고 node 수만 수십 개 흔들어 기각했습니다.
- 성공확률 gate를 적용한 CVaR one-step 후보는 122개 root 중 2개만 행동을 바꿨지만 exact
  interactive 제품 gate를 통과하지 못했습니다.
- sparse constrained policy iteration은 일부 fallback 입력에서 실제 사용자 흐름의 자원
  지표를 개선했습니다. 그러나 현재 TypeScript 연구 구현은 phase2보다 warm p95가 약
  3.85~28.58배 느려 제품 후보에서 제외합니다.

[확인] 후속 Rust/WASM 우선순위 구현도 격리 feature로 검증했습니다. 작은 완료 fixture의
의미론은 min-E[f]와 일치했지만 R10 exact closure는 120만 state budget을 초과했습니다.
bounded 4-pass 후보도 phase2 대비 warm p95가 1.515배였고 candidate WASM이 131,426B로
115KB 예산을 넘었습니다. 사전 중단 조건에 따라 exact interactive 단계와 제품 연결은
진행하지 않았습니다.

## 후보별 검증

| 후보 | 질문 | 확인 결과 | 판정 |
| --- | --- | --- | --- |
| A. phase2 cap offset | 잘라낸 재고 offset을 state/key에 넣으면 phase2 정보가 복원되는가 | 960개 encoded state × 3개 kit에서 비종료 상태의 독립 worst-case recurrence가 기존 `capStockForState`와 전부 일치 | 기각 |
| B. sparse constrained PI | phase2 정책을 필요한 상태만 exact 개선하면 min-E[f] 실패 영역을 보완하는가 | TypeScript 구현은 품질 신호가 있었으나 느렸고, Rust 우선순위 구현은 exact R10 용량·bounded 지연·WASM 크기 gate를 통과하지 못함 | 기각 |
| C. min-E[f] 행동 순서 | 탐색 순서만 바꿔 MEMO_FULL 경계를 줄일 수 있는가 | 6개 순열 모두 action/success/cost bit 동일. fixture별 node 범위 차이는 6~56개이고 outcome 변화 0건 | 기각 |
| D. gate-aware CVaR | 성공확률 gate 안에서 tail 목적을 쓰면 평균 목적도 지킬 수 있는가 | 122개 중 2개 root 변경. 두 변경 모두 exact interactive 공동 gate 실패 | 기각 |

### A. Cap offset

[확인] 다음 recurrence를 Rust 구현과 독립된 TypeScript 테스트로 계산했습니다.

```text
M(s, target) = max_action(
  I(action = target) + max(M(successor_success), M(successor_failure))
)
```

모든 비종료 상태에서 `M`이 기존 상태별 cap과 같았습니다. 따라서 cap을 초과한 양은 phase2
탐색에서 사용할 수 있는 행동 정보를 담지 않습니다. offset을 memo key에 추가하면 상태 차원과
메모리만 늘고 최적 행동을 구분할 근거는 생기지 않습니다. terminal 상태의 cap no-op은 기존
계약으로 별도 확인했습니다.

### C. 행동 순서

[확인] 3개 kit의 6개 순열을 동일 fixture에서 비교했습니다. 모든 완료 결과의 first action,
success bits, expected-cost bits가 동일했습니다. node-count 범위는 다음과 같습니다.

| Fixture | 최대-최소 node 수 |
| --- | ---: |
| semantic dominance-cap, tier 21 | 7 |
| R0 balanced250, tier 21 | 22 |
| R0 balanced250, tier 22 | 49 |
| R0 balanced300, tier 22 | 6 |
| SR0 observed-purple-high, tier 22 | 14 |
| R0 skewed, tier 22 | 56 |

`R0-balanced250`은 tier 21에서 모든 순열이 `MEMO_FULL`, tier 22에서 모두 완료했습니다.
즉 순서 차이는 측정됐지만 용량 경계를 바꿀 정도의 효과는 아니었습니다.

### D. Gate-aware CVaR

[확인] CVaR 후보도 phase2의 최대 성공확률 gate 안에 있는 action만 고려하도록 보강했습니다.
122개 root를 screening한 결과 행동 변경은 `R10-balanced300`,
`SR5-observedPurpleHigh` 2건이었습니다.

| Fixture | interactive P 변화 | interactive F 변화 | 총 사용 횟수 변화 | 기각 이유 |
| --- | ---: | ---: | ---: | --- |
| R10-balanced300 | 0 | +0.0009873 | +2.2575 | 부담과 총소모 악화 |
| SR5-observedPurpleHigh | 약 +1 ulp | -0.005313 | -8.8477 | blue 고갈확률 +0.004558 |

[확인] CVaR root 신호만으로는 성공확률, 평균 부담, 총소모, 키트별 고갈을 동시에 지킬 수
없었습니다. 이 결과는 CVaR 자체가 무가치하다는 증명이 아니라, 이번 eta grid와 one-step
정책이 제품 공동 gate를 통과하지 못했다는 판정입니다.

## Sparse constrained policy iteration

### 방법

초기 정책은 phase2입니다. 현재 정책을 raw-stock terminal cost로 exact 평가하고, phase2
최대 성공확률 gate 안의 대체 action successor closure를 확장한 뒤 비용이 엄격히 줄어드는
상태만 교체합니다. 동률이면 기존 action을 유지합니다. 정책이 안정될 때까지 반복하며,
iteration/state/time budget은 typed outcome으로 분리합니다.

[확인] 작은 의미론 fixture 4개에서 완전 수렴 sparse PI는 Rust min-E[f]와 action, 성공확률,
비용, 기대소모 vector가 일치했습니다. 1회만 수행한 불안정 정책은 `completed`가 아니라
`iteration_budget_exceeded`로 보고합니다.

### Root screening

| Fixture | 수렴 반복 | root 비용 변화 | 총 기대 사용 변화 | 최대 평가 states |
| --- | ---: | ---: | ---: | ---: |
| R0-balanced300 | 21 | -0.0122992 | -2.19453 | 951,465 |
| R10-balanced300 | 28 | -0.00828439 | +0.088421 | 276,843 |
| SR0-balanced300 | 24 | -0.00827429 | -0.691422 | 455,492 |
| R0-observedBalanced | 26 | -0.0165700 | +0.356003 | 217,093 |
| SR0-observedPurpleHigh | 21 | -0.0423141 | -7.12296 | 361,239 |

Root 고정-policy 비용 감소는 interactive 개선의 충분조건이 아니므로 아래 exact evaluator가
최종 품질 판정자입니다.

[확인] successor closure 크기는 입력에 따라 크게 달랐습니다.

| Fixture | phase2 정책 states | sweep 1 | sweep 2 | sweep 3 | sweep 4 | 전체 eligible closure |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| R14e900-yellow30 | 353 | 507 | 622 | 709 | 743 | 750 |
| R10-balanced300 | 10,296 | 83,569 | 276,843 | 559,854 | 890,325 | 2,000,000 초과 |

R10에서는 대체 action의 successor closure 자체가 빠르게 팽창합니다. 현재 성능 저하는
TypeScript/WASM 경계 비용만이 아니라 반복해서 평가하는 실제 state 수에도 기인합니다.

### Exact interactive 결과

제품 ladder와 동일하게 min-E[f]가 완료되면 그대로 사용하고, 실패할 때만 phase2 또는 sparse
PI로 내려갑니다.

| Fixture | sparse 설정 | P 변화 | interactive F 변화 | 총 사용 변화 | 고갈확률 변화 | 수동 입력 기대값 변화 |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| R10-balanced300 | 완전 수렴 | -1.11e-16 | -0.0000195441 | -0.00737312 | blue -0.0000925147 | -0.0401802 |
| R0-observedBalanced | 완전 수렴 | 0 | 0 | 0 | 전부 0 | 0 |
| SR0-observedPurpleHigh | 완전 수렴 | 0 | 0 | 0 | 전부 0 | 0 |
| SR0-balanced300 | 4 sweep | -1.11e-16 | -0.00312231 | -0.302357 | blue -0.00349444 | +0.533577 |

`1e-12` 성공확률 허용치 안에서 R10은 F, 총소모, blue 고갈, 수동 입력이 모두 개선됐습니다.
SR0 4-sweep은 자원 지표가 개선됐지만 완전 수렴 값이 아니며 수동 입력 부담이 증가했습니다.

### 성능 screening

동일 WASM instance에서 첫 측정 1개를 제외한 4개 표본의 nearest-rank p95입니다. 표본 수가
작으므로 사용자 지연 분포가 아니라 후보 제거용 screening으로만 해석합니다.

| 변형 | Fixture | phase2 warm p95 | sparse warm p95 | 비율 |
| --- | --- | ---: | ---: | ---: |
| 완전 수렴 | R10-balanced300 | 243.0 ms | 6,944.7 ms | 28.58× |
| 완전 수렴 | SR0-balanced300 | 1,245.2 ms | 14,722.6 ms | 11.82× |
| 4 sweep | R10-balanced300 | 247.1 ms | 2,270.7 ms | 9.19× |
| 4 sweep | SR0-balanced300 | 1,213.9 ms | 4,673.9 ms | 3.85× |

[확인] 모든 측정이 기존 `max(+15%, +50ms)` gate를 크게 초과했습니다. 따라서 현재
TypeScript sparse PI는 품질 신호와 무관하게 제품 후보가 아닙니다.

### Rust-native 우선순위 후속 검증

Rust 후보는 제품 빌드에서 제외되는 Cargo feature `research-sparse-pi`로 구현했습니다. 현재
정책 평가에서 발견된 최대 root-path 확률이 큰 상태부터 검사하고, pass마다 정해진 수의 엄격
개선만 적용합니다. 이 점수는 합류 경로 확률을 더한 occupancy가 아니라 탐색 순서용
heuristic입니다. `completed`는 recursively discovered eligible closure 전체에서 더 이상 엄격
개선이 없을 때만 반환합니다.

[확인] `maxUpdatesPerPass=1,000,000`, state budget 120만으로 다음 작은 fixture를 완전
수렴시켰습니다. 네 fixture 모두 min-E[f]와 action, success, expected cost, vector 3축이 정한
허용치 안에서 일치했고 probability gap은 0이었습니다.

| Fixture | 결과 | peak states | Node elapsed |
| --- | --- | ---: | ---: |
| R0 / 60·120·900 | completed | 482,775 | 6,546.1 ms |
| R14e900 / 100·100·30 | completed | 750 | 80.7 ms |
| SR5 / 30·100·100 | completed | 2,628 | 109.2 ms |
| SR10 / 100·100·10 | completed | 87 | 47.3 ms |

[확인] R10 / 300·300·300에서 exact closure 검사는 peak 1,200,000 states에 도달해
`state_budget_exceeded`로 끝났습니다. 결과를 본 뒤 budget을 늘리지 않았습니다. 따라서 이
입력에서 exact sparse PI가 phase2 fallback을 대체한다는 주장은 성립하지 않습니다.

[확인] bounded 설정 `4 passes × 256 updates`는 동일 instance에서 첫 측정 하나를 제외한 4개
nearest-rank p95가 phase2 216.12ms, 후보 327.47ms로 1.515배였습니다. 기존 TypeScript
4-sweep 9.19배보다는 크게 줄었지만 사전 continuation 기준 1.5배와 제품 기준
`max(+15%, +50ms)`를 모두 넘었습니다. 표본이 작으므로 사용자 지연 추정이 아니라 후보
제거용 screening으로만 해석합니다.

첫 exploratory latency 실행은 반복마다 fresh instance를 만들고도 첫 표본만 제외해 warm으로
잘못 표기했으므로 폐기했습니다. 위 수치는 baseline과 candidate instance를 각각 재사용해 첫
allocation만 제외한 수정 protocol의 재실행 결과입니다.

[확인] 격리 candidate WASM은 131,426B이고 같은 checkout의 제품 WASM은 99,937B였습니다.
candidate는 제품 raw budget 115,000B를 넘습니다. exact 용량·bounded 지연·크기라는 독립된
세 조건이 함께 실패했으므로 exact interactive 결과를 추가로 골라내지 않고 연구를
중단했습니다. 제품 `public/solver_rs.wasm`과 runtime 배선은 변경하지 않았습니다.

## 미검증 범위

- [미검증] `R0-balanced300` exact candidate 평가는 baseline 자체가 약 812초 걸리는 영역이라
  이번 budget 안에 완료하지 못했습니다.
- [미검증] `SR0-balanced300` 완전 수렴 interactive 평가는 5분 budget을 초과했습니다.
  4-sweep 결과는 근사 정책의 결과이며 최종 수렴값이 아닙니다.
- [미검증] 성능 screening은 단일 Windows/Node 환경, 후보당 5회입니다. 브라우저·Android·tail
  캠페인은 screening 실패 때문에 진행하지 않았습니다.
- [미검증] synthetic 및 과거 집계 기반 scenario를 실제 사용자 빈도로 해석하지 않습니다.
- exact evaluator 전체 경과시간은 상태 전체를 열거하는 연구 비용이며 사용자 1회 solve 지연이
  아닙니다.

## 재현 자료

분석 노트북과 candidate WASM은 로컬 `output/`에 생성되며 공개 저장소에는 포함하지 않습니다.
아래 runner와 판정 문서가 공개 재현 계약입니다.

주요 명령:

```powershell
npm run test:bench
npm run bench:phase2:action-order
npm run bench:phase2:gated-cvar:screen
npm run bench:phase2:gated-cvar:interactive
npm run bench:phase2:successor-closure
npm run bench:phase2:sparse-pi
npm run bench:phase2:sparse-pi:interactive
npm run bench:phase2:sparse-pi:performance
npm run build:solver-wasm:sparse-pi
npm run bench:phase2:sparse-pi:rust
```

대량 JSON은 `benchmarks/results/`, 분석 노트북과 candidate WASM은 `output/`에 생성되며
gitignored입니다. 이 문서의 수치는 해당 로컬 실행 아티팩트를 현재 코드로 재생성해
확인했습니다.
