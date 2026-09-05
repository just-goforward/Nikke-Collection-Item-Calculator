# 동작 보존 리팩터링 검증 기록

2026-09-05 작업의 변경 범위와 검증 근거를 정리한다. 테스트 통과는 검증한 입력·환경의
회귀 근거이며, 가능한 모든 재고·기기에서 결과가 같다는 수학적 증명으로 표현하지 않는다.
Forecast 내용 채택과 production Worker 승인은 이 기록의 범위 밖이다.

## 변경 단위

| 변경 | 목적과 보존 경계 | PR |
|---|---|---|
| 테스트 런타임 분리 | 앱 Vitest/coverage-v8 5.0.0, Cloudflare Worker 6개는 공식 plugin에 맞는 Vitest 4.1.11을 사용한다. 제품 의존성과 혼합하지 않는다. | [#39](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/39) |
| readiness probe | 배포 직후 일시적인 준비 지연과 최종 실패를 구분한다. 실제 schema·신원 검사는 유지한다. | [#40](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/40) |
| tooltip lifecycle | 기존 body portal을 유지하고 위치 재측정과 정리 책임을 다듬는다. | [#41](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/41) |
| 통계 HTTP 경계 | bounded HTTP 및 Turnstile 재시도 처리를 정리한다. 수집 의미와 solver 실행을 분리한다. | [#42](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/42) |
| 결과 입력 흐름 | 순수 outcome plan과 부수 효과를 분리한다. 다회 추천·재고 수정·자동 다음 계산을 회귀 검증한다. | [#43](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/43) |
| Discord 공유 계약 | 메시지/interaction의 공통 규칙을 공유하고 환경별 권한 경계를 유지한다. | [#44](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/44) |
| CI 실행 경계 | 외부 Action SHA 고정, timeout 및 workflow 정적 검사를 적용한다. | [#45](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/45) |
| solver 내부 정리 | 중복 loader와 임시 저장소 관리를 정리한다. ABI·semantic/node-count golden 및 지연 검증을 유지한다. H/p와 fallback 정책은 바꾸지 않는다. | [#46](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/46) |
| 문서·lint·번들 | Worker 전체 lint 범위와 문서를 맞추고 소비되지 않는 style/keyframe 정의만 제거한다. | [#47](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/47) |
| 자동 PR 검증 | bot branch를 명시적으로 검증하고 반환 run ID와 SHA를 대조한다. 생성 파일은 줄 수 대신 codegen 정합 검사를 유지한다. | [#48](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/48) |
| Collector HTTP 분리 | 공통 auth/rate/quota 순서를 유지하면서 operations/source/canary/Discord route를 나눈다. | [#49](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/49) |
| migration runner | 기존 SQL을 바꾸지 않고 파일·ledger 검증과 재실행을 공통화한다. production 승인 job 안에 유지한다. | [#50](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/pull/50) |

각 PR의 병합 상태와 최종 SHA는 GitHub가 정본이다. 새로운 업무는 완료된 위 작업을 다시
구현하지 말고, 현재 main과 후속 diff를 먼저 비교한다.

## CI에서 발견한 추가 결함

- GitHub workflow dispatch의 200 응답에는 `workflow_run_id`가 있다. 204만 성공으로 보는
  helper를 수정하고, 200에서는 접수된 ID와 요청한 SHA가 모두 맞는 run을 확인하도록 했다.
- inactive Forecast 데이터가 늘면서 자동 생성 파일이 900줄 규칙에 걸렸다. 정확히 두 개의
  Forecast 생성 출력만 수동 코드의 파일 길이 규칙에서 제외했다. 임의 생성 경로는 제외하지
  않으며 `check:supply-forecast`의 입력/출력 정합 검사는 그대로다.
- CI merge SHA를 포함한 번들의 initial JS gzip이 130,000바이트 예산을 5~8바이트 넘었다.
  예산은 올리지 않고 실제 미사용 style/keyframe 정의를 제거했다. 같은 실패 SHA로 재빌드하여
  135바이트 감소를 확인했다. 남은 여유는 작으므로 SHA를 포함하는 CI 빌드 검사를 유지한다.
- README에 Naver SmartEditor HTML의 자동 처리가 불가능하다는 과거 설명이 남아 있었다.
  현재 Actions adapter의 구조 marker/공식 작성자 검증과 fail-closed 조건으로 고쳤다.

## 직접 확인한 증거

- 문서/lint/번들 전체 CI: [run 33951713849](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/33951713849).
- 자동 PR helper 전체 CI: [run 33951773616](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/33951773616).
- Collector HTTP 분리 전체 CI: [run 33951742820](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/33951742820).
- 실제 automation namespace branch의 명시적 검증: [run 33951775125](https://github.com/just-goforward/Nikke-Collection-Item-Calculator/actions/runs/33951775125).
  `verify`는 성공했고 `deploy` 및 `post-deploy-smoke`는 건너뛰었다. 이 임시 브랜치는 병합하지
  않고 제거했으며 후보 #37과 활성 Forecast는 변경하지 않았다.
- Collector는 10개 파일 106개 통합 테스트와 양쪽 환경 Wrangler dry-run을 통과했다.
  관리자 인증·rate/quota 순서, 허용 method와 staging 전용 경로를 검사했다.
- migration은 실제 SQL의 빈 DB bootstrap, 이전 버전 upgrade, backfill, 재시작/no-op,
  ledger 오류 및 실행 실패를 검사했다. 통합 후 migration/workflow/dispatch 99개 테스트,
  전체 typecheck와 lint가 통과했다. 원격 production D1 변경은 로컬 검증에 포함하지 않는다.

전체 Pages verify에는 lint, 타입 검사, 앱/Worker 테스트, Rust format/clippy/WASM build,
Playwright E2E·visual·다국어·정렬 검사와 bundle budget이 포함된다. 실제 Android 17 기기나
모든 사용자 환경에서 수행한 실험으로 대체해서 설명하지 않는다.

## 운영 경계와 남는 제한

- 제품 `activeForecastId`, solver H/p 및 사용자 계산 정책은 바꾸지 않는다. 후보 #15·#37은
  별도 일정/연구 근거와 관리자 검토가 필요하다.
- `main`은 `verify`, 세 언어 CodeQL Analyze, CodeQL 결과와 최신 main 포함 검증을 요구한다.
  기존 관리자 예외를 남겼지만 작업 절차에서 실패 검사를 우회하지 않는다.
- Collector HTTP 및 migration refactor의 production Worker 승격은 별도 canary·환경 승인
  경계를 따른다. 코드 병합과 production 배포 완료는 서로 다른 사실이다.
- migration runner는 외부에서 변형되거나 부분 적용된 schema를 자동 복구하지 않는다.
- benchmark 원시 결과와 mutation report는 gitignored 산출물이다. 검증 요약만 추적하며,
  중복 연구 데이터나 임시 작업 파일을 제품 코드에 포함하지 않는다.
- 기존 미커밋 작업이 있는 이전 worktree는 강제 정리하지 않는다.

운영 절차는 [Forecast Runbook](./forecast-automation-runbook.ko.md), 현재 Forecast 보류와
재개 조건은 [Forecast 상태](./forecast-status.ko.md)를 따른다.
