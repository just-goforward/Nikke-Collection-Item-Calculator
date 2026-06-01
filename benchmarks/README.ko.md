# Solver 동적 수급 압박 연구

영문 원본: [`README.md`](./README.md)

## 결론부터

현재 검토한 후보 모델 B/C에 대해서는 **제품 채택 여부를 판단하는 데 필요한 절차가
종료되었습니다.**

| 항목 | 상태 |
| --- | --- |
| 현재 모델 A의 exact interactive-replan 기준선 검증 | 완료, 통과 |
| 후보 B/C 연구용 구현 및 pilot 평가 | 완료 |
| 후보 B/C의 제품 기본 정책 대체 여부 | 기각 |
| B/C 연구 당시 제품용 `solve()` 동작 변경 | 없음 |
| B/C 연구 당시 `solverVersion` 변경 | 없음 |

이는 동적 수급 압박 연구 전체가 영구 종료되었다는 뜻은 아닙니다. 새로운 후보 모델을
설계하면 동일한 기준에 따라 새 평가가 필요합니다.

## 연구 대상

연구 당시 활성 정책이었던 `phase1_availability_pnorm`은 가상 경로를 계산할 때 경로 진입 시점의
가용량을 기준으로 수급 비용을 평가합니다. 이 연구는 같은 경로 안에서 특정 키트를
계속 소비할 때 수급 압박이 커지는 효과를 반영하는 후보가 제품 정책을 대체할 가치가
있는지 검토합니다.

| 모델 | 의미 |
| --- | --- |
| A | 연구 당시 제품 정책: `phase1_availability_pnorm` |
| B | A 결과를 바탕으로 가격을 한 번 보정하는 `single-update shadow-price` |
| C | 반복 보정, cycle 감지, timeout, A fallback을 포함한 `bounded fixed-point shadow-price` |

## 평가 방식

평가는 UI의 실제 흐름에 맞춘 **exact interactive-replan** 방식입니다.

- 기록된 결과가 발생할 때마다 남은 실제 재고에서 다시 계산합니다.
- 다회 추천의 성공은 실제 성공 회차 확률대로 분기합니다.
- 종료되지 않은 다회 성공 뒤에는 사용자가 결과 재고를 정확히 입력한다고 가정합니다.
- 성공 확률은 Monte Carlo 추정이 아니라 exact evaluator 결과로 비교합니다.
- 내부 및 경계 decision에서 기존 `max - 0.01` probability gate 위반이 없어야 합니다.

결정적 안전 시나리오 그리드는 총 96개입니다.

- 균등 재고 회귀 보호 시나리오: 24개
- 희소 또는 편중 재고 개선 시나리오: 72개

비용이 큰 시나리오는 제한 시간 내 평가가 끝나지 않을 수 있습니다. 이 경우 결과는
`verification_incomplete`이며 통과로 취급하지 않습니다.

## 이번 평가가 종료된 이유

A 기준선 검증이 통과한 뒤 B/C를 pilot 평가했습니다. B/C는 저비용 결정적 exact
시나리오에서 이미 필수 채택 조건을 위반했습니다.

- B는 일부 시나리오에서 제품 목적 함수인 interactive `F`를 악화시켰습니다.
- B와 C는 일부 시나리오에서 A보다 exact 성공 확률을 낮췄습니다.
- probability gate 위반은 없었지만, 그것만으로 제품 채택 조건을 충족하지 않습니다.

따라서 현재 정의의 B/C에 대해서는 더 비싼 전체 그리드 tail-risk 평가나 D1 가중
우선순위 분석을 실행해도 기각 결론을 뒤집을 수 없습니다. 이 작업들은 평가 누락이
아니라, 필수 조건을 통과한 새 후보가 있을 때 수행할 후속 단계입니다.

## 실행 명령

빠른 benchmark 회귀 테스트:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run test:bench
```

A 기준선 exact evaluator의 이어서 실행 가능한 slice:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run bench:a-feasibility:slice
```

Shadow-price root pilot 및 exact interactive pilot:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run bench:shadow-pilot
& "C:\Program Files\nodejs\npm.cmd" run bench:shadow-exact-pilot
```

## 상세 결과 문서

- A 기준선 검증 결과: [`BASELINE_FINDINGS.ko.md`](./BASELINE_FINDINGS.ko.md)
- B/C 후보 기각 결과: [`SHADOW_PILOT_FINDINGS.ko.md`](./SHADOW_PILOT_FINDINGS.ko.md)

생성된 원시 결과와 checkpoint는 `benchmarks/results/` 아래 저장되며 커밋하지 않습니다.
