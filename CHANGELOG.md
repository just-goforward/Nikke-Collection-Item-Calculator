# Changelog

소장품 레벨업 계산기의 주요 변경 이력을 기록합니다.

## 2026-09-05

### Forecast 보류 상태 문서화, 아키텍처 감사 및 고재고 회귀 보강

- production Forecast 자동화 인프라와 현재 활성·staging·미병합 후보의 책임 경계를 정리하고,
  제품 Forecast는 기존 `supply-2026-08-21-v1`로 유지한 채 재개 절차를 별도 문서화했습니다.
- 아키텍처 검사 대상에서 빠져 있던 Forecast Dispatcher, Discord Interaction Router와 Stats
  Observer를 검사 루트와 진입점에 추가했습니다. Worker 간 허용 의존성과 기존 복잡도·타입
  경계는 파일·함수 단위의 제거 조건이 있는 부채 목록으로 제한했습니다.
- Android에서 보고된 `R0 / 720·330·195`, 기존 `770·330·190`, 두 번째 phase2 overflow
  segment의 용량 능선 `820·320·160`을 실제 WASM 회귀 테스트에 추가했습니다. 첫 행동, 기대
  사용량 vector의 binary64 값, 상태 수와 메모리 segment 수를 고정했습니다.
- `fast-uri`와 `qs` 전이 의존성을 패치 버전으로 고정해 현재 npm 보안 취약점을 0건으로
  정리했습니다.
- Biome 2.5.12, Playwright 1.63.0, React DOM 타입 19.2.7, Wrangler 4.129.0으로 갱신하고
  여섯 Worker의 생성 타입과 `workerd` 설치 허용 목록을 동기화했습니다.
- 앱·스크립트 테스트를 Vitest 5와 Coverage V8 5로 올리고, Cloudflare 공식 plugin이 아직
  요구하는 Vitest 4.1.11은 여섯 Worker workspace에 격리했습니다. lockfile 기반 경계 검사가
  서로 다른 테스트 런타임의 우발적 혼합을 차단합니다.

### 동작 보존 리팩터링과 운영 검증 정비

- 결과 적용, 다회추천 대성공 회차 처리와 R15 교체를 순수 전이 계획으로 분리하고, 기존 재고
  snapshot·통계 보류·자동 다음 계산 계약을 104개 Playwright 흐름으로 재검증했습니다.
- Discord interaction의 서명, 요청 크기, freshness, payload와 custom ID 계약을 중립 공유
  모듈로 옮겼습니다. Collector의 D1 mutation과 운영 경보, Router의 권한 경계는 그대로
  분리했습니다.
- Rust solver의 write-only scratch 전역과 중복 WASM URL loader를 제거했습니다. 공개 ABI,
  action·확률·vector·cost·status·node count 및 product/research instance 격리는 유지됩니다.
- 외부 GitHub Action을 immutable commit SHA로 고정하고 모든 workflow job에 실행 상한을
  두었습니다. 저장소 검사기가 mutable ref와 누락된 timeout을 재도입하지 못하게 합니다.
- Worker 배포 readiness probe는 이전 edge version의 짧은 전파 지연만 제한적으로 재시도하고,
  새 배포의 schema·계약 불일치는 즉시 실패하도록 정리했습니다.
- 후보 사유 tooltip을 body portal로 옮기고 후보 표 ResizeObserver의 생명주기를 mount 단위로
  고정했습니다. 통계 오류 본문은 16KiB로 제한하고 Turnstile loader는 timeout 후 재시도할 수
  있게 했습니다.
- Workers Paid Usage Guard, Forecast canary v10과 Stats Observer의 배포·canary·promotion 계약을
  문서와 검증 명령에 연결했습니다. Forecast 활성화와 production 승인은 계속 별도 경계입니다.

## 2026-08-13

### 계산 흐름·Worker 배포·운영 계약 보강

