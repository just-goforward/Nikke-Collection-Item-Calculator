# 계산 Worker / Solver 정책 분석 통합 문서

작성일: 2026-05-28  
대상: `src/worker.ts`, `src/solver.ts`, `src/hooks/useSolverWorker.ts`, `benchmarks/`

> 2026-06-01 업데이트: 3단계 슬라이더 캘리브레이션 연구 결과를 반영해 실제 배포 기본값은
> `phase2_availability_h075_tau0_p3`로 전환되었습니다. 현재 production `supply` 정책은
> `H=0.75`(21일 수급 지평), `p=3`, probability tolerance `0`을 사용합니다. 아래 본문 중
> `phase1_availability_pnorm`, `H=0.5`, `1.0%p tolerance`를 설명하는 부분은 연구 및 이전 배포
> 정책의 배경 설명으로 읽어야 합니다.

## 0. 범위와 결론

이 문서는 **계산 Web Worker와 solver 정책**을 정리한다. 여기서 말하는 Worker는
Cloudflare 통계 API Worker가 아니라, 브라우저에서 무거운 계산을 메인 UI 스레드 밖에서
실행하는 `src/worker.ts`와 그 내부에서 호출되는 `src/solver.ts`를 뜻한다.

요약하면 현재 구조는 다음과 같다.

- `src/worker.ts`는 메시지 검증, 진행률 전달, 결과 반환만 담당한다.
- 실제 수학적 의사결정은 `src/solver.ts`의 유한 재고 MDP가 담당한다.
- 현재 공개 활성 전략은 `supply` 하나다.
- `supply`는 SR 15 도달 확률을 우선하되, 최고 확률보다 **1.0%p 이내**인 후보들 사이에서는
  수급 비용이 낮은 행동을 고른다.
- 현재 정책은 **기대 키트 사용량**은 고려하지만, 최소값/중앙값/최대값/분산/고갈 확률 같은
  **분포 기반 꼬리 위험**은 추천 기준에 직접 반영하지 않는다.
- 연구된 B/C shadow-price 후보는 일부 개선 신호가 있었지만, 보호 시나리오에서 성공 확률
  또는 interactive `F`를 악화시켜 제품 기본 정책 대체 후보에서 기각되었다.
- 따라서 현재 배포 제품에는 B/C가 연결되지 않았고, `solve()`와 `solverVersion`도 변경하지 않았다.

관련 상세 결과:

- [A 기준선 실행 가능성 검증](./benchmarks/BASELINE_FINDINGS.ko.md)
- [Shadow-price 후보 pilot 기각 결과](./benchmarks/SHADOW_PILOT_FINDINGS.ko.md)
- [Solver 동적 수급 압박 연구 개요](./benchmarks/README.ko.md)

---

## 1. 전체 구조

### 1.1 역할 분리

```text
React UI
  |
  | useSolverWorker.solveBestAvailable(input)
  v
Web Worker: src/worker.ts
  |
  | solve(input, progress)
  v
Solver: src/solver.ts
  |
  | finiteInventoryMdp()
  v
추천 결과 / 후보 목록 / SR 15 도달 확률 / 기대 키트 사용량
```

### 1.2 `src/worker.ts`의 역할

`src/worker.ts`는 계산 정책을 직접 결정하지 않는다. 하는 일은 다음뿐이다.

1. UI에서 온 메시지를 `WorkerRequestSchema`로 검증한다.
2. `solve` 또는 `validate` 요청을 구분한다.
3. `solve(input)`을 호출한다.
4. 진행률 이벤트를 UI로 전달한다.
5. 계산 결과 또는 오류를 UI로 돌려준다.

간략화하면 다음 구조다.

```ts
self.onmessage = (event) => {
  const parsed = WorkerRequestSchema.safeParse(event.data || {});
  if (!parsed.success) {
    postWorkerMessage({
      type: "error",
      id: messageId(event.data),
      message: "Invalid worker request.",
    });
    return;
  }

  const data = parsed.data as WorkerRequest;

  try {
    const input =
      data.type === "validate"
        ? {
            ...(data.input || {}),
            monteCarloRuns: Math.max(0, Math.floor(Number(data.runs) || 0)),
            monteCarloSeed: Math.max(0, Math.floor(Number(data.seed) || 20260505)),
          }
        : data.input;

    const result = solve(input, (progress) => {
      postWorkerMessage({ type: "progress", id: data.id, progress });
    });

    postWorkerMessage({
      type: "result",
      id: data.id,
      result: data.type === "validate" ? result.monteCarlo : result,
    });
  } catch (error) {
    postWorkerMessage({
      type: "error",
      id: data.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
```

즉 보안/정책/수학적 취약점의 핵심은 대부분 `src/worker.ts`가 아니라 `src/solver.ts`에 있다.

### 1.3 UI 훅의 Worker 사용 방식

`useSolverWorker.ts`는 Web Worker를 lazy 생성하고, 실패하면 메인 스레드에서 동적 import로
`solve()`를 직접 실행한다.

```text
Worker 생성 성공
  -> Worker에서 solve 실행

Worker 생성 실패 또는 Worker 오류
  -> worker reset
  -> import("../solver")
  -> 메인 스레드에서 solve 실행
```

캐시는 두 종류다.

| 캐시 | 용도 | 크기 |
| --- | --- | ---: |
| solve cache | 일반 추천 계산 | 32개 |
| validation cache | Monte Carlo 검산 | 16개 |

이 캐시는 같은 입력을 반복 계산할 때 UI 응답성을 개선하기 위한 장치다.

---

## 2. 게임 규칙 모델링

### 2.1 상태

solver의 기본 상태는 다음으로 구성된다.

