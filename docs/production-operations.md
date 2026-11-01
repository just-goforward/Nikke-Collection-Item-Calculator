# 운영 구성·권한·입력·검증 절차

` scripts/production-operating-catalog.mjs `에서 생성한다. 생성 문서를 직접 편집하지 않는다.

이번 OFF 출시에서 Observer Diagnostics 전환과 Operator profile은 제외한다. 아래 해당 두 구성은 미포함 구현과 별도 승인이 필요한 미래 제안이며 현재 배포 가능한 profile로 취급하지 않는다. 생성·일치 검사는 두 설정 파일을 변경하거나 요구하지 않으며, 고정 후보는 기존 HEAD의 Observer 설정·구현을 함께 보존한다.

## A — 운영 대상·DB·바인딩·경로·Cron

단일 편집 원본은 scripts/production-operating-catalog.mjs이다. 승인된 설계 후보는 기존 7개와 운영자 gateway를 합친 8 Worker / 기존 D1 4개이며 절대 최소 구성 인증이 아니다. 실제 production-worker.ts의 Ingest/PublicStats/RawReader/Diagnostics export에 로컬 서비스 바인딩을 연결한다. 원래 운영 D1 4개의 이름·ID를 그대로 유지한다. staging 자원을 운영에 재사용하지 않는다. 원격 생성·설치·배포의 증거가 아니다.

아래 A 표는 실제 생성 설정에서 계산한다. Site/Stats/Collector/Dispatcher/Interactions와 새 운영자 gateway의 경로와 Cron은 비어 있으며 아직 활성화하지 않는다. 기존 Usage Guard/Observer 보호 Cron은 유지한다. 과거 설정은 퇴역 검토·비관리 대상으로만 남기며 두 번째 운영 원본으로 쓰지 않는다.

정적 자산 우선 처리와 alias/기존38 URL/새 해시 공존을 보존한다. stage 문서 퇴역은 정상 locale/query 문서에만 적용하며 API/auth/WASM/chunk 와일드카드 리다이렉트를 만들지 않는다.

COLLECT_ENABLED와 FORECAST_CLEANUP_ENABLED는 독립이지만 정리 실행에는 UTC :57 예약 호출과 Guard 허용이 모두 필요하다. 한 번에30일 초과의 정리 가능 snapshot 최대10개를 지우고 active/미전송 참조를 보존한다. 긴급 Cron 제거는 정리도 중단한다. 플래그만으로 실행·삭제를 보장하지 않으며 backlog/readiness 차단을 우회하지 않는다.

M2 수집 OFF와 maintenance OFF는 별개다. maintenance는 기존 cap100/테이블,4개 테이블 삭제+시각 갱신의5문장 배치이며 statistics_write Guard를 따른다. 논리 TTL과 물리 삭제 시각은 다르다. Guard가 막으면 삭제가 지연되며 backup/log/export/restore의 삭제는 별도다. CPU 설정값은 충분성·실제 사용량·계정 요금제 검증이 아니다.

새 영구 raw는 확인 완료된 outcome만 보존한다. 무응답·WAIT 장기 추적은 수집하지 않는다. Stats가 raw와 summary를 같은 기존 Stats D1에 소유하며 기존 raw 24시간/90일 정리가 새 영구 fact를 삭제하면 안 된다. 제한된 운영 receipt/control은 영구 fact와 별도 lifecycle이다. 기존 누적 통계는 유지하고 calendar 30일 eligibility 및 공개 archive가 참조하는 데이터의 영구 보존을 구분한다. 승인된 큐 포화 정책은 전송 전에 새 신고 수락 여부를 확정하고, 수락하지 못하면 기존 통계 경로만 보존하는 것이다. 이미 전송했거나 응답이 불명확한 신고는 기존 통계로 fallback하지 않으며 RAM 한도·재시도 상한을 늘리지 않는다.

전환 gate: Site/Observer capability caller 전환과 검증 후에만 기존 Stats default를 축소한다. 별도 승인된 새 raw 활성화 전 기존 M2 v3 preconfirm을 차단한다. 로컬 실제 설정의 raw는 계속 OFF다. capability 검증 전 기존 default를 끄지 않으며 rollback도 preconfirm/raw를 먼저 되살리면 안 된다. Forecast/Discord/Guard에는 새 raw 바인딩을 추가하지 않는다.

공개 view는 coarse source/slot만 허용하고 정확한 시각·해시를 노출하지 않는다. 로컬 후보 Site는 Ingest/PublicStats만, 운영자 gateway는 RawReader만 받아 DB 바인딩을 갖지 않으며 Observer는 Diagnostics와 자체 Observer/Guard DB만 받는다. 이전 STATS-only Site profile의 코드 호환 경로는 남기되 새 후보 설정에는 STATS를 넣지 않는다. Observer의 직접 Stats DB fallback은 없다. staging suffix는 원문 보존·비관리이며 아직 Diagnostics 바인딩으로 전환하지 않았으므로 이 새 Observer source와 함께 사용할 운영 준비 상태가 아니다.

## B — 토큰 권한·범위·사용 시점·보관

운영자 Access는 사람의 접근 정책과 런타임 검증을 모두 요구한다. stats-admin/src/worker.ts:createOperatorGateway는 OPERATOR_ENABLED 및 Access/origin/응답 바이트/동시 실행 입력이 충족되지 않으면 차단한다. 실제 team/aud/허용 identity/origin/namespace/threshold/key는 미설정이며 통과용 placeholder를 넣지 않는다. 로컬 코드 존재는 원격 Access 정책 설치·보호·Worker 생성의 증거가 아니다.

아래 표의 상시4개 CF 토큰 역할과 조건부 운영 역할을 분리한다. 실제 토큰을 생성·등록·사용한 기록이 아니며 권한 확대 승인이 아니다. 없는 Worker의 생성에는 per-Worker 범위를 미리 적용할 수 없다.

일상 배포는 지정된 기존 Worker의 Editor만 사용하며 D1 migration/DNS/생성/삭제 권한을 포함하지 않는다. 단, 배포 권한은 코드와 바인딩을 통해 DB·secret에 영향을 줄 수 있다. Site/Stats에는 signing key나 Discord 자격 증명을 넣지 않는다.

Wrangler4.151.3의 Static Assets/Custom Domain 및 per-Worker Editor 조합은 미검증이다. https://developers.cloudflare.com/workers/authorization/workers/ 의 문서와 실제 계정 상태를 구분한다. 실패를 이유로 자동 확대하지 않는다.

권한 범위와 승인 작업 대상을 구분한다. Account D1 Edit/Turnstile Edit 및 Workers 제품 Admin은 운영 allowlist보다 넓다. DB/widget/hostname allowlist는 운영 절차의 제한일 뿐 자격 증명의 자원 격리가 아니다. D1 Read에는 query가, Billing Read에는 invoice/billing profile 읽기가 포함될 수 있다. 같은 Zone의 route 권한으로 운영/staging hostname을 격리할 수 없다.

공개 Guard GET /health는 D1 읽기를 수행하지만 ADMIN_TOKEN을 요구하지 않는다. 앱 health 인증 Secret은 필요 없다. 향후 GitHub 모니터 Secret 2개(관리 읽기·알림 webhook)는 조건부 미래 제안이며 현재 연결된 Secret이 아니다. 관리 토큰을 앱 인증으로 쓰거나 ADMIN_TOKEN을 복사하지 않는다.

새 watchdog는 배포된 보호가 아니다. 라이브러리 API만 구현되어 있고 이를 호출하는 CLI/workflow 및 GH env→함수 인수 연결은 CODEGAP이다. 제안 변수 이름은 자동 소비되지 않으며 향후 하나의 별도 승인 활성화 단위로 caller를 구현해야 한다. 현재 전체 운영 준비 완료나 기존 보호 대체를 주장하지 않는다. 독립 측정·더 엄격한 조치·기존 canary 동등성 확인 전 기존 보호를 유지한다.

라이브러리 HTTP 제한은 redirect/retry0, 전체 응답20초, 읽기 단계60초, 관리 요청52회 이하, health1회, 알림1회다. 응답 상한은 관리4MiB/health64KiB/알림16KiB이며 새 quota 정책이나 실행 승인이 아니다.

향후 별도 승인으로 GitHub schedule caller를 구현하더라도 예약 실행은 best-effort다. 실행이 지연·누락되거나 비활성화될 수 있으므로 정시 실행 또는 지출의 hard cap으로 취급하지 않는다. 현재는 해당 caller 자체가 CODEGAP이다. Worker의 로컬 rate limit과 개별 요청/CPU 제한도 계정 전체의 합산 비용 상한이 아니다. 기존 독립 측정·Guard·canary를 유지하며 이 제한만으로 비용 보호 대체를 주장하지 않는다.

## C — 실제 입력값·유형·보유자·상태·출처·소비 함수

통합 표는 같은 카탈로그의 실제 Worker vars/secrets, 배포·monitor 입력, build 필드에서 생성한다. 값이 없는 칸은 미해결이며 unset/빈 값은 유효한 대체 승인·키가 아니다. 원격에 설치된 값의 증거로 해석하지 않는다.

Stats main은 src/production-worker.ts이며 생성된 decisionMetadataInstallation을 실제 factory 인수로 전달한다. 현재 undefined이므로 안전 차단된다. FORECAST_DB는 기존 운영 Forecast DB이고 FORECAST_RATE_LIMITER의 승인된 namespace/rate는 미해결이다. staging namespace를 복사하지 않는다. 기존 src/worker.ts의 기본 export는 정적 호환 lane이다.

실제 acquire와 expected-supply mapping 정책 모듈은 CODEGAP이다. 단순 키·숫자 입력 부족과 구별한다. Front 계산 시각 asOf와 서버 publication projection의 동등성은 입증되지 않았다. 허용 client view 전체의 bands 불변성 또는 승인된 공통 projection/계약 변경이 필요하다. 임의 units/window/평균화 값을 만들지 않는다.

공개 decision-production-catalog.json은 같은 원본의 생성 projection 하나뿐이다. publications=[]이며 개인키·게시 hash allowlist를 신뢰원으로 넣지 않는다. 실제 producer/sitekey/mapping 승인이 없으면 disabled다. 인증된 결과 경계만 ({actual,snapshot,signedCandidate}) => Bands|undefined를 공급한다.

원래 v3의 지연 lower ordinal/gap/정규 retry 허용과 충돌 거부를 보존한다. server admission부터24h parent, ID-only dedupe14d, UTC admission-day ID-free daily90d이며 영구 누적 aggregate가 아니다. max body4096/state8192/producer2/cell139/contribution24/batch27/RAM retry20·15분·3회는 원래 계약값이지 새 예산 승인이 아니다.

Router는 운영 Forecast/Guard DB만 사용한다. 운영 /health는 D1 없이404다. Bot secret은 필요 없으며 승인된 게시 활성화 때만 PKCS8 signing key와 consumer key-ID/public-key 일치를 요구한다. Observer Bot secret은 알림 기능의 조건부 런타임 요구이며 Wrangler required 선언이 없다고 알림 자격 증명이 불필요한 것은 아니다.

키 교체는 consumer trust를 먼저 설치·검증한 뒤 publisher signing key/key ID를 바꾸는 순서로 별도 승인한다. 알 수 없는 key ID나 검증 실패는 거부하며 bundled 결과로 조용히 fallback하지 않는다. FORECAST_PUBLICATION_CONSUMER_KEY_ID/PUBLIC_KEY_BASE64 mirror 검사는 publisher 측에 주어진 값과 signing key의 로컬 일치만 증명한다. 실제 원격 consumer에 해당 trust가 설치됐다는 증거가 아니므로 승인된 원격 확인과 consumer 계약 검증을 별도로 수행해야 한다. 전환 중 실패를 승인값·키·fallback으로 우회하지 않는다.

## D — 구현·검증 근거와 별도 승인 후 원격 순서

현재 작업은 로컬 구현이다. 배포·키 등록·게시·migration·삭제·원격 검사를 실행하지 않았다. 원본 운영 문서가 이 worktree에 없어 이 문서 하나를 생성했으며 donor 문서는 읽기 전용 근거다.

