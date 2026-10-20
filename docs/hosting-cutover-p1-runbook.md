# P1 운영 사이트 호스팅 전환: GitHub Pages → Cloudflare Worker

## 범위와 승인 원칙

- 대상: `nikkecollection.com`, Worker `collection-kit-site-production`.
- 계정은 꺼짐. stats 브라우저 요청(집계 조회 `GET /api/stats`, 확정 결과 제출
  `POST /api/events`)은 동일 출처 `https://nikkecollection.com`으로 전송하고 사이트 Worker의
  STATS 서비스 바인딩으로 전달한다. **Release A 준비 단계에서는** 직접 workers.dev stats 주소를
  유지한다. 이 문서의 후속 retirement 절차와 별도 승인된 release B 전에는 닫지 않는다.
- D1, 마이그레이션, 백엔드 배포, OAuth, 개인정보 작업, 로깅 활성화는 금지한다.
  운영자와 smoke는 이벤트 쓰기를 수행하지 않는다. 실제 사용자 브라우저가 보내는
  동일 출처 `POST /api/events`는 활성화 후 의도된 동작이며, 이는 운영자 주도 쓰기가 아니다.
- 이 문서는 실행 승인이 아니다. 아래 각 **승인 게이트**는 대상·후보 SHA·담당자·시간창·
  비용 한도·중단 기준을 운영자가 별도로 승인해야 한다. 자동 롤백은 없다.
- DNS, Custom Domain, 인증서, GitHub 환경 보호의 실제 운영 상태는 로컬 코드 검증으로
  증명되지 않는다. 이번 구현에서는 원격 조회나 변경을 수행하지 않았다.

## Staging redeploy maintenance switch (separate backend scope)

This switch does not authorize backend changes under the P1 site-only scope above.
The owner sets the repository Actions variable `FORECAST_STAGING_AUTO_REDEPLOY`
to `disabled` during a separately approved manual staging rollout. `enabled` or
an unset variable retains the existing automatic deployment behavior. The workflow
changes must be present on `main`; drain already-running deploy jobs separately.

- `.github/workflows/forecast-collector-deploy.yml` skips its staging deployment
  job, but its independent `deploy-usage-guard` job still verifies and deploys the
  account-wide Usage Guard, applies its schema and refreshes persisted quota state.
  That job retains the existing `main` restriction and credential handling; it is
  not controlled by the staging switch. Staging deployment requires its success.
- `.github/workflows/forecast-d1-budget-watch.yml` keeps usage checks, alerts and
  protected production emergency-stop escalation active. Only staging
  Collector/Dispatcher redeployment is suppressed.
- **While disabled, staging stops rely on Usage Guard runtime gating.**
  Watchdog reasons `paid_quota_*`, `canary_runtime_invalid` and
  `stats_production_d1_unreadable` are still reported but are **not enforced by
  staging redeploys**. A watchdog decision is not proof that persisted Guard state
  has changed or that staging stopped. Inspect the alert's observed effective
  Guard action and redeploy outcome; missing evidence is `unavailable`.
  `/health` returns the effective action in both `effectiveAction` and
  `state.action`; it does not expose the underlying persisted action. Stale
  persisted `normal` can therefore appear as an escalated effective action.
  An effective `normal` action can leave staging running despite these watchdog findings.
  The owner must assess and authorize a manual staging stop where needed; do not
  disable the shared Guard or protected production safety to manage staging.
- `.github/workflows/worker-deploy.yml` skips automatic staging stats deployment.
  Production stats promotion of a new `main` commit remains blocked by
  `.github/workflows/worker-promote.yml` until that exact candidate is deployed
  manually to staging and satisfies the existing promotion checks. The switch
  neither bypasses promotion verification nor blocks promotion of an already
  qualifying staging candidate.

Set the variable back to `enabled` (or remove it) only when automatic staging
deployment ownership can safely resume. Summary notices identify suppression;
Discord alerts do not claim that a suppressed redeploy completed a stop.

## 1. 사전 확인 (읽기 전용, 별도 승인된 계정 범위)

