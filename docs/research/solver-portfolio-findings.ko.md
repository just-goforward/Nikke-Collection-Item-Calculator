# 조건부 Solver Portfolio 연구 결과

- 실행일: 2026-08-11
- 기준 커밋: `7e3d07130568e6312590b825dfcd1d2213dcbab3`
- 제품 기준선: `rust-min-ef` tier 21 → capacity 실패 시 `rust-phase2` tier 22
- 범위: 연구 전용. 제품 runtime, WASM, UI, Worker protocol, D1 schema는 변경하지 않음

## 결론

현재 소장품 상태와 키트 재고를 보고 처음부터 다른 solver를 고르거나, min-E[f] 실패 뒤 exact
solver를 하나 더 시도하는 방식은 **이번에 고정한 후보와 조건에서는 제품 기준을 통과하지
못했습니다.** 따라서 현재의 동적 ladder를 유지합니다.

- `[확인]` Branch-and-bound B2는 capacity 실패 root 25건 중 24건을 exact로 구제했습니다.
- `[확인]` 그러나 held-out validation에서 tier 21 실패 뒤 B2를 실행한 전체 경로의 지연 기준은
  9건 중 0건만 통과했습니다.
- `[확인]` 정적 조건으로 처음부터 tier 22 min-E[f]를 고른 방식은 조건 일치 8건 중 7건만
  exact 완료, 현재 provenance 실행에서는 7건이 지연 기준을 통과했습니다.
- `[확인]` 조건부 tier 22가 실패한 최악 경로의 합산 WASM memory growth는 425.375MiB였고,
  tier 21 실패까지 먼저 확인한 변형은 540.25MiB였습니다.
- `[판정]` exact interactive, 브라우저, Android 게이트는 root completion·latency·memory 선행
  게이트를 통과한 finalist가 없어 실행하지 않았습니다.

이 판정은 “상태별 solver 선택이라는 발상이 수학적으로 불가능하다”는 증명이 아닙니다. 현재
코드에서 계산 전에 얻을 수 있는 grade·level·EXP·재고만으로 만든 단순 규칙이 held-out 경계에서
일반화되지 않았다는 뜻입니다.

## 연구 질문

다음 세 가지를 분리해 확인했습니다.

1. min-E[f] tier 21이 실패한 뒤 더 큰 exact solver를 시도하면 phase2보다 좋은 정책을 얻을 수 있는가?
2. 상태·재고 조건으로 capacity 실패를 미리 예측해 tier 21 실패 비용을 생략할 수 있는가?
3. Branch-and-bound 또는 bounded prioritized phase2가 이 조건부 경로의 비용을 감당할 수 있는가?

성공확률·목적함수 의미론과 실행 비용을 섞지 않았습니다. Exact completion이 늘어도 지연이나
메모리가 제품 기준을 넘으면 채택하지 않았고, root가 좋아 보여도 exact interactive까지 자동으로
승격하지 않았습니다.

## 후보와 사전 조건

| 후보 | 실행 위치 | 목적 |
| --- | --- | --- |
| 등급별 exact rescue | tier 21 capacity 실패 뒤 | R은 min-E[f] tier 22, SR은 B2 tier 22 |
| 조건부 tier 22 rescue | tier 21 capacity 실패 뒤 | 성공 가능성이 높은 R 상태만 exact 재시도 |
| 직접 tier 22 | 첫 solve 시작 전 | 예측된 실패 비용을 생략 |
| B2 exact rescue | 모든 capacity 실패 뒤 | 일반 min-E[f]가 못 푼 root 구제 |
| Bounded prioritized phase2 | SR capacity 실패 뒤 | exact보다 제한된 상태에서 phase2 정책 개선 |

개발·confirmation 결과로 만든 정적 조건은 다음과 같습니다.

```text
R 등급
레벨 7 이하
총 재고 600 pieces 이상
그리고 다음 중 하나:
  - 모든 키트가 220 pieces 이하
  - 최소 재고 × 2 <= 최대 재고
```

이 규칙은 결과를 본 뒤 만든 탐색 규칙이므로 같은 자료에서 제품 성능을 주장하지 않았습니다.
`R2/R6/R8`, 205/225, 정확히 절반/절반 직전, 총 599/601 경계를 조합한 새 24개 validation
시나리오에서 별도로 판정했습니다.

## 데이터와 정확성

| 집합 | 시나리오 | tier 21 capacity 실패 | 역할 |
| --- | ---: | ---: | --- |
| Discovery | 122 | 5 | 기존 fixed·supplemental·product-observed 탐색 |
| Confirmation | 48 | 11 | 사전에 고정한 중간 R/SR 상태와 신규 재고 조합 |
| Routing validation | 24 | 9 | 정적 조건의 경계 및 직접 routing 검증 |

- `[확인]` Discovery+confirmation의 공통 exact 완료 영역에서 일반 min-E[f] tier 22와 B2는
  action, success/max-success, expected-cost, 기대소모 vector가 10/10 bit 동치였습니다.
- `[확인]` validation의 공통 exact 완료 2건도 2/2 동치였습니다.
- `[확인]` B2의 maximum-success prepass mismatch는 0건이었습니다.
- `[확인]` tier 21이 정상 완료한 상태에서 직접 tier 22도 완료한 공통 5건은 5/5 의미론이
  동일했습니다. 즉 tier를 키우는 것 자체가 추천 규칙을 바꾸지는 않았습니다.

## Root 결과

### Discovery와 confirmation

| 항목 | 결과 |
| --- | ---: |
| 전체 root | 170 |
| tier 21 capacity 실패 | 16 |
| 등급별 exact rescue 완료 | 12/16 |
| 등급별 전체 경로 지연 기준 통과 | 5/16 |
| B2 완료 | 15/16 |