- Worker 배포 직후 이전 엣지 버전이 잠시 응답할 때 `/api/health` 404만 최대 60초간
  재시도하고, 새 버전이 응답하면 D1 스키마 계약을 검증하도록 했습니다.
- 원격 D1 스키마 검사 스크립트가 Node ESM에서 공유 계약 모듈을 실제로 불러오도록
  TypeScript 확장자를 명시했습니다.
- 결과 검산이 최초 계산에서 실제로 종료된 solver backend를 따르도록 고정해,
  recovery ladder 이후 다른 backend로 검산하는 의미론 이탈을 막았습니다.
- R15 교체 안내는 키트 재고만 수정했을 때 유지하고, 실제 R15 상태에서만 교체·자동
  계산이 실행되도록 상태 경계를 보강했습니다.
- 모바일에서 계산이 실제로 시작된 뒤에만 결과 탭으로 전환하고 포커스를 이동하며,
  `#stats` hash 진입·이탈과 로딩 중 초기화·교체 버튼 상태를 대칭으로 정리했습니다.
- 등급·단계 선택에 방향키, Home, End 키 이동을 추가하고, 통계·세부 정보 lazy chunk
  로드 실패가 전체 앱을 빈 화면으로 만들지 않도록 지역 재시도 경계를 추가했습니다.
- 펼쳐진 검산 영역은 새 계산 결과가 생길 때마다 자동으로 다시 검산하고, 오류·취소 상태는
  닫았다 다시 열 때만 재시도해 무한 반복을 피하도록 동작을 정리했습니다.
- WebKit에서 대성공 회차 선택지의 작은 재고 수량도 WCAG AA 명암비를 만족하도록 보조
  텍스트 대비를 높였습니다.
- Worker의 chunked JSON 본문을 streaming 크기 제한으로 읽고, 필수 D1 테이블·열을 확인하는
  `/api/health`와 로컬·원격 스키마 검사 도구를 추가했습니다.
- staging·production 배포와 수동 rollback의 smoke 실패 시 직전 Worker 버전을 자동
  복원하도록 했습니다. D1 migration은 Worker 버전 복원에 포함되지 않으므로 분리된
  운영 절차로 유지합니다.
- 세 언어 README의 공개·비공개 통계 범위와 개발 도구 기준을 현재 코드에 맞게
  정정하고, 연구 문서 색인과 Vite 빌드별 제3자 라이선스 고지 산출물을 추가했습니다.
- `wrangler` 4.122.0, `@cloudflare/vitest-pool-workers` 0.21.2와 이에 대응하는
  `workerd` 생성 타입·설치 스크립트 allowlist를 갱신했습니다.
- Pages 사전 검증은 현재 프런트엔드가 소비하는 공개 통계 계약만 확인하고, D1 health와
  write 계약은 Worker 배포 후 smoke에서 검사하도록 배포 순환 의존을 제거했습니다.
- Worker 변경 감지에서 staging 데이터 초기화용 `reset-staging.sql`은 migration 차단
  대상에서 제외하되 실제 스키마·migration SQL 변경은 계속 수동 적용하도록 유지했습니다.

## 2026-08-09

### 차세대 solver·플랫폼 연구

- complete-policy 전수열거와 HiGHS 1.14.0의 3단 occupancy LP가 compact exact DP와 일치함을
  확인해 작은·중간 상태의 독립 연구 oracle을 완성했습니다.
- layer-streaming, backward-distance pruning, strong admissible bound, Lagrangian columns를
  구현·검증했지만 `R10-balanced300`의 상태 capacity나 root 인증 gate를 통과하지 못했습니다.
- 전역 단조성은 내부 exact policy에서 행동 재진입 반례 13,679건으로 기각했고, exact DAG
  abstraction은 27.73% 압축으로 사전 gate 30%에 미달했습니다.