1. 전체 소문자 40자리 후보 SHA가 `main` 이력에 있는지 확인한다. dispatch ref도 `main`이다.
   `Deploy GitHub Pages` 성공은 **검증 성공**이지 Pages 게시를 뜻하지 않는다.
   **dispatch 전 체크리스트:** 해당 후보 SHA의 `Deploy GitHub Pages` 검증 실행이 성공했는지
   확인하고 실행 URL을 승인 기록에 연결한다. 다른 SHA의 성공으로 대체하지 않는다.
2. `SITE_HOSTING_TARGET` 저장소 변수:
   - `pages` 또는 미설정/빈 값: 기존 Pages 게시 + 공개 Pages smoke.
   - `worker`: 검증 및 `pages-rollback-<SHA>` 아티팩트 보존; Pages 게시와 Pages 공개 smoke 생략.
   - 다른 값: 게시 전에 실패한다. 공백이나 대소문자를 자동 보정하지 않는다.
3. 해당 SHA의 Pages rollback 아티팩트, 다운로드 digest, checkout identity를 보존한다.
   보존 기간은 30일이므로 전환/복구 훈련 전에 만료 여부를 확인한다.
4. `site-worker/production.wrangler.toml`은 이름, `SITE_ENV=production`, `ASSETS`, 그리고
   `collection-kit-stats`로 가는 `STATS` 서비스 바인딩만 사용하고 `routes`, D1 바인딩, 로그,
   workers.dev, preview URL이 없어야 한다.
   Custom Domain은 이 워크플로가 만들거나 제거하지 않는다. Wrangler 설정의 source-of-truth
   동작 및 dashboard 소유 도메인 보존은 사전 훈련에서 확인한다.
5. 현재 apex/www DNS, TTL, Pages custom domain/TLS, GitHub 도메인 검증 TXT, 기존 Worker
   version ID와 배포 SHA를 승인된 보관 위치에 기록한다. 토큰 값은 기록하지 않는다.
6. **승인 게이트 A — CI 설정 변경:** `cloudflare-site-production` 환경에 필수 승인자,
   self-review 방지 및 `main` 배포 제한을 설정한다. 보호 기능의 플랜 지원 여부와
   실제 적용을 확인한다. 환경 이름만으로 보호가 보장되지 않는다.
   최소 범위 토큰 `CLOUDFLARE_SITE_API_TOKEN`, 변수 `CLOUDFLARE_SITE_ACCOUNT_ID`,
   `CLOUDFLARE_SITE_PRODUCTION_URL=https://nikkecollection.com`을 설정한다.
   토큰에는 DNS 편집, D1 또는 백엔드 변경 권한을 주지 않는다.
7. Release A 이전/전환 중에는 URL과 profile을 한 쌍으로 관리한다:
   `CLOUDFLARE_PRODUCTION_WORKER_URL=https://collection-kit-stats.tbvj159.workers.dev`,
   `CLOUDFLARE_PRODUCTION_SMOKE_PROFILE=direct`. profile 미설정은 실패다.
   URL은 **exact value, no trailing slash**이다. `/`, query 또는 별칭 host를 덧붙이지 않는다.
   사이트 private probe 배포 및 아래 drain 게이트 이후에만
   `https://nikkecollection.com` / `gateway`로 함께 변경한다.

## 2. Bootstrap (과거 P1 절차, release A에서 사용 금지)

아래는 이미 존재하는 사이트 Worker의 역사적 생성 절차다. Release A의 trusted YAML과
deployment validator는 `publish`만 허용한다. 필수 probe secret을 배포 전에 별도로 설정해야
하므로 이 workflow로 새 Worker를 bootstrap할 수 없다. 신규 계정/Worker의 domain-free
bootstrap은 별도 설계·승인이 필요하며 필수 secret 검사를 우회하지 않는다.

