# Phase2 후속 연구 원장

기준일: 2026-08-09  
기준 commit: `45fc4175c332cb5d9656d86ae3f30fe6e4c5e527`  
Phase2 결과 checkpoint: `99331dbf00632e2ac83b6930c6213766908e895a`

연구 보고서 기준 제품 WASM SHA-256:
`37d649b6144196c82cb8623bd7e33fefeac92e707019a6ecfe3be69266bda13`  
Phase2 연구 worktree 재빌드 제품 WASM SHA-256:
`7430c32ae5f3f7c8845c8390568e1f49dcd25c43c67bbda74adb61202c41a8df`

`[확인]` 두 제품 artifact는 모두 99,937B이며 type/import/function/table/memory/global/export/
element/code/name/producers/target-features 섹션이 byte-identical이다. data 섹션에서만 132B가
달랐고, 동일한 파일 문자열 포인터·길이·열 번호 사이에 저장된 Rust panic 위치의 소스 행 번호 66개가
연구용 `cfg` 코드 삽입에 따라 이동한 차이다. 기존 보고서의 전체 artifact SHA는 provenance로 유지하고,
현재 제품 연산 의미가 바뀌었다는 근거로 해석하지 않는다.

## 목적과 실행 순서

이 원장은 다음 여섯 연구를 서로 섞지 않고 순서대로 판정하기 위한 기록이다.

1. admissible branch-and-bound
2. sparse constrained policy iteration exact 기준선
3. prioritized policy improvement
4. bounded hybrid phase2
5. CVaR 등 목적함수 변경
6. 차세대 solver·WebGPU 상태 표현과 탐색 후보

각 단계는 `가설 -> 수학 계약 -> 최소 반례 -> 의미론 parity -> 용량/지연 -> 판정` 순서로
진행한다. 앞 단계의 결과를 다음 단계가 사용하더라도 원시 결과와 해석을 구분한다.

## 증거 계약

- `[확인]`: 현재 코드 또는 fingerprint가 고정된 실행으로 직접 재현한 사실
- `[과거 확인]`: 추적 문서와 로컬 아티팩트가 일치하지만 결과 안에 commit/WASM fingerprint가
  내장되지 않은 사실
- `[추론]`: 확인된 사실에서 도출한 해석
- `[미검증]`: 필요한 실행 또는 증명이 아직 없는 주장
- `[기각]`: 사전 중단 조건을 위반한 후보. 같은 계약으로 다시 실행하지 않는다.

새 결과는 `benchmarks/research-provenance.ts`를 사용해 다음을 기록한다.

- repository commit과 dirty path
- 생성에 관여한 source file별 SHA-256과 결합 fingerprint
- 제품 또는 candidate WASM SHA-256과 byte 수
- study ID, protocol version, 소비되는 options의 canonical hash
- Node, OS, architecture

동일 provenance의 결과가 이미 있으면 기본적으로 재실행하지 않는다. 기존 출력이 다른 계약이거나
provenance가 없는 legacy 결과라면 새 경로를 사용한다. 덮어쓰기는 `RESEARCH_REPLACE=1`을 명시한
경우만 허용한다.

## 기존 연구 자산 감사

다음 파일은 commit/WASM fingerprint를 내장하지 않으므로 현재 기준선의 새 실행으로 표현하지 않고
legacy evidence로만 사용한다.

| 결과 | SHA-256 | 판정 가능한 범위 |
| --- | --- | --- |
| `min-ef-action-order-study.json` | `6fc9ca4e...bd58c1` | 6개 순열의 action/cost bit 및 node 차이 |
| `phase2-successor-closure.json` | `3ac763d0...b6056c` | fixture별 closure 팽창 크기 |
| `sparse-policy-iteration.json` | `948ca0a0...219858` | TypeScript sparse PI root/수렴 결과 |
| `rust-prioritized-sparse-pi.json` | `108d7d5a...67f31` | Rust feature의 exact/bounded screening |
| `gated-cvar-study.json` | `bc02cbf9...ddb03` | one-step CVaR exact interactive 판정 |

현재 연구에서 생성한 authoritative report는 provenance와 contract를 자체 기록한다.

| 결과 | SHA-256 | 판정 가능한 범위 |
| --- | --- | --- |
| `min-ef-branch-bound-b2-latency-final.json` | `00ae76b9...8eef68` | 최종 소스에 결속된 B2 allocation-warm 제품 지연 gate |
| `sparse-policy-exact-baseline-v2.json` | `6046a265...588e5f` | 포화 closure·tau=0 성공률 불변식·min-E[f] parity |
| `prioritized-policy-study-v4.json` | `f0281a31...192ee` | 정정 exact 계약과 동일 예산 priority 순서 비교 |
| `bounded-hybrid-quality-study-v1.json` | `3d0b6c87...b89b08` | bounded fallback의 exact interactive 품질 |
| `bounded-hybrid-performance-study-v2.json` | `34036081...5222a` | phase2와 bounded fallback의 직접 지연 비교 |
| `recorded-cvar-root-screen-v1.json` | `c851dad5...918e1` | full recorded CVaR 정책의 122-root screening |
| `recorded-cvar-interactive-study-v1.json` | `0a075fd4...615d0` | 제품 fallback 상태에서 full CVaR ladder 평가 |
| `single-use-batching-study-v1.json` | `292ab2e9...b5645` | run count를 1로 제한한 exact interactive 평가 |

