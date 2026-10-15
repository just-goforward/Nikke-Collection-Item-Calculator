# 품질 검토 보조 점검 목록

변경을 검토할 때 함께 보는 **보조 질문 목록**이다. 기존 시험, 이중 리뷰, Test
Engineer·Security 역할 지침을 대신하지 않으며, 그쪽에 이미 있는 내용은 다시 적지
않는다. 질문에 해당하는 변경이 있을 때만 쓰고, 이 목록 자체가 시험 실행·도구 설치·
로그 추가·설정 변경을 허가하지 않는다. 각 항목의 위치는 "적용할 만한 곳"이며
결함이 있다는 뜻이 아니다.

외부 플랫폼·라이브러리 동작은 기억이 아니라 `cloudflare-evidence-first`,
`library-docs-first` 스킬의 절차로 확인한다.

## 1. 무작위 입력(속성) 시험의 품질

기존 fast-check 시험(`src/solver.domain.property.test.ts`, `scripts/*.property.spec.ts`)을
추가·수정할 때 확인한다.

- 이 성질은 구현이 틀려도 통과할 수 있는가? 기대값을 구현 코드로 다시 계산하고
  있지 않은가?
- 생성된 입력 대부분이 전제 조건(`fc.pre`, 필터)에서 버려져 실제로 검사되는 경우가
  거의 없지 않은가? 버려지는 비율을 확인했는가?
- 계약이 정당화하는 범위 안에서 가장 강한 성질을 썼는가? (예: "오류가 없다"보다
  "독립 기준과 같다", "되돌리면 원래 값")
- 실패했을 때 줄어든(shrink) 반례가 원인을 알아볼 만큼 작고, 시드가 고정되어 다시
  만들 수 있는가?
- 정확 비교(유리수·BigInt)로 정한 곳을 허용 오차 비교로 느슨하게 바꾸지 않았는가?
- 유한 횟수 무작위 시험은 전체 입력에 대한 증명이 아니다. 확률 보정·희귀 사건·
  통계적 검정력은 별도 통계 검토로 다룬다.

## 2. Rust↔WASM 경계

`rust/certified/src/lib.rs`의 `extern "C"` 내보내기(`certified_input`,
`certified_output_ptr`, `certified_output_len`, `certified_release`, `certified_call`),
`rust/certified/src/allocation.rs`, `rust/solver-rs/`의 같은 종류 경계를 바꿀 때 확인한다.

- `unsafe` 블록마다 지켜야 할 전제(포인터 유효성, 길이, 정렬, 수명)가 주석이나
  코드로 드러나 있는가? 호출하는 쪽(TypeScript)이 그 전제를 실제로 지키는가?
- 같은 메모리를 가리키는 가변 참조가 동시에 생기거나, 해제한 버퍼를 다시 읽는
  경로가 없는가? 출력 포인터·길이를 받은 뒤 다음 호출이 그 버퍼를 덮어쓰지 않는가?
- 입력 길이·크기 계산에서 넘침(overflow)이나 과도한 할당이 일어날 수 있는가?
- 패닉이 경계를 넘을 때 동작이 정해져 있는가? 잘못된 입력이 패닉 대신 오류 코드로
  돌아오는가?
- `unsafe` 근거가 Rust 공식 문서(Reference, 표준 라이브러리 문서)나 명시된 프로젝트
  불변식에 닿는가? "보통 이렇게 동작한다"는 경험에 기대지 않는가?
- TypeScript 쪽 해석(`src/certified/wasmBackend.ts`)이 Rust 쪽 출력 형식과 함께
  바뀌었는가? 형식이 바뀌면 `certified_abi_version` 값을 올려, 맞지 않는 조합이
  `certified_wasm_abi_mismatch`로 거부되게 했는가?

## 3. Worker 요청 처리

`cloudflare/`, `personal-data/`, `site-worker/`, `usage-guard/`, `forecast-*/`,
`stats-observer/`의 요청·정기 작업 처리기를 바꿀 때 확인한다.

- 응답 내용이나 성공 여부가 달린 작업은 응답 전에 끝나는가? 응답 뒤에 해도 되는
  작업만 `ctx.waitUntil`로 넘기고, 기다리지 않은 Promise가 조용히 버려지지 않는가?
- `waitUntil`은 시간 제한이 있는 연장일 뿐 완료 보장이 아니다. 반드시 끝나야 하는
  작업은 다시 시도할 수 있는 기록(DB 상태, 다음 정기 작업)으로 이어지는가? 시간 제한은
  처리기 종류(HTTP 요청, 정기 작업)별 공식 문서 값을 따른다.
- 모듈 최상위 변수에 요청별 값(사용자, 세션, 토큰)을 담아 다른 요청과 섞일 수 있지
  않은가?
- 요청 본문·외부 응답을 읽을 때 크기 상한이 있는가? 상한을 넘으면 정해진 오류로
  끝나는가?
- 비교가 필요한 비밀값(관리 키, 서명)은 시간이 일정한 비교를 쓰는가?
- 무작위 값(토큰, 상태, nonce, ID)은 `crypto.getRandomValues`나 `crypto.randomUUID`로
  만드는가? `Math.random`을 쓰지 않는가?
- 정기 작업 한 번의 DB 호출 수·처리량이 문서화된 상한 안에 있는가?

## 4. D1 사용

`personal-data/src/auth.ts`(`readSession`, `revokeAll`, `consumeOAuthTransaction`),
`personal-data/src/store.ts` 등 D1 질의를 바꿀 때 확인한다.