**승인 게이트 B — Worker 생성/버전 배포:** 정확한 후보 SHA와 계정/Worker를 승인한 후,
`Promote production site Worker`를 `main`, `deploy_sha=<SHA>`, `mode=bootstrap`으로 dispatch한다.
보호 환경 승인을 별도로 완료한다.
동시 실행 그룹의 `cancel-in-progress: false`는 실행 중인 배포의 취소를 막지만,
새 dispatch가 이미 대기 중인 실행을 교체할 수 있다. FIFO 큐를 가정하지 말고
승인 직전에 살아 있는 실행 ID와 후보 SHA를 다시 확인한다.

- 승인 전 main 이력 검증, 승인 후 정확한 SHA 재checkout 및 재검증.
- Node 24.21.0 / npm 12.2.0 / Rust 1.98.1; 자식 빌드 프로세스의 `GITHUB_SHA`는 후보 SHA이다.
  GitHub 예약 환경변수의 step-level 재정의에 의존하지 않는다. 업로드 전에 실제 entry JS의
  후보 SHA를 검사한다.
- 빌드, `check:site-production`, 로컬 `smoke:site-production`, bundle budget, 아티팩트 업로드에는
  배포 토큰이 없다. 토큰은 마지막 배포 단계에만 전달한다.
- 검증/빌드 job은 보호 환경과 분리된 runner에서 실행된다. 보호된 deploy job은 그 실행의
  아티팩트를 내려받고 tar payload SHA-256을 job output과 비교한 후 추출한다.
  GitHub 아티팩트 digest와 payload digest는 별개이며 둘 다 보존한다.
  의존성은 lockfile에서 `npm ci --ignore-scripts`로 설치하고, 내려받은 dist에
  `check:site-production`을 통과한 뒤에만 배포한다.
- `site-worker/production.wrangler.toml`만 배포한다. tag/message는 후보 SHA.
- 실행 summary의 Worker version ID와 아티팩트 digest를 승인 기록과 연결한다.
- bootstrap은 도메인을 붙이지 않으며 공개 smoke를 수행하지 않는다. 공개 접속 불가가 정상이다.
- bootstrap은 대상 Worker가 없거나 배포 목록이 비어 있을 때만 허용한다. 기존 배포,
  인증/권한 오류 또는 알 수 없는 응답은 중단하며 기존 운영 Worker를 덮어쓰지 않는다.
- 실패 시 중단한다. 자동 재시도/자동 복구/권한 확장은 하지 않는다.

## 3. 호스팅 Switch (수동, 각 변경 별도 승인)

1. **승인 게이트 C — Pages 게시 중지:** `SITE_HOSTING_TARGET=worker`로 변경한다.
   진행 중인 Pages deploy가 남아 있지 않은지 확인하고, 이미 시작된 실행의 취소는 별도 승인한다.
   이후 Pages 워크플로가 검증과 rollback 아티팩트는 유지하고 게시/smoke는 생략하는지 확인한다.
2. **승인 게이트 D — 기존 custom-domain/DNS 해제:** apex에 기존 CNAME이 있으면
   Worker Custom Domain 생성 **전에 제거**한다. 기존 Pages 설정 변경이 필요하면 별도로 승인한다.
   GitHub 도메인 검증 TXT는 유지한다. 현재 값/TTL/복구 절차를 먼저 보존한다.
   기존 A/AAAA의 자동 대체 동작은 **미검증**이다. 자동 덮어쓰기를 가정하지 않고, 격리된
   사전 훈련에서 확인한 레코드별 제거/생성 순서를 승인받아 적용한다. 일괄 zone 삭제는 금지한다.
3. **승인 게이트 E — apex 연결:** Cloudflare에서 `nikkecollection.com`을
   `collection-kit-site-production`의 **Worker Custom Domain**으로 연결한다.
   와일드카드 Worker Route나 Pages CNAME으로 대체하지 않는다.
4. 인증서 상태가 **Active**가 될 때까지 수용하지 않는다. DNS 관측, TLS 유효성/호스트명,
   apex의 정확한 후보 SHA 응답을 각각 확인한다. 일정 시간을 기다렸다는 사실은 성공 증거가 아니다.
