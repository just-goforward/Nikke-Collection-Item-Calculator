# Rust Solver 정책 품질 연구 결과

영문 원본: [`solver-policy-quality-findings.md`](./solver-policy-quality-findings.md)

분석 일자: 2026-08-05

## 최종 판정

이번 평균 목적 연구에서 제품에 채택할 후보는 나오지 않았습니다.

개별 시나리오의 `product_candidate`는 해당 fixture의 품질 gate만 통과했다는 뜻입니다.
제품 채택 여부는 report의 `selectedScenarioGrades`와 `decisionScope`를 함께 확인해야 하며,
이번 report는 제품 채택을 승인하지 않습니다.

- 제품 runtime, Worker protocol, solver version, UI는 변경하지 않았습니다.
- 과거 phase2 rerank runtime 배선은 커밋 `52a59c3`에서 제거됐고, 현재는 연구 구현과
  benchmark 경로만 남아 있습니다.
- exact one-step rerank는 정적인 첫 행동 평가에서는 개선을 만들었지만, min-E[f] 실패
  영역의 exact interactive-replan 품질·지연 기준을 통과하지 못했습니다.
- 확률 제약 전체 정책 prototype은 완료 fixture를 악화시켰고 fallback fixture에서는
  memo 한계에 도달했습니다. 이 prototype은 screening 후 제거했습니다.
- 이 보고서 작성 시점의 CVaR ABI에서는 sampled tail 개선 신호가 나왔지만, 성공확률
  gate와 recorded-policy action export가 없어 제품 후보 판정을 할 수 없었습니다. 두
  공백을 보강한 후속 연구도 공동 제품 gate에서 기각됐습니다.

## 평가 계약

exact evaluator가 새로 기록하는 항목은 다음과 같습니다.

- SR15 도달 확률
- 키트별·전체 기대 소모량
- interactive availability cost
- 키트별 고갈 확률
- 도달 가능한 경로의 키트별 최소 잔여량
- solve 호출, cache node, 경과시간, probability gate 위반
- 제한시간 미완료와 policy solver 실패의 typed outcome

raw stock remainder, 다회 추천의 순차 전이, R15→SR5 전환을 보존하며, 관측 결과가
발생할 때마다 남은 재고에서 다시 계산합니다. 2회 추천을 손으로 직접 열거할 수 있는
fixture로 성공 가지, 기대 소모량, 고갈 확률, 최소 잔여량을 함께 검증합니다.

## 정적 root 감사

fixed·supplemental·과거 집계 기반 정의를 합쳐 122개 synthetic 시나리오를 평가했습니다.
집계 기반 시나리오는 실제 사용자 비율로 해석하지 않습니다.

MC 512회 기준:

| 결과 | 건수 |
| --- | ---: |
| phase2 완료 | 121 |
| exact one-step 평가 완료 | 121 |
| exact가 root 행동을 변경 | 13 |
| exact 정적 root 비용 개선 | 13 |
| exact 정적 root 비용 악화 | 0 |
| min-E[f] 완료 | 117 |
| min-E[f] MEMO_FULL | 5 |

min-E[f] 완료 117건에서 exact one-step 비용이 min-E[f]보다 낮은 사례는 0건, `1e-12`
이내 동률은 15건, 더 높은 사례는 102건이었습니다. 정상 완료 영역의 최적성 역전은
발견되지 않았으며, 첫 행동이 달라도 목적함수 최적값은 같을 수 있습니다.

MC와 exact delta 비교 121건은 모두 명목상 1.96 표준오차 범위 안이었습니다. 이는 이
grid와 run 수에 대한 calibration 증거이지, 특정 seed가 모든 차이의 원인이라는 증명은
아닙니다.

min-E[f] 용량 실패 5건:

- `R0-balanced300`
- `R10-balanced300`
- `SR0-balanced300`
- `R0-observedBalanced`
- `SR0-observedPurpleHigh`

## fallback exact interactive 판정

phase2가 완료되는 fallback 관련 시나리오 2개를 exact budget 120초, root latency 5회로
평가했습니다.

