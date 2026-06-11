# Changelog

소장품 레벨업 계산기의 주요 변경 이력을 기록합니다.

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