등급만으로 R과 SR을 나누는 규칙은 confirmation에서 일반화되지 않았습니다. B2는 완료율은 높였지만
모든 입력에서 빠르지 않았습니다.

### Held-out routing validation

| 경로 | 완료 | root 지연 통과 | 최대 memory growth |
| --- | ---: | ---: | ---: |
| 현재 ladder, capacity 실패 9건 | 9/9 | 기준선 | 311.375MiB |
| 조건부 tier 22, 실패 확인 뒤 | 2/3 | 2/3 | 540.25MiB |
| 조건부 tier 22, 처음부터 직접 | 7/8 | 7/8 | 425.375MiB |
| B2, 실패 확인 뒤 | 9/9 | 0/9 | 407.75MiB |

이 표의 지연 값은 route별 단일 실행 screening입니다. 직전 provenance 실행에서는 직접 경로의
지연 통과가 6/8이었고 현재 재실행에서는 7/8이어서, 반복 캠페인 없이 실제 사용자 지연 분포로
일반화할 수 없습니다. 다만 8건 중 1건의 exact 완료 실패와 큰 memory growth만으로도 제품
선행 gate는 통과하지 못합니다.

`R2 / 360·300·180`은 정적 조건에 일치했지만 tier 22 min-E[f]도 `MEMO_FULL`이 되어 phase2까지
실행했습니다. 이 직접 경로는 현재 ladder보다 약 21% 느렸고 memory growth가 약 311MiB에서
425MiB로 증가했습니다.

반대로 tier 21이 정상 완료한 `R6 / 301·150·150`에서는 직접 tier 22가 같은 정책을 냈지만 현재
단일 screening 지연이 약 2% 늘고 min-E[f] memory growth가 약 115MiB에서 229MiB로 증가했습니다.
따라서 오예측은 결과 정확성을 해치지 않더라도 모바일 메모리와 지연 비용을 만듭니다.

`[추론]` tier 21 실패 비용을 반사실적으로 완전히 제거하고 B2 solve 시간만 사용해도 validation
지연 기준을 통과하는 경우는 3/9였습니다. 즉 완벽한 capacity 예측기가 생겨도 현재 B2가 모든
고재고 fallback의 기본 exact solver가 되지는 않습니다.

## 독립 후보 증거

### Branch-and-bound B2

현재 artifact에서 31회 ABBA allocation-warm 캠페인을 재사용했습니다.

- 작은 semantic fixture: 의미론 동치, B2 p95 `139.61ms`, 제품 p95 `199.81ms`
- `R0 / 250·250·250`, tier 22: 의미론 동치지만 B2 p95 `3042.48ms`, 제품 p95
  `1576.39ms`, 허용 한계 `1812.85ms`

`[판정]` B2는 pruning 효과가 있는 상태가 있지만 큰 fallback 상태 전체에서 일관되게 빠르지
않습니다.

### Bounded prioritized phase2

기존 독립 연구의 현재 artifact hash와 이번 screening artifact가 일치하는지 검증했습니다.

- `[확인]` `R10-balanced300` exact interactive에서 F, 총 사용량, blue 고갈 확률이 악화되어
  품질 gate를 통과하지 못했습니다.
- `[확인]` 반복 latency 캠페인도 R10과 SR0에서 gate를 통과하지 못했습니다.
- `[확인]` candidate WASM은 `133089B`로 `115000B` 제품 예산을 초과했습니다.

SR 한 시나리오의 개선 신호만으로 전체 fallback routing을 바꿀 수 없으므로 이번 portfolio의
finalist로 승격하지 않았습니다.

## 왜 Android를 실행하지 않았는가

Android 13 ADB 기기는 사용할 수 있었지만, 계획상 모바일은 Node root·품질·성능 선행 게이트를
통과한 candidate의 생존성과 실제 ARM64 비용을 확인하는 마지막 단계입니다. 이번 후보들은 그 전에
모두 기각됐습니다. 기각된 후보를 기기에서 실행해도 제품 채택 판정은 바뀌지 않고, 낮은 사양·32비트
Android를 대표하지도 않으므로 실행하지 않았습니다.

## 소비자와 관리자 관점

소비자 관점에서는 사이트 동작이 바뀌지 않습니다. 현재 ladder는 보통 입력에서 정확한 min-E[f]를
사용하고, 용량 한계에서 phase2로 복구해 응답 가능성을 우선합니다. 조건부 exact를 추가하면 일부
입력의 정책은 개선될 수 있지만, 다른 입력에서는 대기시간과 메모리만 크게 늘어나는 문제가
held-out에서 재현됐습니다.

관리자 관점에서는 “특정 입력에서 B2가 완료했다”를 제품 조건으로 오해하지 않게 됐습니다. 제품
후보가 되려면 최소한 다음 중 하나가 새로 필요합니다.

- tier 21 capacity 실패를 값싸고 검증 가능하게 예측하는 prepass
- 실패한 tier 21 memo를 버리지 않고 tier 22로 확장·재개하는 구조
- B2의 hard-state p95를 줄이는 더 강하고 값싼 admissible bound

이 중 어느 것도 이번 코드에 구현돼 있지 않으므로 현재 ladder를 유지합니다.

## 재현과 산출물

```powershell
npm run build:solver-wasm:branch-bound
npm run build:solver-wasm:sparse-pi
npm run bench:solver-portfolio
npm run bench:solver-portfolio-routing
npm run bench:solver-portfolio-finalize
```

대량 JSON과 candidate WASM은 `benchmarks/results/`, `output/`에 있으며 gitignored입니다. 추적되는
자산은 계약, 시나리오, runner, 검증 코드와 이 findings입니다. 최종화 스크립트는 측정에 사용된
source와 artifact SHA가 현재 파일과 일치하지 않으면 중단합니다.