```ts
type CollectionState = {
  grade: "R" | "SR";
  level: number;
  exp: number;
};
```

재고는 키트 3종이다.

```ts
type Kit = "blue" | "purple" | "yellow";

type KitVector = {
  blue: number;
  purple: number;
  yellow: number;
};
```

키트는 10개 단위로 1회 사용할 수 있다. 입력된 보유 키트 수량은 piece 단위지만, MDP
상태에서는 사용 가능 횟수로 바뀐다.

```ts
function stockToUses(stock: KitVector): KitVector {
  return {
    blue: Math.floor(stock.blue / 10),
    purple: Math.floor(stock.purple / 10),
    yellow: Math.floor(stock.yellow / 10),
  };
}
```

따라서 9개 이하의 잔여 키트는 현재 계산에서 사용 불가능한 수량이다.

### 2.2 키트 경험치

키트별 경험치 값은 다음과 같다.

| 키트 | 경험치 |
| --- | ---: |
| 초심자용 `blue` | 200 |
| 중급자용 `purple` | 500 |
| 상급자용 `yellow` | 1000 |

등급별 레벨업 필요 경험치는 고정이다.

| 등급 | 필요 경험치 |
| --- | ---: |
| R | 1000 |
| SR | 3000 |

### 2.3 성공/실패 전이

각 키트 사용은 두 갈래로 나뉜다.

- 대성공: 다음 경계 레벨로 점프한다. 경계는 5, 10, 15다.
- 실패: 키트 경험치만큼 경험치가 오른다. 경험치가 필요량을 넘으면 레벨업한다.

간략화한 전이 규칙은 다음과 같다.

```ts
function failStateNormalized(state: CollectionState, kit: Kit): CollectionState {
  const grade = state.grade;
  let level = state.level;
  let exp = state.exp + KIT_META[kit].exp;
  const required = FIXED_REQUIRED_EXP[grade];

  while (exp >= required && level < 15) {
    exp -= required;
    level += 1;
    if (level === 5 || level === 10 || level === 15) {
      exp = 0;
      break;
    }
  }
  return { grade, level, exp };
}

function transitionNormalized(state: CollectionState, kit: Kit) {
  const probability = GREAT_SUCCESS[state.grade][kit][state.level] / 100;
  return {
    probability,
    success: {
      grade: state.grade,
      level: nextBoundary(state.level),
      exp: 0,
    },
    fail: failStateNormalized(state, kit),
  };
}
```

중요한 점은 **대성공을 하지 않아도 성장이 진행된다**는 것이다. 이 효과는 현재 MDP에
들어가 있다.

### 2.4 종료 상태와 등급 교체

종료 상태는 `SR 15`다.

`R 15`는 최종 목표가 아니라 SR 등급으로 교체해야 하는 상태다. 코드에서는 `R 15` 도달 시
`SR 5, 0exp`로 변환하는 경로가 존재한다.

```ts
function convertState(): CollectionState {
  return { grade: "SR", level: 5, exp: 0 };
}
```

---

## 3. 현재 추천 정책 A: 유한 재고 MDP

### 3.1 목적

현재 정책 A의 목적은 다음 둘을 함께 만족하는 것이다.

1. SR 15 도달 확률을 크게 해치지 않는다.
2. 확률 차이가 충분히 작다면 희소한 키트를 덜 쓰는 행동을 고른다.

공개 활성 전략은 `supply`다.

```ts
const ACTIVE_STRATEGY: Strategy = "supply";
```

### 3.2 상태 공간

solver는 다음 상태에 대해 가치를 계산한다.

```text
V(state, stockUses) = 이 상태와 남은 사용 가능 횟수에서 SR 15에 도달할 확률과 기대 소비량
```

`state`는 등급, 레벨, 경험치 bucket으로 인코딩되고, `stockUses`는 키트별 사용 가능 횟수다.

같은 `(state, stockUses)`는 memoization으로 재사용된다.

```ts
const key = memoKey(normalized, stock);
if (memo.has(key)) return memo.get(key);
```

이 구조는 계산량을 크게 줄인다. 대신 뒤에서 설명할 `parent-independent continuation`
근사라는 한계를 만든다.

### 3.3 후보 평가

각 상태에서 가능한 키트 후보를 모두 평가한다.

```ts
for (const kit of KIT_ORDER) {
  if (stock[kit] <= 0) continue;

  const nextStock = decrementStock(stock, kit);
  const edge = transitionNormalized(normalized, kit);

  const success = value(edge.success, nextStock);
  const fail = value(edge.fail, nextStock);

  const vector = mixVector(edge.probability, success.vector, fail.vector, kit);

  const successProbability =
    edge.probability * success.successProbability +
    (1 - edge.probability) * fail.successProbability;
}
```

`vector`는 앞으로 평균적으로 소비할 것으로 예상되는 키트 수량이다.

```ts
function mixVector(probability: number, success: KitVector, fail: KitVector, kit: Kit): KitVector {
  return addUse(
    {
      blue: probability * success.blue + (1 - probability) * fail.blue,
      purple: probability * success.purple + (1 - probability) * fail.purple,
      yellow: probability * success.yellow + (1 - probability) * fail.yellow,
    },
    kit,
  );
}
```

따라서 현재 정책은 **기대 필요 수량**은 고려한다.

하지만 `vector`는 평균이다. 최소값, 중앙값, 최대값, 분산, p90, 고갈 확률 같은 분포 정보는
현재 제품 추천 기준에 직접 들어가지 않는다.

### 3.4 1.0%p probability tolerance

현재 `supply` 전략은 최고 SR 15 도달 확률보다 1.0%p 이내인 후보를 효율 비교 대상으로
남긴다.