- certified approximation과 strict distribution cover는 허용 오차·폭 gate를 실패했습니다.
  SIMD는 parity만 통과하고 속도·크기 gate를 실패했으며, threads는 배포 헤더와 shared memo
  구조가 없어 현재 제품 후보에서 제외했습니다.
- WebGPU 정수 frontier는 데스크톱 key parity를 통과했지만 exact graph capacity를 줄이지
  못했고 연결 Android의 Chrome 자동 실행도 불가능해 채택하지 않았습니다.
- 후속 연구에 재사용할 exact oracle·범용 측정 도구만 유지하고, 기각 후보의 일회성 구현과 전용
  runner·대량 산출물은 Git 추적 대상에서 제외했습니다. 판정과 핵심 수치는 연구 문서에 남겼습니다.
- 제품 solver, `public/solver_rs.wasm`, UI, Worker protocol, D1 schema와 telemetry는 변경하지
  않았습니다. 상세 판정은
  [`docs/research/next-solver-research-findings.ko.md`](docs/research/next-solver-research-findings.ko.md)에
  기록했습니다.

## 2026-08-08

### Rust phase2 방법론 연구

- phase2 cap offset, min-E[f] 행동 순서, 성공확률 gate 적용 CVaR, sparse constrained
  policy iteration을 현재 raw-pieces·`τ=0`, `H=0.75`, `p=3` 계약에서 비교했습니다.
- cap offset과 행동 순서 변경은 의미 있는 상태 또는 용량 개선을 만들지 못해 기각했습니다.
- gate-aware CVaR는 122개 root 중 2개 행동을 바꿨지만 exact interactive 공동 품질
  기준을 통과하지 못했습니다.
- sparse policy iteration은 일부 fallback fixture의 interactive 자원 지표를 개선했지만,
  현재 TypeScript 연구 구현이 phase2보다 warm p95 기준 약 3.85~28.58배 느려 제품 runtime에
  연결하지 않았습니다.
- 후속 Rust-native 우선순위 sparse PI는 작은 fixture에서 min-E[f] 의미론을 재현했지만,
  R10 exact closure가 120만 state budget을 초과했고 bounded 후보도 phase2보다 warm p95가
  약 1.52배 느렸으며 candidate WASM이 115KB 예산을 넘어서 연구 전용으로 유지했습니다.
- 공개 저장소에는 benchmark/evaluator 소스, 핵심 fixture와 판정 문서만 유지하고, 대량
  JSON·분석 notebook·candidate WASM·profiler/trace/checkpoint 산출물은 Git에서 제외했습니다.
- Node.js 24.19.0, npm 12.0.2 환경에서 `@types/node` 26.2.0, `wrangler` 4.120.0,
  `@cloudflare/vitest-pool-workers` 0.20.3으로 개발 의존성을 갱신했습니다.
- 상세 판정: [`docs/research/phase2-methodology-findings.ko.md`](docs/research/phase2-methodology-findings.ko.md)

## 2026-08-06

### H/p 정책 검증, AGPL 전환 및 문서 정리

- 현재 Rust min-E[f]와 phase2 ladder에서 `H × p` 49개 조합을 122개 root 시나리오로
  재평가하고, exact interactive 및 tail-risk gate를 거쳐 기존 `H=0.75`, `p=3`, `τ=0`
  정책을 유지했습니다.
- 프로젝트 코드를 `AGPL-3.0-or-later`로 공개하고, 배포 commit에 대응하는 소스 링크와
  제3자 고지를 추가했습니다. Pretendard는 SIL Open Font License 1.1을 유지합니다.
- 현재 구현에서 소비되지 않는 과거 계획·보고 문서와 중복 설계 문서를 제거했습니다.
- 28일 키트 기대 획득량 근거를 `docs/research`의 추적 문서로 승격하고 현재 21일 수급
  지평 계약에 맞게 갱신했습니다.