5. **승인 게이트 F — www 리다이렉트:** Cloudflare redirect로
   `https://www.nikkecollection.com/<path>?<query>` →
   `https://nikkecollection.com/<path>?<query>`를 설정한다. path/query 보존, 단일 리다이렉트,
   www TLS를 확인한다. www를 별도 콘텐츠 호스트/Worker Custom Domain으로 만들지 않는다.
6. **승인 게이트 G — 기존 Worker publish:** `main`, 동일 승인 SHA, `mode=publish`로 dispatch하고
   보호 환경에서 승인한다. 기존 대상 Worker의 단일 활성 버전을 확인하지 못하면 실패한다.
   도메인 생성/DNS 조작 없이 사이트만 배포하며 그 뒤 공개 smoke를 수행한다.

## 4. Smoke 및 수용 기준

읽기 전용 smoke 실행도 승인된 테스트 시간/요청 예산 내에서 수행한다:

```text
npm run smoke:site-production-deployed -- https://nikkecollection.com <full-candidate-sha>
```

- 한 실행 최대 80 요청, 요청당 15초, 전체 120초, 응답당 20 MiB/전체 64 MiB.
  리다이렉트는 따라가지 않는다. apex를 명시해야 한다.
- `/`, `/en/`, `/ja/` 언어/제목/canonical/hreflang, 정확한 프런트엔드 SHA, sitemap,
  `robots.txt`의 Allow와 Sitemap, JS/CSS/WASM, 계정 off, 동일 출처 stats endpoint 설정을 검사한다.
- HTML 및 고정명 `solver_rs.wasm`/`certified_solver.wasm`은 명시적 재검증이 필요하다
  (`no-cache` 또는 `max-age=0, must-revalidate`). immutable은 해시 자산만 허용한다.
  공개 HTML에 CSP/noindex/쿠키가 없어야 한다.
- `GET /api/stats`는 STATS 서비스로 전달되며 **200 응답과 집계 형식(summary, byKit)을 모두**
  확인해야 한다. 200이라는 사실만으로 통과시키지 않는다.
  `POST /api/events`는 smoke에서 호출하지 않는다.
- 공개 `/v1/statistics`는 503(no-store), 알 수 없는 `/api`, `/auth`, `/v1` 경로는 404,
  허용되지 않은 HEAD는 405, `/api/health`는 404여야 한다.
  OAuth/로그인/로그아웃/개인정보의 허용 메서드 503 검증은 **로컬 gateway 테스트**에서만 한다.
  공개 smoke는 이를 실행하지 않는다. 이벤트 쓰기, 세션 생성, 개인정보 접근은 금지한다.
- www 리다이렉트의 path/query 및 인증서 확인은 별도 승인된 수동 수용 항목이다.
  smoke는 리다이렉트를 허용하지 않으므로 www를 smoke 입력으로 사용하지 않는다.
- 어느 항목이든 실패하면 다음 변경을 중단하고 담당자에게 판단을 요청한다.

## 5. 롤백: 초기 복구와 retirement 이후 복구를 구분

- **Secret/CI cutover 이전:** 기록된 초기 site version 복구는 기존 호스팅 제약 아래에서만 가능하다.
  pre-probe 버전은 private probe나 최신 secret을 제공하지 않는다.
- **변수 전환 이후, B 이전:** 모든 관련 실행을 drain하고 직접 endpoint가 실제로 살아 있는지
  확인한 뒤 URL/profile 쌍을 되돌릴 수 있다. 변수 하나만 되돌리지 않는다.
- **B 이후:** 사전 목록화한 retirement-compatible site/backend version만 사용한다.
  사이트는 동일 출처 stats, private probe, 필요한 secret/limiter를 유지해야 한다.
  backend는 현재 D1/recovery/policy 계약과 quota binding에 호환되어야 한다.
  exact version ID, SHA, artifact digest, secret 세대(값 제외)를 승인 기록에 남긴다.
  pre-activation/direct-client 및 pre-probe site version은 복구 대상이 아니다.