전체 hash와 당시 수치는 이 원장 및 로컬 report에서 확인한다. 생성 코드나 계약이 바뀌지 않은 한
단순 재현을 목적으로 다시 실행하지 않는다. 새 후보와 동일 artifact에서 직접 비교해야 할 때만 새
provenance 계약으로 baseline을 재측정한다.

## 단계 상태

| 단계 | 현재 상태 | 이미 확인된 것 | 이번 단계에서 새로 답할 질문 |
| --- | --- | --- | --- |
| Branch-and-bound | 제품 후보 기각 | B0 안전성, B1/B2 completion gain, B2 31회 latency 실패 확인 | 더 강한 하한은 별도 후속 연구로만 재개 |
| Sparse PI 기준선 | 현재 재검증 완료 | 포화 closure의 작은 fixture 4개는 min-E[f]와 일치, R10은 고정 120만 state budget 초과 | prioritized 후보가 같은 exact 계약을 더 적은 비용으로 재현하는지 검사 |
| Prioritized improvement | 현재 순서 가설 통과 | exact R10 용량은 그대로지만 max-path가 discovery 순서를 세 화면 모두 지배 | max-path 한 후보만 bounded 제품 적합성 gate로 이동 |
| Bounded hybrid | 현재 제품 후보 기각 | max-path 4 pass의 exact interactive 품질, 직접/전체 ladder 지연, WASM 크기 gate 실패 | 동일 계약 재실행 없이 목적함수 연구로 이동 |
| 목적함수 변경 | 현재 제품 후보 기각 | full recorded CVaR는 fallback 상태에서 용량 실패, 1회 배칭은 R10 품질 실패, H/p tail 후보도 기각 | 새 사용자 선호나 더 큰 CVaR 표현의 별도 계약이 있을 때만 재개 |

## 1단계: Branch-and-bound 사전 등록

### 현재 exact 목적

min-E[f]는 성공확률 gate 안에서 terminal availability burden의 기대값을 최소화한다.

```text
J(s, x) = min_a E[J(S', x - e_a)]
terminal J = F_p(consumed pieces / availability denominator)
```

`F_p`는 `p >= 1`에서 각 키트 소비량에 대해 단조 비감소한다. 현재 제품은 `H=0.75`, `p=3`,
`tau=0`이다.

### B0: 즉시 소비 하한

현재까지 소비한 pieces vector를 `c`, 행동 `a`가 즉시 소비하는 10 pieces vector를 `10e_a`라고
하면 모든 후속 terminal vector `C`에 대해 다음이 성립한다.

```text
C >= c + 10e_a                         (component-wise)
F_p(C) >= F_p(c + 10e_a)               (monotonicity)
E[F_p(C)] >= F_p(c + 10e_a)
```

따라서 `LB0 = F_p(c + 10e_a)`는 action expected terminal cost의 admissible lower bound다.

### 아직 증명되지 않은 연결부

현재 min-E[f]는 action eligibility를 알기 위해 성공·실패 child를 이미 재귀 계산한다. `LB0`를 그 뒤에
적용하면 subtree 절감이 없다. 실제 pruning에는 비용 재귀보다 싼 exact success prepass가 필요하다.

검증해야 할 명제는 다음과 같다.

1. phase2의 capped stock `SPMAX`가 min-E[f]의 uncapped state에서 동일한 최대 성공확률을 준다.
2. prepass가 현재 `STRICT_EPSILON` gate와 child policy success 의미를 bit 또는 허용 오차 안에서
   보존한다.
3. prepass 비용을 포함한 전체 node/time이 baseline보다 줄어든다.

명제 1이나 2가 실패하면 phase2 success를 pruning 근거로 사용하지 않는다.

### 단계별 중단 조건

- 직접 열거 가능한 작은 상태에서 admissibility 반례가 하나라도 나오면 해당 bound를 기각한다.
- baseline semantic bits, node-count golden, action 및 vector parity가 달라지면 기각한다.
- B0가 required hard fixture 중 두 개 이상에서 eligible action subtree의 5% 이상을 제거하지 못하면
  Rust 제품 구현으로 진행하지 않는다.
- exact success prepass를 포함한 candidate가 completed hard fixture 두 개에서 node 수를 10% 이상
  줄이지 못하고 `MEMO_FULL` fixture도 하나 이상 완료로 바꾸지 못하면 후속 브라우저 측정을 하지 않는다.
- 제품 후보는 기존 warm p95 `max(+15%, +50ms)`, WASM 115KB, memo tier 불변 조건을 모두 지켜야
  한다.

결과를 본 뒤 fixture, memo tier, time/state budget 또는 위 임계치를 바꾸지 않는다. B0가 약하면 더
강한 하한은 별도 protocol version과 별도 수학 계약으로 시작한다. 이 원장에서 `B1`은 더 강한
하한이 아니라, B0를 exact phase2 success prepass와 결합한 첫 실제 pruning 구현을 뜻한다.

### B0 확인 결과

- `[확인]` 직접 열거 가능한 작은 상태 전수 검사에서 admissibility violation은 0건이었다.
- `[확인]` 현재 제품 WASM과 feature candidate의 hard fixture 결과는 모두 동일했다. 완료 fixture의
  action, success와 expected-cost bits가 같았고 실패 fixture의 status와 node count도 같았다.
