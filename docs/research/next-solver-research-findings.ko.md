# 차세대 solver·WebGPU 연구 결과

- 기준일: 2026-08-09
- 기준선: `H=0.75`, `p=3`, `tau=0`
- 범위: 연구 전용. 제품 solver, UI, Worker protocol, D1 schema는 변경하지 않음
- 최종 판정: 채택 후보 없음, 현재 Rust min-E[f] 및 phase2 유지

## 연구 계약

이번 연구는 기존 알고리즘보다 좋은 결과가 나올 가능성을 부정하지 않는다. 대신 각 후보를 같은
정확성·품질·성능 계약 아래에서 단계적으로 검사하고, 선행 게이트가 실패하면 뒤 단계의 복잡한 구현을
시작하지 않는 방식으로 범위를 닫았다.

- `[확인]` 제품에 쓰는 최종 행동·확률·비용 값은 CPU의 f64 exact 평가가 소유한다.
- `[확인]` WebGPU는 정수 상태 전개와 중복 제거만 수행하며 확률이나 비용을 계산하지 않는다.
- `[확인]` raw pieces는 availability-cost 분모에 보존되고, bounded uses만 compact key에 사용된다.
- `[확인]` tiny complete-policy oracle과 실제 Rust WASM parity test가 compact exact DP를 검증한다.
- `[추론]` 작은 fixture 통과는 제품 범위의 완전성이나 성능을 증명하지 않는다.

## 공통 기반

`compact-exact-graph.ts`는 재고 총 사용 횟수가 매 전이에서 정확히 1씩 줄어드는 DAG를 만든다.
R15는 SR5로 canonicalize하며, 모든 가능한 행동의 성공·실패 edge를 저장한다. 역순 Bellman 평가는
현재 min-E[f]의 성공확률 gate, 비용, 총소모 tie-break를 그대로 사용한다.

- `[확인]` `SR10e2900 / 30·30·30`에서 compact DP와 제품 Rust WASM의 행동, 성공확률,
  최대 성공확률, 기대비용, 소비 vector 3축이 일치했다.
- `[확인]` 4상태 tiny graph의 결정적 정책 3개를 전수열거한 결과도 compact DP root와 일치했다.
- `[확인]` graph budget 초과, 수치적으로 행동을 인증할 수 없는 경우, 장치 미지원은 typed outcome으로
  fail-closed 처리된다.

## 후보별 결과

| 후보 | 실행 상태 | 판정 | 핵심 근거 |
| --- | --- | --- | --- |
| Complete policy enumeration | 완료 | 연구 oracle 통과 | 4상태, 3정책 전수열거가 exact DP와 일치. 제품 후보는 아님 |
| LP/column-generation oracle | 불완전 | `verification_incomplete` | 4상태 occupancy MPS(변수 3, flow row 1)는 생성했으나 HiGHS 실행 파일 부재 |
| WebGPU compact exact hybrid | 완료 | `rejected` | 작은 key-set parity는 통과했지만 R10 graph가 120만 상태 상한 초과 |
| Certified limited depth | 완료 | `rejected` | R10·SR0에서 depth 1/2/4/8 모두 root 행동을 인증하지 못함 |
| AO*/BRTDP | 선행 게이트 중단 | `rejected` | admissible interval이 대표 root를 분리하지 못해 구현 시작 조건 불충족 |
| Pareto-frontier DP | 완료 | `rejected` | 작은 graph에서도 p95 frontier 폭 184로 사전 상한 32 초과 |
| Monotonicity/threshold proof | 표본 검사 완료 | `verification_incomplete` | 표본 반례 0건이지만 전역 증명은 아님 |
| Symbolic decision diagram | 완료 | `rejected` | 127상태가 127 exact partition으로 남아 압축률 0% |
| GPU rollout MCTS | 선행 게이트 중단 | `rejected` | exact WebGPU 경로가 상태 상한을 통과하지 못함 |
| Distributional chance constraint | 선행 게이트 중단 | `rejected` | Pareto 표현의 폭 게이트 실패 |
| Adaptive H/p robust risk | 선행 게이트 중단 | `rejected` | distributional 후보의 선행 게이트 실패 |

`complete_policy_enumeration`의 “통과”는 후속 연구용 oracle로 쓸 수 있다는 뜻이다. 제품에 넣을
알고리즘이라는 뜻이 아니며, 그래서 제품 등급과 `prerequisitePassed`를 별도 필드로 기록한다.

## WebGPU 실측

데스크톱 real Chrome 151, AMD RDNA 2에서 실행했다.