별도 승인 후 전체 인계 순서: 계약·정책·신뢰 및 후보 artifact 검증 → 정확한 계정/자원/경로/Workers Builds 확인 → bootstrap 권한과 고정 Wrangler 호환성 해결 → 승인된 자원만 준비 → 권한 축소 → 소비자별 secret 및 consumer trust 우선 설치·검증 → 비활성 backend/Site 배포 → 실제 Guard 평가 → 통제된 후보 생성과 실제 candidate validation/admission → 해당 후보의 hash·환경·승인 대상에 결합된 사람 승인과 서명·게시 → consumer 계약 검증 → Discord interaction endpoint와 route/Cron을 단일 소유자에게 이전 → 정상 refresh와 예정된 전달/동작 확인 → 그 확인 이후에만 기존 경로 퇴역이다. endpoint/route/Cron 인계의 중복 실행·중복 writer를 방치하지 않으며 기존 보호는 계속 유지한다. 각 원격 단계는 별도 승인이 필요하고 이 문서는 실행 승인이 아니다.

실제 c817 엔진의 sealed panel/receipt가 레지스트리에서 확인되지 않아 awaiting_evidence_panel/publication_evidence_uncovered다. bounded 원본 검색의 미발견은 어디에도 없다는 주장이 아니다. 실제 전체 codeHash/WASM88553…/observed-median-v2에 결합된 원본 증거가 필요하다. synthetic coverage는 테스트 데이터일 뿐 실제 양성 게시·운영 브라우저 승인에 사용할 수 없다.

.github/workflows/pages.yml의 수동 격리 검증은 유지한다. 원격 Workers Builds 연동·중복 trigger는 미확인이다. 로컬에서 중복을 찾지 못했다고 원격에서도 없다고 주장하지 않는다.

이전 범위별 통과 기록: 배포 wrapper8, 공개 catalog3, synthetic watchdog23. R1은 기존8이 놓친 production/bundled artifact 검증 선택 결함이었다. 수정된 후보 production 분기는 assertProductionSiteCandidateProfile의 승인 계약을 buildSiteProduction(check=true,target=production)에 전달하며 뒤에서 bundled-default 검증을 호출하지 않는다. 기존 bundled/staging lane은 유지한다.

R1 수정 후 영향받는 wrapper8+profile 계약1+새 composed 회귀1+기존 artifact1=11개가 건너뜀 없이 통과했다. 원시 전체 출력·90개 입력의 전후 source=execution 해시는 C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793426954411_1816d3f22886494480f8c9d772ead6c1/owned-verification-Op0vE8 에 보존한다. 새 회귀는 실제 assertForecastBuild/receipt/profile/entry SHA 경계를 임시 synthetic 파일과 공개 fixture 계약으로 검증한다. 실제 루트 계약을 승인값으로 조작하지 않았다. 전체 buildSiteProduction packaging/retained 자산 corpus를 통과하는 실제 온라인 artifact 생성·배포는 실행하지 않아 검증되지 않았다. 다른 범위의 유효 결과를 전체 M2 준비 완료로 확대하지 않는다.

최신 확장 operations 타입 검증: 기존 npm run typecheck:operations가 scripts/deploy-site.ts와 scripts/deploy-stats.ts를 모두 포함하는 Lead 수정 tsconfig.operations.json으로 통과했다. scripts/production-operating-catalog.d.mts의 정확한 반환형 선언도 포함되며 any cast·컴파일러 완화 없이 검증했다. 전체 로그와436개 입력의 전후 source=execution 동일성은 C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793426954411_1816d3f22886494480f8c9d772ead6c1/owned-verification-GZLuVj 에 보존했고 PID0을 확인했다. 처음 노출된 TS7016 실패는 C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793426954411_1816d3f22886494480f8c9d772ead6c1/owned-verification-Eoo5ZV 에 별도 보존한다. 이전435개 입력 통과 C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793426954411_1816d3f22886494480f8c9d772ead6c1/owned-verification-tUIY6w 는 당시 두 배포 진입점을 포함하지 않았으므로 진입점 타입 검증 근거로 재해석하지 않는다. 이번 기록은 출처 설명만 갱신하며 선언·런타임 함수·타입 가정은 바꾸지 않아 해당 통과 결과를 재사용한다.

최신 독립 native D1은9/9이며 초기8 통과·그 이전6 실패 기록을 보존한다. 정확히4개 테이블 각각101개 중100개 삭제·live/legacy 보존·5문장·실제 평가 hard-stop에 따른 삭제 거부를 검증했다. browser4는 별도 이전 통과를 재사용했고 재실행하지 않았다. Front34/34와 type 통과는 solver 통제 fixture 및 별도 실제 verifier lane의 범위를 명시한다. A034 실제 생산 transport 실패에서도 공유 App Current/조건부 WAIT 사용성을 보존했다.

Backend49 계약/5 resolver/42 호환 및 최종 focused Cloudflare type 통과는 소유자 원시 로그 범위의 근거다. 최종 type252 입력에는 cleanup helper와 typed 연결이 포함된다. 정책 모듈·실제 sealed 증거·키/예산 및 최종 packaging receipt는 별도 미해결이다. 안정된 최종 소스에 대한 통합 Reviewer 판단을 기다린다.

원시 근거: C:/Users/PC/.mixdog/data/scratch/pcx-n391s1gg/native-connections-retention.log ; C:/Users/PC/.mixdog/data/scratch/pcx-n391s1gg/browser-connections-output-fixed.log ; C:/Users/PC/.mixdog/data/scratch/ana-g16m2s1d/analytics-policy.json ; C:/Users/PC/.mixdog/data/scratch/m2-types-58uhojqw/command.log ; C:/Users/PC/.mixdog/data/scratch/m2-contracts-m9_gxgau/command.log ; C:/Users/PC/.mixdog/data/scratch/m2-resolver-y_81s9ao/command.log ; C:/Users/PC/.mixdog/data/scratch/m2-compatibility-g71y4vu6/command.log .

donor 근거(수정하지 않음): D:/vibe coding/Nikke-Collection-Item-Calculator/docs/forecast-automation-runbook.ko.md ; D:/vibe coding/Nikke-Collection-Item-Calculator/docs/hosting-cutover-p1-runbook.md ; D:/vibe coding/Nikke-Collection-Item-Calculator/docs/d1-time-travel-recovery-runbook.md ; D:/vibe coding/Nikke-Collection-Item-Calculator/README.md . 과거 CI/호스팅/복구 기록은 현재 원격 상태가 아니다. 모든 writer 차단·drain, 환경별 승인, 기존 Guard/canary 유지 원칙은 보존한다.

## A 입력표 — Worker·바인딩·경로·Cron

| Worker | 설정 원본→생성 경로 | D1·서비스·자산 바인딩 | 경로 | Cron / CPU ms | 상태 |
| --- | --- | --- | --- | --- | --- |
| collection-kit-site-production | site-worker/rebuild.production.wrangler.toml → site-worker/rebuild.production.wrangler.toml | STATS_INGEST=collection-kit-stats#Ingest; STATS_PUBLIC=collection-kit-stats#PublicStats; ASSETS=../dist | [] | [] / 명시 없음 | 후보: 경로 전환·온라인 신뢰 미해결 |
| collection-kit-stats | cloudflare/rebuild.production.wrangler.toml → cloudflare/rebuild.production.wrangler.toml | DB=collection-kit-stats (3e18385a-af83-4c67-83a0-ab889149692c); USAGE_GUARD_DB=collection-kit-usage-guard (49b7f966-f4e8-4c2d-8453-279415737054); FORECAST_DB=collection-kit-forecast-collector (2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853) | [] | ["17 3 * * *"] / 10 | 후보: 운영 진입점 연결됨; limiter·정책 모듈 미해결 |
| collection-kit-stats-operator-v2-production | scripts/production-operating-catalog.mjs → stats-admin/rebuild.production.wrangler.toml | STATS_RAW_READER=collection-kit-stats#RawReader | [] | [] / 10 | future proposal excluded from this release; operator implementation, Access and budgets require separate approval; no DB |
| collection-kit-forecast-collector-v2-production | forecast-collector/rebuild.production.wrangler.toml → forecast-collector/rebuild.production.wrangler.toml | FORECAST_DB=collection-kit-forecast-collector (2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853); USAGE_GUARD_DB=collection-kit-usage-guard (49b7f966-f4e8-4c2d-8453-279415737054) | [] | [] / 300 | 후보: 수집·정리·Cron 꺼짐 |
| collection-kit-forecast-dispatcher-v2-production | forecast-dispatcher/rebuild.production.wrangler.toml → forecast-dispatcher/rebuild.production.wrangler.toml | FORECAST_DB=collection-kit-forecast-collector (2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853); USAGE_GUARD_DB=collection-kit-usage-guard (49b7f966-f4e8-4c2d-8453-279415737054) | [] | [] / 25 | 후보: 전달·게시·Cron 꺼짐 |
| collection-kit-forecast-interactions-v2 | forecast-interactions/wrangler.toml → forecast-interactions/rebuild.production.wrangler.toml | PRODUCTION_FORECAST_DB=collection-kit-forecast-collector (2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853); USAGE_GUARD_DB=collection-kit-usage-guard (49b7f966-f4e8-4c2d-8453-279415737054) | [] | [] / 10 | 후보: 운영 DB만 연결; 변경·게시 꺼짐; 실제 신뢰 미해결 |
| collection-kit-usage-guard | usage-guard/wrangler.toml → usage-guard/wrangler.toml | GUARD_DB=collection-kit-usage-guard (49b7f966-f4e8-4c2d-8453-279415737054) | 선언 없음; 원격 미확인 | ["*/15 * * * *"] / 25 | 기존 보호 유지; 계정 변수 교정 필요; 원격 상태 미확인 |
| collection-kit-stats-observer | stats-observer/wrangler.toml → stats-observer/wrangler.toml | OBSERVER_DB=collection-kit-stats-observer (9f998d5d-06e9-407a-8fbf-748f697ee25f); GUARD_DB=collection-kit-usage-guard (49b7f966-f4e8-4c2d-8453-279415737054); STATS_DIAGNOSTICS=collection-kit-stats#Diagnostics | 선언 없음; 원격 미확인 | ["7,37 * * * *"] / 25 | future Diagnostics transition excluded from this release; matching implementation is not selected; inherited Observer configuration and staging remain unchanged |

### 원래 운영 D1 4개

| 이름 | ID | 출처 |
| --- | --- | --- |
| collection-kit-stats | 3e18385a-af83-4c67-83a0-ab889149692c | cloudflare/wrangler.toml |
| collection-kit-forecast-collector | 2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853 | forecast-collector/wrangler.toml |
| collection-kit-usage-guard | 49b7f966-f4e8-4c2d-8453-279415737054 | usage-guard/wrangler.toml |
| collection-kit-stats-observer | 9f998d5d-06e9-407a-8fbf-748f697ee25f | stats-observer/wrangler.toml |

## B 입력표 — 권한·범위·시점·보관