- `[확인]` hard audit의 canonical 잠재 제거율은 다음과 같았다.
  - `R0 / 60·120·900`: 23.03%
  - `R0 / 250·250·250`: 11.99%
  - `R0 / 300·300·300`: 17.11%
  - `SR0 / 350·300·150`: 12.38%
- `[확인]` 네 fixture 모두 lower-bound violation과 potential/actual eligibility mismatch가 0건이었다.
  phase2 maximum-success와 min-E[f] 정책 success의 최대 차이는 `5.55e-16` 이하였다.
- `[판정]` 두 hard fixture에서 5% 이상이라는 사전 gate를 통과했으므로 실제 pruning B1로 진행했다.

### B1 실제 pruning 결과

결과 파일: `benchmarks/results/min-ef-branch-bound-pruning-study.json`  
SHA-256: `0dded70481341c2c7d7fc22bd904470e144fcd56521443ba3ef85000cd24cce7`

B1은 root 후보 세 개를 모두 계산하고, 내부 상태에서만 다음 순서로 행동을 제거한다.

1. phase2 prepass의 exact maximum success가 root state gate 밖이면 제거한다.
2. gate 안의 행동은 canonical 순서로 평가한다.
3. `LB0`가 이미 exact 평가된 eligible incumbent보다 크면 비용 subtree를 제거한다.

| fixture | baseline min-E[f] | B1 min-E[f] | phase2 prepass | combined / baseline | 결과 |
| --- | ---: | ---: | ---: | ---: | --- |
| `R0 / 60·120·900` | 477,508 | 198,785 | 29,112 | 0.48 | bit-identical |
| `R0 / 250·250·250` | 3,618,142 | 2,631,141 | 1,959,511 | 1.27 | bit-identical |
| `R0 / 300·300·300` | MEMO_FULL 3,670,023 | MEMO_FULL 3,670,021 | 1,681,844 | 1.46 | 동일 실패 |
| `SR0 / 350·300·150` | MEMO_FULL 3,670,024 | completed 1,414,190 | 2,430,886 | 1.05 | completion gain |

- `[확인]` 완료 결과에서는 selected action, maximum/success probability, vector 3축, expected cost와
  root 후보 세 개가 모두 bit-identical했다.
- `[확인]` phase2 prepass 값과 min-E[f] 내부 maximum-success 값의 mismatch는 0건이었다.
- `[확인]` candidate WASM은 104,619 bytes로 115KB budget 안이다.
- `[확인]` fresh Node 단일 실행에서 B1은 `R0 / 250³`에서 1.67배 느렸고,
  `R0 / 300³`에서 2.01배 느렸다. `SR0 / 350·300·150`은 새로 완료했지만 baseline과 동등한
  completed latency 비교는 불가능하다.
- `[확인]` tier22 fresh instance의 observed linear-memory growth는 baseline 약 228.9MiB,
  B1 약 425.1MiB였다. 이는 phase2와 min-E[f] memo를 동시에 보존한 현재 prototype의 비용이다.
- `[추론]` B0 가지치기 자체는 실효성이 있지만, 완전한 phase2 memo를 success oracle로 보존하는
  B1 구조는 제품 후보로 비싸다. 반복 latency 캠페인과 compact success prepass 가능성 판정 전에는
  채택·기각을 확정하지 않는다.

### B2 사전 등록: compact maximum-success oracle

B2는 B0 하한과 pruning 순서를 바꾸지 않는다. B1의 phase2 전체 memo 대신 다음 Bellman 값만
별도 hash memo에 저장한다.

```text
M(terminal, stock) = 1
M(dead-end, stock) = 0
M(s, stock) = max_a [q_a M(succ_a, stock-e_a)
                     + (1-q_a) M(fail_a, stock-e_a)]
```

phase2의 state-dependent stock cap은 성공 가능성에 영향을 주지 않는 초과 재고만 제거한다. 따라서
동일 cap, transition, operand order를 사용한 `M`은 phase2 `SPMAX`와 같아야 한다. B2 memo는
`key u32 + generation u32 + maximum-success f64`, 즉 논리적으로 16B/slot만 저장한다. tier22의
논리 크기는 64MiB이며 phase2 전체 memo의 196MiB보다 작다.

B2는 다음 조건을 결과 확인 전에 고정한다.

- compact oracle의 root/action maximum-success bits가 B1 phase2 prepass와 일치해야 한다.
- B1에서 완료된 모든 fixture의 전체 semantic snapshot이 bit-identical이어야 한다.
- B1의 `SR0 / 350·300·150` completion gain을 유지해야 한다.
- tier22 fresh linear-memory growth는 baseline보다 66MiB를 초과해 증가하면 안 된다.
  이는 64MiB 논리 memo와 2MiB allocator/page 여유를 합친 상한이다.
- completed hard fixture의 Node allocation-warm p95를 baseline/candidate 각 31회, ABBA 순서로
  측정한다. p95가 `max(+15%, +50ms)`를 넘으면 제품 후보에서 기각한다. 단일 cold 표본만으로
  이 gate를 판정하지 않는다. 원시 `samplesMs`와 중간 checkpoint를 보존한다.
- candidate WASM은 115KB, min-E[f]와 success memo는 기존 tier22 상한을 유지한다.
- 위 gate를 실패하면 같은 B0에 새로운 저장 구조를 계속 덧붙이지 않고 branch-and-bound 제품 후보를
  기각한다. 더 강한 하한은 별도 후속 연구로만 기록한다.