- GitHub 프로젝트 안내를 한국어 기본 README와 영어·일본어 선택 문서로 확장했습니다.
- `@vitejs/plugin-react` 6.0.5, `wrangler` 4.119.0,
  `@cloudflare/vitest-pool-workers` 0.20.2로 개발 의존성을 갱신했습니다.
- 상세 판정: [`docs/research/min-ef-hp-study-findings.ko.md`](docs/research/min-ef-hp-study-findings.ko.md)

## 2026-07-29

### Rust solver 정책 품질 연구

- 현재 raw-pieces·`τ=0`, `H=0.75`, `p=3` 계약으로 phase2 MC rerank와 exact one-step
  rerank를 다시 평가했습니다.
- exact interactive-replan evaluator에 키트별 고갈 확률, 최소 잔여량, typed solver
  failure를 추가했습니다.
- min-E[f] fallback 시나리오에서 두 rerank 후보가 제품 채택 기준을 통과하지 못해
  production runtime은 변경하지 않았습니다.
- 기존 CVaR ABI는 raw pieces를 보존하지만 성공확률 gate와 interactive policy 검증
  경계가 없어 연구 신호로만 유지합니다.
- 상세 판정: [`docs/research/solver-policy-quality-findings.ko.md`](docs/research/solver-policy-quality-findings.ko.md)

## 2026-07-26

### 단일 대성공 자동 처리와 문서 정리

- 추천 행동이 1회일 때 대성공 O를 선택하면 성공 시점을 1회차로 확정합니다.
  - 사용한 키트 10개를 자동으로 차감합니다.
  - 별도 재고 수정이나 성공 시점 팝업 없이 다음 추천을 즉시 계산합니다.
- 2회 이상 추천이 R 15 또는 SR 15에 도달할 때만 성공 시점 선택 팝업을 표시합니다.
- 성공 시점 선택지에서 대성공 회차를 우선 강조하고 남은 재고는 보조 정보로 표시합니다.
- 운영 문서, 설계 문서, 연구 기록, 시각 검증 증거의 용도를 다시 점검하고 오래된 solver 경로를
  현재 모듈 구조에 맞게 정리했습니다.

## 2026-06-11

### Rust min-E[f] 기본 solver 및 세부 정보 개선

- 기본 계산 경로를 Rust `min-E[f]` solver로 전환했습니다.
  - 상태공간 한계(`MEMO_FULL`)에 도달하면 Rust phase2 solver로 폴백합니다.
  - 운영 경로의 WASM/worker 실패는 기존 JavaScript fallback 정책을 유지합니다.
- 세부 정보 패널을 확장했습니다.
  - `SR 15 도달 확률`과 `구간 대성공 확률`은 정수 퍼센트일 때 소수점을 생략합니다.
  - 후보 표의 `SR 15 도달 확률`과 `구간 대성공 확률`은 `%` 위치가 세로로 맞도록 정렬했습니다.
  - 예상 소모량은 세로 목록 대신 한 줄에 가까운 압축 표시로 정리했습니다.
- 가상의 니붕이 검증 결과 시각화를 개선했습니다.
  - 단순 확률축 대신 성공자 수 기준 이항분포/정규근사 그래프를 표시합니다.
  - 계산 기준, 이번 검증, 95% 근사 범위, 표준편차, 왜도, 초과첨도를 함께 보여줍니다.
  - 다시 검증하는 동안 기존 시각화 영역을 유지하고, 새 결과가 완료되면 갱신합니다.
- 개발 의존성을 갱신했습니다.
  - `typescript` 6.0.3
  - `miniflare` 4.20260609.0
  - `@cloudflare/workers-types` 4.20260611.1
- Cloudflare Worker payload 검증 코드를 정리해 Biome optional-chain 경고를 제거했습니다.

## 2026-06-04

### Rust WASM staging solver experiments

- Added Rust WASM status handling for solver capacity limits.
  - `STATUS_BUDGET_EXCEEDED` and `STATUS_MEMO_FULL` are reported as normal solver statuses instead of traps.
  - Staging Rust paths fail explicitly on these statuses instead of silently falling back.