- **Fingerprint equality 제약:** 이후 main에서 fingerprint 대상 파일이 바뀌면 promote
  workflow는 이전 candidate와의 byte equality가 깨져 승격을 거절한다. 호환된 과거
  candidate라도 새 workflow snapshot과 일치하는 검토가 필요하다. Version ID 기반
  `worker-rollback.yml` 복구는 이 candidate fingerprint 제약을 받지 않지만, 복구 후
  현재 smoke의 전체 계약 검증은 여전히 필수다.
- **Pages/direct 복구는 B 이후 사용 불가:** 별도로 승인된 routing 재개방과 호스팅 복구 없이는
  아래 Pages 절차를 실행하지 않는다. Pages smoke 통과는 stats 복구의 증거가 아니다.
- `src/lib/statsSubmissionOutbox.ts`의 기존 endpoint 문자열과 storage-key migration은 유지한다.
  이 코드는 로컬 저장소 마이그레이션이며 네트워크 fallback이 아니다.
- Worker 버전 복구는 workers.dev routing을 복구하지 않는다. 버전 ID, routing 상태,
  gateway/private contract를 각각 확인한다. 실패 시 자동으로 public routing을 열지 않는다.
  필요한 경우 정확한 `collection-kit-stats` 대상의 재개방을 별도 승인하고 preview는 닫아 둔다.

### Worker 버전 롤백 (호스팅은 Worker 유지)

**승인 게이트 R1:** 계정/Worker와 사전에 보존한 정확한 version ID를 승인한 뒤,
운영자가 해당 버전을 100%로 수동 복구한다. DNS/도메인은 바꾸지 않는다.
복구 SHA로 동일 smoke를 수행한다. 버전이 없거나 assets 복원 조건을 충족하지 않으면 중단한다.
이 워크플로는 자동 rollback을 수행하지 않는다.

### GitHub Pages 호스팅 복구 (DNS/TLS 포함)

**Retirement 이후 금지, 별도 재개방 승인 시에만 사용 가능한 역사적 절차다.**

1. **승인 게이트 R2:** 승인된 Pages rollback SHA/digest와 보존 아티팩트를 확인하고
   `SITE_HOSTING_TARGET=pages`로 되돌린다. Pages 배포는 기존 승인 절차로 수행한다.
   변수 변경 자체가 과거 아티팩트를 자동 재게시하지 않는다. 현재 워크플로의 게시 이벤트는 main push다.
   과거 아티팩트 재게시가 필요하면 별도의 검토된 Pages 배포 절차와 실행 승인을 확보한다.
2. **승인 게이트 R3:** Worker Custom Domain을 해제하고, 기록된 apex/www Pages DNS 구성을
   훈련된 순서로 복구한다. 리다이렉트 규칙의 제거/수정도 별도 승인한다.
3. **승인 게이트 R4:** 필요하면 GitHub Pages custom domain을 다시 추가한다.
   Pages TLS 인증서 재발급/HTTPS 활성화가 필요할 수 있다. GitHub 검증 TXT는 계속 유지한다.
4. Pages TLS가 정상이고 DNS가 관측된 뒤 Pages smoke를 복구 SHA로 실행한다.
   Pages smoke는 `SITE_HOSTING_TARGET=worker` 및 직접적인 workers.dev 주소를 거절한다.
   apex 입력은 리다이렉트를 금지하고, legacy Pages URL은 리다이렉트를 허용하되 최종 호스트를
   원래 호스트 또는 HTTPS apex로 제한한다. CLI는 최대 10번, 실패 사이 6초 간격으로 재시도한다.
   **한계:** 같은 apex에서 같은 HTML을 제공하는 Pages와 Worker를 콘텐츠 smoke만으로 구별할
   수 없다. 실제 Pages 복구는 별도의 DNS/Custom Domain/Pages 설정 확인으로 증명해야 한다.
   알려진 외부 font stylesheet와 data URL은 요청하지 않으며 앱 자산은 승인된 origin만 검사한다.