### B2 결과와 판정

초기 protocol v1은 `SR0 / 350·300·150`에서 compact oracle의 root maximum success를 잘못
`1.0`으로 계산했고 phase2 oracle과 1,128개 mismatch를 냈다. 원인은 transition 전역 register인
`TX_FAIL`을 success child 재귀가 끝난 뒤 읽은 것이었다. 재귀 전에 `TX_SUCC`와 `TX_FAIL`을 모두
지역 변수로 캡처하도록 수정하고, 실패 결과를 덮어쓰지 않은 채 protocol v2와 새 결과 경로를 사용했다.

| 결과 | SHA-256 | 용도 |
| --- | --- | --- |
| `min-ef-branch-bound-compact-study.json` | `feb6fcb8...72d46` | `[기각 구현]` transition register capture 누락 증거 |
| `min-ef-branch-bound-compact-study-v2.json` | `10233752...3e404` | corrected B2 의미론·메모리 screening |
| `min-ef-branch-bound-b2-latency-final.json` | `00ae76b9...8eef68` | 최종 소스에서 재생성한 31회 allocation-warm 제품 gate |

- `[확인]` corrected B2는 네 hard fixture에서 B1 phase2 oracle의 root/action maximum-success bits와
  일치했고, prepass mismatch는 0건이었다.
- `[확인]` completed fixture의 selected/root-candidate semantic snapshot이 bit-identical했고,
  `SR0 / 350·300·150` completion gain도 유지했다.
- `[확인]` tier22 observed memory growth는 제품 228.88MiB, B1 425.06MiB, B2 292.88MiB였다.
  B2의 제품 대비 +64.00MiB는 사전 상한 +66MiB 안이다.
- `[확인]` corrected candidate WASM은 110,336 bytes로 115KB budget 안이다.
- `[확인]` 최종 소스의 31회 ABBA allocation-warm 캠페인에서 모든 124개 표본의 semantic
  snapshot이 같았다. 제품 WASM은 `7430c32a...41a8df`, B2 WASM은
  `2eac499a...5afcf`였다.
  - `R0 / 60·120·900`: 제품 p95 199.81ms, B2 139.61ms, ratio 0.70, 통과
  - `R0 / 250·250·250`: 제품 p95 1,576.39ms, B2 3,042.48ms, ratio 1.93,
    허용 상한 1,812.85ms 초과
- `[판정]` B2는 정확성·WASM·메모리 상한과 한 MEMO_FULL completion gain을 만족했지만 hard
  completed fixture latency gate를 크게 실패했다. 사전 등록에 따라 현재 B0 기반 branch-and-bound는
  제품 후보에서 기각하며 브라우저·실기기 측정으로 진행하지 않는다.
- `[추론]` 작은 fixture의 속도 개선은 가지치기 이득이 oracle 비용보다 큰 영역이 있음을 뜻하지만,
  hard fixture에서 반대가 되므로 제품 입력 전반의 개선으로 일반화할 수 없다. `SR0` capacity gap을
  메우는 연구 fallback으로는 가치가 있으나, 그 용도는 별도 실패복구 정책과 지연 예산을 요구한다.

## 2단계: Sparse PI exact 기준선

### Legacy 완료 판정 결함

현재 TypeScript prototype은 iteration 시작 시점의 `evaluation.values.keys()`만
`improvementStates`로 복사한다. 이후 대체 행동을 평가하면서 새 successor state가 Map에 추가되어도
그 iteration의 개선 대상에는 포함되지 않는다. 그런데 기존 코드는 기존 대상의 action change가 0이면
새 state의 존재와 무관하게 `completed`를 반환했다.

- `[확인]` legacy `R10-balanced300`의 마지막 iteration은 `changes=0`이지만
  `improvementStates=23,289`, `evaluatedStates=77,851`이었다.
- `[확인]` 따라서 54,562개 state는 발견됐지만 해당 iteration에서 개선 가능성을 검사받지 않았다.
- `[판정]` 기존 root·interactive 수치는 해당 prototype의 관측값으로는 보존하지만, “전체 eligible
  closure에서 완전 수렴한 exact sparse PI”라는 해석은 철회한다.

### 정정 exact 계약

1. root에서 시작해 phase2 maximum-success gate에 들어올 가능성이 있는 모든 action의 success/fail
   successor를 반복 확장한다.
2. 새 state가 더 생기지 않을 때까지 closure를 포화한다. 이 closure는 iteration 사이에 버리지 않는다.
3. 각 policy evaluation은 closure의 모든 state 값을 계산한다.
4. action의 maximum-success가 gate 안이라는 조건은 closure 포함용 상한으로만 사용한다. 실제 policy
   improvement에서는 candidate continuation의 actual success가 state maximum-success gate 안인지 다시
   검사한다.
5. closure 전체를 스캔한 결과 strict action change가 0일 때만 `completed`를 반환한다.
6. exact tie에서는 기존 action을 유지한다.

완료된 작은 fixture는 Rust min-E[f]의 action, maximum/selected success, expected cost, vector 3축과
비교한다. 서로 다른 정책이 같은 최적값을 갖는 exact tie는 허용하되 현재 fixture에서는 action도
비교한다.

### 사전 중단 조건

- `R0 / 60·120·900`, `R14e900-yellow30`, `SR5-blue30`, `SR10-yellow10` 중 하나라도 min-E[f]
  의미론과 불일치하면 exact 기준선으로 인정하지 않는다.
