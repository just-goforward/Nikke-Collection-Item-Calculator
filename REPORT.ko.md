# Solver 3단계 슬라이더 캘리브레이션 — 통합 보고서

> 이 폴더(`...\Claude`)는 원본(`...\Codex\모듈작`)의 **solver + benchmarks 서브트리만 자립 복사**한
> 뒤, 감독 과정에서 발견한 문제를 고치고 **누락돼 있던 최종 선정(select) 단계까지 추가**하고,
> 전체 규모 캘리브레이션을 실행해 **결론까지 낸** 수정본입니다. **원본은 일절 수정하지 않았습니다.**
>
> 두 기준 문서를 출발점으로 한다:
> - **참고 1** = `…\Codex\모듈작\SOLVER_WORKER_ANALYSIS.ko.md` — production solver(정책 A) 분석 +
>   슬라이더 *아이디어의 기원*(§8.3).
> - **참고 2** = "Solver 3단계 슬라이더 캘리브레이션 실험 계획" — 아이디어를 실험으로 확장한 원안.

---

## 0. 핵심 요약

- production `solve()`는 **바뀌지 않습니다.** 비용함수 리팩터(`availabilityRatio` + H=0 edge fix)는
  rooted p-norm을 그대로 유지하고, 바뀐 분기(`availability ≤ 0`)는 H=0.5에서 도달 불가라 관측 결과가
  동일합니다(회귀 테스트 통과).
- **결론(전체 규모 실행)**: `improved-default-available` — 기본값 A `(τ=0.01, H=0.5)`는
  **`tau0-h0.75-p3 (τ=0, H=0.75)` 에 모든 축(확률·공급·고갈)에서 지배**당합니다. 즉 **3단계 확률-tradeoff
  슬라이더는 정당화되지 않고**(null result), 대신 **공급 안정은 horizon H가 공짜로 만든다**는 양성 결과가
  나왔습니다. 정직한 권고는 슬라이더가 아니라 **기본값 교체**입니다.
- 이 결론에 이르기까지의 보완:
  - 진행 4~6의 `R0-balanced300` exact 타임아웃 = 시나리오 역할이 섞인 설계 결함 → **수정 #1**.
  - journey-tail에서 y축 데이터가 통째로 유실될 구조 → **수정 #2**.
  - 절단 소비 supplyDebt가 y축에 새는 위험 → **수정 #3**.
  - 최소 완주충분 재고 + 다중 panel(skewed) → **수정 #4**(이번 세션에 SR0 한정으로 완성).
  - Pareto/단계계약/단조성/null-result = 최종 선정 단계 부재 → **select capstone 추가**.
  - "P=A인데 공급 우수"가 단계 슬롯 사이로 새 `keep-A-only`로 오보될 문제 → **select에 지배 후보 surface**
    (이번 세션).

검증: `typecheck` ✓ · `lint`(error 0) ✓ · `test`(solver 회귀 17) ✓ · `test:bench`(벤치 스펙 27) ✓ ·
**전체 규모 파이프라인**(screen→calibrate→deep→significance→select) 완주 ✓ (§8).

---

## 1. 플랜의 진화: τ-only → (τ, H, p) → 기본값 교체

| 단계 | 슬라이더를 무엇으로 봤나 | 핵심 레버 | 예상/실제 결과 |
|---|---|---|---|
| **참고 1 §8.3** | A의 **확률 tolerance(τ) 3단** | τ 만 | 확률을 조금씩 양보해 희소 키트 보존 |
| **참고 2 (플랜)** | **성공확률 ↔ 수급안정 효용함수 선택** | **(τ, H, p)** | (τ,H) 단조 schedule로 3점, 아니면 null |
| **최종 결과** | — (전제 폐기) | **H (horizon)** | A는 `(τ=0, H=0.75)`에 **지배**됨 → **기본값 교체** |

### 슬라이더 개념 변경과 이유
- 참고 1 §8.3은 슬라이더를 **A의 τ만 조절**(확률우선 0.1%p / 균형 1.0%p / 보존 2.0%p)로 봤고,
  "1차 구현은 B/C 제외, **A tolerance 조절만**" 이라고 못박았다.