| 역할 | 최소 권한/검증 상태 | 자격 증명 권한 범위 | 승인 작업 대상·시점 | 보관 위치 | 금지·주의 |
| --- | --- | --- | --- | --- | --- |
| 상시1 운영 배포 | Editor | 명시적으로 지정한 기존 7 Worker만 | 부트스트랩 완료 후; 승인된 수동 배포 때만 | GitHub 보호 환경 Secret1 CLOUDFLARE_API_TOKEN | Static Assets/Custom Domain 및 Wrangler4.151.3 조합 미검증; 자동 권한 확대 금지 |
| 상시2 기존 Guard 분석 | Account Analytics Read + D1 Read | 자격 증명 범위: 승인된 Account | 승인 작업: 기존 */15 Guard 분석·D1 목록 확인 | Guard Secret CLOUDFLARE_D1_ANALYTICS_TOKEN | D1 Read는 목록 조회뿐 아니라 DB query 권한도 포함한다. 코드의 좁은 사용 범위와 토큰 권한을 혼동하지 않음 |
| 상시3 기존 Guard 청구 | Account Billing Read | 자격 증명 범위: 동일 Account | 승인 작업: 기존 Guard 요금제/기간 확인 | Guard Secret CLOUDFLARE_BILLING_READ_TOKEN | invoice·billing profile 등 청구 정보 읽기가 포함될 수 있음; 분석·배포 토큰과 분리 |
| 상시4 독립 모니터 | Account Analytics Read + D1 Read + Account Billing Read | 자격 증명 범위: 별도 승인된 동일 Account | 향후 승인된 caller만; 현재 CLI/workflow caller는 CODEGAP | 독립 보관소 제안; GitHub 등록·연결 없음 | D1 query·청구 정보 읽기 포함; 앱 /health 인증 아님. 기존 보호 대체 미승인 |
| 조건부 부트스트랩 | Workers 제품 범위 Admin | 자격 증명 범위: Account 내 Workers 제품 전체; 생성 전용 토큰 아님 | 승인 작업 대상: 명시한 새 Worker 생성만; 완료 후 즉시 축소/폐기 | 일시적 운영자 비밀 보관소; CI 상시 저장 금지 | 실제 권한은 생성 외 기존 Worker 변경·삭제 등에도 미친다. 작업 allowlist가 자격 증명 격리를 제공하지 않음; 없는 Worker에 per-Worker 범위 선부여 불가 |
| 조건부 D1 변경 | D1 Edit | 자격 증명 범위: Account; 특정 DB 전용 토큰이 아님 | 승인 작업 대상: 명시된 기존 DB ID allowlist의 migration/복구만 | 일시적 운영자 보관소 | 정확한 DB ID는 운영상 allowlist이지 토큰의 DB 격리가 아니다. 일상 배포에 이 권한을 추가하지 않음 |
| 조건부 경로 변경 | Worker Editor + Zone Workers Routes Write | 자격 증명 범위: 대상 Worker와 영향받는 Zone | 승인 작업 대상: 명시한 hostname/route 전환만 | 일시적 운영자 보관소 | 같은 Zone의 production/staging hostname을 Route Write 토큰으로 격리할 수 없음. DNS 권한을 포함하지 않으며 Custom Domain 호환성 미검증 |
| 조건부 Turnstile 관리 | Account → Turnstile → Edit (API schema: Turnstile Sites Write) | 자격 증명 범위: Account 전체 Turnstile; 단일 widget 격리 아님 | API로 widget/호스트를 변경할 때만 발급; 수동 dashboard 작업에는 별도 API 토큰 불필요 | account-owned 토큰 미지원 API에는 user-owned 토큰 사용; 운영자 보관소 | 승인된 widget ID는 작업 allowlist일 뿐 권한 격리가 아님. 런타임 TURNSTILE_SECRET_KEY와 다르며 배포/GitHub에 추가하지 않음 |

## C 통합 입력표 — GH·런타임·Secret·빌드