- Added staging-only Rust phase2 backend.
  - Enabled with `?statsEnv=staging&solverBackend=rust-phase2`.
  - The default production path remains the JavaScript phase2 solver.
- Added staging-only Rust phase2 rerank backend.
  - Enabled with `?statsEnv=staging&solverBackend=rust-phase2-rerank`.
  - Root candidates are filtered by exact phase2 probability gate first.
  - Eligible first actions are reranked by fixed-seed first-action E[f] rollout.
  - A held-out seed is recorded for the selected action to expose seed sensitivity.
  - Historical note: runtime selection wiring was removed on 2026-06-21. The rerank
    implementation now remains research-only and is not an active product backend.
- Added Rust staging smoke coverage and diagnostic-version tests for the new solver variants.

## 2026-06-01

### Solver 기본 추천 정책 개선

- 3단계 슬라이더 캘리브레이션 연구에서 지배 후보로 확인된 `tau0-h0.75-p3` 정책을 실제 배포용 기본 solver에 적용했습니다.
  - 수급 가용성 지평을 14일치(`H=0.5`)에서 21일치(`H=0.75`)로 조정했습니다.
  - `supply` 전략의 성공확률 허용폭을 1.0%p에서 0%p로 조정해, 기본 추천은 최대 SR 15 도달 확률 후보 안에서 수급 비용을 비교합니다.
  - p-norm 차수는 기존과 동일하게 `p=3`을 유지합니다.
- 통계 진단 이벤트의 solver 버전을 `phase2_availability_h075_tau0_p3` / `phase2`로 갱신했습니다.
- 연구용 `(τ,H,p)` benchmark와 historical A 기준은 유지하되, production `solve()`의 기본 경로만 새 정책으로 전환했습니다.

## 2026-05-27

### 통계 수집 정확성 및 보안

- 통계 이벤트 저장을 D1 batch 기반 원자적 처리로 변경했습니다.
  - 이벤트 ID와 관련 집계를 한 트랜잭션으로 기록해, 집계 실패 후 재시도가 중복 처리로 막히며 통계가 누락되는 문제를 방지합니다.
  - `kit_result`와 `solver_diagnostic` 모두 정상 처리, 중복 제출, rollback, 실패 후 동일 ID 재시도를 Worker 통합 테스트로 검증합니다.
- 브라우저의 통계 제출을 FIFO queue로 직렬화했습니다.
  - 동시에 발생하는 공개 결과 이벤트와 비공개 진단 이벤트가 Turnstile token을 충돌 없이 각각 발급받아 제출됩니다.
  - 재시도 시 같은 event ID를 유지하고 새 token을 사용해 D1 중복 방지와 복구 흐름을 함께 보장합니다.
- Turnstile 검증과 오류 분류를 보강했습니다.
  - action별 widget과 명시적 실행 방식을 사용하고, 유효하지 않은 `size: "invisible"` widget 옵션을 제거했습니다.
  - Worker에서 Siteverify 일시 실패를 같은 token과 `idempotency_key`로 1회 재시도합니다.
  - Siteverify 요청을 `application/x-www-form-urlencoded` 형식으로 전송하고, HTTP 400 응답의 `error-codes`를 보존해 secret 설정 오류와 일시 장애를 구분합니다.
  - token, IP, payload를 남기지 않고 실패 종류와 action 불일치만 관측하도록 로그 범위를 제한했습니다.
- `RATE_LIMIT_SECRET`이 없는 환경은 fallback secret으로 동작하지 않고 통계 제출을 거부하도록 변경했습니다.

### 통계 응답 및 화면

- 공개 `/api/stats` 응답에서 현재 화면이 사용하지 않는 통계 계산을 제거했습니다.
  - `successAttemptDistribution` 별도 D1 쿼리와 `levelKitStats` 생성 비용을 제거했습니다.
  - 기존 클라이언트 호환을 위해 두 응답 필드는 빈 배열로 유지합니다.
