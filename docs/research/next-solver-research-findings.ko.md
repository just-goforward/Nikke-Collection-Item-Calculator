# 차세대 solver·플랫폼 연구 결과

- 기준일: 2026-08-09
- 기준선: Rust min-E[f] → Rust phase2 fallback, `H=0.75`, `p=3`, `tau=0`
- 범위: 연구 전용. 제품 solver, WASM, UI, Worker protocol, D1 schema는 변경하지 않음
- 최종 판정: 제품 채택 후보 없음. 현재 solver ladder 유지

## 결론

`[확인]` 사전 등록한 exact·근사·구조 압축·수학적 완화·WASM/WebGPU 후보를 순서대로
검사했지만, 현재 제품의 정확성·용량·품질·성능 조건을 모두 통과한 후보는 없었다.

이 결론은 “수학적으로 가능한 모든 알고리즘이 현재보다 나쁘다”는 증명이 아니다. 이번에 구현한
후보들이 각자의 중단 조건을 통과하지 못했다는 뜻이다. 새 제품 연구를 다시 시작하려면 더 강한
수학적 bound, graph를 만들기 전부터 적용 가능한 exact 표현, 명시적인 목적함수 변경, 또는 배포
환경 변경 중 적어도 하나의 새로운 근거가 필요하다.

## 증거 계약

- `[확인]` 제품 결과의 최종 행동·확률·비용은 CPU f64 exact 평가가 소유한다.
- `[확인]` raw pieces는 availability-cost 분모에 보존하고 bounded uses만 compact key에 쓴다.
- `[확인]` 각 후보는 `completed`, `budget_exceeded`, `numeric_ambiguous`, `device_unavailable`
  같은 typed outcome으로 종료한다.
- `[확인]` 생성된 대량 JSON/MPS/SOL은 `benchmarks/results/`에 두고 gitignore한다. tracked
  코드에는 재사용 가능한 계약·oracle·검증 테스트와 findings만 남긴다.
- `[추론]` 작은 fixture parity와 짧은 latency campaign은 제품 범위 전체나 사용자 지연 분포를
  증명하지 않는다.

캠페인 최종화 당시 원시 보고서의 kind, version, SHA-256과 판정을 대조했고 제품 변경 승인은
`runtimeChangeAuthorized: false`였다. 해당 최종화 산출물 자체는 영구 Git 자산이 아니다.

## 독립 exact oracle

`compact-exact-graph.ts`는 매 전이마다 총 재고 uses가 1 감소하는 DAG를 만들고, R15를 SR5로
canonicalize한다. 역순 Bellman 평가는 현재 min-E[f]의 성공확률 gate, availability cost,
총소모 tie-break를 유지한다.

- `[확인]` 4상태 tiny graph의 결정적 정책 3개를 전수열거한 root가 compact exact DP와 일치했다.
- `[확인]` HiGHS 1.14.0으로 최대 도달률 → 최소 기대비용 → 최소 기대 uses를 순서대로 푸는
  3단 occupancy LP를 실행했다.
- `[확인]` `SR14e2900-balanced10`(4상태/3 edge), `SR10e2900-balanced30`
  (127/144), `R14e900-balanced10`(21/18) 모두 action, 도달률, 비용, uses가 exact DP와
  허용 오차 안에서 일치했다.
- `[확인]` LP는 제품 알고리즘이 아니라 작은·중간 graph의 독립 정답 검사기다.

## 후보별 최종 판정

| 후보 | 판정 | 핵심 근거 |
| --- | --- | --- |
| Complete-policy enumeration | oracle 통과 | 4상태의 모든 정책을 전수열거해 compact DP와 일치 |
| HiGHS occupancy LP | oracle 통과 | 3개 fixture에서 3단 lexicographic 목적이 exact DP와 일치 |
| Layer-streaming exact DP | `rejected` | 논리 payload 72.46% 감소, 상태·edge 수와 hard capacity 실패는 동일 |
| Backward-distance exact pruning | `rejected` | hard fixture에서 capacity 도달 전 collapse된 상태 0개 |
| Strong admissible bounds | `rejected` | depth 8에서도 R10·SR0 root action을 비용 구간으로 인증하지 못함 |
| AO*/BRTDP | `rejected` | 사용할 수 있는 bound가 root 후보를 분리하지 못해 구현 선행 조건 실패 |
| Lagrangian relaxation·column generation | `rejected` | exact pricing의 successor closure가 full eligible graph 방향으로 폭증 |
| Global monotone threshold | `rejected` | exact 내부 정책에서 행동이 사라졌다 다시 나타나는 반례 13,679건 |
| Exact DAG abstraction | `rejected` | R10 압축 27.73%로 30% gate 미달, full graph 전개 후에만 구성 가능 |
| Certified approximation | `rejected` | 성공 regret는 0이지만 depth-16 비용 regret가 0.0934/0.1693 |
| Pareto/distribution compression | `rejected` | strict cover p95 폭 약 106, 사전 상한 32 초과 |
| Adaptive H/p risk | `rejected` | strict distribution gate 실패, 현재 H/p 연구도 baseline 유지 |
| WASM SIMD | `rejected` | bit parity 통과, WASM +197B, 두 warm speed gate 모두 실패 |
| WASM threads | `rejected` | COOP/COEP 부재, shared layout 없음, 독립 3 instance 약 344.8MiB |
| WebGPU integer frontier | `rejected` | 소형 parity 통과, hard exact graph가 120만 상태 상한 초과 |
| GPU rollout/MCTS | `rejected` | exact CPU 확인 전에 필요한 GPU 상태 경로의 용량 선행 gate 실패 |