- `completed` record에서 closure 크기와 improvement scan 크기가 다르면 회귀로 처리한다.
- `R10-balanced300`은 기존 계약과 같은 `maxStates=1,200,000`을 유지한다. full closure가 이를
  넘으면 `state_budget_exceeded`로 종료하며 결과를 본 뒤 상한을 올리지 않는다.
- budget 실패 record는 품질 개선·악화 판정에 사용하지 않고, prioritized/bounded 연구의 용량 기준선으로
  사용한다.
- 이 단계에서는 제품 지연을 채택 판정하지 않는다. exact closure·값 의미를 먼저 고정한 뒤 다음 단계의
  prioritized 후보가 같은 기준선을 더 적은 state로 재현하는지 비교한다.

### 현재 실행 결과

- `[확인]` authoritative report: `benchmarks/results/sparse-policy-exact-baseline-v2.json`
  - SHA-256: `6046a26508d6eb1221288dff85d56d9461cd29bf62d3fb923d9965eec6588e5f`
  - 기준 commit: `45fc4175c332cb5d9656d86ae3f30fe6e4c5e527`
  - 제품 WASM SHA-256: `37d649b6144196c82cb8623bd7e33fefeaec92e707019a6ecfe3be69266bda13`
  - contract SHA-256: `f8e15dfa7369bcbca7c82d3c0d787d44eadc7d685850de32fdd38a9977461a01`
- `[확인]` `R0 / 60·120·900`은 closure 482,775개를 매 iteration 전부 검사해 8회에
  `completed`가 됐고 Rust min-E[f]와 action·selected/maximum success·cost·vector가 정확히
  일치했다.
- `[확인]` `R14e900-yellow30`, `SR5-blue30`, `SR10-yellow10`도 각각 closure
  750/2,628/87개, 5/7/5회 iteration으로 완료했고 동일 parity gate를 통과했다.
- `[확인]` `R10-balanced300`은 closure 1,200,001번째 state에서
  `state_budget_exceeded`가 됐으며 policy-improvement iteration은 시작하지 않았다. 이는 품질 결과가
  아니라 prioritized/bounded 후보가 줄여야 할 정확한 용량 기준선이다.
- `[판정]` 정정 exact 기준선 gate는 통과했다. 반면 legacy report의 R10 `completed`와 그
  interactive 개선 수치는 포화 closure 수렴을 증명하지 못하므로 제품 품질 근거로 사용하지 않는다.

## 3단계: Prioritized policy improvement

### 수학 계약

- `[확인]` 이 단계의 exact 주장은 `tau=0`에 한정한다. 초기 phase2 정책은 모든 상태에서 최대
  성공확률을 실현하며, 실제 continuation success가 해당 state maximum과 같은 action으로만 정책을
  교체하면 DAG의 역방향 귀납에 따라 갱신 정책도 같은 최대 성공확률을 보존한다.
- `[확인]` 따라서 각 후보 action의 current-policy success와 phase2 action maximum은
  `STRICT_EPSILON` 안에서 같아야 한다. Rust candidate는 이를 매 후보마다 검사하고 위반 시
  `probability_invariant_violation`으로 종료한다. 비영점 `tau`는 현재 exact ABI에서 거부한다.
- `[확인]` priority는 exact closure의 집합이나 크기를 바꾸지 않는다. exact 모드에서는 heap이 빌
  때까지 모두 검사하므로 순서는 latency만 바꿀 수 있다. priority의 품질 가설은 고정 update budget에서
  더 중요한 state를 먼저 바꾸는 bounded 경우에만 성립한다.

### Authoritative v4 결과

- `[확인]` report: `benchmarks/results/prioritized-policy-study-v4.json`
  - SHA-256: `f0281a31785413169501f26002cb979978e73e09cc64396494bf7a99203192ee`
  - candidate WASM: 133,089B,
    SHA-256 `933f502066074d5c1e951970999b0ef17b31af351adad81605e521670cfb0b9f`
  - 제품 WASM: 99,937B,
    SHA-256 `37d649b6144196c82cb8623bd7e33fefeaec92e707019a6ecfe3be69266bda13`
- `[확인]` exact mode의 네 작은 fixture는 min-E[f]와 action·success·cost·vector가 일치했고,
  완료 pass의 scanned/states는 각각 482,775/482,775, 750/750, 2,628/2,628, 87/87이었다.
  총 10,429,859회의 tau=0 success-invariant check에서 최대 차이는 0이었다.
- `[확인]` `R10-balanced300` exact mode는 peak 1,200,000 state,
  scanned 734,332에서 `state_budget_exceeded`가 됐다. priority는 full closure 용량 경계를 줄이지
  못한다는 수학적 예상과 일치한다.
- `[확인]` 동일 `4 passes x 256 updates`에서 `max_path_probability`는 `discovery_order`보다
  세 screen 모두 낮은 `E[F]`를 냈고 성공확률은 동일했다.

| Fixture | phase2-policy 초기 E[F] | discovery 개선 | max-path 개선 | max-path 추가 개선 |
| --- | ---: | ---: | ---: | ---: |
| `R0 / 60·120·900` | 0.1251474752 | -0.0003748917 | -0.0020623718 | -0.0016874801 |
| `R10-balanced300` | 0.2358558317 | -0.0013426082 | -0.0028072683 | -0.0014646601 |
| `SR0-balanced300` | 0.2879194508 | -0.0007201506 | -0.0023314963 | -0.0016113457 |

