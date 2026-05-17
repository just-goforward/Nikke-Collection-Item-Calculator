# Phase 2~4 Migration Roadmap

이 문서는 현재 `Vue shell + legacy-controller.ts` 구조에서 `React + Vite` 기반 구조로 옮기는
작업 순서, 성공 기준, 검증 명령을 고정한다. 목표는 기능을 유지하면서 명령형 DOM 조작을
React 상태/이벤트 구조로 단계적으로 흡수하는 것이다.

## Current Baseline

- Phase 1 안전망은 적용된 상태다.
  - Biome: `npm run lint`
  - Vitest: `npm test`
  - Playwright smoke: `npm run test:e2e`
  - TypeScript check: `npm run typecheck`
- Zod 경계 검증은 적용된 상태다.
  - 브라우저 Web Worker 요청/응답: `src/schemas.ts`
  - `/api/stats` fetch 응답: `src/schemas.ts`
  - Cloudflare `/api/events` request body: `cloudflare/src/schemas.ts`
- React shell 전환은 적용된 상태다.
  - `src/App.tsx`
  - `src/main.tsx`
  - `src/components/*.tsx`
  - `vite.config.ts`의 React 플러그인
- 아직 남은 핵심 부채:
  - `src/legacy-controller.ts`가 계산 상태, worker 통신, 통계, 결과 적용, tooltip, modal orchestration을
    계속 소유한다.
  - React 컴포넌트들은 일부 상태를 들고 있지만, 많은 흐름이 CustomEvent bridge에 의존한다.

## Global Gate

각 단계가 끝날 때 아래 명령이 모두 통과해야 한다.

```powershell
& "C:\Program Files\nodejs\npm.cmd" run lint
& "C:\Program Files\nodejs\npm.cmd" test
& "C:\Program Files\nodejs\npm.cmd" run test:e2e
& "C:\Program Files\nodejs\npm.cmd" run typecheck
& "C:\Program Files\nodejs\npm.cmd" run build
```

수동 확인이 필요한 화면:

- R 15 선택 시 `SR 등급으로 교체` 안내와 적용
- SR 10 + 키트 입력 후 계산 결과와 세부 정보 표시
- 대성공 O/X 적용 후 레벨, 경험치, 보유 키트 반영
- 다회 대성공으로 R15/SR15 도달 시 회차 입력 모달
- 테마 자동/라이트/다크 토글
- `?demoStats=1` 통계 화면과 구간별 tooltip
- 390px, 660px, 980px, desktop 폭의 주요 버튼 줄바꿈

## Phase 2.4: React + Vite Bootstrap

목표: Vue 런타임을 제거하고 React shell로 동일한 화면 구조를 렌더링한다.

상태: 완료.

완료 기준:

- `vue`, `@vitejs/plugin-vue`, `vue-tsc` 제거
- `react`, `react-dom`, `@vitejs/plugin-react`, React type package 추가
- `vite.config.ts`가 `react()` 플러그인을 사용
- `src/main.tsx`가 `createRoot(...).render(<App />)`로 앱 마운트
- `src/App.vue`, `src/components/*.vue`, `src/main.ts`, `src/vue-shims.d.ts` 제거
- `src/App.tsx`, `src/components/*.tsx`, `src/main.tsx` 추가
- class, id, label, aria-label, data 속성은 기존 smoke test가 통과할 정도로 유지

검증:

- Global Gate 전체
- 특히 `npm run test:e2e`에서 기존 smoke가 React 전환 후에도 통과해야 한다.

## Phase 2.5: legacy-controller.ts Strangler Migration

목표: `legacy-controller.ts`가 가진 상태, 이벤트, 렌더링 책임을 React 컴포넌트와 훅으로 흡수한다.

원칙:

- 한 번에 삭제하지 않는다.
- 패널 하나를 옮길 때마다 Global Gate 중 최소 `lint`, `typecheck`, `test:e2e`를 실행한다.
- 새 파일은 처음부터 명시 타입으로 작성한다.
- `body.theme-dark`, `body.theme-light` CSS 계약은 유지한다.
- `data-theme`나 Tailwind `dark:` 전환은 Phase 3 이후에만 검토한다.

권장 순서:

1. `StatePanel`
   - `selectedGrade`, `selectedLevel`, `selectedExp`를 React state/reducer로 이동
   - `renderStatePanel`, `setGrade`, `setState`, `sanitizeExp`, `updateLevelButtons`, `updateLevelMode` 제거
   - 계산 입력은 React state에서 직접 만들어 solver runner에 전달

2. `StockPanel`
   - `selectedStock`, `manualStockEditRequired`를 React state/reducer로 이동
   - `renderStockPanel`, `setStockCountForKit`, `currentStockSnapshot`, `stockCountForKit` 제거
   - 대성공 O 후 수동 수정 안내도 React state로 처리

3. `SolvePanel`
   - `selectedStrategy`, `calculateDisabled`를 React state/reducer로 이동
   - `renderSolvePanel`, `setStrategy`, `markInputChanged`, `clearManualStockLock` 제거
   - 계산/초기화 버튼은 JSX event handler로 직접 연결