- `[확인]` 127상태·144 edge fixture의 선택 layer 12개 key를 CPU와 GPU가 전개했고, 정렬된
  출력 24개가 정확히 일치했다.
- `[확인]` setup 395.7ms, allocation-warm p50 2.5ms, p95 3.5ms였다.
- `[확인]` `R10-balanced300` census는 37개 layer, 누적 1,162,033상태, 최대 frontier 87,690에서
  다음 layer가 사전 등록한 1,200,000상태 상한을 넘으므로 `budget_exceeded`로 종료했다.
- `[확인]` census 시간은 937.0ms였다.
- `[추론]` GPU 전개 자체는 동작하지만, 현재 exact graph 표현은 CPU f64 Bellman 단계에 도달하기
  전에 용량 게이트를 실패한다. 결과를 보고 상한을 올리지 않았으며 제품 후보로 진행하지 않았다.
- `[미검증]` 위 지연은 한 PC의 screening 수치이며 사용자 지연 분포가 아니다.

Android smoke runner도 구현했지만 연결된 SM-G781N의 Android user 0에서 설치된 Chrome 147
패키지에 해석 가능한 VIEW activity가 없었다. 기본 Samsung Internet을 Chrome 증거로 대체하지 않았다.
따라서 Android WebGPU는 `device_unavailable`이며 실제 key-set·device-loss 검증은 미완료다.

## 제한 깊이·구조 후보 실측

### Certified limited depth

- `[확인]` 종료에 가까운 `SR14e2900 / 10·10·10`은 depth 1부터 인증됐다.
- `[확인]` `R10-balanced300`은 depth 8에서 2,640상태를 전개하고도 `numeric_ambiguous`였다.
- `[확인]` `SR0-balanced300`은 depth 8에서 2,662상태를 전개하고도 `numeric_ambiguous`였다.
- `[추론]` 현재의 보수적 interval은 대표 fallback root에서 AO*/BRTDP를 유도할 만큼 좁지 않다.

### Pareto·단조성·symbolic

- `[확인]` 127상태 fixture의 Pareto vector 총수는 3,883, p50 폭 1, p95 폭 184,
  최대 및 root 폭 756이었다. 사전 상한 p95 32를 넘었다.
- `[확인]` `SR14e2900`, `R14e900`에서 각 kit 재고를 0~12 uses로 변화시키고 다른 두 kit를
  4 uses로 고정한 표본에서는 성공확률 단조성 위반과 행동 재진입 패턴이 없었다.
- `[미검증]` 이 표본 결과는 모든 state·재고에 대한 threshold 구조의 증명이 아니다.
- `[확인]` exact transition+value partition은 127개로, 원래 상태 127개와 같았다. 압축률은 0%이고
  exact value mismatch도 0건이었다.

## 제품 판단

- `[확인]` 채택된 후보는 없다.
- `[확인]` 제품 runtime, `public/solver_rs.wasm`, 공개 API, UI, Worker, D1, telemetry를 변경하지 않았다.
- `[추론]` WebGPU가 계산을 빠르게 할 수 없다는 결론은 아니다. 이번 exact graph 계약과 120만 상태
  상한 아래에서 제품 범위를 넓히지 못했다는 결론이다.
- `[추론]` AO*/BRTDP, MCTS, distributional, adaptive H/p를 구현하지 않은 것은 누락이 아니라
  사전 등록한 선행 게이트의 중단 규칙을 적용한 결과다.
- `[미검증]` 더 강한 admissible bound, 다른 exact state representation, 실제 Android Chrome,
  외부 HiGHS solver는 새 protocol의 후속 연구가 필요하다.

## 관련 기록

- Phase2 내부 방법론과 bounded 후보: [`phase2-methodology-findings.ko.md`](./phase2-methodology-findings.ko.md)
- Phase2 단계별 증거 원장: [`phase2-next-research-ledger.ko.md`](./phase2-next-research-ledger.ko.md)
- H/p 공동 최적화 결과: [`min-ef-hp-study-findings.ko.md`](./min-ef-hp-study-findings.ko.md)

## 재현 명령

```powershell
npm run test:bench
npm run bench:next-solver:lp-oracle
npm run bench:next-solver:webgpu-frontier
npm run bench:next-solver:webgpu-android
npm run bench:next-solver:limited-depth
npm run bench:next-solver:structure
npm run bench:next-solver:finalize
```

원시 report는 `benchmarks/results/`에 생성되며 gitignored다. tracked 코드에는 후보 계약, 실행기,
검증 테스트와 이 findings만 남긴다.