- `[판정]` prioritized 순서 가설의 승자는 `max_path_probability`다. 이는 bounded update 배분의
  screening 승리이며 제품 채택 승인이 아니다. exact capacity는 실패했고 candidate WASM도 115KB
  예산을 초과하므로 다음 단계에서 interactive 품질·지연을 별도로 판정한다.
- `[기록]` v2는 phase2 baseline cost를 기록하지 못했고, v3는 `F(E[C])`와 `E[F(C)]`를 직접
  비교한 단위 오류가 있어 authoritative evidence에서 제외한다. v4는 Rust evaluator가 내보낸 초기
  phase2-policy `E[F]`와 bounded 최종 `E[F]`만 비교한다.

## 4단계: Bounded hybrid 제품 적합성

### 고정 후보와 판정 계약

3단계의 동일 예산 승자인 `max_path_probability` 하나만 다음 고정값으로 평가했다.

```text
passes = 4
updates per pass = 256
max states = 1,200,000
H = 0.75, p = 3, tau = 0
```

제품 ladder는 min-E[f] tier21이 완료되면 기존 결과를 그대로 사용하고, `MEMO_FULL` 또는
`budget_exceeded`일 때만 위 후보로 fallback한다. exact interactive 판정은 성공확률, interactive F,
총 기대 사용량, 키트별 고갈확률이 시나리오별로 모두 비악화하고, 전체 집합에서 성공확률 또는 F의
엄격한 개선이 하나 이상 있어야 통과한다. 수동 입력은 hard gate가 아니지만 별도 기록한다.

### Exact interactive 결과

결과 파일: `benchmarks/results/bounded-hybrid-quality-study-v1.json`  
SHA-256: `3d0b6c8743a0f2ee1a440186ea9b0e92e71d889cd1d5e6d25740f6c327b89b08`

| fixture | success delta | interactive F delta | total uses delta | blue exhaustion delta | manual entries delta | 판정 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `R10-balanced300` | 0 | +0.0010308173 | +0.1342049927 | +0.0002999188 | +0.0750752869 | 기각 |
| `SR0-balanced300` | +1.11e-16 | -0.0027377024 | -0.2987284709 | -0.0025905029 | +0.2029253483 | 시나리오 비악화 통과 |

- `[확인]` 두 팔 모두 300초 exact budget 안에서 완료했고 candidate의 boundary probability violation은
  0건이었다. bounded fallback은 `R10`에서 2회, `SR0`에서 14회 호출됐으며 모두
  `iteration_budget_exceeded`라는 사전 허용 outcome으로 정책을 게시했다.
- `[확인]` 모든 fallback에서 actual-success invariant 최대 차이와 root probability gap은 0이었다.
- `[확인]` `R10`은 성공확률은 같지만 F, 총 사용량, blue 고갈확률, 수동 입력이 모두 악화됐다.
  시나리오별 hard gate이므로 `SR0` 개선으로 이를 상쇄하지 않는다.
- `[확인]` `SR0`은 F, 총 사용량, blue 고갈확률이 개선됐지만 수동 입력 기대값이 0.2029회 늘었다.
  수동 입력은 이번 hard gate가 아니므로 이 record 자체는 비악화 통과지만 전체 후보는 기각이다.

### 지연과 크기 결과

| 결과 | SHA-256 | 계약 |
| --- | --- | --- |
| `bounded-hybrid-performance-study-v1.json` | `dcbf970f...48cfa` | 전체 min-E[f]→fallback ladder의 보조 측정 |
| `bounded-hybrid-performance-study-v2.json` | `34036081...5222a` | 공통 min-E[f] rung을 제외한 fallback 직접 비교 정본 |

v1 전체 ladder는 네 캠페인 중 `R10` 2회차와 `SR0` 1회차가 p95 gate를 실패했다. 공통 min-E[f]
실패 비용이 두 팔에 모두 들어가 알고리즘 차이를 희석하므로, 제품 지연의 보조 증거로만 사용한다.

v2는 fresh instance에서 1회 준비 후 각 팔 31개 allocation-warm 표본을 ABBA로 교차 수집하고 두
캠페인을 독립 실행했다.

| fixture | campaign | phase2 p95 | bounded p95 | ratio | gate |
| --- | ---: | ---: | ---: | ---: | --- |
| `R10-balanced300` | 1 | 169.71ms | 224.35ms | 1.322 | 실패 |
| `R10-balanced300` | 2 | 158.09ms | 216.26ms | 1.368 | 실패 |
| `SR0-balanced300` | 1 | 925.76ms | 1,097.21ms | 1.185 | 실패 |
| `SR0-balanced300` | 2 | 943.55ms | 1,096.72ms | 1.162 | 실패 |

- `[확인]` 248개 측정 solve의 build별 결과 signature는 각 캠페인 안에서 모두 동일했고 candidate의
  tau=0 invariant도 모두 통과했다.
- `[확인]` 네 직접 비교 캠페인 모두 p95 `max(+15%, +50ms)` 상한을 넘었다.
- `[확인]` candidate WASM은 133,089B로 115,000B 제품 예산을 18,089B 초과한다.
- `[판정]` bounded hybrid는 `R10` exact 품질, 직접/전체 ladder 지연, WASM 크기에서 독립적으로
  제품 gate를 실패했다. 같은 4-pass·256-update 계약을 다시 실행하지 않고 제품 후보에서 기각한다.
