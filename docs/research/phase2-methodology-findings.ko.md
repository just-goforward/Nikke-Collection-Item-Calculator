# Rust Phase2 방법론 연구 결과

영문 문서: [`phase2-methodology-findings.md`](./phase2-methodology-findings.md)

분석 일자: 2026-08-09

연구 시작 기준: `45fc4175c332cb5d9656d86ae3f30fe6e4c5e527`

Phase2 결과 checkpoint: `99331dbf00632e2ac83b6930c6213766908e895a`

범위: 연구용 Rust/WASM ABI, TypeScript evaluator, benchmark, 판정 문서

## 최종 판정

[확인] 현재 제품에 바로 채택할 Rust phase2 방법론 후보는 없습니다. 제품 runtime, UI,
Worker protocol, D1 schema, solver 정책 버전은 변경하지 않았습니다.

- cap-offset 상태 확장은 수학적으로 새 정보를 복원하지 못하므로 기각했습니다.
- min-E[f] 행동 순서 변경은 결과 경계를 바꾸지 못하고 node 수만 수십 개 흔들어 기각했습니다.
- B0 기반 branch-and-bound는 정확성, 한 용량 회복, WASM·메모리 gate를 통과했지만 hard
  fixture에서 phase2 대비 1.93배 느려 제품 후보에서 기각했습니다.
- sparse constrained policy iteration의 정정 exact 구현은 작은 fixture에서 min-E[f]와
  일치했지만 `R10-balanced300`의 120만-state budget을 넘었습니다.
- Rust max-path 우선순위 bounded 후보는 `SR0` 자원 품질을 개선했지만 `R10`을 악화시켰고,
  네 직접 지연 캠페인과 115KB WASM budget도 모두 실패했습니다.
- full recorded CVaR는 제품 fallback이 실제 도달하는 21개 상태에서 모두 memo capacity를
  초과해 phase2로 복구됐고, exact 결과를 한 번도 바꾸지 못했습니다.
- 추천 run을 항상 1회로 제한하면 기대 수동 입력은 줄지만 `R10`의 F와 총 사용량이 악화되고
  재확인·재계산 부담은 미측정이므로 기각했습니다.

## 후보별 검증

| 후보 | 질문 | 확인 결과 | 판정 |
| --- | --- | --- | --- |
| A. phase2 cap offset | 잘라낸 재고 offset을 state/key에 넣으면 phase2 정보가 복원되는가 | 960개 encoded state × 3개 kit에서 비종료 상태의 독립 worst-case recurrence가 기존 `capStockForState`와 전부 일치 | 기각 |
| B. sparse constrained PI | phase2 정책을 필요한 상태만 exact 개선하면 min-E[f] 실패 영역을 보완하는가 | TypeScript 구현은 품질 신호가 있었으나 느렸고, Rust 우선순위 구현은 exact R10 용량·bounded 지연·WASM 크기 gate를 통과하지 못함 | 기각 |
| C. min-E[f] 행동 순서 | 탐색 순서만 바꿔 MEMO_FULL 경계를 줄일 수 있는가 | 6개 순열 모두 action/success/cost bit 동일. fixture별 node 범위 차이는 6~56개이고 outcome 변화 0건 | 기각 |
| D. gate-aware CVaR | 성공확률 gate 안에서 tail 목적을 쓰면 평균 목적도 지킬 수 있는가 | one-step 변경 2건은 공동 gate 실패. full recorded 정책은 제품 fallback 상태에서 21/21 capacity 실패 | 기각 |
| E. branch-and-bound | 안전한 하한으로 min-E[f] 상태 수를 줄일 수 있는가 | B2는 의미론·용량·메모리·WASM gate를 통과했지만 hard fixture p95가 1.93배로 악화 | 기각 |
| F. 단일 사용 배칭 | 추천을 1회씩 끊으면 수동 입력과 자원 부담을 함께 줄일 수 있는가 | 수동 입력은 약 0.15회 감소했지만 R10 F·총사용량 악화, 사용자 상호작용 부담 미측정 | 기각 |

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

[과거 확인] one-step CVaR 후보도 phase2의 최대 성공확률 gate 안에 있는 action만 고려하도록
보강했습니다. 122개 root를 screening한 결과 행동 변경은 `R10-balanced300`,
`SR5-observedPurpleHigh` 2건이었습니다.

| Fixture | interactive P 변화 | interactive F 변화 | 총 사용 횟수 변화 | 기각 이유 |
| --- | ---: | ---: | ---: | --- |
| R10-balanced300 | 0 | +0.0009873 | +2.2575 | 부담과 총소모 악화 |
| SR5-observedPurpleHigh | 약 +1 ulp | -0.005313 | -8.8477 | blue 고갈확률 +0.004558 |