DNS 캐시, 도메인 충돌 해소, 인증서 발급 때문에 **즉시 롤백을 보장하지 않는다**.
훈련에서만 측정하며 아직 숫자를 약속하지 않는다:

| 지표 | 시작 → 종료 | 훈련 측정값 |
| --- | --- | --- |
| T_custom_domain_ready | 승인된 연결 시작 → Custom Domain 준비 | 미측정 |
| T_certificate_active | 연결 시작 → 인증서 Active | 미측정 |
| T_dns_observed | DNS 변경 → 지정 관측점 모두 새 대상 확인 | 미측정 |
| T_pages_restore | Pages 복구 승인 → DNS/TLS/Pages smoke 정상 | 미측정 |
| T_end_to_end_recovery | 장애 선언 → 사용자 경로 수용 완료 | 미측정 |

## 6. Release A private probe 준비 및 pending retirement

**현재 범위는 코드 준비뿐이다.** 다음 배포·secret·변수·로그 조회·B routing 변경은 실행되지
않았으며 각 대상/SHA/예산/시간창에 대한 별도 승인이 필요하다.

1. 운영자가 32 random bytes를 unpadded base64url로 생성한다(43자; 길이는 entropy 증거가 아님).
   사이트 Worker에 `STATS_HEALTH_PROBE_TOKEN`을 먼저 provision한다.
   `wrangler secret put`은 새 버전을 즉시 배포하므로 이전 version ID를 먼저 기록한다.
   GitHub `cloudflare-site-production`, `cloudflare-production`, `cloudflare-stats-probe`에
   같은 probe capability를 저장한다. secret은 build/install/artifact에 전달하지 않는다.
   namespace `419105`는 tracked config에서 미사용이나 계정 전체 충돌 여부는 운영자가 확인한다.
2. `cloudflare-stats-probe`는 main-only branch policy와 15분 job 제한을 적용한다.
   읽기 전용 Pages 계약 검사가 매 push마다 막히지 않도록 **required reviewer 없음**을 권장한다.
   이는 운영자 정책 결정이며 site/backend 배포 환경의 승인 요구를 완화하지 않는다.
3. 승인된 A site를 `mode=publish`로 배포한다. 공개 `/api/health`, `/api/admin/*`는 계속 404,
   `GET /api/_ci/stats-health`만 bearer로 인증한다. upstream은 고정
   `https://nikkecollection.com/api/health`, headers는 고정 Accept뿐이다.
   Site publish의 frontend-contract smoke는 **site candidate의** D1 schema/recovery/policy
   상수를 사용한다. 이미 운영 중인 backend가 이를 만족해야 하므로 새 계약을 포함한 site
   candidate는 나중 Stats promotion 전에 post-publish smoke가 실패할 수 있다.
   이 coupling은 유지한다. A처럼 계약이 바뀌지 않는 후보를 사용하거나 별도 승인된
   backend-first rollout으로 맞추며 검사를 완화하지 않는다.
4. 새 실행을 freeze하고 site, Stats promote/rollback, Observer, Pages probe의 모든 concurrency
   group에서 실행/대기 작업을 drain한다. 취소가 필요하면 별도 승인한다.
   아무 실행도 없는 상태에서 URL/profile을 `https://nikkecollection.com` / `gateway`로 변경하고
   일치 여부를 확인한다. GitHub의 두 변수 업데이트가 원자적이라고 가정하지 않는다.
5. `SITE_HOSTING_TARGET=worker`를 유지하여 **production mutation 없이** Pages workflow의
   분리된 frontend-contract job을 검증한다. Observer promotion이나 live rollback을 smoke
   테스트 용도로 dispatch하지 않는다.