- 통계 난이도 구간 tooltip의 글꼴 스타일을 복구하고, 키보드 연결 및 `Escape` 닫기 동작을 보강했습니다.
- 대성공 발생 회차 modal에 `Escape` 닫기, focus trap, 닫은 뒤 focus 복귀 동작을 추가했습니다.

### 검증 환경 및 배포

- 운영 통계를 오염시키지 않고 실제 Turnstile 및 D1 저장 흐름을 확인할 수 있는 staging 통계 환경을 추가했습니다.
  - `?statsEnv=staging`으로 별도 Worker, D1, Turnstile widget을 사용하며 화면에 staging 배너를 표시합니다.
  - `?demoStats=1`과 `?statsEnv=disabled`에서는 통계 이벤트 전송을 중지합니다.
  - staging 데이터 초기화를 위한 marker guard 및 reset SQL을 추가했습니다.
- staging에서 `최초 계산 -> 대성공 X -> 자동 다음 계산` 흐름을 검증해 `kit_result` 1건과 `solver_diagnostic` 2건 저장을 확인한 뒤 시험 데이터를 초기화했습니다.
- Miniflare 기반 Worker 통합 테스트, 제출 queue 및 Turnstile 단위 테스트, Playwright 시나리오를 보강했습니다.
- GitHub Actions의 Linux Chromium 환경에서 시각 회귀 테스트가 동작하도록 Ubuntu baseline을 추가했습니다.

## 2026-05-06

- 계산 방식 선택지를 추가했습니다.
  - `단일 목표`: 지금 이 소장품을 SR 15로 만들기 위한 최적의 선택
  - `수급량 고려`: SR 15 도달 확률을 크게 깎지 않는 선에서 수급량/보유량을 함께 고려
- MDP 정책 기준을 `SR 15 도달 확률 최대화`에서 `도달 확률 보존 + 소모 효율` 중심으로 조정했습니다.
- 수급량 고려 계산에 28일 기대 획득량 기준을 반영했습니다.
  - 초심자용 관리 키트: 473.912개
  - 중급자용 관리 키트: 55.808개
  - 상급자용 관리 키트: 24.736개
- 수급량 고려 모드의 SR 15 도달 확률 허용폭을 1.0%p로 조정했습니다.
- 수급량 고려 모드의 후보 비교 방식을 복합 비용 기준으로 변경했습니다.
  - 수급 비용 75%
  - 현재 보유량 압박 25%
- 계산 결과 후보 표에 `최대 대비 차이`를 추가해, 최대 SR 15 도달 확률과의 차이를 확인할 수 있게 했습니다.
- 다회 사용 추천을 지원했습니다.
  - 중간에 대성공이 발생하면 레벨만 이동하고, 보유 키트 수는 사용자가 직접 수정하도록 안내합니다.
- R 15레벨과 SR 15레벨을 단계 선택에 추가했습니다.
  - R 15레벨은 `SR 등급으로 교체`를 안내합니다.
  - SR 15레벨은 최종 목표 상태로 처리합니다.
- Web Worker를 사용해 계산 중 화면 멈춤을 줄였습니다.
- 계산 중 로딩 오버레이를 추가했습니다.
- Monte Carlo 검산을 접힌 영역으로 이동했습니다.
  - PC는 12,000회, 모바일은 3,000회 검산을 사용합니다.
- Monte Carlo 검산을 기본 계산에서 분리했습니다.
  - 추천 행동은 정확 MDP 계산만으로 먼저 표시합니다.
  - 검산은 세부 정보에서 `몬테카를로 검산 실행`을 눌렀을 때만 실행합니다.
- 입력별 계산 캐시를 추가했습니다.
  - 같은 등급, 레벨, 경험치, 전략, 보유 키트 조합으로 다시 계산하면 이전 MDP 결과를 재사용합니다.