```ts
const STRATEGY_PROBABILITY_TOLERANCE: Record<Strategy, number> = {
  single: 0.001,
  supply: 0.01,
};
```

후보 필터링은 다음 방식이다.

```ts
function withinProbabilityTolerance(
  successProbability: number,
  maxSuccessProbability: number,
  strategy: unknown,
) {
  return (
    maxSuccessProbability - successProbability <=
    probabilityToleranceForStrategy(strategy) + STRICT_EPSILON
  );
}
```

예시:

| 후보 | SR 15 도달 확률 | `supply` 기준 |
| --- | ---: | --- |
| A | 90.0% | 최고 확률 |
| B | 89.4% | 0.6%p 낮으므로 비용 비교 대상 |
| C | 88.7% | 1.3%p 낮으므로 제외 |

이 규칙 때문에 현재 추천은 항상 확률 최고 후보만 고르지는 않는다. 최고 후보와 거의 비슷한
성공 확률이면 희소 키트 보존을 우선할 수 있다.

### 3.5 수급 비용식

`supply` 전략의 비용식은 기대 소비량을 현재 보유량과 예상 수급량으로 나눈 뒤 p-norm으로
합친다.

```text
availability[kit] = currentStockPieces[kit] + horizon * expected28DayGain[kit]
cost = (Σkit (expectedConsumption[kit] / availability[kit])^p)^(1/p)
```

현재 상수는 다음이다.

```ts
const SUPPLY_AVAILABILITY_PARAMS = {
  horizon: 0.5,
  normPower: 3,
};
```

코드의 `EXPECTED_28_DAY_GAIN`은 상세 보상 확률표에서 계산한 28일 예상 획득량이다.
산출 근거는 [키트 28일 기대 획득량 산출 근거](./KIT_EXPECTED_GAIN_SOURCE.ko.md)에 따로
보존한다.

```ts
const EXPECTED_28_DAY_GAIN: KitVector = {
  blue: 473.912,
  purple: 55.808,
  yellow: 24.736,
};
```

이를 주간 기준으로 환산하면 다음과 같다.

| 키트 | 28일 예상 획득량 | 주간 예상 획득량 | 비용식 반영량 `0.5 × 28일`, 즉 14일분 |
| --- | ---: | ---: | ---: |
| 초심자용 | 473.912개 | 118.478개/주 | 236.956개 |
| 중급자용 | 55.808개 | 13.952개/주 | 27.904개 |
| 상급자용 | 24.736개 | 6.184개/주 | 12.368개 |

따라서 현재 `supply` 비용식은 “현재 보유량 + 약 2주치 예상 획득량”을 가용량으로 본다.
예를 들어 상급자용 키트 30개를 보유했다면 비용식의 분모는 대략 다음이다.

```text
30 + 12.368 = 42.368
```

코드:

```ts
function availabilityCostScore(vector: KitVector, stockPieces: KitVector) {
  const powered = KIT_ORDER.reduce((sum, kit) => {
    const availability =
      stockPieces[kit] + SUPPLY_AVAILABILITY_PARAMS.horizon * EXPECTED_28_DAY_GAIN[kit];
    if (availability <= 0) return Number.POSITIVE_INFINITY;
    const ratio = vector[kit] / availability;
    return sum + ratio ** SUPPLY_AVAILABILITY_PARAMS.normPower;
  }, 0);
  return powered ** (1 / SUPPLY_AVAILABILITY_PARAMS.normPower);
}
```

비유하면 다음과 같다.

> 여러 종류의 물통을 들고 등산하는데, 어떤 물통이 희소할수록 같은 양을 쓰더라도 비용이
> 더 크다. 특히 한 종류의 희소 물통에 소비가 몰리면 세제곱으로 강하게 벌점을 준다.

### 3.6 후보 선택 순서

최종 후보 선택은 다음 순서다.

1. 최고 성공 확률보다 tolerance 이내인 후보만 남긴다.
2. 그 안에서 `resourceCost`가 가장 낮은 후보를 고른다.
3. 비용이 사실상 같으면 총 기대 키트 소비량이 낮은 후보를 고른다.
4. 그것도 같으면 성공 확률이 높은 후보를 고른다.

간략화한 코드:

```ts
function compareEfficiency(a: AnyValue, b: AnyValue, strategy: Strategy) {
  if (strategy === "supply") {
    if (Math.abs(a.resourceCost - b.resourceCost) > STRICT_EPSILON) {
      return a.resourceCost - b.resourceCost;
    }
  }

  const totalDiff = totalKits(a.vector) - totalKits(b.vector);
  if (Math.abs(totalDiff) > STRICT_EPSILON) return totalDiff;

  return b.successProbability - a.successProbability;
}
```

---

## 4. 현재 Worker/Solver가 제공하는 결과

일반 계산 결과에는 다음 정보가 포함된다.

| 필드 | 의미 |
| --- | --- |
| `best.firstAction` | 추천 키트 |
| `best.run` | 같은 키트를 몇 회까지 연속 추천할 수 있는지 |
| `best.successProbability` | 현재 MDP 기준 SR 15 도달 확률 |
| `best.maxSuccessProbability` | 현재 상태에서 가능한 최고 SR 15 도달 확률 |
| `best.probabilityGap` | 최고 후보와 추천 후보의 확률 차이 |
| `best.vector` | 기대 키트 사용량 |
| `best.resourceCost` | 현재 전략 기준 수급 비용 |
| `topCandidates` | 후보별 확률/비용 비교 목록 |
| `route` | 실패만 이어졌을 때의 참고 경로 |
| `monteCarlo` | 검산 요청 시 가상 실행 결과 |

### 4.1 Monte Carlo 검산의 의미