[과거 확인] one-step root 신호만으로는 성공확률, 평균 부담, 총소모, 키트별 고갈을 동시에 지킬 수
없었습니다.

[확인] 후속 연구에서는 Rust의 full recorded CVaR 정책을 `alpha=0.9`,
`eta={0,0.05,0.1,0.2,0.4,0.8,1.6}`으로 실행했습니다. 122개 root 중 115개가 완료되고 7개가
1,000,000-slot memo에서 실패했습니다. tail·성공확률·평균 guardrail을 통과해 recorded policy가
선택된 root는 29개였지만 first action 또는 run이 실제로 바뀐 것은 `SR10-skewPurple` 하나뿐이며,
이 입력은 제품 ladder에서 min-E[f]가 168 states로 먼저 완료합니다.

[확인] 제품 fallback을 재현한 exact 평가에서 `R10-balanced300` 4개 상태와
`SR0-balanced300` 17개 상태의 CVaR 시도가 모두 status 2로 실패했습니다. phase2 복구 뒤 두
시나리오의 성공확률, F, 총사용량, 키트별 고갈은 baseline과 동일했고 CVaR decision change는
0건이었습니다.

[판정] 현재 memo와 유한 eta grid의 full recorded CVaR는 제품 fallback을 개선하지 못했습니다.
이 결과는 모든 CVaR 목적이 무가치하다는 증명이 아니며, 더 큰 상태 표현이나 다른 tail 목적은 새
용량·성능 계약이 있을 때만 다시 연구합니다.

### H/p supply-debt tail 선행 판정

[확인] 별도 `min-ef-hp-study-findings.ko.md`는 현재 raw-pieces 의미론에서 H/p 49개 조합을
screening하고 16개 shortlist의 176개 exact record를 완료했습니다. baseline `H0.75-p3` 외에 tail
단계로 진입한 유일한 challenger `H0.5-p3`는 `R0-balanced150`의 max-kit supply-debt CVaR90을
76.4861일에서 85.9952일로 9.5091일 악화시켰고 Holm 보정 뒤에도 유의했습니다. 따라서 baseline을
유지했습니다. 이는 고정 grid와 현재 tail panel의 판정이며 모든 가능한 위험함수의 최적성 증명은
아닙니다.

### E. Admissible branch-and-bound

[확인] 즉시 소비 하한 B0은 terminal cost의 비음수·단조성을 이용하며, 가능한 작은 상태를 전수
검사해 실제 continuation cost를 넘지 않는 admissible lower bound임을 확인했습니다. compact
maximum-success oracle을 더한 corrected B2는 네 hard fixture에서 phase2 oracle과 bit-identical했고
`SR0 / 350·300·150`의 기존 MEMO_FULL을 완료로 바꿨습니다.

| 항목 | 결과 |
| --- | --- |
| tier22 제품 대비 linear-memory growth | +64.00MiB, 사전 상한 +66MiB 통과 |
| candidate WASM | 110,336B, 115KB budget 통과 |
| `R0 / 60·120·900` warm p95 | 199.81ms → 139.61ms, ratio 0.70 |
| `R0 / 250·250·250` warm p95 | 1,576.39ms → 3,042.48ms, ratio 1.93 |

[확인] hard fixture는 `max(+15%, +50ms)` 지연 gate를 크게 넘었습니다. 작은 입력의 pruning
이득이 oracle 비용을 상쇄해도 큰 입력에서는 반대가 될 수 있으므로, 현재 B0/B2를 제품 입력 전반의
개선으로 일반화하지 않고 기각했습니다. 브라우저·Android 측정은 사전 중단 규칙에 따라 진행하지
않았습니다.

## Sparse constrained policy iteration

> **현재 정정:** 아래 root·interactive·latency 표는 closure 완료 판정 결함이 있던 legacy
> TypeScript prototype의 관측값이다. iteration 시작 뒤 새로 발견된 state를 같은 iteration에서 전부
> 개선 검사하지 않고도 `completed`가 될 수 있었으므로, 해당 표의 `완전 수렴` 표현과 제품 품질
> 해석은 철회한다. 현재 exact 기준선은 포화 closure를 먼저 고정하고 모든 state를 매 iteration
> 검사하며, 그 결과는 `phase2-next-research-ledger.ko.md`와
> `sparse-policy-exact-baseline-v2.json`이 소유한다.

### 방법

초기 정책은 phase2입니다. 현재 정책을 raw-stock terminal cost로 exact 평가하고, phase2
최대 성공확률 gate 안의 대체 action successor closure를 확장한 뒤 비용이 엄격히 줄어드는
상태만 교체합니다. 동률이면 기존 action을 유지합니다. 정책이 안정될 때까지 반복하며,
iteration/state/time budget은 typed outcome으로 분리합니다.