| 실제 이름 | 유형 | 보유자/위치 | 값 또는 미해결 | 상태 | 필드 출처 | 소비 함수/진입점 |
| --- | --- | --- | --- | --- | --- | --- |
| CLOUDFLARE_API_TOKEN | GitHub Secret1 | 보호된 production 배포 환경 | 미등록/실제 값 미확인 | 미등록/미해결 또는 조건부 | scripts/deploy-site.ts | scripts/deploy-site.ts:deploy |
| 앱 /health 인증 Secret | 현재 불필요 | 현재 없음 | 공개 Guard /health에는 불필요; ADMIN_TOKEN 복사 금지 | 미등록/미해결 또는 조건부 | usage-guard/src/worker.ts | usage-guard/src/worker.ts:fetch |
| CLOUDFLARE_ACCOUNT_ID | 공개 계정 변수 | 배포 환경 | 기존 검증 메타데이터의 승인된 32-hex 계정 15be33fd20ea78eb3d60b719be831148과 현재 로컬 Guard 값 일치; 과거 31자리 주장 원문 값·근거 미확인; 이번 작업에서 원격 설정은 재조회하지 않음 | 미등록/미해결 또는 조건부 | scripts/deploy-site.ts | scripts/deploy-site.ts:deploy |
| healthUrl | 실제 라이브러리 함수 인수(공개 URL) | 향후 승인된 caller; 현재 caller 미구현 | 실제 HTTPS /health URL 미해결 | 함수 인터페이스 구현됨; CLI/workflow 연결은 CODEGAP | scripts/production-watchdog-http.ts:WatchdogHttpConfig | scripts/production-watchdog-http.ts:runProductionWatchdogHttp |
| CLOUDFLARE_USAGE_GUARD_URL | 공개 GitHub Variable 제안(과거 이름 보존) | 승인 후 GH 환경; 아직 연결·등록 없음 | 역사적 이름 제안일 뿐 현재 env 소비 없음; 자동으로 작동하지 않음 | CODEGAP — GH env를 읽는 caller 미구현; 자동 사용 금지 | scripts/production-operating-catalog.mjs:externalInputs (donor의 과거 이름) | 소비 함수 없음 — 향후 healthUrl 인수 연결 필요 |
| expectedAccountId | 공개 계정 확인 입력 | 수동 watchdog 호출자 | 승인 계정은 15be33fd20ea78eb3d60b719be831148 (32-hex); caller의 명시적 확인 입력은 여전히 필요하며 저장소에서 자동 기본값을 공급하지 않음 | 미등록/미해결 또는 조건부 | scripts/production-watchdog-http.ts | scripts/production-watchdog-http.ts:runProductionWatchdogHttp |
| expectedDeploymentSha | 공개 SHA 입력 | 수동 watchdog 호출자 | 승인된 40자리 값 미해결 | 미등록/미해결 또는 조건부 | scripts/production-watchdog-http.ts | scripts/production-watchdog-http.ts:runProductionWatchdogHttp |
| managementReadToken | 실제 라이브러리 함수 인수(관리 읽기 Secret) | 향후 승인된 caller의 비밀 보관소 | 실제 값 미등록; 앱 health 인증이 아님 | 함수 인수 구현됨; env→인수 연결 caller는 CODEGAP | scripts/production-watchdog-http.ts:WatchdogHttpConfig | scripts/production-watchdog-http.ts:runProductionWatchdogHttp |
| notificationWebhookUrl | 실제 라이브러리 함수 인수(알림 Secret) | 향후 승인된 caller의 비밀 보관소 | 실제 값 미등록; 전달 없음 | 함수 인수 구현됨; env→인수 연결 caller는 CODEGAP | scripts/production-watchdog-http.ts:WatchdogHttpConfig | scripts/production-watchdog-http.ts:runProductionWatchdogHttp |
| CLOUDFLARE_WATCHDOG_READ_TOKEN | 향후 GitHub Secret 제안 1/2 | 향후 별도 승인된 GH 모니터 환경 | 제안 이름만; 생성·등록·사용 없음 | CODEGAP — CLI/workflow caller 미구현; 조건부 미래 Secret | scripts/production-operating-catalog.mjs:externalInputs (사용자 제안) | 소비 함수 없음 — 향후 managementReadToken 인수 연결 필요 |
| DISCORD_MONITOR_WEBHOOK_URL | 향후 GitHub Secret 제안 2/2 | 향후 별도 승인된 GH 모니터 환경 | 제안 이름만; 생성·등록·전달 없음 | CODEGAP — CLI/workflow caller 미구현; 조건부 미래 Secret | scripts/production-operating-catalog.mjs:externalInputs (사용자 제안) | 소비 함수 없음 — 향후 notificationWebhookUrl 인수 연결 필요 |
| USAGE_GUARD_HEALTH_URL | 향후 공개 GitHub Variable 제안 | 향후 별도 승인된 GH 모니터 환경 | 제안 이름만; 실제 URL·등록 없음 | CODEGAP — CLI/workflow caller 미구현 | scripts/production-operating-catalog.mjs:externalInputs (사용자 제안) | 소비 함수 없음 — 향후 healthUrl 인수 연결 필요 |
| STATS_CAPABILITY_CUTOVER | 미설정 Worker 입력 | Stats | 실제 승인·schema 검증·예산 미해결; TOML에 통과용 값 없음 | 미등록/미해결 또는 조건부 | cloudflare/src/outcome-handler.ts | cloudflare/src/outcome-handler.ts:outcomeConfig/handleOutcomeAnalytics; cloudflare/src/outcome-facts.ts:cleanupOutcomeFacts |
| OUTCOME_FACTS_SCHEMA_VERSION | 미설정 Worker 입력 | Stats | 실제 승인·schema 검증·예산 미해결; TOML에 통과용 값 없음 | 미등록/미해결 또는 조건부 | cloudflare/src/outcome-handler.ts | cloudflare/src/outcome-handler.ts:outcomeConfig/handleOutcomeAnalytics; cloudflare/src/outcome-facts.ts:cleanupOutcomeFacts |
| OUTCOME_FACTS_DAILY_WRITE_ATTEMPTS | 미설정 Worker 입력 | Stats | 실제 승인·schema 검증·예산 미해결; TOML에 통과용 값 없음 | 미등록/미해결 또는 조건부 | cloudflare/src/outcome-handler.ts | cloudflare/src/outcome-handler.ts:outcomeConfig/handleOutcomeAnalytics; cloudflare/src/outcome-facts.ts:cleanupOutcomeFacts |
| OUTCOME_FACTS_MAX_PUBLIC_ROWS | 미설정 Worker 입력 | Stats | 실제 승인·schema 검증·예산 미해결; TOML에 통과용 값 없음 | 미등록/미해결 또는 조건부 | cloudflare/src/outcome-handler.ts | cloudflare/src/outcome-handler.ts:outcomeConfig/handleOutcomeAnalytics; cloudflare/src/outcome-facts.ts:cleanupOutcomeFacts |
| OUTCOME_FACTS_MAX_PUBLIC_BYTES | 미설정 Worker 입력 | Stats | 실제 승인·schema 검증·예산 미해결; TOML에 통과용 값 없음 | 미등록/미해결 또는 조건부 | cloudflare/src/outcome-handler.ts | cloudflare/src/outcome-handler.ts:outcomeConfig/handleOutcomeAnalytics; cloudflare/src/outcome-facts.ts:cleanupOutcomeFacts |
| OUTCOME_FACTS_MAX_MAINTENANCE_AGE_MS | 미설정 Worker 입력 | Stats | 실제 승인·schema 검증·예산 미해결; TOML에 통과용 값 없음 | 미등록/미해결 또는 조건부 | cloudflare/src/outcome-handler.ts | cloudflare/src/outcome-handler.ts:outcomeConfig/handleOutcomeAnalytics; cloudflare/src/outcome-facts.ts:cleanupOutcomeFacts |
| OUTCOME_FACTS_MAX_OVERDUE_MS | 미설정 Worker 입력 | Stats | 실제 승인·schema 검증·예산 미해결; TOML에 통과용 값 없음 | 미등록/미해결 또는 조건부 | cloudflare/src/outcome-handler.ts | cloudflare/src/outcome-handler.ts:outcomeConfig/handleOutcomeAnalytics; cloudflare/src/outcome-facts.ts:cleanupOutcomeFacts |
| OUTCOME_FACTS_MAX_BACKLOG_ROWS | 미설정 Worker 입력 | Stats | 실제 승인·schema 검증·예산 미해결; TOML에 통과용 값 없음 | 미등록/미해결 또는 조건부 | cloudflare/src/outcome-handler.ts | cloudflare/src/outcome-handler.ts:outcomeConfig/handleOutcomeAnalytics; cloudflare/src/outcome-facts.ts:cleanupOutcomeFacts |
| OUTCOME_FACTS_MAINTENANCE_ROWS | 미설정 Worker 입력 | Stats | 실제 승인·schema 검증·예산 미해결; TOML에 통과용 값 없음 | 미등록/미해결 또는 조건부 | cloudflare/src/outcome-handler.ts | cloudflare/src/outcome-handler.ts:outcomeConfig/handleOutcomeAnalytics; cloudflare/src/outcome-facts.ts:cleanupOutcomeFacts |
| ACCESS_TEAM_DOMAIN | 미설정 Worker 입력 | Operator | 실제 Access 정책·identity·origin·운영 예산 미설정 | 미등록/미해결 또는 조건부 | stats-admin/src/worker.ts | stats-admin/src/worker.ts:createOperatorGateway |
| ACCESS_AUD | 미설정 Worker 입력 | Operator | 실제 Access 정책·identity·origin·운영 예산 미설정 | 미등록/미해결 또는 조건부 | stats-admin/src/worker.ts | stats-admin/src/worker.ts:createOperatorGateway |
| ADMIN_ALLOWED_EMAILS | 미설정 Worker 입력 | Operator | 실제 Access 정책·identity·origin·운영 예산 미설정 | 미등록/미해결 또는 조건부 | stats-admin/src/worker.ts | stats-admin/src/worker.ts:createOperatorGateway |
| OPERATOR_ORIGIN | 미설정 Worker 입력 | Operator | 실제 Access 정책·identity·origin·운영 예산 미설정 | 미등록/미해결 또는 조건부 | stats-admin/src/worker.ts | stats-admin/src/worker.ts:createOperatorGateway |
| RAW_MAX_RESPONSE_BYTES | 미설정 Worker 입력 | Operator | 실제 Access 정책·identity·origin·운영 예산 미설정 | 미등록/미해결 또는 조건부 | stats-admin/src/worker.ts | stats-admin/src/worker.ts:createOperatorGateway |
| RAW_MAX_IN_FLIGHT | 미설정 Worker 입력 | Operator | 실제 Access 정책·identity·origin·운영 예산 미설정 | 미등록/미해결 또는 조건부 | stats-admin/src/worker.ts | stats-admin/src/worker.ts:createOperatorGateway |
| RAW_MAX_ROWS | 미설정 Worker 입력 | Operator | 실제 Access 정책·identity·origin·운영 예산 미설정 | 미등록/미해결 또는 조건부 | stats-admin/src/worker.ts | stats-admin/src/worker.ts:createOperatorGateway |
| RAW_MAX_QUERY_DAYS | 미설정 Worker 입력 | Operator | 실제 Access 정책·identity·origin·운영 예산 미설정 | 미등록/미해결 또는 조건부 | stats-admin/src/worker.ts | stats-admin/src/worker.ts:createOperatorGateway |
| SITE_ENV | Worker Variable | collection-kit-site-production | production | 로컬 설정; 원격 미확인 | site-worker/rebuild.production.wrangler.toml → catalog workers.site.config.vars.SITE_ENV | site-worker/src/worker.ts:fetch |
| FORECAST_RUNTIME_MODE | Worker Variable | collection-kit-site-production | off | 로컬 설정; 원격 미확인 | site-worker/rebuild.production.wrangler.toml → catalog workers.site.config.vars.FORECAST_RUNTIME_MODE | site-worker/src/worker.ts:fetch |
| STATS_HEALTH_PROBE_TOKEN | Worker Secret | collection-kit-site-production | 비밀 값 미열람 | required 이름만 확인; 원격 등록 미확인 | site-worker/rebuild.production.wrangler.toml → catalog workers.site.config.secrets | site-worker/src/worker.ts:fetch |
| ALLOWED_ORIGINS | Worker Variable | collection-kit-stats | https://nikkecollection.com | 로컬 설정; 원격 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.vars.ALLOWED_ORIGINS | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| TURNSTILE_ALLOWED_HOSTNAMES | Worker Variable | collection-kit-stats | nikkecollection.com,www.nikkecollection.com | 로컬 설정; 원격 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.vars.TURNSTILE_ALLOWED_HOSTNAMES | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| DEPLOYMENT_SHA | Worker Variable | collection-kit-stats | local | 로컬 설정; 원격 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.vars.DEPLOYMENT_SHA | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| SITE_ENV | Worker Variable | collection-kit-stats | production | 로컬 설정; 원격 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.vars.SITE_ENV | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| FORECAST_RUNTIME_MODE | Worker Variable | collection-kit-stats | off | 로컬 설정; 원격 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.vars.FORECAST_RUNTIME_MODE | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| STATS_CAPABILITY_CUTOVER | Worker Variable | collection-kit-stats | false | 로컬 설정; 원격 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.vars.STATS_CAPABILITY_CUTOVER | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| DECISION_ANALYTICS_ENABLED | Worker Variable | collection-kit-stats | false | 로컬 설정; 원격 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.vars.DECISION_ANALYTICS_ENABLED | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| DECISION_ANALYTICS_MAINTENANCE_ENABLED | Worker Variable | collection-kit-stats | false | 로컬 설정; 원격 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.vars.DECISION_ANALYTICS_MAINTENANCE_ENABLED | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| OUTCOME_FACTS_ENABLED | Worker Variable | collection-kit-stats | false | 로컬 설정; 원격 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.vars.OUTCOME_FACTS_ENABLED | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| OUTCOME_FACTS_MAINTENANCE_ENABLED | Worker Variable | collection-kit-stats | false | 로컬 설정; 원격 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.vars.OUTCOME_FACTS_MAINTENANCE_ENABLED | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| TURNSTILE_SECRET_KEY | Worker Secret | collection-kit-stats | 비밀 값 미열람 | required 이름만 확인; 원격 등록 미확인 | cloudflare/rebuild.production.wrangler.toml → catalog workers.stats.config.secrets | cloudflare/src/worker.ts:createProductionStatsWorker → createStatsWorker; site-worker/src/forecast.ts:createForecastEndpoint |
| OPERATOR_ENABLED | Worker Variable | collection-kit-stats-operator-v2-production | false | 로컬 설정; 원격 미확인 | scripts/production-operating-catalog.mjs → catalog workers.operator.config.vars.OPERATOR_ENABLED | stats-admin/src/worker.ts:createOperatorGateway/fetch |
| FORECAST_V2_MODE | Worker Variable | collection-kit-forecast-collector-v2-production | off | 로컬 설정; 원격 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.FORECAST_V2_MODE | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| FORECAST_V2_BOOTSTRAP_CUTOFF | Worker Variable | collection-kit-forecast-collector-v2-production | 빈 값 | 미해결; 활성화 근거 아님 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.FORECAST_V2_BOOTSTRAP_CUTOFF | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| NAVER_BOARD48_PAGE_SIZE | Worker Variable | collection-kit-forecast-collector-v2-production | 10 | 로컬 설정; 원격 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.NAVER_BOARD48_PAGE_SIZE | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| ENVIRONMENT | Worker Variable | collection-kit-forecast-collector-v2-production | production | 로컬 설정; 원격 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.ENVIRONMENT | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| COLLECTION_SCHEDULE | Worker Variable | collection-kit-forecast-collector-v2-production | combined | 로컬 설정; 원격 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.COLLECTION_SCHEDULE | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| DEPLOY_SHA | Worker Variable | collection-kit-forecast-collector-v2-production | local | 로컬 설정; 원격 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.DEPLOY_SHA | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| POLL_MODE | Worker Variable | collection-kit-forecast-collector-v2-production | both | 로컬 설정; 원격 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.POLL_MODE | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| COLLECT_ENABLED | Worker Variable | collection-kit-forecast-collector-v2-production | false | 로컬 설정; 원격 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.COLLECT_ENABLED | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| FORECAST_CLEANUP_ENABLED | Worker Variable | collection-kit-forecast-collector-v2-production | false | 로컬 설정; 원격 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.FORECAST_CLEANUP_ENABLED | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| RUNTIME_INGESTION_ENABLED | Worker Variable | collection-kit-forecast-collector-v2-production | false | 로컬 설정; 원격 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.RUNTIME_INGESTION_ENABLED | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| RUNTIME_NOTICE_DAILY_LIMIT | Worker Variable | collection-kit-forecast-collector-v2-production | 20 | 로컬 설정; 원격 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.vars.RUNTIME_NOTICE_DAILY_LIMIT | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| ADMIN_TOKEN | Worker Secret | collection-kit-forecast-collector-v2-production | 비밀 값 미열람 | required 이름만 확인; 원격 등록 미확인 | forecast-collector/rebuild.production.wrangler.toml → catalog workers.collector.config.secrets | forecast-collector/src/worker.ts:scheduled → runV2Invocation; forecast-collector/src/http.ts:handleHttpRequest |
| FORECAST_V2_NOTIFICATIONS_ENABLED | Worker Variable | collection-kit-forecast-dispatcher-v2-production | false | 로컬 설정; 원격 미확인 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.vars.FORECAST_V2_NOTIFICATIONS_ENABLED | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| ENVIRONMENT | Worker Variable | collection-kit-forecast-dispatcher-v2-production | production | 로컬 설정; 원격 미확인 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.vars.ENVIRONMENT | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| DEPLOY_SHA | Worker Variable | collection-kit-forecast-dispatcher-v2-production | local | 로컬 설정; 원격 미확인 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.vars.DEPLOY_SHA | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| PUBLICATION_MODE | Worker Variable | collection-kit-forecast-dispatcher-v2-production | off | 로컬 설정; 원격 미확인 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.vars.PUBLICATION_MODE | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| DISCORD_APPROVAL_CHANNEL_ID | Worker Variable | collection-kit-forecast-dispatcher-v2-production | unset | 미해결; 활성화 근거 아님 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.vars.DISCORD_APPROVAL_CHANNEL_ID | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| DISCORD_CHANNEL_ID | Worker Variable | collection-kit-forecast-dispatcher-v2-production | unset | 미해결; 활성화 근거 아님 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.vars.DISCORD_CHANNEL_ID | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| DISCORD_ACTIVITY_CHANNEL_ID | Worker Variable | collection-kit-forecast-dispatcher-v2-production | unset | 미해결; 활성화 근거 아님 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.vars.DISCORD_ACTIVITY_CHANNEL_ID | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| DISCORD_ALERT_CHANNEL_ID | Worker Variable | collection-kit-forecast-dispatcher-v2-production | unset | 미해결; 활성화 근거 아님 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.vars.DISCORD_ALERT_CHANNEL_ID | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| DISCORD_FALLBACK_CHANNEL_ID | Worker Variable | collection-kit-forecast-dispatcher-v2-production | unset | 미해결; 활성화 근거 아님 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.vars.DISCORD_FALLBACK_CHANNEL_ID | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| DISPATCH_ENABLED | Worker Variable | collection-kit-forecast-dispatcher-v2-production | false | 로컬 설정; 원격 미확인 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.vars.DISPATCH_ENABLED | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| DISCORD_BOT_TOKEN | Worker Secret | collection-kit-forecast-dispatcher-v2-production | 비밀 값 미열람 | required 이름만 확인; 원격 등록 미확인 | forecast-dispatcher/rebuild.production.wrangler.toml → catalog workers.dispatcher.config.secrets | forecast-dispatcher/src/dispatcher.ts:runDispatcher; forecast-dispatcher/src/discord.ts:resolveDiscordChannelId/createMessage |
| FORECAST_ENVIRONMENT | Worker Variable | collection-kit-forecast-interactions-v2 | production | 로컬 설정; 원격 미확인 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.FORECAST_ENVIRONMENT | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| DEPLOY_SHA | Worker Variable | collection-kit-forecast-interactions-v2 | local | 로컬 설정; 원격 미확인 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.DEPLOY_SHA | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| DISCORD_PUBLIC_KEY | Worker Variable | collection-kit-forecast-interactions-v2 | unset | 미해결; 활성화 근거 아님 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.DISCORD_PUBLIC_KEY | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| DISCORD_APPLICATION_ID | Worker Variable | collection-kit-forecast-interactions-v2 | unset | 미해결; 활성화 근거 아님 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.DISCORD_APPLICATION_ID | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| DISCORD_GUILD_ID | Worker Variable | collection-kit-forecast-interactions-v2 | unset | 미해결; 활성화 근거 아님 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.DISCORD_GUILD_ID | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| DISCORD_FORECAST_APPROVER_USER_ID | Worker Variable | collection-kit-forecast-interactions-v2 | unset | 미해결; 활성화 근거 아님 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.DISCORD_FORECAST_APPROVER_USER_ID | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| DISCORD_APPROVAL_CHANNEL_ID | Worker Variable | collection-kit-forecast-interactions-v2 | unset | 미해결; 활성화 근거 아님 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.DISCORD_APPROVAL_CHANNEL_ID | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| DISCORD_ALERT_CHANNEL_ID | Worker Variable | collection-kit-forecast-interactions-v2 | unset | 미해결; 활성화 근거 아님 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.DISCORD_ALERT_CHANNEL_ID | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| DISCORD_ACTIVITY_CHANNEL_ID | Worker Variable | collection-kit-forecast-interactions-v2 | unset | 미해결; 활성화 근거 아님 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.DISCORD_ACTIVITY_CHANNEL_ID | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| PRODUCTION_MUTATIONS_ENABLED | Worker Variable | collection-kit-forecast-interactions-v2 | false | 로컬 설정; 원격 미확인 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.PRODUCTION_MUTATIONS_ENABLED | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| STAGING_PUBLICATION_MODE | Worker Variable | collection-kit-forecast-interactions-v2 | off | 로컬 설정; 원격 미확인 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.STAGING_PUBLICATION_MODE | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| PRODUCTION_PUBLICATION_MODE | Worker Variable | collection-kit-forecast-interactions-v2 | off | 로컬 설정; 원격 미확인 | forecast-interactions/wrangler.toml → catalog workers.interactions.config.vars.PRODUCTION_PUBLICATION_MODE | forecast-interactions/src/worker.ts:fetch/publicationResponse/publicationKeyAvailable |
| ENVIRONMENT | Worker Variable | collection-kit-usage-guard | production | 로컬 설정; 원격 미확인 | usage-guard/wrangler.toml → catalog workers.guard.config.vars.ENVIRONMENT | usage-guard/src/worker.ts:runUsageGuard/sendQuotaAlert/fetch |
| DEPLOY_SHA | Worker Variable | collection-kit-usage-guard | local | 로컬 설정; 원격 미확인 | usage-guard/wrangler.toml → catalog workers.guard.config.vars.DEPLOY_SHA | usage-guard/src/worker.ts:runUsageGuard/sendQuotaAlert/fetch |
| CLOUDFLARE_ACCOUNT_ID | Worker Variable | collection-kit-usage-guard | 15be33fd20ea78eb3d60b719be831148 | 로컬 설정; 원격 미확인 | usage-guard/wrangler.toml → catalog workers.guard.config.vars.CLOUDFLARE_ACCOUNT_ID | usage-guard/src/worker.ts:runUsageGuard/sendQuotaAlert/fetch |
| DISCORD_ALERT_CHANNEL_ID | Worker Variable | collection-kit-usage-guard | 1544139171667513354 | 로컬 설정; 원격 미확인 | usage-guard/wrangler.toml → catalog workers.guard.config.vars.DISCORD_ALERT_CHANNEL_ID | usage-guard/src/worker.ts:runUsageGuard/sendQuotaAlert/fetch |
| CLOUDFLARE_D1_ANALYTICS_TOKEN | Worker Secret | collection-kit-usage-guard | 비밀 값 미열람 | required 이름만 확인; 원격 등록 미확인 | usage-guard/wrangler.toml → catalog workers.guard.config.secrets | usage-guard/src/worker.ts:runUsageGuard/sendQuotaAlert/fetch |
| CLOUDFLARE_BILLING_READ_TOKEN | Worker Secret | collection-kit-usage-guard | 비밀 값 미열람 | required 이름만 확인; 원격 등록 미확인 | usage-guard/wrangler.toml → catalog workers.guard.config.secrets | usage-guard/src/worker.ts:runUsageGuard/sendQuotaAlert/fetch |
| DISCORD_BOT_TOKEN | Worker Secret | collection-kit-usage-guard | 비밀 값 미열람 | required 이름만 확인; 원격 등록 미확인 | usage-guard/wrangler.toml → catalog workers.guard.config.secrets | usage-guard/src/worker.ts:runUsageGuard/sendQuotaAlert/fetch |
| ADMIN_TOKEN | Worker Secret | collection-kit-usage-guard | 비밀 값 미열람 | required 이름만 확인; 원격 등록 미확인 | usage-guard/wrangler.toml → catalog workers.guard.config.secrets | usage-guard/src/worker.ts:runUsageGuard/sendQuotaAlert/fetch |
| ENVIRONMENT | Worker Variable | collection-kit-stats-observer | production | 로컬 설정; 원격 미확인 | stats-observer/wrangler.toml → catalog workers.observer.config.vars.ENVIRONMENT | stats-observer/src/observer.ts:runObserver; stats-observer/src/discord.ts:deliverAlert |
| DEPLOY_SHA | Worker Variable | collection-kit-stats-observer | local | 로컬 설정; 원격 미확인 | stats-observer/wrangler.toml → catalog workers.observer.config.vars.DEPLOY_SHA | stats-observer/src/observer.ts:runObserver; stats-observer/src/discord.ts:deliverAlert |
| DISCORD_ALERT_CHANNEL_ID | Worker Variable | collection-kit-stats-observer | 빈 값 | 미해결; 활성화 근거 아님 | stats-observer/wrangler.toml → catalog workers.observer.config.vars.DISCORD_ALERT_CHANNEL_ID | stats-observer/src/observer.ts:runObserver; stats-observer/src/discord.ts:deliverAlert |
| DISCORD_BOT_TOKEN | 조건부 Worker Secret | Observer 알림 기능 | 실제 비밀 값 없음/미확인 | 기능 사용 시 코드상 필수; required 선언과 별개 | stats-observer/src/discord.ts | stats-observer/src/discord.ts:deliverAlert |
| FORECAST_PUBLICATION_SIGNING_KEY | 조건부 Worker Secret | Router 게시 기능 | 실제 비밀 값 없음/미확인 | 기능 사용 시 코드상 필수; required 선언과 별개 | forecast-interactions/src/worker.ts | forecast-interactions/src/worker.ts:publicationKeyAvailable |
| FORECAST_PUBLICATION_KEY_ID | Worker Variable | Router 게시 설정 | 미해결 | 실제 소비자 신뢰와 일치 필요 | forecast-interactions/src/worker.ts | publicationKeyAvailable |
| FORECAST_PUBLICATION_CONSUMER_KEY_ID | Worker Variable | Router 게시 설정 | 미해결 | 실제 소비자 신뢰와 일치 필요 | forecast-interactions/src/worker.ts | publicationKeyAvailable |
| FORECAST_PUBLICATION_CONSUMER_PUBLIC_KEY_BASE64 | Worker Variable | Router 게시 설정 | 미해결 | 실제 소비자 신뢰와 일치 필요 | forecast-interactions/src/worker.ts | publicationKeyAvailable |
| DECISION_ANALYTICS_SCHEMA_VERSION | Worker Variable | Stats | 미해결 — 실제 승인/예산 필요 | 미설정; 안전 차단 | cloudflare/src/decision-analytics-handler.ts | analyticsConfig/handleDecisionAnalytics |
| DECISION_ANALYTICS_PRODUCERS | Worker Variable | Stats | 미해결 — 실제 승인/예산 필요 | 미설정; 안전 차단 | cloudflare/src/decision-analytics-handler.ts | analyticsConfig/handleDecisionAnalytics |
| DECISION_ANALYTICS_DAILY_WRITE_ATTEMPTS | Worker Variable | Stats | 미해결 — 실제 승인/예산 필요 | 미설정; 안전 차단 | cloudflare/src/decision-analytics-handler.ts | analyticsConfig/handleDecisionAnalytics |
| DECISION_ANALYTICS_PUBLICATION_CONTENT_HASH | Worker Variable | Stats | 미해결 — 실제 승인/예산 필요 | 정적 호환 lane 전용; 운영 dynamic 신뢰 대체 금지 | cloudflare/src/decision-analytics-handler.ts | analyticsConfig/handleDecisionAnalytics |
| DECISION_ANALYTICS_MAX_MAINTENANCE_AGE_MS | Worker Variable | Stats | 미해결 — 실제 승인/예산 필요 | 미설정; 안전 차단 | cloudflare/src/decision-analytics-handler.ts | analyticsConfig/handleDecisionAnalytics |
| DECISION_ANALYTICS_MAX_OVERDUE_MS | Worker Variable | Stats | 미해결 — 실제 승인/예산 필요 | 미설정; 안전 차단 | cloudflare/src/decision-analytics-handler.ts | analyticsConfig/handleDecisionAnalytics |
| DECISION_ANALYTICS_MAX_BACKLOG_ROWS | Worker Variable | Stats | 미해결 — 실제 승인/예산 필요 | 미설정; 안전 차단 | cloudflare/src/decision-analytics-handler.ts | analyticsConfig/handleDecisionAnalytics |
| DECISION_ANALYTICS_MAINTENANCE_ROWS_PER_TABLE | Worker Variable | Stats | 미해결 — 실제 승인/예산 필요 | 미설정; 안전 차단 | cloudflare/src/decision-analytics-maintenance.ts | maintenanceRows/runDecisionAnalyticsMaintenance |
| VITE_SERVICE_CERTIFIED_SOLVER | 공개 빌드 환경 | 검증된 Site 빌드 | true | 공개값만; 실제 신뢰 승인 별도 | scripts/build-local-service.mjs | productionServiceEnvironment/productionForecastBuildEnv/forecastRuntimeBuildPlugin |
| VITE_FORECAST_RUNTIME | 공개 빌드 환경 | 검증된 Site 빌드 | production (별도 승인 필요) | 공개값만; 실제 신뢰 승인 별도 | scripts/forecast-runtime-build.ts | productionServiceEnvironment/productionForecastBuildEnv/forecastRuntimeBuildPlugin |
| VITE_FORECAST_PUBLIC_KEY_ID | 공개 빌드 환경 | 검증된 Site 빌드 | 미해결 | 공개값만; 실제 신뢰 승인 별도 | site-worker/production-forecast.proposed.json | productionServiceEnvironment/productionForecastBuildEnv/forecastRuntimeBuildPlugin |
| VITE_FORECAST_PUBLIC_KEY_BASE64 | 공개 빌드 환경 | 검증된 Site 빌드 | 미해결 | 공개값만; 실제 신뢰 승인 별도 | site-worker/production-forecast.proposed.json | productionServiceEnvironment/productionForecastBuildEnv/forecastRuntimeBuildPlugin |
| SITE_DEPLOY_WORKER | 배포 확인 변수 | 수동 배포 환경 | 정확한 승인 대상과 일치 필요 | 일치하지 않으면 배포 전 차단 | scripts/deploy-site.ts | deploy |
| SITE_DEPLOY_HOSTNAME | 배포 확인 변수 | 수동 배포 환경 | 정확한 승인 대상과 일치 필요 | 일치하지 않으면 배포 전 차단 | scripts/deploy-site.ts | deploy |
| SITE_DEPLOY_ACCOUNT_ID | 배포 확인 변수 | 수동 배포 환경 | 정확한 승인 대상과 일치 필요 | 일치하지 않으면 배포 전 차단 | scripts/deploy-site.ts | deploy |
| STATS_DEPLOY_WORKER | 배포 확인 변수 | 수동 배포 환경 | 정확한 승인 대상과 일치 필요 | 일치하지 않으면 배포 전 차단 | scripts/deploy-site.ts | deploy |
| STATS_DEPLOY_HOSTNAME | 배포 확인 변수 | 수동 배포 환경 | 정확한 승인 대상과 일치 필요 | 일치하지 않으면 배포 전 차단 | scripts/deploy-site.ts | deploy |
| STATS_DEPLOY_ACCOUNT_ID | 배포 확인 변수 | 수동 배포 환경 | 정확한 승인 대상과 일치 필요 | 일치하지 않으면 배포 전 차단 | scripts/deploy-site.ts | deploy |
| GITHUB_SHA / 명시 SHA 인수 | 공개 빌드·배포 값 | 검토된 후보 | 승인된 전체40자리 | receipt/현재 HEAD/깨끗한 작업 트리 확인 | scripts/ci/run-checked-command.mjs; vite.config.ts | childEnvironment; __APP_REVISION__; deploy |
| enabled | 생성 공개 catalog 필드 | public/decision-production-catalog.json | false | 실제 producer/sitekey 미승인으로 disabled | catalog decisionPublicConfiguration.enabled | src/analytics/decisionBootstrap.ts:initializeDecisionProduction; createProductionDecision |
| producer | 생성 공개 catalog 필드 | public/decision-production-catalog.json | 미해결 | 실제 producer/sitekey 미승인으로 disabled | catalog decisionPublicConfiguration.producer | src/analytics/decisionBootstrap.ts:initializeDecisionProduction; createProductionDecision |
| allowedProducers | 생성 공개 catalog 필드 | public/decision-production-catalog.json | [] | 실제 producer/sitekey 미승인으로 disabled | catalog decisionPublicConfiguration.allowedProducers | src/analytics/decisionBootstrap.ts:initializeDecisionProduction; createProductionDecision |
| turnstileSiteKey | 생성 공개 catalog 필드 | public/decision-production-catalog.json | 미해결 | 실제 producer/sitekey 미승인으로 disabled | catalog decisionPublicConfiguration.turnstileSiteKey | src/analytics/decisionBootstrap.ts:initializeDecisionProduction; createProductionDecision |
| publications | 생성 공개 catalog 필드 | public/decision-production-catalog.json | [] | 항상 비어 있음; unsigned mapping 금지 | scripts/render-production-operations.mjs | renderDecisionProductionCatalog; initializeDecisionProduction |