## Exact 상태 공간 후보

### Layer streaming과 backward pruning

- `[확인]` layer streaming은 작은 fixture에서 bit-identical 결과를 내고 논리 payload를
  11,084B에서 3,052B로 줄였다.
- `[확인]` 그러나 `R10-balanced300`은 37개 layer, 1,162,033상태, 3,452,202 edge,
  최대 layer 폭 87,690에서 다음 layer가 1,200,000상태 상한을 넘었다.
- `[추론]` 저장 형식을 줄였을 뿐 계산해야 하는 상태 수를 줄이지 못했으므로 현재 hard failure를
  해결하지 않는다.
- `[확인]` 낙관적 최소 행동 수보다 재고 uses가 적은 상태를 정확히 0 도달률로 접는 backward
  pruning은 작은 fixture parity를 지켰지만 hard run에서 0개 상태만 제거했다.

### Strong bounds, AO*/BRTDP

- `[확인]` 무제한 색상 finite-horizon 도달률 upper bound, 고정 재고 schedule lower bound,
  불가피한 최소 사용 비용 lower bound, 보장 schedule upper bound를 구현했다.
- `[확인]` hard root의 성공확률 구간은 즉시 0폭으로 닫혔지만 비용 구간은 depth 8에서
  R10 `0.3067633`, SR0 `0.4516169` 폭으로 남았다.
- `[추론]` AO*/BRTDP가 탐색 우선순위를 정할 수는 있어도, 이 구간으로 exact root action을
  조기에 인증할 근거가 없다. 따라서 더 큰 탐색기를 제품 코드에 추가하지 않았다.

### Lagrangian과 reachable columns

- `[확인]` compact fixture 네 개에서는 공통 유한 penalty `lambda=1000`이 exact root bits를
  재현했다.
- `[확인]` hard R10에서 phase2 정책 closure는 10,296상태였지만 exact 개선 sweep은
  83,569 → 276,843 → 559,854 → 890,325상태로 증가했고 full eligible set은
  2,000,000상태에서 잘렸다.
- `[추론]` 누락 행동을 exact하게 pricing하려면 phase2가 방문하지 않던 successor를 계속
  추가해야 하므로, column 방식이 min-E[f]의 상태 폭발을 피한다는 가설이 성립하지 않았다.

## 구조·근사 후보

### 단조성 및 exact abstraction

- `[확인]` 초기 root cube 1,458개에서는 행동 재진입 반례가 없었다.
- `[확인]` 그러나 SR10/R10 exact graph의 내부 정책 line 141,682개를 검사하자 반례가
  13,679개 발견됐다. 예를 들어 `R10-balanced100:sid741`의 한 inventory line에서
  행동이 `yellow, blue, blue, blue, blue, yellow, blue, blue` 순으로 바뀐다.
- `[추론]` “재고가 늘면 한 번 바뀐 행동은 다시 돌아오지 않는다”는 전역 threshold 규칙은
  exact pruning 계약으로 사용할 수 없다.
- `[확인]` 값과 무관한 exact DAG partition은 SR10에서 0%, R10에서 27.73% 압축됐다.
  R10 결과는 141,555 node를 102,300 partition으로 줄였지만 30% gate에 미달했고,
  graph 전개가 끝난 뒤에만 만들 수 있어 capacity failure를 선행 차단하지 못한다.

### Certified approximation과 distribution

- `[확인]` depth 16 certified approximation은 R10 53,722상태에서 비용 regret upper
  `0.0933914`, SR0 59,945상태에서 `0.1692542`였다. 성공확률 regret upper는 둘 다 0이다.
- `[확인]` 비용 오차는 연구 상한 `0.001`과 제품 상한 `0.000001`을 크게 넘었다.
- `[확인]` exact Pareto frontier의 p95 폭은 184, 최대 756이었다. 0.1 piece/kit 오차의
  strict epsilon cover도 p95 약 106, 최대 422였다.