[확인] 정정 구현은 작은 의미론 fixture 4개에서 closure 전체를 매 iteration 검사했고 Rust
min-E[f]와 action, 성공확률, 비용, 기대소모 vector가 일치했습니다. `R10-balanced300`은 고정
120만 state budget에서 `state_budget_exceeded`로 종료됐습니다. 아래 legacy root 표는 이 정정
실행의 결과가 아닙니다.

### Legacy root screening (정정 전 prototype)

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

### Legacy interactive 결과 (exact 수렴 근거로 사용하지 않음)

제품 ladder와 동일하게 min-E[f]가 완료되면 그대로 사용하고, 실패할 때만 phase2 또는 sparse
PI로 내려갑니다.

| Fixture | sparse 설정 | P 변화 | interactive F 변화 | 총 사용 변화 | 고갈확률 변화 | 수동 입력 기대값 변화 |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| R10-balanced300 | legacy `completed` | -1.11e-16 | -0.0000195441 | -0.00737312 | blue -0.0000925147 | -0.0401802 |
| R0-observedBalanced | legacy `completed` | 0 | 0 | 0 | 전부 0 | 0 |
| SR0-observedPurpleHigh | legacy `completed` | 0 | 0 | 0 | 전부 0 | 0 |
| SR0-balanced300 | 4 sweep | -1.11e-16 | -0.00312231 | -0.302357 | blue -0.00349444 | +0.533577 |

[과거 확인] legacy R10 관측값은 `1e-12` 성공확률 허용치 안에서 F, 총소모, blue 고갈,
수동 입력이 모두 개선되는 신호를 보였습니다. 그러나 정정 exact 구현은 같은 입력에서 closure budget을
초과했으므로 이를 완전 수렴 정책의 개선으로 해석하지 않습니다. SR0 4-sweep도 근사 정책의 관측값이며
수동 입력 부담이 증가했습니다.

### Legacy 성능 screening

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

[확인] 동일 bounded 예산 `4 passes × 256 updates`에서 `max_path_probability`가
`discovery_order`보다 세 screening fixture의 최종 phase2-policy E[F]를 모두 낮춰 후속 후보로
선택됐습니다. 이는 exact 수렴이나 제품 채택이 아니라 제한된 update 순서의 screening 승리입니다.

[확인] 제품 ladder exact 평가에서 `R10-balanced300`은 성공확률은 같았지만 F
`+0.0010308173`, 총 기대 사용량 `+0.1342049927`, blue 고갈확률 `+0.0002999188`로
악화했습니다. `SR0-balanced300`은 F `-0.0027377024`, 총사용량 `-0.2987284709`, blue
고갈확률 `-0.0025905029`로 개선했지만 수동 입력 기대값이 `+0.2029253483` 증가했습니다.
시나리오별 hard gate이므로 SR0 개선으로 R10 악화를 상쇄하지 않았습니다.

[확인] 공통 min-E[f] rung을 제외한 직접 fallback 비교는 후보별 31개 warm 표본, 두 독립
캠페인으로 실행했습니다. R10 p95 ratio는 1.322와 1.368, SR0은 1.185와 1.162였고 네 캠페인
모두 `max(+15%, +50ms)`를 넘었습니다. 격리 candidate WASM은 133,089B로 제품 raw budget
115,000B를 18,089B 초과했습니다.

[판정] exact R10 용량, R10 interactive 품질, 직접 지연, WASM 크기가 독립적으로 실패했습니다.
후보를 제품 runtime에 연결하지 않았고 `public/solver_rs.wasm`도 변경하지 않았습니다.

## 단일 사용 배칭

기존 min-E[f]→phase2가 선택한 action은 그대로 두고 추천 run count만 1로 제한해 매 사용 뒤 다시
계산했습니다.

| Fixture | P 변화 | interactive F 변화 | 총 사용 변화 | blue 고갈 변화 | 수동 입력 변화 | solve call 변화 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `R10-balanced300` | 0 | +0.0000000475 | +0.0000809789 | -0.0000000949 | -0.1475407801 | +292 |
| `SR0-balanced300` | +2.22e-16 | -0.0001656483 | -0.0292006848 | -0.0006787112 | -0.1526720255 | +976 |

[확인] 두 시나리오에서 기대 수동 입력은 약 0.15회 줄었습니다. 그러나 R10의 F와 총사용량이
악화하고 엄격한 성공확률/F 이득이 없어 공동 품질 gate를 실패했습니다. 또한 사용자가 추가로
수행할 확인·재계산 횟수와 체감 부담은 exact evaluator가 측정하지 않습니다. 따라서 이 후보는
상호작용 trade-off로 승격하기 전 자원 품질에서 이미 기각됩니다.