### 신규 outcome·capability 계약과 소스 증거

| 버전/역할 | 동작/이름 | schema/경계 | 실제 소비 함수/원본 | 상태/검증 |
| --- | --- | --- | --- | --- |
| HTTP capabilities | STATS_INGEST → Ingest; STATS_PUBLIC → PublicStats | POST events/outcomes; GET stats/health/outcome-summary; OPTIONS; query 거부 | cloudflare/src/production-worker.ts → stats-capabilities.ts; site-worker/src/worker.ts:fetch | 로컬 바인딩 코드 연결; 기존 STATS-only profile 호환은 유지; 새 profile의 v3 route는 410 |
| private raw capability | STATS_RAW_READER → RawReader | readCalculation({calculationId,maxBytes?}); queryCalculations({fromGameDate,untilGameDate,publicationContentHash?,slotId?,afterCalculationId?,maxRows?,maxBytes?}) | cloudflare/src/stats-capability-contract.ts; stats-admin/src/worker.ts:createOperatorGateway | Operator만 바인딩; 실제 Access·운영 예산 미설정; 기술 ceiling은 승인 예산 아님 |
| v4 confirmed_outcome | POST /api/decision-outcomes; commit / attempt_patch; action decision_outcome_v4 | reportId UUIDv4; body <=4096 bytes; token fresh per network attempt; attemptCount null or positive | shared/decisionOutcomeV4.ts:parseOutcomeEnvelope / classifyOutcomeCommit / classifyOutcomeAttemptPatch | DTO 구현됨; backend admission/schema/env 활성화 연결 전환 중; 실행 미검증 |
| v4 lifecycle | rawFacts/reportUniqueness indefinite; initial digest immutable | attempt patch 24h / receipt 14d are bounded private controls, not raw TTL | shared/decisionOutcomeV4.ts:OUTCOME_RETENTION / OUTCOME_ATTEMPT_PATCH_TTL_MS / OUTCOME_RECEIPT_TTL_MS | 기술 계약; 원격 schema/migration/보존 설치 증거 아님 |
| 제안 migration 순서 | 0002_stats_public_read_models.proposed.sql → 0003_outcome_facts.proposed.sql | 기존 Stats D1의 public read models 후 outcome facts; 실행·schema attestation 없음 | cloudflare/decision-analytics/0002_stats_public_read_models.proposed.sql; cloudflare/decision-analytics/0003_outcome_facts.proposed.sql | 별도 승인 대상 제안만 문서화; 이 로컬 generation/test에서 migration 실행 금지 |
| public supply reference | published-slot-releases-v1 | publicationContentHash + gameDay + slotStart/slotEnd; published slot releases, not personal future holdings | shared/decisionSupplyReference.ts:parsePublicSupplyReference | 공개 reference 계약과 private confirmed raw를 구분; raw 정확한 시각/해시 공개 금지 |
| bounded diagnostics | STATS_DIAGNOSTICS.readObservations({cutoff}) | fixed 3 aggregate queries, LIMIT 501; Observer >500 rejection | cloudflare/src/stats-diagnostic-capability.ts:readDiagnosticObservations → stats-observer/src/diagnostics.ts → observer.ts:readObservations | observer.test.ts capability failure non-downgrade + 기존 overflow/cursor/Guard 테스트; 새 소스 실행 미검증 |