- `[추론]` 1 piece 수준으로 완화하면 p95 12까지 줄지만 현재 exact 제품 계약과 다른 근사
  목적이 된다. 사용자 요구 없이 이 trade-off를 제품 개선으로 승격하지 않았다.

## 플랫폼 후보

### WebGPU

- `[확인]` Chrome 151, AMD RDNA 2에서 12개 input key의 GPU 전개 결과 24개가 CPU와
  정확히 일치했다.
- `[확인]` setup `384.6ms`, samples `5.2/3.9/2.8/3.4/2.7ms`, warm p50 `2.8ms`,
  warm p95 `3.9ms`였다.
- `[확인]` hard census는 37 layer와 1,162,033상태에서 `budget_exceeded`; 시간은 `928ms`였다.
- `[추론]` GPU는 현재 상태 표현을 더 빨리 전개할 수 있지만, 표현 자체의 상태 수를 줄이지 않는다.

연결된 SM-G781N(Android 13, ARM64, Chrome 147)은 Android user 0에서 해석 가능한 Chrome
VIEW activity가 없어 자동 실행하지 못했다. `[미검증]` Android WebGPU 생존성과 device-loss
복구는 확인되지 않았다.

### SIMD와 threads

- `[확인]` Rust 1.97.1 `+simd128` candidate는 semantic parity를 통과했으나 WASM이
  99,937B에서 100,134B로 커졌다.
- `[확인]` warm paired median ratio는 R0 `0.9850`, SR5 `1.0083`으로 요구값 `<=0.97`을
  모두 통과하지 못했다.
- `[확인]` 2026-08-09 현재 GitHub Pages 응답에는 COOP/COEP가 없고 shared-memory solver
  layout도 없다. 독립 Worker 세 개는 min-E[f] memo를 복제해 측정 기준 약 344.8MiB가 된다.
- `[추론]` threads는 단순 플래그가 아니라 배포 헤더와 memo 소유 구조를 함께 바꾸는 별도 제품
  설계이며, 현재 solver의 저위험 가속안이 아니다.

## 제품 판단과 남은 범위

- `[확인]` 채택 후보는 없으며 현재 Rust min-E[f] → phase2 ladder를 유지한다.
- `[확인]` `public/solver_rs.wasm`, runtime backend, 공개 API, UI, Worker, D1, telemetry는
  변경하지 않았다.
- `[확인]` LP와 complete-policy 구현은 제품 후보가 아니라 후속 연구의 독립 oracle로 유지한다.
- `[추론]` 현재 남은 이론적 후보는 “구체적 bound나 표현을 먼저 증명한 새 연구”이지, 지금 즉시
  구현할 수 있는 저위험 후보 목록이 아니다.
- `[미검증]` 저사양/32비트 Android, 접근 가능한 Android Chrome WebGPU, cross-origin isolated
  배포에서의 shared-memory solver는 이번 결과가 보장하지 않는다.

## 관련 기록

- Phase2 방법론과 bounded 후보: [`phase2-methodology-findings.ko.md`](./phase2-methodology-findings.ko.md)
- Phase2 단계별 증거 원장: [`phase2-next-research-ledger.ko.md`](./phase2-next-research-ledger.ko.md)
- H/p 공동 최적화: [`min-ef-hp-study-findings.ko.md`](./min-ef-hp-study-findings.ko.md)

## 연구 자산 보존 경계

- `[확인]` compact exact graph, complete-policy 전수열거, HiGHS occupancy LP exporter/parser,
  공용 candidate latency 측정과 WebGPU frontier 검증은 후속 연구에서도 쓸 수 있어 유지한다.
- `[확인]` 제품 gate에서 기각된 두 번째 연구 묶음의 후보별 구현, 전용 runner·finalizer와 대량
  JSON/CSV/MPS/SOL은 Git 추적 대상에서 제외했다. 제품 runtime에는 이 코드가 필요하지 않다.
- `[확인]` 후보별 판정과 측정 수치는 이 문서와 단계별 원장에 보존한다. 다만 삭제한 일회성 후보의
  개별 수치를 깨끗한 checkout에서 그대로 재실행할 수 있다는 뜻은 아니다.
- `[추론]` 기각 후보를 다시 검토하려면 당시 코드를 영구 API로 복원하기보다, 현재 solver 계약과
  새 가설에 맞춘 격리 candidate로 다시 구현·측정하는 편이 오래된 전제의 재유입을 막는다.

## 유지된 재현 계약

```powershell
npm run test:bench
npm run bench:next-solver:lp-oracle
npm run bench:next-solver:structure
npm run bench:next-solver:webgpu-frontier
npm run bench:next-solver:webgpu-android
```

`bench:next-solver:lp-oracle`은 `HIGHS_PATH`에 HiGHS 1.14.0 실행 파일 경로가 필요하다.
유지된 runner의 원시 report도 `benchmarks/results/`에 생성되고 gitignored된다.