- `[추론]` `SR0` 개선은 prioritized update가 일부 고난도 상태에서 품질을 높일 수 있음을 보여주지만,
  고정 예산 정책이 상태 전반에서 단조 개선을 보장하지는 않는다. 이를 제품화하려면 사후 선택이 아닌
  안전한 상태별 승인 bound가 새로 필요하며, 이는 별도 알고리즘 연구다.

## 5단계: 목적함수 변경

### 목적함수와 판정 경계

이 단계는 같은 평균 목적을 더 빠르게 푸는 연구가 아니라, tail risk·키트별 고갈·사용자 입력 부담을
별도 목표로 삼았을 때 제품에 넣을 수 있는 정책이 있는지 확인한다. 성공확률, interactive F, 총 기대
사용량, 세 키트의 고갈확률은 시나리오별 hard gate로 유지한다. 한 시나리오의 개선으로 다른
시나리오의 악화를 상쇄하지 않는다.

### H/p와 supply-debt tail 선행 결과

`min-ef-hp-study-findings.ko.md`의 현재 의미론 연구는 H/p 49개 조합을 122개 root에서 screening하고,
16개 shortlist를 11개 exact 시나리오에서 평가했다. 176개 exact record는 모두 완료됐고 tail 단계에는
baseline `H0.75-p3`와 `H0.5-p3`만 진입했다.

- `[확인]` `H0.5-p3`는 `R0-balanced150`에서 max-kit supply-debt CVaR90을
  76.4861일에서 85.9952일로 9.5091일 악화시켰고 Holm 보정 뒤에도 유의했다.
- `[판정]` tail challenger가 없어 D1 replay와 독립 성능 캠페인은 실행하지 않았으며 제품값은
  `H=0.75, p=3`으로 유지했다.
- `[한계]` 이는 고정된 H/p grid와 현재 exact/tail gate의 판정이다. 가능한 모든 위험함수가
  baseline보다 나쁘다는 증명은 아니다.

### Full recorded CVaR 정책

| 결과 | SHA-256 | 역할 |
| --- | --- | --- |
| `recorded-cvar-root-screen-v1.json` | `c851dad5f1cccb7ba77d6f6c469b049f3fb0f36d3f060edf45252209fba918e1` | alpha 0.9, eta 7개 full-policy root screen |
| `recorded-cvar-interactive-study-v1.json` | `0a075fd49eb376c5b4ccb324195eef4d09d6ce771c29b94e65eb8a36902615d0` | 제품 min-E[f]→CVaR→phase2 ladder의 exact 평가 |

- `[확인]` 122개 root 중 115개가 완료되고 7개가 현재 1,000,000-slot CVaR memo에서 실패했다.
  성공확률과 평균 비용을 비악화시키면서 sampled CVaR을 엄격히 줄인 recorded policy는 29개였지만,
  first action 또는 추천 run이 실제로 바뀐 root는 `SR10-skewPurple` 하나였다.
- `[확인]` `SR10-skewPurple`은 현재 제품 ladder에서 min-E[f]가 168 states로 먼저 완료하므로 CVaR
  fallback이 도달하지 않는 영역이다.
- `[확인]` exact `R10-balanced300`에서는 min-E[f] 실패 상태 4개, `SR0-balanced300`에서는 17개에서
  CVaR을 시도했지만 모두 solver status 2로 실패해 phase2로 복구됐다. 23,291개 전체 solve call에서
  CVaR 결정 변경은 0건이고, 두 시나리오의 확률·F·총사용량·고갈확률은 baseline과 동일했다.
- `[판정]` 현재 memo와 eta grid의 full recorded CVaR는 제품 fallback을 개선하지 못했다. CVaR
  자체를 보편적으로 기각하는 것이 아니라, 더 큰 상태 표현이나 다른 tail 목적은 새 용량·성능 계약이
  있을 때만 별도 연구한다.

### 키트별 고갈 목적의 수학적 한계

키트별 고갈은 하나의 수가 아니라 다음 벡터다.

```text
g(policy) = (P[blue < 10], P[purple < 10], P[yellow < 10])
```

어떤 정책이 blue 고갈을 줄이는 대신 purple 고갈을 늘리면 두 정책에는 자연스러운 대소관계가 없다.
가중합 `w_b*g_b + w_p*g_p + w_y*g_y`, lexicographic 우선순위, 특정 키트 제약 중 하나를 정하려면
사용자 선호가 필요하다. 이번 연구는 임의의 가중치를 만들지 않고 componentwise
`g_candidate <= g_baseline`을 제품 guardrail로 사용했다. H/p, bounded hybrid, CVaR, 1회 배칭 후보
중 이 guardrail과 나머지 제품 gate를 모두 통과해 엄격한 이득을 만든 후보는 없었다. 이는 가능한
모든 Pareto 후보가 없다는 뜻이 아니라, 선호가 정의되지 않은 벡터를 임의로 scalarize하지 않았다는
뜻이다.

### 단일 사용 배칭

결과 파일: `benchmarks/results/single-use-batching-study-v1.json`  
SHA-256: `292ab2e90714644385949de35e3b2526e20ed310e9e34e3e7fbd699a95eb5645`

기존 min-E[f]→phase2 정책의 추천 action은 유지하고 추천 run count만 1로 제한해 매 사용 뒤 다시
계산했다.