- 플랜은 이를 **`(τ, H, p)` 효용함수 선택**으로 일반화했다. **왜**: τ는 "최고확률−τ 이내" 후보 집합을
  정하는 *띠*일 뿐, 정책이 **공급을 더 비축**하게 만들지 못한다(참고 1 §3.4~3.6). 비축의 강도는 비용식의
  **H(horizon)** 가 결정한다. 참고 1 자신이 "τ를 바꾸면 A가 새 정책이 된다"고 *경고*했는데, 어느 분기가
  A를 **지배**하는지는 τ 한 축으로 판별 불가 → 더 넓은 `(τ,H,p)` 격자 + exact 평가가 필요했다.
- **가장 결정적 변경은 H 축의 추가**다. 참고 1의 슬라이더엔 H가 아예 없었고, 이 축이 최종 결과를 만들었다.

### 격자
```
A 기준 = (τ=0.01, H=0.5, p=3)            ← 참고 1 §3.5의 SUPPLY_AVAILABILITY_PARAMS
τ ∈ {0, 0.001, 0.002, 0.005, 0.01, 0.02, 0.03}
H ∈ {0, 0.25, 0.5, 0.75, 1.0}            ← 참고 1에는 없던 축 (horizonFactor)
p = 3 기본, {4, ∞} 보존 escalation, 2 민감도
```
H는 days로도 표시: `horizonDays = H × 28`. A의 H=0.5 = 14일, 권고된 H=0.75 = 21일.

---

## 2. 설계 (참고 1 대비 무엇이 / 왜)

### 2.1 연구 API — production 불변을 보장하는 확장
참고 1의 정책 A는 비용식 상수가 고정(`{ horizon: 0.5, normPower: 3 }`)이었다. 플랜은 `src/solver.ts`에
**연구 전용 파라미터만** 추가하되 `solve()`의 관측 결과는 동일하게 유지하도록 했다. 실제 코드:
```ts
type ResearchCostModel =
  | { kind: "availability-pnorm"; horizonFactor?: number; normPower?: number }
  | { kind: "linear-shadow"; prices: KitVector };          // B/C shadow-price 경로 보존
type ProbabilityGateAudit = { decisionCount; maxGap; maxGapWitness; violationCount;
  firstViolationWitness; eligibleEmptyCount;               // 의도치 않은 fallback 감지
  fixedToleranceViolationCount; firstFixedToleranceViolationWitness; }; // 고정 0.01 병행 audit
type SolveExecutionOptions = { researchCostModel?; collectGateAudit?; toleranceOverride?; };
const DEFAULT_RESEARCH_COST_MODEL = { kind: "availability-pnorm" }; // 빈 파라미터 = 상수 기본값
```
- **production 불변의 핵심**: `solve(input, progress)`는 `solveInternal(input, progress)`로 **옵션을 아예
  안 넘긴다** → `toleranceOverride` 미설정(전략 기본 0.01 유지), `researchCostModel` 미설정(기본 모델). 연구
  레버는 **API 레벨에서 구조적으로** production에 닿지 않는다.
- **플랜 예시 vs 실제 구현의 차이**(= 실제 코드 변경 디테일):
  1. **H=0 edge** — `availabilityRatio`: `availability>0`이면 비율, 아니면 소비>0→∞·소비=0→0 (`0/0` 누수 차단).
  2. **horizonFactor 방어** — 플랜의 `?? 기본` 한 줄을 실제는 `typeof…Number.isFinite…Math.max(0,…)`로 음수/NaN 방어.
  3. **normPower=∞** — 플랜의 "`!isFinite → max`"를 실제는 `=== +∞ → minimax(max)` 와 "그 외 ≤0/NaN → ∞(거부)"로 분리.
  4. **gate audit 이중화** — 후보 *자기 τ* 위반과 **고정 0.01** 위반을 동시에 기록 → "τ=0.03 후보는 고정
     0.01을 수백만 건 위반(=설계대로 확률 양보)하지만 *자기 τ* 위반은 0"이 증거로 남는다.