6. 정확한 A SHA를 수동 staging 배포한 뒤 Stats A를 promote한다. maintenance switch
   `FORECAST_STAGING_AUTO_REDEPLOY=disabled`는 일반 workflow_dispatch도 막는다.
   trusted SHA/pinned dependencies, Worker types/tests, Paid quota preflight/Guard normal,
   D1 schema check, dry-run, prior-version capture를 먼저 수행한다. 예상 밖 migration은 중단한다.
   기존 staging deploy command를 그대로 사용한다:

   ```text
   npx wrangler deploy --env staging --config cloudflare/wrangler.toml --var "DEPLOYMENT_SHA:<APPROVED_SHA>" --tag "<APPROVED_SHA>" --message "GitHub <APPROVED_SHA>"
   npm run smoke:stats-worker -- https://collection-kit-stats-staging.tbvj159.workers.dev https://nikkecollection.com full direct-staging
   ```

   100% active staging version의 tag가 SHA와 일치해야 한다. production promotion은 승인 전/후
   동일 staging target을 재검증한다. dispatch override는 별도 승인된 추가 작업일 뿐이다.
   `direct-staging`은 위 staging origin만, `direct`는 production workers.dev origin만
   허용한다. 둘 다 trailing slash 없이 정확히 일치해야 하며 staging workflow는
   최초 staging probe/mutation 전에 별도 trusted-YAML origin 검사도 수행한다.
7. 7일 traffic/recovery gate 후에만 B를 준비한다. B에서 production `workers_dev=false`,
   `preview_urls=false`; staging `workers_dev=true`, `preview_urls=false`를 명시한다.
   **A는 stats routing config를 바꾸지 않는다.** B trusted main-ref YAML은 candidate TOML의
   top-level false/false를 독립 검사해야 한다. `[env.staging]` 값은 그 검사를 만족시키지도,
   실패시키지도 않는다. 버전 복구와 별도로 subdomain flags를 확인한다.
   승인자는 pre-guard run의 재실행을 거부하고 guard를 포함한 workflow SHA의 새 main dispatch만
   승인한다. A의 capability guard도 candidate script의 self-report가 아닌 trusted workflow
   commit의 파일 fingerprint와 비교한다. adapter 변경은 해당 main workflow snapshot의 검토가 필요하다.

### 요청/D1 예산과 limiter

최대 4개 probe slot: Stats promote/rollback 공유 1개, site 1개, Observer 1개, Pages 1개.
각 health 요청은 첫 요청/phase 전환도 최소 1초 pacing, episode당 최대 60회/120초이다.
429 및 `cf-mitigated`는 bounded backoff 후 unavailable로 보고하며 backend incompatibility나
성공으로 간주하지 않는다. 404 exhaustion은 auth/routing uncertainty이다. redirect는 금지한다.
Schema repair/rollback 전 `readiness-only`는 backend health 성공이 아니라 authenticated
transport를 통한 well-formed backend envelope 도달을 확인한다. Healthy 200 또는
well-formed non-2xx backend JSON `error` envelope(예: 500 `internal_error`)가 통과할 수 있다.
`retryable`은 없거나 boolean이어야 한다. 인증/limiter 이후 binding 호출이 실패한 gateway
502 `service_unavailable`도 recovery를 허용한다. 그러나 limiter의 503 `service_unavailable`,
`service_not_configured`, 404, 429, challenge, redirect 및 malformed body는 통과하지 않는다.
Quota preflight/runtime guard는 우회하지 않으며 corrective operation 이후에는 전체 healthy
계약을 요구한다. Readiness summary에는 임의 backend error 원문을 기록하지 않는다.
Full verification의 gateway failure, 429/challenge exhaustion 및 public-request challenge는
`verification unavailable (transport)`로 구분하고 restore 시에도 그 분류를 보존한다.

경계 여유를 포함한 244/min에 25% headroom을 적용해 limiter 320/60을 사용한다.
key는 고정 `stats-health-production`; Cloudflare location별 eventual limiter는 전역 비용 상한이 아니다.
T=28 + guard read 1: frontend-only 최대 66 HTTP/1,743 SQL statements, full 67/1,743,
readiness + post-change full + restore full은 최대 194/5,226이다. 두 invalid-token event는
Turnstile 전에 native counter를 사용할 수 있으나 D1 이전에 거부되며 Siteverify는 최대 4회다.
Site publish는 기존 asset smoke 최대 80회에 frontend-contract 최대 66회가 추가된다.
기존 quota/schema/deployment control-plane 및 B negative-probe 요청은 별도 예산에 더한다.
statement 수는 billable rows가 아니다. 각 run은 approved budget 안에서만 실행한다.