| fixture | success delta | interactive F delta | total uses delta | blue exhaustion delta | manual entries delta | solve calls delta | 판정 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `R10-balanced300` | 0 | +0.0000000475 | +0.0000809789 | -0.0000000949 | -0.1475407801 | +292 | 기각 |
| `SR0-balanced300` | +2.22e-16 | -0.0001656483 | -0.0292006848 | -0.0006787112 | -0.1526720255 | +976 | 시나리오 비악화 통과 |

- `[확인]` 두 시나리오 모두 expected manual entries가 약 0.15회 감소했지만 `R10`에서 F와 총 기대
  사용량이 악화되고 엄격한 확률/F 이득이 없어 시나리오별 hard gate를 실패했다.
- `[확인]` exact evaluator의 solve call은 각각 292회, 976회 늘었다.
- `[미검증]` 사용자가 추가로 눌러야 하는 확인·재계산 횟수와 체감 부담은 evaluator가 측정하지 않는다.
  이 미측정만으로도 제품 채택을 승인할 수 없지만, 후보는 그보다 앞서 R10 자원 품질에서 기각됐다.

### 목적함수 단계 판정

- `[판정]` H/p tail, one-step CVaR, full recorded CVaR, 단일 사용 배칭 중 현재 제품 공동 gate를
  통과한 후보는 없다.
- `[판정]` 특정 키트 보호는 사용자 선호 없이 유일한 scalar 목적을 정의할 수 없으므로 임의 가중치를
  도입하지 않았다.
- `[확인]` 제품 runtime, `public/solver_rs.wasm`, UI, Worker protocol, D1 schema, solver 정책
  버전은 변경하지 않았다.

## 6단계: 차세대 solver·WebGPU 후보

Phase2 내부 개선과 H/p 목적함수 후보가 제품 gate를 통과하지 못한 뒤, 서로 다른 상태 표현과
탐색 방법을 공통 exact 계약 아래에서 screening했다.

| 후보군 | 현재 판정 | 중단 근거 |
| --- | --- | --- |
| Complete-policy·LP oracle | 연구 기반만 유지 | 작은 상태 독립 검증용이며 제품 규모 알고리즘은 아님. LP 실행은 HiGHS 부재로 미완료 |
| WebGPU compact exact hybrid | 기각 | 소형 key parity 통과, R10 exact graph 120만 상태 상한 초과 |
| Certified limited depth·AO*/BRTDP | 기각 | 대표 R10·SR0 root의 행동 interval 미분리 |
| Pareto·distributional·adaptive H/p | 기각 | 작은 graph p95 frontier 폭 184, 상한 32 초과 |
| Monotonicity threshold | 검증 미완료 | 제한 표본 반례 0건은 전역 증명이 아님 |
| Symbolic partition | 기각 | 127상태가 127 partition으로 남아 압축률 0% |
| GPU MCTS | 선행 게이트 중단 | exact WebGPU 상태 용량 게이트 실패 |

- `[확인]` 공통 compact DP는 실제 Rust WASM과 action·확률·비용·vector parity를 통과했다.
- `[확인]` 선행 게이트가 실패한 AO*/BRTDP, GPU MCTS, distributional, adaptive H/p에는 제품용
  구현이나 runtime 배선을 추가하지 않았다.
- `[판정]` 현재 Rust min-E[f]→phase2 ladder를 유지한다. 이는 위 후보군과 고정된 예산·정확성
  계약의 판정이며 수학적으로 가능한 모든 알고리즘에 대한 부재 증명이 아니다.
- 상세 보고서: [`next-solver-research-findings.ko.md`](./next-solver-research-findings.ko.md)

## 다음 기록 위치

- 생성 코드: `benchmarks/run-min-ef-branch-bound-study.ts`
- 순수 수학/전수 검사: `benchmarks/min-ef-branch-bound.spec.ts`
- 로컬 결과: `benchmarks/results/min-ef-branch-bound-study.json`
- Sparse PI exact runner: `benchmarks/run-sparse-policy-exact-baseline.ts`
- Sparse PI exact 결과: `benchmarks/results/sparse-policy-exact-baseline-v2.json`
- Prioritized runner: `benchmarks/run-prioritized-policy-study.ts`
- Prioritized 결과: `benchmarks/results/prioritized-policy-study-v4.json`
- Bounded quality runner: `benchmarks/run-bounded-hybrid-quality-study.ts`
- Bounded performance runner: `benchmarks/run-bounded-hybrid-performance-study.ts`
- Bounded 결과: `benchmarks/results/bounded-hybrid-*-study-v*.json`
- Full recorded CVaR runners: `benchmarks/run-recorded-cvar-*.ts`
- Full recorded CVaR 결과: `benchmarks/results/recorded-cvar-*-v1.json`
- 단일 사용 runner: `benchmarks/run-single-use-batching-study.ts`
- 단일 사용 결과: `benchmarks/results/single-use-batching-study-v1.json`
- 차세대 solver 계약: `benchmarks/next-solver-research-contract.ts`
- Compact exact graph: `benchmarks/compact-exact-graph.ts`
- 차세대 solver 결과: `benchmarks/results/next-solver-research-v1.json`
- 차세대 solver 판정: `next-solver-research-findings.ko.md`
- 채택·기각 해석: 이 원장과 `phase2-methodology-findings.ko.md`