Monte Carlo는 제품 추천을 고르는 기준이 아니다. 사용자가 검산 버튼을 누를 때, 고정 seed의
난수로 가상의 실행을 돌려 이론 계산과 크게 어긋나지 않는지 보여주는 보조 기능이다.

```ts
function simulate(input: AnyValue, actionFor: AnyValue, runs = 12000, seed = 20260505) {
  // ...
}
```

현재 제품 추천은 Monte Carlo 평균으로 결정되지 않는다. 추천은 exact MDP 값으로 결정된다.

### 4.2 exact 재계산 성공 확률과의 차이

현재 제품 계산은 한 번의 MDP 안에서 `V(state, stock)`을 계산한다. 연구용
exact interactive-replan evaluator는 UI 사용 흐름처럼 각 결과 분기마다 다시 `solve()`를
실행해 전체 확률을 합산한다.

```text
제품 계산:
  현재 state, stock에서 MDP value 계산

연구용 exact interactive-replan:
  정책이 추천한 행동 실행
  -> 대성공/실패 결과 분기
  -> 각 분기에서 실제 남은 재고로 다시 solve()
  -> 모든 분기 확률 합산
```

제품에서 exact interactive-replan을 매 계산마다 돌리지 않는 이유는 비용이다. A 기준선 검증에서
가장 비싼 sentinel인 `R0-balanced300`은 active compute만 609,777 ms가 걸렸다.

---

## 5. 현재 구조의 취약점과 한계

여기서 취약점은 보안 취약점만 뜻하지 않는다. 수학적 근사, 계산 비용, UX 오해 가능성,
미측정 위험까지 포함한다.

### 5.1 기대값 중심 정책

현재 정책은 기대 키트 사용량 `vector`를 수급 비용에 반영한다. 그러나 사용량 분포는 직접
평가하지 않는다.

예를 들어 두 후보가 있다고 하자.

```text
후보 A: 거의 항상 상급자 키트 50개 사용
후보 B: 50% 확률로 10개만 사용, 50% 확률로 90개 사용
```

둘의 평균은 50개다. 현재 비용식은 주로 평균 소비량을 본다. 그러나 실제 사용자가 느끼는
위험은 다르다. 후보 B는 운 나쁜 경로에서 희소 키트가 크게 털리는 꼬리 위험이 있다.

현재 제품 추천 기준에 직접 들어가지 않는 값:

| 항목 | 현재 추천 기준 반영 |
| --- | --- |
| 최소 필요 수량 | 직접 반영 안 함 |
| 최대 필요 수량 | 직접 반영 안 함 |
| 중앙값 | 직접 반영 안 함 |
| 분산 | 직접 반영 안 함 |
| p90/p95 사용량 | 직접 반영 안 함 |
| 키트 고갈 확률 | 직접 반영 안 함 |

따라서 “평균은 좋아 보이지만 운 나쁜 경로가 나쁜 후보”를 완전히 구분하지 못할 수 있다.

### 5.2 참고 통계: 단일 키트만 계속 사용할 때 필요한 수량 분포

위 설명만으로는 “그래서 실제 최소/최대가 어느 정도인가”를 감각적으로 보기 어렵다. 아래 표는
**한 종류의 키트만 계속 사용한다**는 단순 기준에서 계산한 참고 통계다.

전제:

- 재고 제한은 없다고 가정한다.
- 키트 1회 사용은 실제 키트 10개 소비다.
- R 15에 도달하면 즉시 SR 5로 교체한다고 가정한다.
- 현재 제품 정책처럼 키트를 섞어 쓰는 최적 추천 결과가 아니다.
- 분포는 정규근사가 아니라 대성공/실패 전이를 모두 합산한 exact 이산 분포다.
- `최소확률`은 해당 최소 횟수로 바로 끝날 확률이다.

#### R 0에서 SR 15까지, 단일 키트 고정

| 키트 | 최소(회/개) | 최소확률 | 중앙값(회/개) | 평균(회/개) | 표준편차(회) | p90(회/개) | p95(회/개) | 최대(회/개) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 초심자용 | 5 / 50 | 0.0001% | 82 / 820 | 82.80 / 828.0 | 28.70 | 121 / 1210 | 132 / 1320 | 225 / 2250 |
| 중급자용 | 5 / 50 | 0.0535% | 25 / 250 | 25.58 / 255.8 | 9.15 | 38 / 380 | 42 / 420 | 87 / 870 |
| 상급자용 | 5 / 50 | 3.0000% | 11 / 110 | 11.42 / 114.2 | 3.64 | 16 / 160 | 18 / 180 | 29 / 290 |

#### SR 0에서 SR 15까지, 단일 키트 고정

| 키트 | 최소(회/개) | 최소확률 | 중앙값(회/개) | 평균(회/개) | 표준편차(회) | p90(회/개) | p95(회/개) | 최대(회/개) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 초심자용 | 3 / 30 | 0.0010% | 85 / 850 | 86.06 / 860.6 | 31.23 | 127 / 1270 | 139 / 1390 | 225 / 2250 |
| 중급자용 | 3 / 30 | 0.0475% | 26 / 260 | 26.70 / 267.0 | 10.03 | 40 / 400 | 44 / 440 | 90 / 900 |
| 상급자용 | 3 / 30 | 0.7500% | 11 / 110 | 11.72 / 117.2 | 4.20 | 17 / 170 | 19 / 190 | 39 / 390 |

이 표에서 볼 수 있는 점:

- SR 0은 이론상 최소 횟수가 더 작다. 이미 SR 등급이므로 R 구간 3회를 거치지 않아도 된다.
- 하지만 최소 컷 확률은 매우 낮다. 예를 들어 SR 0 상급자용 3회 컷은 0.75%다.
- R 0은 최소 횟수는 5회로 더 크지만, R 구간이 쉽고 R 15가 SR 5로 교체되므로 평균/최대/꼬리에서
  SR 0보다 유리하거나 비슷한 경우가 많다.