- `τ_s`(solver 내부 결정 띠, 실험 입력)와 `ΔP_budget`(end-to-end exact P 손실 허용, 출력 임계, 기본 0.005)을 분리.

### 2.2 평가 방법론 — root F → exact interactive-replan + CRN tail
- 참고 1의 B/C는 root `F`로 fail-fast 기각됐다. 플랜은 채택 *판정*을 다음으로 바꿨다:
  - **차단 게이트 = exact interactive-replan 성공확률 손실(vs A)만**. MC fallback 금지(timeout=판정불가).
  - **tail = CRN trajectory**(seeds 4 × runs 12,000, 모델 간 동일 난수) + paired bootstrap + Holm.
  - `F`는 차단 게이트에서 **강등**(A 편향) → 싼 screen + 해석용.
- **왜**: 한 번짜리 MDP value와 UI 흐름 전체 exact 재계산은 목적함수가 다르다(참고 1 §4.2·§5.7). 슬라이더
  채택은 실사용 성공확률로 판정해야 정직하다. tail risk(참고 1 §5.1~5.3)는 점추정으론 부족 → 유의검정.

### 2.3 y축 — journey panel의 supplyDebt (절단 소비 아님)
- 참고 1은 "기대 소비량 `vector`"만 봤다(§3.3, §5.1). 플랜은 y축을 **`CVaR90(max_k supplyDebtDays_k)`** 로
  정의하고 **완주충분 journey panel에서만** 측정한다. **왜**: 희소 시나리오의 **절단 소비**로 재면 공격적
  정책이 거짓으로 좋아 보이는 역전이 생긴다(수정 #3). guardrail과 구조적으로 분리한다.

### 2.4 선정 — 2D Pareto + 단계계약 + null-result (참고 1·2에 코드가 없던 단계)
`run-availability-select.mjs`(capstone)가 plan §7을 구현한다(§4·§6.4 참조).

---

## 3. 원본 대비 변경 파일

| 파일 | 변경 |
|---|---|
| `src/solver.ts` | **무변경**(원본 그대로 복사). `availabilityRatio`/H=0 fix/`normPower`(∞)/`toleranceOverride`/`eligibleEmptyCount`/이중 gate audit가 이미 반영, production 동등성 OK. |
| `src/types.ts`, `src/solver.test.ts` | 무변경 복사. |
| `benchmarks/**`(evaluator/metrics/models/scenarios/specs/tail-statistics) | 무변경 복사(단, journey-panels·select·calibrate·deep는 아래 수정). |
| `benchmarks/run-availability-deep-slice.mjs` | **수정 #1·#2·#3** + **이번 세션 additive 재개**(§6.2). |
| `benchmarks/run-availability-deep.mjs` | **수정 #1·#3·#5**. |
| `benchmarks/scenarios/journey-panels.ts` | **수정 #4** + **이번 세션 skewed SR0 한정**(§6.1). |
| `benchmarks/run-availability-journey-calibrate.mjs` | **수정 #4** + **이번 세션 조기종료**(§6.1). |
| `benchmarks/run-availability-significance.mjs` + `significance.spec.ts` | **신규(§5 배선)**: CRN paired bootstrap + Holm. |
| `benchmarks/run-availability-select.mjs` | **신규 capstone** + **이번 세션 지배 후보 surface**(§6.4). |
| `benchmarks/run-availability-finish.mjs`, `benchmarks/analyze-availability.mjs` | **신규(이번 세션)**: 자동 체인 오케스트레이터 + 통합 분석(§6.3). |
| `package.json` 등 설정 | 집중 프로젝트용으로 신규/축소. |

---

## 4. 수정 사항 상세 (수정 #1~#6)

### 수정 #1 [높음] — exact-gate 시나리오에서 `balanced300` 제거 (역할 분리)
- **증상**: `R0-balanced300` baseline이 300s에서 `verification_incomplete`, 그 시나리오 후보 19개가 전부
  `baseline_incomplete`. exact 예산의 큰 몫이 정보 0인 측정에 소모.
- **원인**: x축(exact P 손실)과 y축(supplyDebt)은 서로 다른 시나리오 집합에서 나와야 하는데
  `DEFAULT_SCENARIO_IDS`와 `DEFAULT_JOURNEY_PANEL_IDS`가 `balanced300`에서 겹쳤음. balanced300은 P≈0.99999라
  **게이트 정보 0**이면서 exact가 가장 비쌈(R0=610s).
- **수정**: gate/guardrail 시나리오를 **확률이 실제로 위태로운 희소/현실 시나리오**로 한정
  (`R0/SR0-balanced100`, `R14e900-yellow30`, `SR5-blue30`, `SR10-blue10`, `SR10-yellow10`). balanced300은 journey 전용.

### 수정 #2 [높음·예방] — trajectory 슬라이스-경계 절단 방지
- **증상(잠복)**: `collectInteractiveTrajectories`는 재개 불가인데 슬라이스 runner가 job index를 전진시키고
  잘린 예산을 줘서, 슬라이스 끝자락 job이 `verification_incomplete`로 **영구 스킵** → y축 데이터 통째 유실 가능.
- **수정**: (a) `sliceMs ≥ trajectoryBudgetMs` 단언(`assertTrajectoryFitsSlice`), (b) `remainingSliceMs ≥
  trajectoryBudgetMs`일 때만 job 시작, (c) job 예산을 잘리지 않은 `trajectoryBudgetMs`로 고정.

### 수정 #3 [중간] — journey-demand y축과 finite-stock 절단 소비 분리 강제
- **증상/원인**: `summarizeTrajectories`가 희소 job에도 supplyDebt를 계산 → 절단 소비 역전(공격적 정책일수록
  희소키트 빨리 고갈→소비 적게 측정→거짓 저-debt)이 y축에 새면 결론 뒤집힘.
- **수정**: 필드는 유지(테스트 보존)하되 **scenario ∩ journeyPanels = ∅를 런타임 단언**으로 강제, y축은
  `aggregateJourneyDemand`(journeyTail 전용)에서만 읽음. 절단 소비 누수가 **구조적으로 불가능**.

### 수정 #4 [중간·예방] — 최소 완주충분 재고 + 다중 panel
- **증상**: journey panel이 `R0/SR0-balanced300` 둘뿐. "A의 exact P가 0.995를 막 넘는 최소 재고" + "skewed
  panel 추가"가 미구현.
- **수정**: `FIXED_SAFETY_GRID`(96·불변)를 안 건드리고 **별도 모듈 `journey-panels.ts`**에 완주충분 후보
  (`balanced150/200/250/300` + skewed `demand300`)를 정의. `run-availability-journey-calibrate.mjs`가 A 기준
  completionRate로 **per-start-state 최소 완주충분 panel**을 추천. (이번 세션에 skewed를 SR0 한정으로 완성 →
  §6.1.)

### 수정 #5 [낮음] — 비-슬라이스 deep runner baseline-incomplete skip
- baseline exact가 미완료면 해당 시나리오 후보를 `baseline_incomplete`로 기록하고 건너뜀(견고성).

### 수정 #6 [낮음·프로세스] — 보존 단계 p-escalation 트리거 명시
- **select 단계가 자동 판정**: 보존 미성립 + 평가셋 전부 p=3이면 `preservationEscalationSuggested: true`와
  정확한 재실행 명령을 보고서에 출력.

---

## 5. 추가 배선: 유의성 검정 (plan §4·§7)

플랜은 supplyDebt 차이에 **CRN paired bootstrap + Holm**을 요구하는데 원본은 점추정만 비교했다. 배선:
- **`run-availability-significance.mjs`**: deep 결과에서 **보존 후보**(점추정 supplyDebt < A, 손실 ≤
  ΔP_budget)만 골라, A+후보의 journey panel을 한 프로세스에서 재수집해 per-run `maxSupplyDebt`를 CRN 인덱스로
  짝짓고 `cvarUpperTail(·,0.9)` 통계량으로 `pairedBootstrapImprovement`.
- **방향 주의**: 라이브러리 `adversePValue`+Holm은 *악화* 확인용이라, *개선* 확인엔 인자 swap(`base↔cand`).
  `significantImprovement = 전 panel CI>0 AND Holm 확정`. (`significance.spec.ts`로 고정.)
- **select 소비**: 보존 계약의 "tail 엄격 개선"을 점추정→**유의**로 교체. 유의성 파일 부재 시 점추정 **잠정**
  판정 + 경고(`preservationProvisional`).

### select capstone 요약 (plan §7)
- x = 최악 exact P 손실(vs A), y = `CVaR90(max supplyDebt)`의 2D Pareto.
- 단계계약: **확률우선**(P>A, guardrail 비악화) / **균형**(=A) / **보존**(P 손실 ≤ ΔP_budget AND supplyDebt
  유의 개선 AND ≥1 위험군 개선).
- 출력 단조성 + 사후 라벨 + null-result(`improved-default-available`/`3-stage`/`2-stage:*`/`keep-A-only`/
  `insufficient-evidence`/`non-monotone-3-candidates`) + escalation. 보수적 판정(gate 불완전/fallback/판정불가
  후보 제외).

---

## 6. 이번 세션의 보완 (전체 규모 실행 중 발견·수정)

### 6.1 skewed `demand300` 패널 SR0 한정 + 캘리브레이션 조기종료
- **변경**: skewed(blue 편중) 패널을 **SR0 시작에만** 두고, 캘리브레이션이 start-state별 최소 완주충분
  balanced를 찾으면 더 큰 balanced를 건너뛰게 함.
- **왜**: 진단 결과 solve 비용이 **재고 크기에 가파르게 비례**(R0에서 blue 170→200에 ms/solve 6배)하고, skew가
  blue 소비를 134→237로 끌어올려 **R0-skewed는 비현실적**. SR0(짧은 horizon)만 처리 가능(완주율 0.9952,
  ~5200키, ~51ms/solve, ~270s/job). 순차 실행 메모리 누적이 SR0-demand300까지 오염시키던 것을 조기종료로 해소.
- **코드**: `JOURNEY_SKEWED_STOCKS` + `SKEWED_PANEL_START_IDS = Set(["SR0"])`; 캘리브레이션 루프에
  `minimumSufficientBalancedFound` 조기종료 + 기본 budget 300s.

### 6.2 deep journey-tail **additive 재개**
- **변경**: 체크포인트 config 비교에서 `journeyPanelIds` 제외(`sameExactConfig`), (candidate,panel,seed)
  identity-skip 추가, 패널 변경 시 journey-tail 재진입.
- **왜**: exact(120)·finite-tail(480)은 journey 패널과 무관 → 패널 추가에 전체 재실행은 낭비. additive로
  **신규 SR0-demand300 80 job만** 재실행(기존 160+exact+finite 보존). 스모크로 멱등성 검증.

### 6.3 유의성 자동 연결 + 분석 스크립트
- **변경**: `run-availability-finish.mjs`(대기-체이닝 오케스트레이터)로 deep 완료 감지 →
  significance→select→analyze 자동(stall 가드로 deep 사망 시 미완성 데이터 차단). `analyze-availability.mjs`로
  통합 뷰(per-panel supplyDebt·완주율·지배 관계).

### 6.4 select에 **지배(dominator) 후보 surface** — 핵심 보완
- **변경**: A를 *지배*하는 후보(확률 손실 없음 + supplyDebt 유의 개선 + guardrail 비악화 + ≥1 위험군 개선)를
  탐지해 `keep-A-only` 대신 **`improved-default-available`** 로 보고하고 최선 지배 후보를 교체 기본값으로 제시.
- **왜(가장 중요)**: 단계계약은 확률우선(P>A=음수 손실)·보존(P<A=양수 손실)뿐이라, **"P=A인데 공급 우수"**
  (loss≈0)인 후보가 어느 슬롯에도 안 맞아 *가장 강한 결과가 가장 약하게* 보고된다. 실제로 τ=0 고-H 후보는
  worst loss가 정확히 0(또는 1.1e-16) → 슬롯 사이로 새며 `keep-A-only`로 오보될 상황이었고, 동시에 Pareto
  전선은 A를 제외하므로 모순까지 발생. 이를 정직하게 표현.
- **코드**: `dominatorsOfA` filter + outcome 우선순위(improvedDefault 최우선) + `improvedDefault`/
  `dominatorsOfA` 출력 + 보고서 헤드라인 섹션.

---

## 7. production 불변 보장 (재확인)
- `solve()`는 `toleranceOverride`/`researchCostModel`을 설정하지 않으므로 supply gate `0.01`·기본 cost model이
  그대로입니다.
- 비용함수는 원본도 신규도 rooted `(Σ ratio^p)^(1/p)`로 **동일**, 차이는 `availability ≤ 0` 처리뿐인데
  H=0.5에선 `stock + 0.5·G ≥ 0.5·G > 0`라 **도달 불가**.
- `src/solver.test.ts`(관측 동등성)·`a-root-preflight.spec.ts`(전 96 root gate 위반 0) 통과.
- **채택은 별도 승인 작업**: 승인 시에만 기본 cost model 교체(H 0.5→0.75, τ 0) + `solverVersion`/`solverPhase` 동시 갱신.

---

## 8. 검증 결과 + 최종 결과

### 8.1 단위/회귀/스펙 (실행 환경: Windows, node v24)
| 항목 | 명령 | 결과 |
|---|---|---|
| 타입체크 | `npm run typecheck` | 통과 |
| 린트 | `npm run lint` | error 0 (warning/info는 비차단) |
| solver 회귀 | `npm test` | 17/17 통과 |
| 벤치 스펙 | `npm run test:bench` | 27/27 통과(유의성 spec 3 포함) |

### 8.2 전체 규모 실행 결과 (2026-05-31) — `improved-default-available`
deep config: 후보 20 × gate 시나리오 6, journey 패널 `[R0-balanced150, SR0-balanced200, SR0-demand300]`,
seeds 4 × runs 12,000. 무결성: exact 120/120·finite 480/480·journey 240/240 전부 `completed`,
fallback(eligibleEmpty) **0**, A 자기-τ 위반 0(maxGap 0.00999981<0.01).

**선정 결과**: A `(τ=0.01,H=0.5)` 는 다음 후보들에 **지배**됨(확률 손실 0):

| 지배 후보 | 최악 P손실 | supplyDebt CVaR90 (vs A 108.4) | 고갈확률 | guardrail |
|---|---|---|---|---|
| **`tau0-h0.75-p3` (권고)** | 0.000000 | **98.6** (−9.7) | 더 낮음 | 비악화 |
| `tau0-h1-p3` | 0.000000 | 98.8 (−9.5) | 더 낮음 | 비악화 |
| `tau0-h0.25-p3` | 0.000000 | 99.2 (−9.1) | 더 낮음 | 비악화 |

**유의성(paired bootstrap+Holm)**: 위 3종은 **전 패널(R0-balanced150·SR0-balanced200·SR0-demand300)에서
유의 개선** 확정. τ>0 후보(`tau0.02-h1`, `tau0.01-h1`, `tau0.01-h0.75`)는 balanced150·demand300에서 CI<0 →
**탈락**(=확률을 양보하고도 로버스트하지 않음). 즉 **공급 안정의 레버는 τ가 아니라 H**다.

> **demand300의 역할**: y축 max는 안 바꿨지만(전 후보에서 비-binding), significance의 "전 패널 개선" 요건에서
> 비-로버스트 후보를 걸러내 제값을 했다.

### 8.3 스모크 결과 (축소 실행, 2026-05-29) — 역사 기록
파이프라인이 end-to-end로 완주함을 먼저 축소 config로 확인했다(후보 3·1 seed·400 run). 그 축소셋에선 A가
y축 최소라 `keep-A-only`가 **예상된 보수적 판정**이었다(억지 3점 안 만드는 null-result 규율 실증).
`tau0.03-h0-p3`의 exact P 손실 0.0262 측정으로 `toleranceOverride`가 실제 P 양보를 만든다는 것도 확인.
→ 전체 규모(§8.2)에서 비로소 H 지배가 드러났다.

---

## 9. 최종 결론 — 참고 1 §10.4 채택 조건 대비

| 채택 조건(참고 1) | 충족 여부(최종) |
|---|---|
| exact 재계산 성공확률이 A보다 낮아지지 않을 것 | ✅ worst loss 0 (모든 게이트 시나리오에서 P≥A) |
| 보호 시나리오에서 interactive F 비악화 | ✅ guardrail 비악화 + 고갈확률 개선 (F는 해석용으로 강등) |
| probability gate 위반 0 | ✅ 자기-τ 위반 0, A maxGap 0.00999981<0.01 |
| Web Worker 체감 성능 비악화 | ⚠ 본 실험 범위 밖(채택 시 별도). H 변경은 비용식 상수만 바꿔 런타임 동일 예상 |
| 결과가 UI에서 설명 가능 | ✅ "horizon을 14→21일로 늘려 더 비축, 확률은 그대로" 로 설명 가능 |

참고 1 §8.3은 "τ-슬라이더는 A를 새 정책으로 만든다"고 경고했는데, 실험은 그 경고를 **정량 확인**했다. 다만
새 정책은 τ 분기가 아니라 **H 상향**이었고 A를 모든 축에서 지배했다. **3단계 확률-tradeoff 슬라이더는
정당화되지 않으며**, 정직한 권고는 **기본 cost model의 H를 0.5→0.75, τ를 0** 으로 두는 것이다(plan의
null-result 규율과 일치하되 더 적극적인 양성 결론).

---

## 10. 실행 방법

### 10.1 단위/회귀
```powershell
& "C:\Program Files\nodejs\npm.cmd" install
& "C:\Program Files\nodejs\npm.cmd" run typecheck
& "C:\Program Files\nodejs\npm.cmd" run lint
& "C:\Program Files\nodejs\npm.cmd" test
& "C:\Program Files\nodejs\npm.cmd" run test:bench
```

### 10.2 전체 캘리브레이션 (실제 규모)
```powershell
# 1) 후보 screen → deepCandidateIds 산출
& "C:\Program Files\nodejs\npm.cmd" run bench:availability-screen
# 2) journey panel 캘리브레이션 → 최소 완주충분 panel 추천 (skewed는 SR0 한정)
& "C:\Program Files\nodejs\npm.cmd" run bench:availability-journey-calibrate
# 3) deep 평가(슬라이스, 재개 가능). SLICE_MS >= TRAJECTORY_BUDGET_MS 필수.
$env:AVAILABILITY_DEEP_JOURNEY_PANELS='R0-balanced150,SR0-balanced200,SR0-demand300'
$env:AVAILABILITY_DEEP_TRAJECTORY_BUDGET_MS='1200000'
$env:AVAILABILITY_DEEP_SLICE_MS='1800000'
& "C:\Program Files\nodejs\npm.cmd" run bench:availability-deep:loop   # 완료까지 자동 반복(체크포인트 재개)
# 4) 유의성 → 5) 선정 → 6) 분석 (또는 4~6을 finish 오케스트레이터로 자동 연결)
& "C:\Program Files\nodejs\npm.cmd" run bench:availability-finish      # deep 완료 감지 후 significance→select→analyze
# (개별 실행도 가능: bench:availability-significance / -select / -analyze)
```
> additive 재개(§6.2): journey 패널만 추가하고 **나머지 config는 동일**하게 두면 exact/finite/기존 패널을
> 보존하고 신규 패널 job만 재실행한다(`RESET` 금지).

### 10.3 빠른 스모크(축소)
```powershell
$env:AVAILABILITY_DEEP_CANDIDATES='tau0.01-h0.5-p3,tau0-h0.75-p3,tau0.03-h0-p3'
$env:AVAILABILITY_DEEP_SCENARIOS='R14e900-yellow30,SR10-blue10,SR10-yellow10'
$env:AVAILABILITY_DEEP_JOURNEY_PANELS='SR0-balanced200'
$env:AVAILABILITY_DEEP_RUNS_PER_SEED='400'
$env:AVAILABILITY_DEEP_SEEDS='20260505'
& "C:\Program Files\nodejs\npm.cmd" run bench:availability-deep
& "C:\Program Files\nodejs\npm.cmd" run bench:availability-select
```

---

## 11. 코드 변경 요약표

| 파일 | 무엇 | 참고 1 대비 |
|---|---|---|
| `src/solver.ts` | `ResearchCostModel`(horizonFactor/normPower/linear-shadow), `toleranceOverride`, `ProbabilityGateAudit`(이중 tolerance), `availabilityRatio`(H=0 fix), `availabilityCostScoreWithParams`(∞ minimax) | 비용식 상수 → 연구 파라미터화. **`solve()` 관측 불변** |
| `benchmarks/models/availability-grid.ts` | `(τ,H,p)` 격자 + A 기준 | τ 한 축 → 세 축 |
| `benchmarks/evaluator/exact-replan.ts` | 차단 게이트(MC fallback 없음) | root F fail-fast → end-to-end exact |
| `benchmarks/evaluator/trajectory.ts` + `tail-statistics.ts` | CRN trajectory + paired bootstrap/Holm | 분포 꼬리 미반영 → CVaR90 유의검정 |
| `benchmarks/scenarios/journey-panels.ts` | 완주충분 패널 + **skewed SR0 한정** | 신규 |
| `benchmarks/run-availability-*.mjs` | screen→calibrate(조기종료)→deep(additive)→significance→select→finish | 신규 파이프라인 |
| `benchmarks/run-availability-select.mjs` | 2D Pareto + 단계계약 + null-result + **dominator surface** | 신규 capstone |
| `benchmarks/analyze-availability.mjs` | 통합 분석 뷰 | 신규 |

---

## 12. 남은 한계 / 후속
- production `solve()`는 **여전히 불변**. 채택은 별도 승인 작업(H 0.5→0.75 + `solverVersion`/`solverPhase` 갱신).
- finite-stock guardrail의 "위험군 개선"은 아직 **점추정 비교**(supplyDebt만 유의검정 배선). guardrail에도
  paired bootstrap 확장 가능.
- **significance 재수집의 completion-gate 비대칭 — 해소됨**: (이전 상태) deep의 y축 집계
  (`aggregateJourneyDemand`)는 per-(panel, seed) `completionRate ≥ 0.995` 게이트로 미달 seed-job을 제외하는데,
  significance의 재수집은 타임아웃 여부만 보고 completion 게이트 없이 전 seed를 pooling해 두 경로가 불일치했다.
  **(수정)** 순수 모듈 `benchmarks/significance-gate.ts`의 `gatePairedSeeds`를 도입해, **A·후보 중 하나라도
  (panel, seed) 완주 미달이면 그 seed를 양쪽에서 제외**한다(같은 seed를 양쪽에서 빼므로 paired bootstrap의 CRN
  짝과 등길이가 보존됨). `run-availability-significance.mjs`의 `collectPanelArray`는 이제 per-seed
  `completionRate`까지 수집하고, 출력 perPanel에 `completionMin`/`seedsKept`/`seedsGated`를 기록해 이 비대칭이
  닿는 실행을 자동 감지한다(임계값은 `AVAILABILITY_SIG_COMPLETION_THRESHOLD`, 기본 0.995). `significance.spec.ts`에
  게이팅 단위테스트 5건 추가(no-gate / 후보·baseline 미달 시 양쪽 제외 / all-gated / custom threshold + CRN 등길이).
  **결론 영향 없음**(검증): balanced150·200은 전 후보 4/4라 무변경, demand300은 A의 marginal seed(0.9942)만 빠져
  deep와 정확히 일치하고 지배 후보는 큰 마진을 유지.
- **전문가 모드(plan §8) 미구현** — 최종 후보 per-use replan 계약 재확인. select 이후 단계.
- **held-out seed 재확인(plan §4) 미구현** — winner's-curse 방어. select 이후 단계.
- trajectory는 run 단위 checkpoint 없음(수정 #2는 슬라이스 경계 절단만 막음). 한 seed-job이
  `TRAJECTORY_BUDGET_MS` 초과 시 incomplete.
- S28은 v1 점추정(`EXPECTED_28_DAY_GAIN`) 그대로. convolution 분포(v1.5)는 범위 밖.
- demand300은 y축 비-binding이나 significance 판별에 기여(§8.2). R0-skewed는 계산비용상 비현실적이라 제외(§6.1).
