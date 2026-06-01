# A 기준선 실행 가능성 검증 결과

영문 원본: [`BASELINE_FINDINGS.md`](./BASELINE_FINDINGS.md)  
분석 일자: 2026-05-27

## 결론

현재 제품 정책 A에 대한 필수 **exact interactive-replan 실행 가능성 검증**이
완료되었습니다. 필수 sentinel 5개 모두에서 기존 probability gate의 내부 위반과
경계 위반이 0건이었습니다.

이 결과는 B/C 연구 후보를 비교 평가할 수 있다는 의미입니다. A를 다른 정책으로
교체해도 된다는 승인 결과는 아닙니다.

## 평가기가 의미하는 것

평가기에서는 근사 없이 다음 흐름을 계산합니다.

- 관측 가능한 결과가 발생할 때마다 남은 실제 재고 상태에서 solver를 다시 실행합니다.
- 확률이 0인 분기는 exact 결과에 기여하지 않으므로 건너뜁니다.
- 중단된 실행은 통과가 아니라 `verification_incomplete`로 처리합니다.

## 완료된 필수 기준선 결과

| 시나리오 | 실제 계산 시간 | 경계 solve 횟수 | 성공 확률 | Interactive F | Gate 위반 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `R0-balanced300` | 609,777 ms | 39,564 | 0.9999999999999998 | 0.024659813280066945 | 0 |
| `SR0-balanced300` | 135,848 ms | 14,672 | 0.9999999999999998 | 0.026706662774961247 | 0 |
| `R0-balanced100` | 18,919 ms | 2,516 | 0.9078240851567179 | 0.35691614548825096 | 0 |
| `SR0-balanced100` | 3,126 ms | 937 | 0.8691509913512931 | 0.38639717112739064 | 0 |
| `R14e900-yellow30` | 197 ms | 111 | 0.5814477455800285 | 0.452573837916863 | 0 |

총 실제 계산 시간은 `767,867 ms`, 약 12분 48초입니다.

완료 manifest는 커밋 대상이 아닌
`benchmarks/results/a-feasibility.checkpoint.json`에 생성됩니다. 이 checkpoint는
근사 결과가 아니라 이미 완료된 경계 정책과 하위 결과를 저장한 재개용 데이터입니다.

## 검증 범위

명시적 benchmark 테스트는 다음을 다룹니다.

- 96개 안전 시나리오 그리드의 형태와 필수 sentinel 식별자
- 저비용 sentinel `R14e900-yellow30`의 exact interactive-replan 완료
- evaluator 예산 소진 시 `verification_incomplete` 보고
- 96개 A root-policy 시나리오의 probability gate audit
- 결정적 interactive trajectory 수집과 tail summary 기본 기능
- paired bootstrap 및 Holm-Bonferroni tail 통계 기본 기능

실행 명령:

```powershell
& "C:\Program Files\nodejs\npm.cmd" run test:bench
```

## 재개 가능한 exact 실행

필수 sentinel 계산은 다음 명령으로 30초 단위로 이어서 수행할 수 있습니다.

```powershell
& "C:\Program Files\nodejs\npm.cmd" run bench:a-feasibility:slice
```

기존 checkpoint를 버리고 처음부터 시작하려면:

```powershell
$env:A_FEASIBILITY_RESET = "1"
& "C:\Program Files\nodejs\npm.cmd" run bench:a-feasibility:slice
Remove-Item Env:A_FEASIBILITY_RESET
```

## 이후 판단

A 기준선은 통과했으므로 B/C 연구 후보 평가가 진행되었습니다. 실제 제품 교체는
후보가 exact interactive-replan 비교, probability gate 위반 0건, tail-risk 및
성능 기준을 모두 통과할 때만 가능했습니다. B/C의 결과는
[`SHADOW_PILOT_FINDINGS.ko.md`](./SHADOW_PILOT_FINDINGS.ko.md)에 기록되어 있습니다.