- 행을 고르기 전에 소유자·권한 조건이 질의에 들어 있는가? 읽은 뒤 코드에서 거르는
  방식에 기대지 않는가?
- 여러 문장이 함께 성공해야 하는 변경이 한 `batch` 안에 있는가? 나뉘어 있다면 중간
  실패 뒤의 상태가 안전한가?
- 실패 후 다시 시도하는 쓰기가 두 번 적용되어도 결과가 같은가(멱등)? 아니라면 재시도를
  막았는가?
- 방금 쓴 값을 바로 읽어야 하는 흐름에서 오래된 값을 읽을 가능성을 고려했는가?
- 신뢰할 수 없는 **값**은 항상 `bind`로 넘기는가? SQL 문장을 이어 붙이는 경우,
  붙이는 조각이 코드에 고정된 문자열이나 허용 목록에서 고른 것뿐인가? (`bind`는 값만
  대신할 수 있고 테이블·열 이름은 대신할 수 없다.)
- 목록 질의에 상한과 정해진 정렬이 있는가?
- 구조 변경은 새 migration 파일로만 하고, 이미 적용된 파일을 고치지 않았는가?
  로컬(`--local`)과 원격(`--remote`) 대상이 맞는가?

## 5. 실패 시 열리는 기본값과 실수하기 쉬운 설정

로그인·권한·사용량 보호(`personal-data/`, `usage-guard/`, `site-worker/src/worker.ts`)를
바꿀 때 확인한다.

- 환경변수·비밀값이 없거나 잘못됐을 때 기능이 "허용"으로 동작하지 않고 거부로
  끝나는가?
- 기능 플래그 기본값(예: `PUBLICATION_ENABLED`)이 꺼짐 쪽인가? 정확한 켜짐 값
  (`"true"`)일 때만 켜지고, 대소문자·공백이 다른 값을 포함한 그 밖의 모든 값은 꺼짐으로
  남는가? 값을 정규화해 켜짐 조건을 넓히지 않았는가?
- 허용 출처·경로 목록이 정확 일치인가? 접두사·부분 문자열 비교로 넓어지지 않았는가?
- 쿠키 속성(`Secure`, `HttpOnly`, `SameSite`, `Path`)과 만료가 의도대로인가?
- 오류 처리 분기에서 검사를 건너뛰고 다음 단계로 넘어가는 경로가 없는가?

## 6. React 화면 성능

`src/` 화면 코드를 바꿀 때, 측정 근거가 있을 때만 적용한다. Next.js 전용 기법은
대상이 아니다.

- 서로 의존하지 않는 비동기 요청을 순서대로 기다리지 않는가?
- 계산으로 얻을 수 있는 값을 별도 state로 두고 effect로 맞추고 있지 않은가?
- 무거운 계산이 렌더링마다 반복되지 않는가? 메모이제이션이 실제로 효과가 있는가?
- 큰 기능이 첫 화면 번들에 들어오지 않는가? 번들 예산 검사(`npm run
  check:bundle-budget`) 결과와 맞는가?

## 7. 접근성·다국어 페이지

기존 시험(`e2e/accessibility.spec.ts`의 axe·키보드·초점 검사,
`e2e/localized-pages.spec.ts`의 canonical·hreflang·JSON-LD 검사)이 있으므로 그 시험이
다루지 않는 새 화면·상태에만 적용한다.

- 새 위젯의 초점 동작이 그 위젯 종류의 약속과 맞는가? 모달 대화상자는 열릴 때 초점이
  안으로 들어가고 닫히면 대체로 연 요소로 돌아오며, 펼침 패널은 초점을 옮기지 않아도
  된다. 다르게 정했다면 이유가 있는가?
- 마우스로만 열리는 기능이 없는가? 새 상태(오류, 진행 중, 빈 화면)에서도 axe 검사가
  돌아가는가?
- 새 페이지·주소를 추가했다면 세 언어 모두에 서로를 가리키는 hreflang,
  `hreflang="x-default"`, 자기 자신을 가리키는 canonical이 있는가? 손으로 태그를 쓰지
  않고 기존 생성기(`scripts/localized-pages.ts`)를 거치는가?
- 숫자·날짜 표시가 언어 설정을 따르는가?

## 참고 출처

아래 자료의 아이디어를 참고해 이 저장소에 맞게 새로 쓴 질문이다. 원문은 복사·번역하지
않았다. 자료가 바뀔 수 있으므로 다시 참고할 때는 고정 커밋을 기준으로 한다.

| 분야 | 출처 (확인한 커밋) | 라이선스 |
|---|---|---|
| 1 | `trailofbits/skills` `property-based-testing` (`e1f86a3`) | CC-BY-SA-4.0 |
| 2 | `trailofbits/skills` `rust-review` (`e1f86a3`), `google/rust-skills` `unsafe_rust_review` (`4b4f8b2`) | CC-BY-SA-4.0, Apache-2.0 |
| 3 | `cloudflare/skills` `workers-best-practices` (`be68fd8`) | Apache-2.0 |
| 4 | `cloudflare/skills` `skills/cloudflare/references/d1/` (`be68fd8`) | Apache-2.0 |
| 5 | `trailofbits/skills` `insecure-defaults`·`sharp-edges` (`e1f86a3`) | CC-BY-SA-4.0 |
| 6 | `vercel-labs/agent-skills` `react-best-practices` (`063bee9`) | MIT |
| 7 | `vercel-labs/web-interface-guidelines` (`434b7f9`), `coreyhaines31/marketingskills` `seo-audit` (`55ff469`) | MIT |