### 추가 바인딩과 정책 코드 간극

| 입력/계약 | 상태 | 소비자 |
| --- | --- | --- |
| FORECAST_RATE_LIMITER | 미해결: 승인된 운영 namespace/rate 필요 | site-worker/src/forecast.ts:createForecastEndpoint |
| cloudflare/src/generated/decision-production-installation.ts | 연결 구현됨; undefined로 안전 차단. 실제 acquire/mapping 정책은 CODEGAP | cloudflare/src/production-worker.ts → createProductionStatsWorker → createProductionDecisionResolver |
| asOf/projection 및 expectedSupply | CODEGAP: 허용 client view 전체 bands 불변성 또는 승인된 공통 projection/계약 변경 필요 | cloudflare/src/decision-analytics-publication.ts:createProductionDecisionResolver; src/analytics/decisionAcquisition.ts |

### 실제 게시 증거 미해결

| 필드 | 값/요건 |
| --- | --- |
| engineBuildHash | c817a71495ece25fd4e62b389d25ec9700d82c47c90ca26062f6f75080f6381c |
| wasmHash | 88553a72d8503d2c7c78366e3d85bbee0cd9dfd738ac94d588fb09bd9d5942ae |
| cadenceVersion | observed-median-v2 |
| 레지스트리 | shared/certifiedEvidenceCoverage.ts |
| 차단 상태 | awaiting_evidence_panel / publication_evidence_uncovered |
| 필수 원본 | 전체 해시·WASM·cadence에 결합된 원래 panel과 sealed receipt; fixture 대체 불가 |

### 비관리·퇴역 검토 설정

- `site-worker/production.wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `cloudflare/wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `forecast-collector/wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `forecast-dispatcher/wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `forecast-interactions/wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `forecast-interactions/rebuild.wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `site-worker/wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `site-worker/rebuild.staging.wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `cloudflare/rebuild.staging.wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `forecast-collector/rebuild.staging.wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `forecast-dispatcher/rebuild.staging.wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `forecast-admin/rebuild.staging.wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.
- `forecast-interactions/staging.wrangler.toml` — 비관리; 운영 후보의 별도 원본이 아님.

### 원래 M2 출처와 테이블

- `C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793283804397_e319f9d9f3e14106bc13cca1480f2581/nikke-abc-g51b26mp/minimal-analytics-5odzgh8b/contract/decision-analytics-v3.contract.json`
- `C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793283804397_e319f9d9f3e14106bc13cca1480f2581/nikke-abc-g51b26mp/minimal-analytics-5odzgh8b/contract/v3-index.json`
- `C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793283804397_e319f9d9f3e14106bc13cca1480f2581/nikke-abc-g51b26mp/minimal-analytics-5odzgh8b/candidate/cloudflare/src/decision-analytics-handler.ts`
- `C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793283804397_e319f9d9f3e14106bc13cca1480f2581/nikke-abc-g51b26mp/minimal-analytics-5odzgh8b/candidate/cloudflare/src/decision-analytics-store.ts`
- `C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793283804397_e319f9d9f3e14106bc13cca1480f2581/nikke-abc-g51b26mp/minimal-analytics-5odzgh8b/candidate/cloudflare/src/decision-analytics-maintenance.ts`
- `C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793283804397_e319f9d9f3e14106bc13cca1480f2581/nikke-abc-g51b26mp/minimal-analytics-5odzgh8b/candidate/cloudflare/decision-analytics/0001_decision_analytics_v3.proposed.sql`

기존 Stats DB의 테이블(원격 적용 증거 아님): `decision_analytics_episodes`, `decision_analytics_dedupe`, `decision_analytics_daily`, `decision_analytics_budget`, `decision_analytics_maintenance`

## 0002 공식 FILE 경로 — 로컬 준비만 완료

대상은 `cloudflare/decision-analytics/0002_stats_public_read_models.proposed.sql` 원문 13,969 bytes, LF, SHA-256 `df5394e74a3553516673fccd042e2a6b9bd07481aac44e8216aa62c5ae97e6de`와 Stats DB `3e18385a-af83-4c67-83a0-ab889149692c`다. `scripts/d1-file-import.mjs`는 한 번 읽어 고정한 bytes를 전송 대상으로 유지한다. 원문 분할·wrapper·ledger·SQL 정책 변경은 하지 않는다.

FILE 소스는 `scripts/d1-file-import.mjs`, `scripts/d1-file-import-https.mjs`, `scripts/d1-file-import-state.mjs`; 합성 시험은 각각의 `.test.mjs`다. FILE용 실제 인증 공급과 HTTP 전송 binding은 미연결이며, import adapter는 명시적으로 주입한 요청·Agent 구현 없이는 사용할 수 없다. 별도의 고정 DB 읽기 factory는 실제 node:https에 연결되지만 아직 실행하지 않았다. 합성 주입의 출처는 호출자의 책임이고 synthetic 표시는 OS sandbox가 아니다. CurrentUser DPAPI·현재 사용자 ACL·배타 OS lock·영속 예산을 사용하고, 기존 기록은 새 INIT 없이 보존된 작업의 관측만 허용한다. API 완료는 `complete_pending_postcheck`이며 `postverified:false`다. UNKNOWN·timeout·클라이언트 종료는 서버 취소나 rollback 완료가 아니다.

인증 callback은 목적·대상·provider ID·만료·승인 참조를 명시하며, 승인 descriptor는 실제 권한의 증명이 아니다. 첫 await 전에 승인 필드·중첩 binding·provider 선택을 복사·고정하므로 외부 객체 변경으로 만료나 대상을 대체할 수 없다. 공급원 자동 탐색·로그인·갱신·fallback은 없다. 승인 만료는 공급 전과 dispatch 직전에 검사하고, 유효 기한은 기존 작업 기한·최초 승인 만료·요청 시작 후 30초 중 가장 이른 시점이다. timeout/abort는 클라이언트 요청·응답을 정리하며, 동기 취소 후 반환된 Agent 등 자원도 해제하고 다음 timer·dispatch를 시작하지 않는다. header 16KiB·body 64KiB의 byte 한도를 초과하면 거절하고 retry·redirect하지 않는다. API 인증은 PUT에 전달하지 않는다. 영속 예약 횟수와 adapter 호출·dispatch 횟수는 별개이며, `actualRequestsThisRun`은 adapter 계수의 차이만 사용하고 계수가 없거나 무효하면 `null`이다. 합성 시험은 실제 TLS·proxy 억제·DNS·서버 수신·wire 요청 수를 증명하지 않는다.

합성 원로그: adapter 53/53 `C:/Users/PC/.mixdog/data/scratch/file-r4-r5-tests-8lhghdxb/adapter-after-fix.log`; 실행기 95/95 `C:/Users/PC/.mixdog/data/scratch/file-r4-r5-tests-8lhghdxb/runner-after-fix.log`. 같은 폴더의 `r4-baseline.log`, `r5-baseline.log`는 동기 취소 자원 누수와 mutable 승인 만료 연장의 수정 전 실패를 보존한다. 이전 계수 오류의 87/88 원로그는 `C:/Users/PC/.mixdog/data/scratch/file-https-tests-c5ecd2rt/https-runner.log`에 남긴다. 보호 기록 11/11은 source가 바뀌지 않은 `C:/Users/PC/.mixdog/data/scratch/s.edb1c28281601c4c/d1-state-9bxpuiwd/focused-fix2.log`를 재사용한다. 초기 모순 응답 실패는 `C:/Users/PC/.mixdog/data/scratch/file-runner-tests-6_llwssa/file-runner-pre-fix-terminal.log`, 보호 기록 시험 보조 코드 오류는 보호 기록 폴더의 `focused.log`, `focused-fix1.log`에 보존한다. Node hook은 native helper의 OS 수준 egress 차단이 아니며, 악성 동일 사용자에 의한 전체 기록 rollback이나 실제 정전 내구성은 검증하지 않았다. 기존 SQL native100·로컬Wrangler9·helper26은 각 기존 범위만 재사용하며 원격 원자성·재개 증거로 확대하지 않는다.