- 특히 상급자용만 보면 R 0의 최대는 29회, SR 0의 최대는 39회다.
- 이 통계는 현재 제품 추천 기준에 직접 들어가지 않는다. 현재 제품은 여러 키트 후보를 섞어 비교하며,
  위 표의 중앙값/p90/p95/최대 같은 분포 통계가 아니라 기대 사용량 `vector`를 수급 비용에 반영한다.

제품 수준에서 이 정보를 활용하려면 두 방향이 가능하다.

1. 정보 표시용: 결과 패널에 `평균 / p90 / 고갈 확률` 같은 tail-risk 정보를 보여준다.
2. 추천 기준용: 평균 기대 사용량 외에 p90, p95, 고갈 확률을 비용 함수에 넣는다.

2번은 추천 정책 자체가 바뀌므로 별도 benchmark와 exact interactive-replan 평가가 필요하다.

### 5.3 정규분포 가정의 부적합

키트 필요 수량은 정규분포로 근사해 표현할 수는 있지만, 실제 구조는 정규분포보다 이산
확률분포에 가깝다.

이유:

- 키트는 10개 단위로만 사용된다.
- 보유 재고가 상한을 만든다.
- 대성공은 5/10/15 경계로 점프한다.
- 실패가 이어질 때 긴 꼬리가 생긴다.
- 낮은 재고와 희소 키트 상황에서는 분포가 비대칭이다.

따라서 개선한다면 단순 정규분포보다 다음 통계가 더 적합하다.

```text
p05 / p10 / median / p90 / p95
고갈 확률
운 나쁜 경로에서의 잔여 키트 수량
```

### 5.4 parent-independent continuation 근사

현재 MDP는 `(state, stockUses)`만 memoization key로 쓴다.

```text
V(state, stockUses)
```

이 값은 어떤 경로로 그 상태에 도달했는지는 알지 못한다. 즉 같은 상태와 같은 재고라면
앞에서 어떤 키트를 얼마나 많이 썼는지와 무관하게 같은 continuation 값을 재사용한다.

코드 주석도 이 점을 명시한다.

```ts
// This is deterministic and stable for each memoized (state, stock), but it is not a proof of
// global whole-route p-norm optimality. The memoized continuation is parent-independent, so
// prior route consumption is not part of the state.
```

비유하면 다음과 같다.

> 같은 산장에 물통이 같은 양 남은 채 도착했다면, 지금 알고리즘은 이전에 어떤 물통을
> 얼마나 무리해서 써 왔는지는 잊고 앞으로의 계획만 평가한다.

이 구조는 계산을 가능하게 만드는 핵심 최적화이지만, 긴 경로 전체의 p-norm 비용을 엄밀하게
최적화한다는 보장은 아니다.

### 5.5 경로 내 시간적 수급 압박 미반영

현재 수급 비용은 경로 진입 시점의 `initialStockPieces`를 분모로 사용한다.

```ts
const supplyCost = researchCostScore(vector, initialStockPieces, researchCostModel);
```

즉 한 가상 경로 안에서 같은 희소 키트를 여러 번 쓰더라도, 첫 사용과 마지막 사용의 가격이
시간에 따라 더 비싸지는 효과는 직접 들어가지 않는다.

비유:

```text
상급자 키트 30개를 가지고 시작
  1번째 사용: 아직 30개 있으므로 상대적으로 덜 부담
  3번째 사용: 거의 바닥이므로 훨씬 부담
```

현재 제품 정책은 이 “마지막 사용이 더 아까운 효과”를 별도 가격 상승으로 모델링하지 않는다.

### 5.6 1.0%p tolerance의 오해 가능성

현재 제품은 최고 SR 15 도달 확률보다 1.0%p 낮은 후보도 추천할 수 있다. 이는 의도된 정책이다.

그러나 사용자는 “왜 가장 높은 확률이 아닌 후보를 추천하지?”라고 느낄 수 있다. 결과 패널에서
`probabilityGap`을 충분히 설명하지 않으면 UX 오해가 생긴다.

### 5.7 exact interactive-replan 미사용

현재 제품 계산은 연구용 exact interactive-replan을 매번 돌리지 않는다. 이는 성능상 필수적인
선택이다.

취약점이라기보다는 trade-off다.

- 장점: 웹에서 즉시 계산 가능
- 단점: 실제 UI 흐름 전체를 펼친 exact 평가와 완전히 같은 목적함수는 아님

### 5.8 큰 재고에 대한 상태 공간 제한

MDP 상태 공간은 키트별 최대 관련 사용 횟수를 제한한다.

```ts
const MAX_RELEVANT_USES: KitVector = { blue: 220, purple: 88, yellow: 44 };
```

입력 재고가 이보다 커도 MDP search state는 관련 최대치로 제한된다. 비용식의 가용량은 실제
piece 재고를 보지만, 재귀 상태 공간은 cap된 사용 횟수로 계산된다.

이는 상태 폭발을 막기 위한 실용적 장치다. 다만 cap 추정이 잘못되면 초대량 재고 상황에서
정책 해석이 왜곡될 여지가 있으므로, cap 관련 회귀 테스트가 중요하다.

### 5.9 다회 추천과 수동 재고 수정

추천이 같은 키트를 여러 번 연속 사용하라고 말할 수 있다. 다회 사용 중 대성공이 발생하면
몇 번째에 발생했는지에 따라 실제 소비 재고가 달라진다.