### Traffic gate (미실행)

실제 telemetry field keys를 먼저 discover한다(현재 unresolved).
Workers Observability telemetry query에는 **Workers Observability Write** 권한이 필요하다.
dataset `cloudflare-workers`, service `collection-kit-stats`, URL prefix
`https://collection-kit-stats.tbvj159.workers.dev/`를 사용해 매일 bounded 24h window를 조회한다.
consumer signal은 GET `/api/stats`, POST `/api/events`, GET `/api/health`, GET `/api/admin/*`.
7일 완전한 window에서 legitimate 또는 unclassified signal **0**이 게이트다.
승인된 synthetic run과 확실히 상관된 요청만 제외하며 UA만으로 bot/CI를 판정하지 않는다.
scanner 예외는 근거/운영자 승인과 원래 count를 보존한다. missing/truncated window는 0이 아니다.
10% sampling의 zero는 실제 zero의 증거가 아니므로 운영자가 잔여 위험을 수용하거나
추가 sampling의 개인정보/비용 범위를 별도 승인해야 한다.

**2026-10-21 운영자 승인: 임시 100% sampling.** production `collection-kit-stats`의
`head_sampling_rate`를 1.0으로 올린다(staging 0.1 유지). 범위: 모든 production 호출의
invocation log(요청/응답 metadata와 header, IP·UA 포함; `Authorization`은 `********`,
`Cookie`는 `REDACTED`로 마스킹됨을 기존 로그에서 확인), Workers Logs 보존 최대 7일.
비용: 관측 호출 일 39~473건 기준 월 포함량 20M events의 1% 미만. 개인정보 안내(i18n 3개,
README 3개)는 같은 변경에서 "일시적으로 전체, 평소 10% 표본"으로 갱신하고, site publish로
안내가 운영에 반영된 뒤에만 stats `worker-promote`를 실행한다.
- 관찰 기준: production 100% 버전 promote 성공 시각부터 연속 7개 24h window. host 판정은
  `$workers.event.request.headers.host`(legacy = `collection-kit-stats.tbvj159.workers.dev`)를
  events view로 직접 세며, calculations group-by 결과는 events와 불일치해 사용하지 않는다.
  같은 window의 GraphQL `workersInvocationsAdaptive` 호출 수와 대조해 누락 window를 판정한다.
- 판정 후(B 종료 또는 연장 결정): `head_sampling_rate` 0.1, `scripts/cloudflare-paid-quota-config.test.ts`
  기대값 `[0.1, 0.1]`, 개인정보 안내 6곳을 원래 "표본 요청 로그(설정 10%)" 문구로 되돌리고
  승인된 staging→promote 경로로 배포한다. 담당: Lead, 결정: 운영자.

### Token rotation

모든 consumer를 freeze/drain → 새 32-byte token 생성 → Worker와 모든 GitHub 환경 secret 갱신 →
새 token으로 private probe 검증 → recovery version/secret 세대 목록 갱신 → resume 순서다.
단일 token 교체 중 CI를 실행하지 않는다. secret 값은 기록/로그/URL/CLI 인자로 노출하지 않는다.
실패하면 resume하지 말고 승인된 복구/새 rotation으로 해결한다. old-secret version을 무심코
rollback하지 않는다.

## 근거 및 한계

아래는 작업 요청에 제공된 공식 참고 자료이며 기준 검색일은 **2026-10-15**이다.
이번 로컬 구현 세션에서는 네트워크 금지에 따라 다시 조회하지 않았다. 운영자가 실행 전
현재 공식 문서와 실제 계정 상태를 승인된 읽기 전용 범위에서 재확인해야 한다.

- [Cloudflare Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Static assets headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Wrangler configuration source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)
- [GitHub Pages HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
- [GitHub Pages custom-domain troubleshooting](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/troubleshooting-custom-domains-and-github-pages)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
