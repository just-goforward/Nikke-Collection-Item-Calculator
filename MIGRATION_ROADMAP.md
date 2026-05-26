# 소장품 레벨업 계산기 유지보수 로드맵

이 문서는 현재 구현을 기준으로 후속 변경의 경계와 검증 기준을 기록한다. 과거 Vue
전환 및 `legacy-controller.ts` 제거 과정은 완료된 이력이며, 현재 구현 대상이 아니다.

## 현재 기준선

- 프론트엔드: React 19 + Vite + Tailwind CSS v4 (`@theme` 토큰과 컴포넌트 내부
  `classes` 상수 사용)
- 계산: Web Worker에서 MDP solver 실행, Worker 생성 실패 시 동적 import 폴백
- 통계 조회: Cloudflare Worker `/api/stats` + D1 집계
- 통계 제출: `useStatsSubmission` -> FIFO queue -> action별 Turnstile widget ->
  `/api/events`
- 이벤트 저장: `event_ids`와 aggregate UPSERT를 하나의 D1 batch로 commit

## 변경 시 지켜야 할 계약

### Solver

- 실제 사용자 UI는 `supply` 전략을 사용하고, `single`은 테스트·비교 기준선으로
  보존한다.
- Supply 비용은 다음 근사식을 사용한다.

  ```text
  availability[kit] = stock[kit] + 0.5 * expected28DayGain[kit]
  cost = (Σkit (expectedUse[kit] / availability[kit])^3)^(1/3)
  ```

- 이 비용은 deterministic하게 계산되지만 누적 소모를 상태에 포함하지 않으므로
  전체 경로 p-norm 최적성을 보장하지 않는다.
- solver 규칙 또는 확률표 변경 시 `src/solver.test.ts`와 검산/벤치마크를 함께
  실행한다.

### Statistics

- 공개 통계는 결과 입력 표본의 이벤트 단위 참고 지표이며 사용자별 성과 분석이
  아니다.
- `/api/stats`의 `levelKitStats`와 `successAttemptDistribution`은 현재 UI가
  사용하지 않지만, 구버전 프론트 호환을 위해 빈 배열 필드로 유지한다.
- `/api/events`의 `kit_result`와 `solver_diagnostic`은 모두 FIFO 제출과 동일
  `eventId` 재시도 규칙을 유지한다.
- `RATE_LIMIT_SECRET`과 `TURNSTILE_SECRET_KEY`가 없는 배포 환경은 통계 이벤트를
  수집해서는 안 된다.

### UI

- Tailwind CSS v4 구조를 유지하며 CSS Modules 또는 스타일 variant 라이브러리로
  되돌리지 않는다.
- 반응형 레이아웃, 테마 전환, tooltip, modal, 모바일 하단 조작부 변경은 E2E와
  visual snapshot으로 고정한다.
- tooltip과 modal은 키보드 및 터치 접근성을 함께 유지한다.

## 단기 작업

1. 미사용 stats 계산 제거 후 응답 크기와 `/api/stats` TTFB를 재측정한다.
2. Worker secret 설정, Turnstile 오류 분류, 이벤트 저장 오류를 운영 점검 항목으로
   유지한다.
3. 중간 viewport와 오류 상태를 포함하는 E2E 시나리오를 필요에 따라 추가한다.

## 측정 후 검토할 작업

- 누적 통계 쿼리가 실제 지연 원인이 될 때만 `Server-Timing`, revision 기반 D1
  snapshot 또는 rollup 테이블을 검토한다.
- Phase 2 solver 정확화는 오프라인 벤치마크와 비공개 bucket 진단값이 현재
  휴리스틱의 문제를 보여줄 때만 진행한다. 후보 접근은 shadow-price fixed-point다.
- 커스텀 도메인, edge cache, KV snapshot, D1 read replication은 트래픽과 지연
  측정이 정당화할 때만 진행한다.

## 공통 검증 게이트

```powershell
npm run lint
npm run typecheck
npm test
npm run test:worker
npm run build
npm run test:e2e
npm run test:visual
```

Worker를 배포하기 전에는 필요한 Cloudflare secret이 대상 환경에 설정되어 있는지
확인하고, 배포 후에는 정상 계산 흐름의 이벤트 제출과 `/api/stats` 응답을 직접
확인한다.
