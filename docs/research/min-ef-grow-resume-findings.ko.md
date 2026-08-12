# min-E[f] Memo Grow-and-Resume 연구 결과

- 실행일: 2026-08-12
- 기준 커밋: `7e3d07130568e6312590b825dfcd1d2213dcbab3`
- 제품 기준선: `rust-min-ef` tier 21 -> capacity 실패 시 `rust-phase2` tier 22
- 연구 계약: `H=0.75`, `p=3`, `tau=0`, min-E[f] node budget 4,000,000
- 범위: 연구 전용. 제품 runtime, WASM, UI, Worker protocol, D1 schema는 변경하지 않음

## 결론

Grow-and-resume 후보는 tier 21 memo가 가득 찼을 때 이미 계산한 항목을 tier 22 memo로 옮기고
같은 exact min-E[f] 탐색을 이어가는 방식이다. 처음부터 tier 22 exact solve를 다시 시작하는 것보다
네 hard fixture에서 p50이 31.7%~41.6% 짧았고, 공통 완료 24건의 결과는 fresh tier 22와 모두
bit-identical했다.

그러나 현재 제품의 phase2 fallback과 비교한 hard gate에서 `R10-balanced300`의 전체 경로 p95가
901.883ms에서 1,222.216ms로 35.5% 증가했다. 사전 기준은 모든 hard fixture가
`max(+15%, +50ms)` 안에 들어와야 한다는 것이므로 후보를 제품에서 기각했다.

- `[확인]` root 선행 gate는 정확성, 완료율, memory, WASM 크기 조건을 모두 통과했다.
- `[확인]` 반복 성능 4건 중 3건은 현재 ladder보다 빨랐고 1건은 p95 기준을 실패했다.
- `[판정]` exact-interactive, 브라우저, Android 단계는 성능 선행 gate 실패로 실행하지 않았다.
- `[판정]` candidate feature, ABI, build/runner 코드는 제거했고 제품 WASM은 바꾸지 않았다.
- `[추론]` 재시작을 피하는 구조는 유효하지만, 현재 phase2를 대체할 만큼 일관되게 빠르지는 않다.

## 구현 원리

기존 exact 재시도는 다음 순서다.

```text
tier 21 탐색 -> MEMO_FULL -> 새 tier 22 instance -> 처음부터 exact 재계산
```

후보는 다음처럼 동작했다.

```text
tier 21 탐색 -> MEMO_FULL -> tier 22 할당 -> 기존 entry rehash -> 중단 지점부터 재개
```

Packed memo key를 `(state, blue, purple, yellow)`로 되돌려 새 hash table에 삽입했다. 계산된 값을
버리지 않으므로 exact 재시작 비용을 줄일 수 있지만, 약 183만 entry를 옮기는 rehash와 두 memo가
잠시 공존하는 memory 비용이 생긴다.

## Root Screening

Discovery 122건, confirmation 48건, 기존 routing validation 24건, 새 held-out 24건을 합친
218개 root를 사용했다.

| cohort | root | tier 21 capacity 실패 | resume 완료 | fresh tier 22 완료 | bit parity |
| --- | ---: | ---: | ---: | ---: | ---: |
| Discovery | 122 | 5 | 2 | 2 | 2/2 |
| Confirmation | 48 | 11 | 8 | 8 | 8/8 |
| Validation | 24 | 9 | 7 | 7 | 7/7 |
| Held-out | 24 | 11 | 7 | 7 | 7/7 |
| 합계 | 218 | 36 | 24 | 24 | 24/24 |

Bit parity는 선택 action, success/max-success, expected-cost, 기대 소비 vector 3축과 root 후보별
validity/success/vector/cost 전체를 비교했다. 12건은 resume와 fresh tier 22가 모두 capacity 안에서
완료하지 못했다.