저장된 공식 근거의 FILE 문구는 “to ensure large imports are atomic operations, never leaving your database in a halfway state”로 파일 import 기능에 관한 것이다(https://blog.cloudflare.com/building-d1-a-global-database/). 별도 API 문구 “Imports block the D1 for their duration.”는 준비·사후 조회까지의 차단이나 정확한 in-flight 직렬화 경계를 증명하지 않는다. 새 실행기와 실제 운영 경로에 대한 최종 적용성은 미확정이다.

사후 확인에는 별도 승인이 필요하다. schema/helper 확인은 14개 label(테이블 3·trigger 10의 전체 정의와 helper 부재), 기존 relation-postcheck는 고정 1행으로 계획한다. DDL 정의별 UTF-8 분석 한도는 8,192 bytes이며, 초과·잘림·누락은 거절한다. 비교에는 SQLite catalog 표현의 정규화만 허용하고 전체 정의를 고정 SQL과 대조한다. 정수 counter와 동시점 원본/요약의 양방향 정합성을 요구하며, 테이블 존재나 빈 artifact 테이블만으로 통과시키지 않는다. 관계 일치 flag만으로 과거 행 보존을 독립적으로 증명하지 못하며, 고정된 additive SQL·원자적 적용·지원 writer 가정의 근거도 필요하다. 입력 sentinel·DDL 분석 한도는 실제 전송량·물리 읽기·비용 상한이 아니다. 이번에는 사후 조회를 실행하지 않았다.

운영 전 미완료: 실제 인증 공급·권한, 원자성·동시 쓰기 차단의 최종 적용성, writer/cleanup 통제·재개 조건, 변경 전 보호된 복구 기준, 실제 계정·DB 상태·비용 승인, 원격 시간·횟수·사후 조회 예산, UNKNOWN 확인 책임자·후속 승인. writer 중지·Time Travel·자동 재실행·계정 전체 조회·새 token·운영 설정 변경은 묶지 않는다. 이 로컬 준비는 raw 계산건/forecast 연구 DB 전체의 구현·익명화·수집 활성화 완료가 아니다.

## 실행 후보·읽기 확인·출시 의존관계

이 절의 로컬 근거는 실제 배포·수집 활성화 승인이 아니다. 미커밋 파일 전체를 후보로 승인하지 않는다. 계정은 `15be33fd20ea78eb3d60b719be831148`(32-hex), 지정 DB는 `3e18385a-af83-4c67-83a0-ab889149692c`다. 기존 인증은 ‘Mixdog 설정의 Cloudflare 연결’이며 도구 호출에는 사용 가능하지만 로컬 node:https의 credential 공급원으로 확인된 것은 아니다. 선택한 로컬 방식에 별도 인증이 필요했고, 사용자는 이후 단기 계정 D1 Read token을 로컬 비표시 입력으로 공급해 `fields=uuid,name` GET 최대1회에 쓰는 변경을 승인했다. token의 계정 수준 읽기 권한과 프로그램의 지정DB·GET1회 제한은 별개다. Global API Key·쓰기·배포·DNS·token 생성 권한을 묶지 않고 추가 verify·retry·endpoint 탐색을 하지 않는다. MCP 인증 추출·OAuth/브라우저/.env 탐색·Guard/배포 secret 재사용·내부 패치 없이 진행하며 MCP 조회를 로컬 HTTPS PASS로 대체하지 않는다.

**현재 종료는 B — 지정 DB 실제 HTTPS metadata 읽기 성공**이다. 사용자가 검토된 동일 명령을 직접 실행한 후 비밀 없는 `run-f5kjM8`의 execution/result/journal과 parent receipt를 확인했다. 승인된 계정·DB·GET path와 예상 uuid/name `collection-kit-stats`가 일치하고 예약·adapter 호출·dispatch·확인 응답이 각각 1이다. client PID22548은 종료됐으며 sqlAccessed:false·credentialPersisted:false, 승인된 source/runtime hash가 일치한다. 근거는 `C:/Users/PC/.mixdog/data/scratch/s.edb1c28281601c4c/d1-read-stdin-c9x9pn8l/parent-receipt.json` 및 `run-f5kjM8/read-journal.jsonl`, `execution.json`, `result.json`이다. 독립 Reviewer가 해당 기록만 확인해 B를 수용했다. GET1 예산은 소진됐으며 추가 verify·조회·retry를 하지 않는다. 실제 입력·서버 부여 권한의 범위·token 폐기를 별도 API로 검증한 것은 아니다. 폐기와 클립보드 정리는 사용자 handoff 완료 보고이며 token 원문을 읽거나 기록하지 않았다. 이 성공은 FILE write·PUT·SQL 원자성·schema·복구·writer/cleanup·사이트 배포 준비를 입증하지 않는다.

**최초 C — 실행 전 실패 이력은 보존한다.** 에이전트가 일반 Windows PowerShell `-NoProfile -File`로 시작한 최초 시도는 OS 실행 정책이 script load를 거부했다. 오류는 ‘이 시스템에서 스크립트를 실행할 수 없으므로 … 파일을 로드할 수 없습니다.’, `FullyQualifiedErrorId: UnauthorizedAccess`, terminal 1 cursor `1793502658791000` → `1793502658791919`였다. 그 최초 시도는 입력창·provider·Node API client·GET 모두 0으로 끝났고 HTTP/TLS/DB 실패는 아니었다. 에이전트는 정책 변경·Bypass·elevation·encoded-command 우회·자동 재실행을 하지 않았다. 이후 사용자 수동 실행 환경의 정책 설정을 조회하거나 변경하지 않았으며, 현재 성공과 최초 거부를 합치거나 이력을 지우지 않는다.

입력 경로는 PowerShell `Read-Host -AsSecureString` → 환경을 제한한 Node의 private stdin pipe였다. 비밀은 argv·환경변수·Git·일반 로그·receipt에 쓰지 않고 실행 메모리로 공급하며 JS/string의 완전한 zeroization은 보장하지 않는다. scratch `C:/Users/PC/.mixdog/data/scratch/s.edb1c28281601c4c/d1-read-stdin-c9x9pn8l/bridge.ps1` SHA-256은 `1e09c7dc19749ccb263e06e8565f38c184c0274b3c82b2efbb814ec927eb4ae5`, `bridge.mjs`는 `3f6ab05547268f6fc0d757855cdaca9396482f6a45158f02cde3411d5fccacf7`다. 결과 기록에는 입력 후 client window30초·고정 GET·원문 module bytes 복사/검증·배타 marker·비밀 없는 journal이 결속된다. client 종료는 token 폐기나 서버 취소와 다르며 같은 bridge를 다시 실행하지 않는다. FILE 쓰기 권한·DB 적용·배포·수집 활성화·복원·commit·push는 이번 승인에 포함되지 않는다.

발급 절차 참고: https://dash.cloudflare.com/profile/api-tokens/ 의 My Profile → API Tokens → Create Token → Create Custom Token에서 Account → D1 → Read만 선택하고 Include → Specific account로 위 계정 하나를 고른다. TTL은 짧게 설정하고 결과·실패·중단 직후 token을 폐기한다. Global API Key·Edit/Write·DNS·Workers 배포·token 관리 권한은 추가하지 않는다. 발급 화면의 예제 verify/curl은 이번 승인에 포함되지 않는다. 이번 token 사용은 종료됐으므로 새 token을 발급·입력하거나 기존 명령을 다시 실행할 필요가 없다. 공식 근거: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ ; 지정 DB metadata GET의 D1 Read 허용: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/ .

수용된 기준 후보의 SHA-256은 아래와 같다. 53·95건은 각각 당시 adapter·실행기 전체 파일 결과이며, 변경 없는 보호 저장소 11건은 별도 근거다. 과거 55·92건과 합산하지 않는다. 읽기 준비의 후속 diff와 영향 시험은 별도로 연결하고, 과거 결과를 변경된 전체 후보의 새 PASS로 이월하지 않는다.

| 수용된 기준 파일 | SHA-256 |
| --- | --- |
| scripts/d1-file-import.mjs | c2d2fac895e1e9cd66661459b1f997024d8787a80be354d091f4caba89b49eae |
| scripts/d1-file-import-https.mjs | 0f38ac867c2310b3dd70c3f78c9b6076ca575cfba228e70203efe7720e51623a |
| scripts/d1-file-import-state.mjs | c50053942cd82c3d605bce15cbb554d49c2198781b0d10a84c7f8ce24577eec2 |
| scripts/d1-file-import.test.mjs | 24ba07019196a06e362fd23cfa484d991886c4d7488bd15758741b7413a68724 |
| scripts/d1-file-import-https.test.mjs | 0e0e2cdf3edde4f7a049a407b6be52f5c73f30709ee64c5e0a58df0594698fb7 |
| scripts/d1-file-import-state.test.mjs | 4656ad35af0fb33315c7282a8db05aefd8e6748359f1428d481272eef3b7b0e3 |

원로그의 before/after source hash는 일치한다. 이후 scratch `run.py`에 문서 확인 mode가 추가되어 현재 wrapper hash는 당시 시험 기록과 다르며, 이를 source 변경이나 전체 환경의 새 검증으로 표현하지 않는다. 실제 실행 의존성은 고정 Node 26.13.0과 Node built-in, 보호 저장소의 Windows PowerShell `-NoProfile -NonInteractive`·.NET CurrentUser DPAPI·ACL이다. Node 실행 파일 SHA-256은 `14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5`다. OS helper source는 저장소 module hash에 결속되지만 PowerShell/.NET 전체 환경의 별도 봉인은 확인하지 않았다. Wrangler 4.151.3은 기존 SQL 리허설 도구이지 작은 실행기의 런타임 의존성이 아니다.

이번 읽기 준비 후보는 `scripts/d1-file-import-https.mjs` SHA-256 `9db6083f7afdc183cfc53acf3b4aadd70baad46c4afcc4013f12db68b19c4ade`, `scripts/d1-db-read-check.mjs` SHA-256 `5552370a54a82c32e8b83aa7299e03b202f6d783caca7cea6c5b018a8da0f63f`, `scripts/d1-db-read-check.test.mjs` SHA-256 `78ef21026cc328da0454cb2609c92508ff022d3445ccff704c95e63a26eec01c`다. 새 고정 읽기 영향 시험 55/55(공유 HTTPS의 좁은 POST/PUT 확인 4건 포함)는 `C:/Users/PC/.mixdog/data/scratch/d1-read-tests-mpkfzhdn/read-after-owner-fix.log`에 있다. 같은 폴더의 `fixed-read-initial.log`는 source 정리·metrics 결함과 시험 보조 코드 오류의 최초 43/51 결과를 보존한다. 이는 과거 실행기 55건과 다른 새 시험이며 기존 53/95/11을 재실행하거나 합산한 것이 아니다. 공유 adapter source의 후속 diff에 대한 근거일 뿐, 과거 53건을 새 source 전체의 실행 결과로 이월하지 않는다.

읽기 경로는 `runD1DatabaseReadCheck`와 `createD1DatabaseReadTransport`로 제한한다. 정확한 HTTPS origin·명시 계정·고정 DB·GET·`?fields=uuid,name`만 허용하고 예상 uuid와 collection-kit-stats를 확인한다. 실제 node:https 구현은 import와 공유하되 읽기 permission·최대1회 예약·기록을 migration 상태와 분리한다. fresh exclusive·fsync 읽기 journal에는 비밀 없는 대상·승인 참조·시각·계수·분류만 남기고 기존 파일 재사용은 거절한다. 인증 공급·승인·기한 검증 전에는 실제 요청하지 않는다. 성공은 제한 내 실제 응답의 수신·대상 확인·결과 기록까지 완료한 경우에만 해당한다. 예약·adapter 호출·dispatch·확인 응답을 각각 기록하며 계수 불명은 null이다. 401/403·대상 불일치·TLS/연결·응답 한도·기록 실패를 구분하고 실패 후 retry·다른 endpoint 탐색을 하지 않는다. FILE write 권한·PUT·SQL 원자성/복구·writer/cleanup·사이트 배포 준비는 이 읽기로 증명하지 못한다.

| 기능 / 상태 | 실제 소비 코드·endpoint | Worker·DB·최소 schema | 설정·OFF 및 남는 작업 | 호환·복구·출시 조건 |
| --- | --- | --- | --- | --- |
| Site / 조건부 준비 | src/hooks/useCalculatorApp.ts; site-worker/src/worker.ts; /api/stats, /api/outcome-summary, /api/events | 기존 collection-kit-site-production → collection-kit-stats의 named Ingest/PublicStats capability | forecast/raw OFF 가능하나 named 통계 조회는 계속 실행. 명시적 build/check/deploy:site-production-off 경로 사용 | bundled/OFF artifact의 실제 빌드·고정 SHA·구성 검증과 별도 배포 승인 필요. 기존 STATS fallback과 capability profile의 v3 410은 별도 계약; 파일 번호로 퇴역을 결정하지 않음 |
| 신규 solver / 로컬 근거 | useServiceCertifiedSolver → serviceCertifiedAdapter → browserClient/workerHandler; Calculate 시 lazy 생성 | 브라우저 dedicated Worker·고정 WASM/ABI. Forecast D1·Discord는 bundled 계산의 필수 조건 아님 | VITE_SERVICE_CERTIFIED_SOLVER 선택. App boot는 solver Worker·forecast 조회를 시작하지 않음; dispose/idle 해제 유지 | 기존 고정 WASM 검증을 사용하며 Rust rebuild는 명시 작업. signed online forecast와 현재 engine sealed publication 증거는 별도 gate. 구 runtime URL·WASM alias 보존 |
| 운영 forecast / 별도 미완료 | /api/forecast/version, /api/forecast; collector /health·인증 /admin/*; dispatcher scheduled; /discord/interactions | 기존 collector/dispatcher/interactions + Forecast 2d58bcc0-a7b5-43f3-8f42-34e1bf1ff853·Guard 49b7f966-f4e8-4c2d-8453-279415737054; runtime publication v5 schema | Site enabled에는 DB·Guard·rate limiter·공개 신뢰키 필요. collection/dispatch/publication/cleanup은 독립 flag. collector health도 Guard 사용; dispatcher fetch는 404 | production/staging caller 분리·binding/name·Cron·CPU budget 정렬 필요. 후보 빈 Cron·CPU300을 과거 운영 빈 Cron·CPU50 관찰과 혼동하지 않음. 외부 caller 미확인. signed OFF와 sequence0 초기화는 다름 |
| 기존 통계 / DB0002 미적용 | PublicStats → stats-read.ts; /api/stats; Diagnostics.readObservations; schema-health.ts | 기존 collection-kit-stats, Stats D1·Guard. named compact reader는 stats_public_totals/game_day(0002); diagnostics/health는 기존 원본 schema | raw OFF여도 public 통계·diagnostics·legacy schema health는 독립 실행. health는 0002/0003 attestation 아님. 초기 handler 구성은 DB migration을 실행하지 않음 | 기존 default HTTP reader는 원본 aggregate 사용. cutover=true면 그 HTTP interface 비활성. Stats CPU10·17 3 Cron을 보존하며 별도 DB 적용/사후 확인 필요 |
| 결과 신고 / 신규 raw 기본 OFF | Ingest /api/events, /api/decision-outcomes; PublicStats /api/outcome-summary; outcome-handler.ts/event-submission.ts | 기존 events schema; outcome_summary/outcome_effects 등은 Stats0003. 0002만으로 outcome-summary 준비 안 됨 | 새 v4 /api/decision-outcomes만 OUTCOME_FACTS_ENABLED·STATS_CAPABILITY_CUTOVER가 모두 true여야 저장하고 OFF면 storage 전 404. 기존 /api/events는 raw OFF여도 기존 검증·보안·quota 조건 아래 저장 가능. outcome-summary는 OFF와 독립 조회; cutover=true의 기존 kit_result는 outcome_effects도 확인 | queue 미수락 legacy 보존·전송 후 불명 ACK fallback 금지 정책 유지. raw OFF는 기존 통계 수집 전체의 OFF가 아님. flags OFF만으로 named profile의 schema 필요가 사라지지 않음. 0003 독립 승인·호환 consumer 필요 |
| 신규 raw 통계 / 수집 비활성 | OutcomeRawFacts; outcome-store/facts/raw-reader/publication; stats-admin operator gateway | Stats0003 영구 facts·uniqueness·effects·요약, 0002 artifact archive. Forecast는 공개 공급의 authoritative 원본 | 보유량·선택/권고 method·실제 recommendedUses·명시 outcome/attemptCount·공개 supplyReference 계약. reader budgets+Guard 및 Access/JWT/operator 승인 필요; OPERATOR_ENABLED=false는 raw RPC 전 503 | outcome-only 영구 facts 유지. 적합한 별도 노출 분모 없이는 신고 분포를 강화 선택률로 표현하지 않으며, 무응답을 미강화·WAIT로 채우지 않는다. 이를 보완하려고 새 사용자 ID·장기 추적·추가 수집을 넣지 않는다. 무응답 제외·random UUID·개인 입력/outbox RAM-only 유지. projection은 exact rational pieces/공개 interval이며 누락을 임의 미래 공급으로 채우지 않음. 후속은 unknown 횟수의 제한된 once-only 보완; 사실/uniqueness 영구, patch control24h·receipt14일. 전체 연구 DB 완료로 확대하지 않음 |
| cleanup·복구 / 별도 통제 | Stats scheduled → rate-limit.ts; outcome maintenance; collector minute57 cleanup; Site /api/_ci/stats-health | Stats receipts event_ids/stats_rejection_event_ids + Guard; private raw reader는 별도 capability. Site probe는 고정 /api/health만 전달 | ingest OFF는 maintenance OFF가 아님. Stats 기존 17 3 Cron·Guard */15 보존. raw maintenance는 자체 flag/schema4/budget; collector cleanup도 자체 flag·Guard·invocation 필요 | 기존 known UPSERT+receipt cleanup만 전제하고 외부 직접 writer는 운영 제한 가정. 실제 중지·공유 Guard OFF·Time Travel 자동 호출 없음. rollback은 승인된 code/공개 pointer/보존 자산 경로로 검토 |

### OFF 배포 경로와 남은 승인 단위

`npm run build:site-production-off -- <approved-full-SHA>`는 깨끗한 고정 후보에서 신규 solver ON·forecast bundled·online trust 비움을 고정하고 새 `dist/`를 생성한다. 고정 WASM·engine freshness·기존 bundled packaging·보존 자산·disabled catalog·artifact SHA를 검증하며 기존 산출물 덮어쓰기를 거절한다. `npm run check:site-production-off -- <approved-full-SHA>`가 같은 artifact를 확인하고, 별도 승인된 `npm run deploy:site-production-off -- <approved-full-SHA>`는 기존 collection-kit-site-production과 named collection-kit-stats profile을 사용한다. `.vite/local-operational-profile.json`의 `deploymentApproved:false`는 유지하며 artifact 검증을 배포 승인으로 바꾸지 않는다. 기존 online build·deployment gate는 완화하지 않고 제외된 online-builder 변경을 이 후보의 구현으로 간주하지 않는다. `npm run build:operations`의 별도 로컬 `dist-service-bundled/`를 배포 산출물로 자동 승격하지 않는다. Site ASSETS·Stats bindings와 named /api/stats의0002, outcome-summary의0003, 기존 /api/events 의존성은 OFF에서도 유지한다. 실제 DB 적용·인증·복구·시간/요청/비용 예산 및 Backend→Site 순서의 배포 승인은 아직 미완료다.

| 미완료 조건 / 실제 소비 | 필요한 값·근거 | 승인 단위 |
| --- | --- | --- |
| decisionMetadataInstallation → createProductionStatsWorker | cloudflare/src/generated/decision-production-installation.ts는 undefined; 실제 승인된 설치 구성 필요 | backend의 한정 module 구현·통합 검증 |
| createProductionDecisionResolver acquire / expectedSupply mapping | 인증된 contentHash·runtimeSnapshotHash·asOf acquisition과 frontend 공급량 의미에 맞는 mapping | Front/Backend 공유 정책 승인; bands·단위·window 임의 생성 금지 |
| serviceCertifiedAdapter / retainVerifiedAcquisition / resolver | frontend 계산 asOf와 server projection 대응 근거 | 동등성 검증 또는 명시적 계약 변경 승인 |
| candidateCoverageError / prepareArtifactApproval | 현재 engine별 원래 sealed panel/receipt·production trust·publication key 승인 | 실제 증거 검증·게시 승인; 과거 engine·synthetic으로 대체 금지 |
| Ingest / PublicStats | Stats0002·0003 각각의 원문·선행 schema·사후 확인 | 기존 Stats D1의 독립 파일 적용 승인 |
| Forecast applyMigrations / createForecastEndpoint / createInteractionWorker | 별도 migration cohort/ledger·production 키·binding·limiter·staging caller 전환 | Forecast DB·키 등록·연결·발행 각각의 승인 |
| kitResultAggregateStatement / cleanupExpiredStatistics / runStatisticsCleanupJobs | 실행 시점 writer/caller/cleanup baseline·보호된 복구 기준·UNKNOWN 책임자는 미확정 | 필요 대상만 한정 조회·조정·재개 조건 승인 |

### migration 구분과 다음 적용계획 — 아직 실행 승인 아님

Stats0002는 위 고정 원문이며 이번 workflow에서는 미적용이다(운영 상태 재조회 아님). Stats0003는 `cloudflare/decision-analytics/0003_outcome_facts.proposed.sql`, 10,233 bytes, SHA-256 `5ad0f107744d608b2956b38862952e6a9962fa603d6908f3d2be689d288668c0`다. 영구 결과 facts/effects·중복 방지·요약/운영 제어를 추가하고 0002의 outcome_public_artifacts를 선행조건으로 한다. 동일 hash의 과거 로컬 적용·late-failure rollback은 `C:/Users/PC/.mixdog/data/scratch/sess_daemon_1793450787820_04c84add7b414658928f786508c1a04e/wrangler-local-migration-literal-lookup.log`에 있으며 실제 운영 준비 증명은 아니다. 0002 뒤 자동 연속 적용하지 않고 historical raw를 재구성하지 않는다.

Forecast의 `forecast-collector/migrations/0005_discord_staging_adoptions.sql` 및 `0011`–`0034`는 다른 DB·ledger/checkpoint 작업이다. helper는 0005 선행 schema와 0011의 중복 revision 조건을 확인하며 0034는 publication dependency closure를 재구성한다. 기존 수용된 선행조건·로컬 검증은 역사적 범위만 재사용하고 재실행하지 않았다. 정확한 승인 cohort·실제 적용 이력은 운영 전 별도 확인하며 code rollback 때 schema/history를 삭제하거나 v5 비호환 구 앱에 publication을 노출하지 않는다.

다음 실제 적용안은 Stats0002 단독이다. 선행 source는 cloudflare/schema.sql의 event_aggregates/event_aggregates_game_day(각 8열 PK·integer counter)이며 bootstrap은 실행하지 않는다. 별도 승인 사전 조회는 bounded catalog 1회(257 sentinel·DDL별 8,192-byte 분석 한도)와 기존 self-validating Q2 1회(고정 2행·source별 10,001 sentinel)로 제안한다. 알려진 단조 UPSERT와 14일 receipt cleanup의 담당·외부 writer 제한·재개 조건을 기록하되 새 blanket fence는 요구하지 않는다. 변경 전 보호된 복구 기준은 아직 미완료이며, 필요 시 지정 Stats DB의 현재 bookmark GET 최대 1회를 별도 승인받는다. 실행 상태 기록은 DB backup이 아니다.

적용 예산 제안은 INIT≤1·PUT≤1·INGEST≤1·POLL≤12, 작업600초와 최초 승인 만료·요청30초 중 이른 제한이며 실제 HTTP retry/redirect/인증·사후 확인을 포함한 최종 wire 예산 승인은 별도다. 논리 성공 작업량 2L+3C≤50,000은 물리 과금 상한이 아니다. 비용 판단에 필요할 경우에만 요금제 확인 최대1회와 해당 quota 기간 D1 read/write/storage 집계 최대1회를 별도 범위·권한으로 제안한다. 사후 조회는 위 metadata14 label 1회+relation flag1행 1회이며 실제 실행하지 않았다. API complete와 postverified를 분리한다. 원본 보존은 고정 additive SQL·원자적 적용·지원 writer와 관계 검증을 함께 근거로 삼는다.

UNKNOWN 확인 책임자는 **미지정**이며 지정 전 적용할 수 없다. 시작 응답/작업 ID 유실·한도 소진·프로세스 종료는 자동 재실행이나 복원으로 처리하지 않는다. 보호 기록과 terminal status·대상 schema 정의를 좁은 별도 승인으로 확인한 후 후속 조치를 결정한다. Time Travel은 이후 정상 쓰기를 덮어쓸 수 있으므로 변경 전 기준·적용 결과·이후 쓰기를 구분한 복구 승인이 필요하다. 이번 읽기 확인 승인은 이 적용계획·writer 중지·publication·배포·키 등록·복원을 승인하지 않는다.

## 미해결 승인·값·검증

| 필드 | 상태 |
| --- | --- |
| routeIds | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| productionDomainCutover | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| newRateLimitNamespaces | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| productionApprovalRef | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| productionKeyId | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| productionPublicKey | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| bootstrapCutoff | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| currentEngineOriginalSealedPanelAndReceipt | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| m2RuntimeBudgets | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| m2Allowlists | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| m2CleanupActivation | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| actualExpectedSupplyMappingUnitsWindow | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| dynamicBackendResolverSeamReview | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| statsForecastRateLimiterNamespaceAndRate | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| cpuSufficiency | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| planCompatibility | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| wrangler41513StaticAssetsCustomDomainScope | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| oldActiveCanary | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| watchdogEquivalence | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| remoteWorkersBuildsIntegration | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| guardConfiguredAccountIdCorrection | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| watchdogExpectedAccountId | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
| watchdogHealthUrl | 미해결 — 값·승인·원격 검증을 만들어 채우지 않음 |