UI는 이 경우 사용자에게 성공 회차를 묻거나, 일부 경우 수동 재고 수정을 요구한다. 이 흐름은
정확성을 위한 장치지만, 사용자가 회차를 잘못 입력하면 이후 계산도 틀릴 수 있다.

### 5.10 Worker fallback과 메인 스레드 계산

Worker 생성 실패 시 메인 스레드에서 `solve()`를 직접 실행한다. 이 fallback은 기능 안정성에는
좋지만, 매우 큰 입력에서 UI가 잠시 무거워질 가능성이 있다.

---

## 6. 논의된 보완 계획

### 6.1 B/C shadow-price 연구

기존 취약점 중 “경로 내 시간적 수급 압박”을 보완하기 위해 shadow-price 방식이 검토되었다.

목표:

```text
희소 키트를 많이 쓰는 경로일수록 그 키트의 암묵 가격을 올린다.
```

비유:

> 등산 계획을 세운 뒤, 특정 물통을 너무 많이 쓰는 계획으로 나오면 그 물통의 가격표를
> 올려 다시 계획을 짠다.

모델 정의:

| 모델 | 설명 |
| --- | --- |
| A | 현재 제품 정책 `phase1_availability_pnorm` |
| B | A의 예상 소비량으로 가격을 한 번 보정한 뒤 다시 계산 |
| C | 가격 보정과 재계산을 반복하는 bounded fixed-point 모델 |

### 6.2 B: single-update shadow-price

```text
1. A로 한 번 계산한다.
2. A의 기대 소비량에서 키트별 shadow price를 계산한다.
3. 그 가격으로 다시 한 번 solve한다.
4. root F가 A보다 나빠지면 A로 fallback한다.
```

의사코드:

```ts
function solveSingleUpdateShadow(input) {
  const baseline = solveWithResearchCostModel(input, availabilityPnorm);
  const prices = shadowGradient(baseline.best.vector, input.stock);
  const candidate = solveWithResearchCostModel(input, linearShadow(prices));
  return candidate.rootF <= baseline.rootF ? candidate : baseline;
}
```

### 6.3 C: bounded fixed-point shadow-price

```text
1. A로 초기 기대 소비량을 구한다.
2. 기대 소비량에서 가격을 계산한다.
3. 가격을 반영해 다시 solve한다.
4. 새 기대 소비량으로 가격을 다시 계산한다.
5. 추천 signature가 안정되면 종료한다.
6. cycle, timeout, max iteration이면 A로 fallback한다.
```

실제 연구 모델은 다음 방어 장치를 포함했다.

| 장치 | 목적 |
| --- | --- |
| damping `0.5` | 가격이 과하게 튀는 것을 완화 |
| max iterations `8` | 무한 반복 방지 |
| timeout `10,000 ms` | 과도한 계산 방지 |
| signature cycle 감지 | 같은 추천 패턴 반복 감지 |
| root objective safeguard | root `F`가 A보다 나빠지면 A fallback |

### 6.4 exact interactive-replan 평가

B/C는 root에서 좋아 보여도 실제 UI 흐름 전체에서는 나빠질 수 있다. 그래서 연구에서는
결과마다 다시 solve하는 exact evaluator를 사용했다.

의사코드:

```ts
function exactReplanValue(policy, state, stock) {
  if (state === "SR15") return 1;
  if (stock is empty) return 0;

  const action = policy.solve(state, stock).best.firstAction;
  const edge = transition(state, action);
  const nextStock = decrement(stock, action);

  return (
    edge.probability * exactReplanValue(policy, edge.success, nextStock) +
    (1 - edge.probability) * exactReplanValue(policy, edge.fail, nextStock)
  );
}
```

이 값이 “exact 재계산 성공 확률”이다.

### 6.5 채택 조건

연구 전에 다음 조건을 고정했다.

| 조건 | 의미 |
| --- | --- |
| exact 재계산 성공 확률이 A보다 낮아지지 않을 것 | 현재 정책보다 목표 달성 가능성을 악화시키지 않음 |
| interactive `F`가 보호 시나리오에서 악화되지 않을 것 | 수급 보존 목적도 망치지 않음 |
| probability gate 위반 0건 | 기존 `max - 0.01` 정책 계약 유지 |

이 조건은 보수적이다. 개선 모델을 제품 기본값으로 바꾸려면 일부 좋은 사례가 아니라 보호
시나리오에서의 비악화가 필요하다고 판단했다.

---

## 7. 실험 진행 결과

### 7.1 A 기준선 검증

A 기준선 exact evaluator는 필수 sentinel 5개를 모두 완료했다.

| 시나리오 | 실제 계산 시간 | 경계 solve 횟수 | 성공 확률 | Interactive F | Gate 위반 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `R0-balanced300` | 609,777 ms | 39,564 | 0.9999999999999998 | 0.024659813280066945 | 0 |
| `SR0-balanced300` | 135,848 ms | 14,672 | 0.9999999999999998 | 0.026706662774961247 | 0 |
| `R0-balanced100` | 18,919 ms | 2,516 | 0.9078240851567179 | 0.35691614548825096 | 0 |
| `SR0-balanced100` | 3,126 ms | 937 | 0.8691509913512931 | 0.38639717112739064 | 0 |
| `R14e900-yellow30` | 197 ms | 111 | 0.5814477455800285 | 0.452573837916863 | 0 |

총 active compute는 767,867 ms였다.

결론:

- A는 연구 후보와 비교할 기준선으로 사용할 수 있다.
- 이 결과는 A를 교체하라는 뜻이 아니라, B/C를 평가해도 된다는 전제 통과다.

### 7.2 B/C exact pilot 결과