| 시나리오 | 후보 | P 변화 | interactive F 변화 | 총 사용 횟수 변화 | warm p95 | 판정 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `R10-balanced300` | MC rerank | 0 | +0.000385782 | +1.6391 | 138.77 ms | 기각 |
| `R10-balanced300` | exact one-step | +1.1e-16 | +0.000261342 | -0.7384 | 573.46 ms | 기각 |
| `SR0-balanced300` | MC rerank | -1.1e-16 | +0.001684126 | +3.0888 | 832.12 ms | 기각 |
| `SR0-balanced300` | exact one-step | +1.1e-16 | +0.001979388 | +3.2440 | 3351.11 ms | 기각 |

interactive F와 총 사용 횟수는 낮을수록 좋습니다. [확인] `R10-balanced300` exact
후보는 총 기대 사용량을 약 0.7384회 줄였지만 interactive F가 악화됐고, 성공 확률
또는 F의 엄격한 개선도 없었습니다. 현행 분류 계약에서는 품질만으로 기각되며, 지연
gate(`max(+15%, +50ms)`)도 별도로 초과했습니다. 따라서 정적 첫 행동 개선을 사용자
흐름의 제품 개선으로 승격할 수 없습니다.

warm p95는 cold 1회를 제외한 표본 4개의 nearest-rank p95입니다. 이 표본 수에서는
관측 최댓값과 같으며, 실제 사용자 지연 분포가 아닌 screening 수치로만 해석합니다.

## 조건부 전체 정책 screening

[미검증·재현 불가] one-step rerank가 통과하지 못해 확률 제약 exact-policy prototype을
연구 전용으로 screening했습니다. prototype은 현재 HEAD에서 제거됐으므로 아래 당시
수치는 동일 실행으로 재현할 수 없습니다.

- `R14e900-yellow30`: interactive F가 `0.3279638107`에서 `0.3303792873`으로 증가했고,
  기대 총소모도 약 `0.3291 pieces` 늘었습니다.
- `R10-balanced300`: 고정 memo 한계에 도달해 완료하지 못했습니다.

완료 fixture 동치와 fallback 완료 조건을 모두 위반하므로 Rust prototype과 WASM
export를 제거했습니다. 기각된 추상화를 제품 artifact에 남기지 않았습니다.

## CVaR ABI 감사

`alpha=0.9`, eta `0, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6`을 sampled audit했습니다.

`R14e900-yellow30`의 sampled 최저점은 eta `0.8`이었습니다.

| 지표 | phase2 정책 | recorded CVaR 정책 | 변화 |
| --- | ---: | ---: | ---: |
| 평균 비용 | 0.7247767680 | 0.7054249217 | -0.0193518463 |
| sampled CVaR90 | 1.0144857929 | 0.9895445060 | -0.0249412869 |

raw pieces 감사에서는 `100/100/30`을 `101/101/31`로 바꿨습니다. uses는 같았지만 평균
비용은 `-0.0074593649`만큼 달라져 실제 재고 분모가 보존됨을 확인했습니다.

다만 제품 판정은 [미완료] `verification_incomplete`입니다.

- optimizer가 제품 성공확률 gate 대신 재고가 있는 모든 행동을 허용
- recorded action table을 exact interactive evaluator에서 읽을 export가 없음
- eta grid는 연속 dual 최적값의 증명이 아니라 표본

후속 연구에서는 성공확률 gate와 recorded-policy action export를 추가하고 122개 root를
다시 평가했습니다. 행동이 바뀐 2건 모두 exact interactive 평균 부담·총소모·키트별 고갈
공동 기준 중 하나를 위반했습니다. 현재 판정은
[`phase2-methodology-findings.ko.md`](./phase2-methodology-findings.ko.md)에 기록합니다.

## 후속 결정

rerank나 CVaR를 production에 다시 연결하지 않습니다.

후속 연구에서 probability gate와 research action export를 구현했지만 제품 기준을 통과한
후보는 없었습니다. 현재 min-E[f]와 phase2 fallback 정책을 유지합니다.

## 산출물 역할

- 분류 실행 계약은 `benchmarks/rerank-quality.ts`가 소유합니다.
- 대표 행동 회귀는 benchmark spec이 보호합니다.
- 캠페인 실행·직렬화 계약은 runner가 소유합니다.
- 이 문서는 연구 해석의 추적 기록입니다.
- gitignored `benchmarks/results/` JSON은 특정 실행의 재생성 가능한 원시 결과입니다.