- MDP 내부 상태 key를 문자열에서 정수 기반 key로 변경했습니다.
  - 결과는 유지하면서 문자열 생성과 가비지 컬렉션 부담을 줄였습니다.
- MDP 내부에서 이미 정규화된 상태를 다시 정규화하지 않도록 빠른 경로를 추가했습니다.
- 상태별 worst-case 사용 횟수 기반 동적 cap을 추가했습니다.
  - 각 상태에서 SR 15 도달 전 소비될 수 없는 초과 재고를 MDP 탐색에서 제외합니다.
  - cap 계산 실패 시 기존 재고를 그대로 사용하는 fallback 안전장치를 추가했습니다.
- 테마 선택 기능을 추가했습니다.
  - 자동, 라이트, 다크 모드를 지원합니다.
  - 기기 다크 모드 설정을 자동 모드에서 반영합니다.
- R/SR 등급 색상과 단계 버튼 스타일을 조정했습니다.
  - R: `#22B0F4`
  - SR: `#883FBE`
  - 공통 텍스트 색상: `#F8FCFE`
- 모바일 및 중간 폭 화면의 반응형 레이아웃을 개선했습니다.
  - 단계 버튼 overflow 수정
  - 보유 키트 입력칸 압축 문제 수정
  - 테마 선택 영역 크기 조정
  - 현재 경험치 표시를 `현재 경험치 / 필요 경험치` 형태로 정리
- 키트 명칭을 정식 표기로 변경했습니다.
  - 초심자용 관리 키트
  - 중급자용 관리 키트
  - 상급자용 관리 키트
- 대성공 결과 적용 버튼을 추가했습니다.
  - `대성공 O`
  - `대성공 X`
- 대성공 O 선택 시 보유 키트 수 직접 수정 안내와 강조 표시를 추가했습니다.
- 다회 대성공으로 R 15 또는 SR 15에 도달하는 경우, 대성공 발생 시점을 선택하는 필수 팝업을 추가했습니다.
  - 선택한 시도 횟수만큼 보유 키트를 자동 차감하고 통계를 즉시 전송합니다.
  - `모르겠음` 선택 시 시도 분포 통계는 생략하고 보유 키트 직접 수정을 안내합니다.
- Cloudflare Workers + D1 + Turnstile 기반 통계 수집 구조를 추가했습니다.
  - 통계 이벤트는 익명 집계 목적으로 전송됩니다.
  - Turnstile 및 IP 기반 요청 제한을 사용합니다.
  - 공개 통계 조회용 `/api/stats` 엔드포인트를 사용합니다.
- 통계 수집 Worker의 요청 처리 비용과 공격 방어 흐름을 개선했습니다.
  - Turnstile 전후 2단계 rate limit 적용
  - rate limit 증가 쿼리를 `RETURNING` 기반 1쿼리로 축소
  - cleanup 예약 중복 제거
  - 이벤트 전송 후 통계 재조회에 500ms 지연 적용
- 전체 통계 표시 항목을 확장했습니다.
  - 누적 참여 현황: 총 집계, 오늘 집계, 30일 최다 사용 키트
  - 레벨별 이론 vs 실측 대성공률
  - 대성공 시도 분포 세로 히스토그램
  - 평균 시도 횟수 기준 구간별 체감 난이도
- 개인정보 및 통계 수집 안내 문구를 footer에 추가했습니다.
- GitHub Pages 배포 방식을 `dist` + GitHub Actions 구조로 정리했습니다.
- 정적 파일 minify 스크립트를 추가하고 배포용 파일을 `dist`에 생성하도록 정리했습니다.
- GitHub Actions workflow를 Node.js 24 대응 가능한 action 버전으로 구성했습니다.
- 계산 영역과 추천 행동 영역의 한국어 문구가 글자 단위로 잘리지 않도록 줄바꿈 처리를 조정했습니다.