| 시나리오 | 모델 | Exact 성공 확률 | Interactive F | A 대비 성공 확률 변화 | A 대비 F 변화 | 판정 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `R14e900-yellow30` | A | 0.5814477455800285 | 0.4525738379168630 | - | - | 기준선 |
| `R14e900-yellow30` | B | 0.5854778239184680 | 0.4554618867922021 | +0.0040300783384395 | +0.0028880488753391 | 기각: F 악화 |
| `R14e900-yellow30` | C | 0.5809695512322890 | 0.4547045363154545 | -0.0004781943477395 | +0.0021306983985915 | 기각: 성공 확률 및 F 악화 |
| `SR5-blue30` | A | 0.9565117082385661 | 0.2016306298740647 | - | - | 기준선 |
| `SR5-blue30` | B | 0.9563314325784384 | 0.2006232166491749 | -0.0001802756601277 | -0.0010074132248898 | 기각: 성공 확률 악화 |
| `SR5-blue30` | C | 0.9564833775151333 | 0.2005449832268461 | -0.0000283307234328 | -0.0010856466472186 | 기각: 성공 확률 악화 |
| `SR0-balanced100` | A | 0.8691509913512931 | 0.3863971711273906 | - | - | 기준선 |
| `SR0-balanced100` | B | 0.8695927910281485 | 0.3807100679816476 | +0.0004417996768554 | -0.0056871031457430 | 개선 신호만 확인 |
| `SR0-balanced100` | C | 0.8709616366733679 | 0.3820550274167669 | +0.0018106453220748 | -0.0043421437106237 | 개선 신호만 확인 |

해석:

- B/C는 일부 상황에서 성공 확률과 `F`를 함께 개선했다.
- 그러나 보호 시나리오에서 성공 확률 또는 `F`를 악화시켰다.
- 제품 기본 정책은 일부 좋은 사례만으로 바꿀 수 없다.
- 따라서 현재 B/C는 drop-in replacement로 기각했다.

### 7.3 왜 더 큰 평가를 생략했나

원래 B/C가 pilot 필수 조건을 통과했다면 다음 평가가 필요했다.

- 96개 전체 grid deep evaluation
- tail-risk trajectory significance
- D1-weighted strata 우선순위 분석
- Web Worker 체감 성능 평가

하지만 B/C는 저비용 deterministic exact pilot에서 이미 필수 조건을 위반했다.

따라서 더 비싼 평가를 수행해도 현재 B/C의 제품 채택 결론을 뒤집을 수 없다. 이는 평가 누락이
아니라 fail-fast 기각이다.

---

## 8. 지금까지 고려된 방법과 대안

### 8.1 MDP 상태에 누적 소비량 추가

아이디어:

```text
V(state, stockUses, cumulativeConsumption)
```

장점:

- 경로 내 누적 소비를 정확히 상태에 넣을 수 있다.

거부 이유:

- 상태 공간이 폭발한다.
- 현재 solver의 핵심 장점인 memoization 효율이 크게 무너진다.
- 코드 주석에서도 실용적 refinement는 상태 확장이 아니라 shadow-price pass라고 명시했다.

### 8.2 Shadow-price fixed-point

아이디어:

- 누적 소비를 상태에 넣지 않고, 희소 키트의 암묵 가격을 반복 보정한다.

평가:

- 실험 대상으로 채택했다.
- B/C로 구현했다.
- 현재 정의의 B/C는 exact pilot에서 기각했다.

### 8.3 사용자에게 전략 토글 제공

아이디어:

```text
확률 우선 / 균형 / 키트 보존
```

또는:

```text
supply / supply-conservative
```

기존 판단:

- B/C를 사용자 노출 전략으로 제공하는 것은 부적절하다. 이미 보호 시나리오에서 기각된 후보이기 때문이다.
- 다중 전략 토글은 UX 혼란을 키울 수 있다.

다만 현재 A 정책의 probability tolerance만 조절하는 3단계 슬라이더는 별도 가능성이 있다.

예시:

| 단계 | tolerance | 의미 |
| --- | ---: | --- |
| 확률 우선 | 0.1%p | 최고 확률 후보에 가깝게 선택 |
| 균형 | 1.0%p | 현재 기본값 |
| 키트 보존 | 2.0%p | 조금 더 확률을 양보하고 희소 키트 보존 |

주의:

- tolerance를 바꾸면 A 자체가 새 정책이 된다.
- B/C를 다시 후보로 올리려면 새 tolerance 조건에서 다시 평가해야 한다.
- 1차 구현을 한다면 B/C 제외, A tolerance 조절만 검토하는 편이 안전하다.

### 8.4 D1 진단 데이터 기반 결정

아이디어:

- 운영 `solver_diagnostic` 집계를 보고 위험군이 얼마나 자주 발생하는지 판단한다.

한계:

- D1 진단 데이터는 노출 빈도다.
- 대안 모델을 같은 입력에서 돌린 개선 효과가 아니다.
- stock도 bucket으로 저장되어 정확한 사용자 입력 재생이 불가능하다.

따라서 D1 데이터는 우선순위 신호로만 사용하고, 채택 결정 근거로 단독 사용하지 않는다.

### 8.5 exact interactive-replan을 제품 계산에 직접 사용

아이디어:

- 연구 evaluator처럼 모든 결과 분기에서 다시 solve하며 추천한다.

거부 이유:

- 계산 비용이 너무 크다.
- A 기준선 sentinel 하나가 약 10분 이상 걸렸다.
- 웹 계산 버튼에 넣을 수 있는 방식이 아니다.

### 8.6 분포 기반 tail-risk 표시

아이디어:

현재 제품은 평균 기대 사용량을 고려한다. 추가로 다음을 계산하거나 표시한다.