## 키트별 고갈 목적

키트별 고갈은 `g=(P[blue<10], P[purple<10], P[yellow<10])`인 벡터입니다. 한 정책이 blue를
보호하는 대신 purple을 더 소모하면 사용자 가중치나 lexicographic 우선순위 없이는 두 정책 중
하나를 수학적으로 더 낫다고 정할 수 없습니다. 이번 연구는 임의 가중치를 만들지 않고 세 축의
componentwise 비악화를 제품 guardrail로 사용했습니다. H/p tail, bounded hybrid, CVaR, 1회
배칭 중 나머지 gate까지 모두 통과한 후보는 없습니다. 이는 모든 Pareto 후보의 부재를 증명하는
것이 아니라, 정의되지 않은 사용자 선호를 solver에 몰래 넣지 않았다는 뜻입니다.

## 차세대 solver·WebGPU 후속 연구

[확인] Phase2 방법론 후보를 닫은 뒤 complete-policy oracle, compact LP, WebGPU exact hybrid,
certified limited depth, AO*/BRTDP 선행 bound, Pareto frontier, 단조성 표본 검사, symbolic
partition과 그 의존 후보를 별도 계약으로 평가했습니다.

- 소형 compact graph는 현재 Rust WASM의 행동·확률·비용·소모 vector와 일치했습니다.
- WebGPU 정수 frontier는 소형 key-set parity를 통과했지만 `R10-balanced300` exact graph가
  사전 등록한 120만 상태 상한을 초과했습니다.
- 제한 깊이 bound는 대표 R10·SR0 root를 depth 8에서도 인증하지 못했고, Pareto와 symbolic
  후보도 각각 frontier 폭과 압축률 gate를 실패했습니다.
- 단조성 표본에서 반례는 없었지만 전역 증명이 아니므로 pruning 계약으로 승격하지 않았습니다.

[판정] 후속 연구에서도 제품 채택 후보는 없으며 현재 Rust min-E[f]→phase2 ladder를 유지합니다.
이는 가능한 모든 알고리즘이 열등하다는 증명이 아니라, 이번 후보와 사전 계약의 판정입니다. 상세
수치와 미검증 범위는 [`next-solver-research-findings.ko.md`](./next-solver-research-findings.ko.md)에
기록했습니다.

## 미검증 범위

- [미검증] branch-and-bound, bounded hybrid, full CVaR는 앞선 Node·품질·크기 gate에서 기각해
  브라우저와 Android에서 측정하지 않았습니다.
- [미검증] full CVaR는 alpha 0.9, eta 7개, 현재 1,000,000-slot memo에 한정됩니다. 더 큰 memo나
  다른 tail-risk 정의의 결과를 일반화하지 않습니다.
- [미검증] 단일 사용 배칭의 추가 확인·재계산 클릭과 체감 부담은 exact evaluator가 측정하지
  않습니다.
- [미검증] 키트별 고갈 목적의 사용자 가중치·우선순위는 정의되지 않았습니다.
- [미검증] synthetic 및 과거 집계 기반 scenario를 실제 사용자 빈도로 해석하지 않습니다.
- exact evaluator 전체 경과시간은 상태 전체를 열거하는 연구 비용이며 사용자 1회 solve 지연이
  아닙니다.

## 재현 자료

candidate WASM과 대량 결과는 로컬 gitignored 경로에 생성됩니다. 아래 runner와 판정 문서가 공개
재현 계약이며, 단계별 authoritative hash는 `phase2-next-research-ledger.ko.md`에 기록했습니다.

주요 명령:

```powershell
npm run test:bench
npm run bench:phase2:action-order
npm run bench:phase2:branch-bound:latency
npm run bench:phase2:gated-cvar:screen
npm run bench:phase2:gated-cvar:interactive
npm run bench:phase2:recorded-cvar:screen
npm run bench:phase2:recorded-cvar:interactive
npm run bench:phase2:single-use-batching
npm run bench:phase2:successor-closure
npm run bench:phase2:sparse-pi
npm run bench:phase2:sparse-pi:exact-baseline
npm run bench:phase2:sparse-pi:interactive
npm run bench:phase2:sparse-pi:performance
npm run build:solver-wasm:sparse-pi
npm run bench:phase2:sparse-pi:rust
npm run bench:phase2:prioritized-policy
npm run bench:phase2:bounded-hybrid:quality
npm run bench:phase2:bounded-hybrid:performance
```

대량 JSON은 `benchmarks/results/`, candidate WASM은 `output/`에 생성되며 gitignored입니다.
이 문서의 수치는 fingerprint가 고정된 현재 아티팩트와, 명시적으로 legacy로 표시한 과거 결과를
구분해 사용했습니다.