- `[확인]` rehash 시간은 135.7~152.8ms였다.
- `[확인]` rehash한 entry는 1,834,748~1,834,869개였다.
- `[확인]` resume 중 기존 memo hit는 114,115~7,543,691회였다.
- `[확인]` 36개 capacity 실패 모두 fresh tier 22 대비 +16MiB memory gate를 통과했다.
- `[확인]` 최대 추가 page growth는 15,597,568B(약 14.88MiB)였다.
- `[확인]` candidate WASM은 106,140B로 115,000B budget 안이었다.

## 반복 성능

각 팔은 fresh process에서 ABBA 순서로 31회 측정했다. `candidate combined`는 tier 21 실패,
rehash, resume를 합친 시간이다. `restart exact`는 tier 21 실패 뒤 fresh tier 22 exact solve를 다시
시작한 경로이고, `current ladder`는 tier 21 실패 뒤 phase2로 복구하는 제품 경로다.

| fixture | candidate p50 | restart exact p50 | restart 대비 | candidate p95 | current ladder p95 | current 대비 | 판정 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `R10-balanced300` | 1,127.910ms | 1,695.087ms | -33.5% | 1,222.216ms | 901.883ms | +35.5% | 실패 |
| `confirm-R3e400-balanced220` | 1,012.483ms | 1,588.572ms | -36.3% | 1,064.173ms | 1,845.071ms | -42.3% | 통과 |
| `validate-R2e300-balanced205` | 838.062ms | 1,434.421ms | -41.6% | 925.435ms | 1,723.175ms | -46.3% | 통과 |
| `grow-resume-R5e800-balanced260` | 1,252.226ms | 1,832.547ms | -31.7% | 1,310.219ms | 1,511.919ms | -13.3% | 통과 |

모든 반복에서 outcome과 semantic snapshot은 안정적이었다. 네 fixture 모두 fresh tier 22 재시작
대비 p50 20% 개선 조건과 resume 단독 p95 조건은 통과했다. 최종 기각 사유는
`R10-balanced300`의 현재 제품 ladder 대비 p95 하나다.

## Provenance와 보존 범위

| artifact | bytes | SHA-256 |
| --- | ---: | --- |
| 정리 후 제품 WASM | 99,937 | `7430c32ae5f3f7c8845c8390568e1f49dcd25c43c67bbda74adb61202c41a8df` |
| 임시 candidate 소스의 feature-off base | 99,937 | `9cdd43bb8360b73451fec7d66c0b80a96d7340384f2f17de0546851b84dec856` |
| grow/resume candidate | 106,140 | `9d95154b94972953db75fb378dc5647edd6b2ff2e353e1ec0624aad141cffb03` |
| root report | - | `ea0d6e8706dabfab9d76fa886c574cfb890c398942c40e89ee830ab837c6700a` |
| performance report | - | `daee1a7d8c5f2d8b21e4700605544e2a091d1690a2686d96bb1f5bba632da56a` |

임시 base는 candidate 소스에서 연구 feature만 끈 비교 팔이다. 정리 후 기본 feature로 다시 만든
제품 WASM은 Git의 기존 artifact와 동일해 diff가 없다. 로컬 report에는 기준 commit, dirty path,
source fingerprint, 파일별 hash, Node `v24.19.0`, Windows x64 환경이 기록돼 있다. 대량 JSON과
candidate WASM은 gitignored 로컬 결과이며, 기각된
candidate 구현과 전용 runner는 제품 저장소에 남기지 않았다. 재사용 가능한 218개 시나리오 계약,
gate 단위 테스트, packed memo-key 왕복 테스트와 이 findings만 추적한다.

## 한계

- `[미검증]` 성능 측정은 Windows x64 Node에서 수행했으며 브라우저와 실제 Android 분포가 아니다.
- `[미검증]` 성능 선행 gate 실패로 exact-interactive 품질과 브라우저/Android 생존성은 실행하지 않았다.
- `[미검증]` grow/resume라는 접근 전체가 불가능하다는 증명은 아니다. 이번 tier 21->22 rehash 구조와
  고정된 게이트에서 제품 phase2보다 일관된 이득을 내지 못했다는 판정이다.
