# Rust min-E[f] H/p 공동 최적화 연구

- 생성 시각: 2026-08-05T13:14:59.246Z
- 기준점: `H0.75-p3`, tau=0
- 범위: 연구 전용, 제품 채택 자동 승인 없음

## 증거 계보

| 자료 | 의미론 | 이번 판정에서의 역할 |
| --- | --- | --- |
| `6dcb329` availability 연구 | 과거 solver·재고 계약 | 역사적 선행 증거만 사용, 수치 합산 안 함 |
| 현재 `min-ef-hp-study` v1 | raw pieces, 현재 WASM, min-E[f]→phase2 ladder | 현재 판정의 유일한 수치 근거 |

## 기준선과 screening

- [확인] Baseline 동치 검증: passed (raw remainder min-E[f] root is bit-identical to the current product wrapper; R0-balanced300 falls back from min-E[f] tier 21 to bit-identical phase2 tier 22; exact interactive evaluation preserves R15 to SR5 conversion)
- [확인] Root screening: 5978/5978
- [확인] Shortlist 16개: `H1.25-pinf`, `H0.875-pinf`, `H1.25-p6`, `H1.25-p4`, `H0.875-p6`, `H0.75-pinf`, `H1-p4`, `H1.25-p3`, `H0.5-pinf`, `H0.75-p4`, `H1-p3`, `H0.75-p3`, `H0.5-p3`, `H0.75-p2`, `H0.25-p3`, `H0.75-p1`
- [확인] Root screening은 후보 축소용이며 사용자 체감 지연 분포가 아닙니다.

## Exact interactive

- [확인] Terminal record: 176/176
- [확인] 완료 176, solver failure 0, checkpoint 대기 0
- [확인] Hard-gate 결과: 통과 57, 탈락 119, 판정 불완전 0
- [확인] Tail 진입 후보: `H0.75-p3`, `H0.5-p3`

## Tail·D1·성능

- [확인] Tail discovery 판정 1건, 통과 0건, confirmation record 0건
- [확인] `H0.5-p3`는 `R0-balanced150`에서 CVaR90 76.4861→85.9952일, 개선량 -9.5091일로 Holm 보정 후 유의하게 악화했습니다.
- [확인] D1 snapshot (diagnostic v6, 818 events); 후보 replay 판정 0건
- [확인] 독립 성능 record 0건
- [추론] Tail discovery 통과 후보가 없어 D1 후보 replay와 성능 캠페인은 실행하지 않았습니다.
- [추론] D1 이벤트는 반복 계산 이벤트이며 사용자 수나 실제 사용자 비율로 해석하지 않습니다.

## 후속 adaptive H/p 판정

- [확인] 차세대 solver 연구는 H/p를 경로별·분포별로 바꾸는 adaptive 후보의 선행조건으로
  distributional state representation을 요구했습니다.
- [확인] 해당 선행 Pareto 표현은 작은 exact graph에서도 p95 frontier 폭 184로 사전 상한 32를
  초과해 adaptive H/p 구현을 시작하지 않았습니다.
- [추론] 이는 현재 고정 `H=0.75, p=3` 판정을 강화하지만, 모든 가능한 adaptive 규칙의 열등성을
  증명하지는 않습니다. 상세 내용은
  [`next-solver-research-findings.ko.md`](./next-solver-research-findings.ko.md)를 참고하세요.

## 판정

- `H1.25-pinf`: rejected
- `H0.875-pinf`: rejected
- `H1.25-p6`: rejected
- `H1.25-p4`: rejected
- `H0.875-p6`: rejected
- `H0.75-pinf`: rejected
- `H1-p4`: rejected
- `H1.25-p3`: rejected
- `H0.5-pinf`: rejected
- `H0.75-p4`: rejected
- `H1-p3`: rejected
- `H0.5-p3`: rejected
- `H0.75-p2`: rejected
- `H0.25-p3`: rejected
- `H0.75-p1`: rejected

- [추론] 최종 상태: keep_baseline
- [추론] 선택 후보: `H0.75-p3`
- [확인] 이 보고서는 runtime 상수 변경을 승인하지 않습니다.

모든 필수 게이트가 끝나지 않았거나 baseline과 통계적으로 구분되는 이득이 없으면 현재 제품값 H=0.75, p=3을 유지합니다.