```text
예상 사용량
중앙값
p90/p95 사용량
고갈 확률
운 나쁜 10% 경로의 잔여 키트
```

장점:

- 사용자가 “평균은 괜찮지만 운 나쁜 경로가 위험한 후보”를 이해할 수 있다.
- shadow-price보다 설명 가능성이 높을 수 있다.

주의:

- 추천 기준에 넣을지, 정보 표시만 할지는 별도 결정이 필요하다.
- tail-risk 계산은 Monte Carlo 또는 별도 분포 DP가 필요하다.
- 제품 성능과 UI 복잡도를 함께 평가해야 한다.

---

## 9. 현재 정책을 이해하기 위한 비유

### 9.1 현재 A 정책

현재 A는 다음과 같은 내비게이션이다.

> 목적지는 SR 15다. 각 갈림길에서 목적지 도착 확률을 계산한다. 도착 확률이 거의 같은
> 길들이 있으면, 앞으로 부족해질 물통을 덜 쓰는 길을 고른다.

단점:

> 앞으로 전체 여정에서 특정 물통을 계속 쓰게 되는 경로라면, 뒤로 갈수록 그 물통이 더
> 귀해진다. 하지만 현재 A는 이 가격 상승을 경로 전체에 엄밀히 누적하지 않는다.

### 9.2 B/C shadow-price

B/C는 다음과 같은 보정 내비게이션이다.

> 처음 계획을 보고 특정 물통을 너무 많이 쓰는 것이 보이면, 그 물통의 가격을 올려 다시
> 계획한다.

문제:

> 가격을 올렸더니 어떤 상황에서는 물통은 조금 아끼지만 목적지 도착 확률이 낮아졌다.
> 또 어떤 상황에서는 현재 시점의 가격표는 괜찮아 보여도 전체 재계산 흐름에서 부담이
> 나빠졌다.

따라서 제품 기본 내비게이션으로 바꾸지 않았다.

---

## 10. 현재 결론과 다음 선택지

### 10.1 현재 결론

- 제품은 기존 A 정책을 유지한다.
- B/C는 연구 후보로 기각됐다.
- 연구 API와 benchmark는 향후 재설계 비교를 위해 보존할 수 있다.
- D1 가중 분석과 full tail-risk 평가는 현재 B/C에 대해서는 수행하지 않는다.

### 10.2 단기적으로 가능한 안전한 개선

1. 결과 패널에 `probabilityGap`을 더 명확히 표시한다.
2. 현재 추천이 최고 확률 후보보다 몇 %p 낮은지 설명한다.
3. 기대 키트 사용량과 실제 보유량 대비 부담을 더 읽기 쉽게 표시한다.

### 10.3 중기 연구 후보

1. A tolerance 3단계 조절 실험
2. tail-risk 표시용 Monte Carlo trajectory collector
3. 키트별 p90/p95 사용량과 고갈 확률 표시
4. 새 dynamic pressure 모델 재설계

### 10.4 제품 채택 조건

새 모델이 제품 기본 정책을 대체하려면 최소한 다음을 만족해야 한다.

```text
1. 기존 A보다 exact 재계산 성공 확률이 낮아지지 않을 것
2. 보호 시나리오에서 interactive F가 악화되지 않을 것
3. 기존 probability gate 계약을 위반하지 않을 것
4. Web Worker 환경에서 사용자 체감 성능을 해치지 않을 것
5. 결과가 UI에서 설명 가능할 것
```

---

## 11. 참고 파일

핵심 코드:

- [`src/worker.ts`](./src/worker.ts): Web Worker 메시지 계층
- [`src/hooks/useSolverWorker.ts`](./src/hooks/useSolverWorker.ts): Worker 생성, 캐시, fallback
- [`src/solver.ts`](./src/solver.ts): MDP solver와 현재 정책
- [`src/hooks/useCalculatorState.ts`](./src/hooks/useCalculatorState.ts): 활성 전략 `supply`

연구 코드와 문서:

- [`benchmarks/README.ko.md`](./benchmarks/README.ko.md): 연구 개요
- [`benchmarks/BASELINE_FINDINGS.ko.md`](./benchmarks/BASELINE_FINDINGS.ko.md): A 기준선 검증
- [`benchmarks/SHADOW_PILOT_FINDINGS.ko.md`](./benchmarks/SHADOW_PILOT_FINDINGS.ko.md): B/C 기각 결과
- [`benchmarks/models/shadow-price.ts`](./benchmarks/models/shadow-price.ts): B/C 연구 모델
- [`benchmarks/evaluator/exact-replan.ts`](./benchmarks/evaluator/exact-replan.ts): exact interactive-replan 평가기
- [`benchmarks/trajectory.ts`](./benchmarks/trajectory.ts): trajectory/tail-risk 실험 기반

---

## 12. 핵심 요약

현재 Worker/solver는 **평균 기대 사용량 기반의 수급 고려 MDP**다. 대성공/실패로 인한 성장,
재고 감소, SR 15 도달 확률, 키트별 기대 소비량은 계산한다. 그러나 분포 기반 꼬리 위험과
경로 내 시간적 수급 압박은 현재 제품 추천 기준에 직접 반영하지 않는다.

이 한계를 보완하기 위해 shadow-price B/C를 설계하고 exact interactive-replan으로 평가했다.
B/C는 일부 개선 신호가 있었지만, 필수 보호 시나리오에서 성공 확률 또는 interactive `F`를
악화시켰다. 그래서 현재 제품에는 연결하지 않는다.

다음으로 가치가 큰 방향은 B/C를 억지로 살리는 것이 아니라, 현재 A 정책의 tolerance 조절
가능성이나 tail-risk 표시/평가를 별도 실험으로 검토하는 것이다.