4. `ResultPanel`
   - `latestResult`, `renderResult`, `renderError`, `renderOutcomeApplied`, `applyOutcome`, `applyConvert`를
     React state/action으로 이동
   - `innerHTML` 또는 CustomEvent 기반 결과 렌더링 제거

5. `DetailPanel`
   - 후보/메트릭/Monte Carlo 검산 UI 상태를 React state로 이동
   - `renderDetailPanel`, `renderDetailValidation`, `renderEmptyDetail` 제거
   - 검산 버튼은 hook action으로 직접 연결

6. `StatsPanel`
   - `/api/stats` fetch, demo stats, tooltip state를 React hook으로 이동
   - `renderStatsPanel`, `renderGlobalStats`, tooltip DOM 직접 생성 제거
   - `/api/stats` 응답 Zod 검증은 유지

7. `TopBar`
   - theme state, localStorage sync, system theme listener를 `useTheme` hook으로 이동
   - `THEME_PANEL_CHANGE_EVENT`, `THEME_STATE_EVENT` bridge 제거
   - 기존 body class toggle 계약은 유지

8. 마무리
   - `src/legacy-controller.ts` 삭제
   - `src/main.tsx`에서 `bootCalculator()` import/call 제거
   - `biome.json`에서 `!src/legacy-controller.ts` ignore 제거
   - 전체 `npm run lint:fix` 실행
   - Global Gate 전체 실행

추출 권장 모듈:

- `src/hooks/useCalculatorState.ts`
- `src/hooks/useSolverWorker.ts`
- `src/hooks/useStats.ts`
- `src/hooks/useTheme.ts`
- `src/hooks/useSuccessAttemptModal.ts`
- `src/services/statsEvents.ts`
- `src/services/sourceHost.ts`
- `src/services/turnstile.ts`
- `src/utils/format.ts`

## Phase 3: Type and Style Hardening

전제: `legacy-controller.ts`가 삭제된 뒤 진행한다.

### Strict TypeScript

목표:

- `tsconfig.json`
- `cloudflare/tsconfig.json`

설정:

```json
{
  "strict": true,
  "noImplicitAny": true
}
```

완료 기준:

- `npm run typecheck` 0 error
- 신규 React hook/component/service에 `any`가 남지 않음
- Web Worker protocol과 stats payload는 Zod schema와 TypeScript type이 일치

### Tailwind CSS v4

전제: React 컴포넌트 구조가 안정화된 뒤 진행한다.

목표:

- 기존 CSS token을 Tailwind `@theme`로 이전
- 컴포넌트 단위로 utility class 적용
- 대응되는 `src/styles.css` selector를 점진 삭제

주의:

- 현재 다크/라이트 테마는 `body.theme-dark`, `body.theme-light`가 기준이다.
- Tailwind `dark:` 또는 `data-theme` 전환은 별도 migration으로 진행한다.
- 기존 모바일 breakpoints인 390px, 660px, 980px 구간을 Playwright 또는 수동 검증으로 유지한다.

## Phase 4: Optional Tools

이 단계는 필수 migration 이후에만 검토한다.

### TanStack Query

도입 후보:

- `/api/stats`: `useQuery`
- `/api/events`: `useMutation`

도입하지 않는 영역:

- MDP 계산기 핵심 상태
- 현재 소장품/보유 키트/결과 반영 reducer

판단 기준:

- 통계 fetch 재시도, refetch, cache invalidation 코드가 커졌을 때 도입한다.

### React Hook Form + Zod Resolver

판단 기준:

- 현재 경험치, 보유 키트, 레벨 입력의 검증 규칙이 더 복잡해질 때 도입한다.
- 단순 정수/100단위 입력만 유지된다면 React state로 충분하다.

### Zustand

판단 기준:

- `useReducer`와 props 전달만으로 패널 간 상태 전달이 과해질 때 도입한다.
- Phase 2.5 완료 전에는 도입하지 않는다.

## Completion Audit Checklist

| Requirement | Evidence | Status |
| --- | --- | --- |
| React + Vite shell로 전환 | `src/main.tsx`, `src/App.tsx`, `vite.config.ts`, React deps | Done |
| Vue runtime 제거 | `package.json`에 Vue deps 없음 | Done |
| Vue SFC 제거 | `src/App.vue`, `src/components/*.vue`, `src/vue-shims.d.ts` deleted | Done |
| legacy-controller 해체 순서 명확화 | Phase 2.5 section | Done |
| strict 전환 기준 명확화 | Phase 3 Strict TypeScript section | Done |
| Tailwind 도입 조건 명확화 | Phase 3 Tailwind section | Done |
| 선택 도구 도입 기준 명확화 | Phase 4 section | Done |
| 검증 명령 명확화 | Global Gate section | Done |
| 현 시점 미완료 범위 표시 | Current Baseline, Phase 2.5 | Done |

