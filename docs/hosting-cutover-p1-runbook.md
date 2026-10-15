# P1 운영 사이트 호스팅 전환: GitHub Pages → Cloudflare Worker

## 범위와 승인 원칙

- 대상: `nikkecollection.com`, Worker `collection-kit-site-production`.
- 정적 자산만 이전한다. 계정은 꺼짐, 서비스 바인딩 없음. stats 브라우저 요청은 기존
  `https://collection-kit-stats.tbvj159.workers.dev`로 직접 전송한다.
- D1, 마이그레이션, 백엔드 배포, OAuth, 이벤트 쓰기, 개인정보 작업, 로깅 활성화는 금지한다.
- 이 문서는 실행 승인이 아니다. 아래 각 **승인 게이트**는 대상·후보 SHA·담당자·시간창·
  비용 한도·중단 기준을 운영자가 별도로 승인해야 한다. 자동 롤백은 없다.
- DNS, Custom Domain, 인증서, GitHub 환경 보호의 실제 운영 상태는 로컬 코드 검증으로
  증명되지 않는다. 이번 구현에서는 원격 조회나 변경을 수행하지 않았다.

## 1. 사전 확인 (읽기 전용, 별도 승인된 계정 범위)

1. 전체 소문자 40자리 후보 SHA가 `main` 이력에 있는지 확인한다. dispatch ref도 `main`이다.
   `Deploy GitHub Pages` 성공은 **검증 성공**이지 Pages 게시를 뜻하지 않는다.
2. `SITE_HOSTING_TARGET` 저장소 변수:
   - `pages` 또는 미설정/빈 값: 기존 Pages 게시 + 공개 Pages smoke.
   - `worker`: 검증 및 `pages-rollback-<SHA>` 아티팩트 보존; Pages 게시와 Pages 공개 smoke 생략.
   - 다른 값: 게시 전에 실패한다. 공백이나 대소문자를 자동 보정하지 않는다.
3. 해당 SHA의 Pages rollback 아티팩트, 다운로드 digest, checkout identity를 보존한다.
   보존 기간은 30일이므로 전환/복구 훈련 전에 만료 여부를 확인한다.
4. `site-worker/production.wrangler.toml`은 이름, `SITE_ENV=production`, `ASSETS`만 사용하고
   `routes`, 서비스/D1 바인딩, 로그, workers.dev, preview URL이 없어야 한다.
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
7. `CLOUDFLARE_PRODUCTION_WORKER_URL`은 기존 stats 백엔드 주소다. 사이트 주소로 바꾸지 않는다.

## 2. Bootstrap (공개 호스트 연결 없음)

**승인 게이트 B — Worker 생성/버전 배포:** 정확한 후보 SHA와 계정/Worker를 승인한 후,
`Promote production site Worker`를 `main`, `deploy_sha=<SHA>`, `mode=bootstrap`으로 dispatch한다.
보호 환경 승인을 별도로 완료한다.

- 승인 전 main 이력 검증, 승인 후 정확한 SHA 재checkout 및 재검증.
- Node 24.21.0 / npm 12.2.0 / Rust 1.98.1; 빌드의 `GITHUB_SHA`는 dispatch SHA가 아니라 후보 SHA.
- 빌드, `check:site-production`, 로컬 `smoke:site-production`, bundle budget, 아티팩트 업로드에는
  배포 토큰이 없다. 토큰은 마지막 배포 단계에만 전달한다.
- `site-worker/production.wrangler.toml`만 배포한다. tag/message는 후보 SHA.
- 실행 summary의 Worker version ID와 아티팩트 digest를 승인 기록과 연결한다.
- bootstrap은 도메인을 붙이지 않으며 공개 smoke를 수행하지 않는다. 공개 접속 불가가 정상이다.
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
  `robots.txt`의 Allow와 Sitemap, JS/CSS/WASM, 계정 off, 직접 stats URL을 검사한다.
- HTML은 재검증; immutable은 해시 자산만 허용. 고정명 `solver_rs.wasm`은 immutable 금지.
  공개 HTML에 CSP/noindex/쿠키가 없어야 한다.
- `/api/stats`, 공개 `/v1/statistics`는 503, 알 수 없는 `/api`, `/auth`, `/v1` 경로는 404,
  허용되지 않은 HEAD는 405, `/api/health`는 404여야 한다.
  OAuth/로그인/로그아웃/개인정보의 허용 메서드 503 검증은 **로컬 gateway 테스트**에서만 한다.
  공개 smoke는 이를 실행하지 않는다. 이벤트 쓰기, 세션 생성, 개인정보 접근은 금지한다.
- www 리다이렉트의 path/query 및 인증서 확인은 별도 승인된 수동 수용 항목이다.
  smoke는 리다이렉트를 허용하지 않으므로 www를 smoke 입력으로 사용하지 않는다.
- 어느 항목이든 실패하면 다음 변경을 중단하고 담당자에게 판단을 요청한다.

## 5. 롤백: 버전 복구와 호스팅 복구를 구분

### Worker 버전 롤백 (호스팅은 Worker 유지)

**승인 게이트 R1:** 계정/Worker와 사전에 보존한 정확한 version ID를 승인한 뒤,
운영자가 해당 버전을 100%로 수동 복구한다. DNS/도메인은 바꾸지 않는다.
복구 SHA로 동일 smoke를 수행한다. 버전이 없거나 assets 복원 조건을 충족하지 않으면 중단한다.
이 워크플로는 자동 rollback을 수행하지 않는다.

### GitHub Pages 호스팅 복구 (DNS/TLS 포함)

1. **승인 게이트 R2:** 승인된 Pages rollback SHA/digest와 보존 아티팩트를 확인하고
   `SITE_HOSTING_TARGET=pages`로 되돌린다. Pages 배포는 기존 승인 절차로 수행한다.
   변수 변경 자체가 과거 아티팩트를 자동 재게시하지 않는다. 현재 워크플로의 게시 이벤트는 main push다.
   과거 아티팩트 재게시가 필요하면 별도의 검토된 Pages 배포 절차와 실행 승인을 확보한다.
2. **승인 게이트 R3:** Worker Custom Domain을 해제하고, 기록된 apex/www Pages DNS 구성을
   훈련된 순서로 복구한다. 리다이렉트 규칙의 제거/수정도 별도 승인한다.
3. **승인 게이트 R4:** 필요하면 GitHub Pages custom domain을 다시 추가한다.
   Pages TLS 인증서 재발급/HTTPS 활성화가 필요할 수 있다. GitHub 검증 TXT는 계속 유지한다.
4. Pages TLS가 정상이고 DNS가 관측된 뒤 Pages smoke를 복구 SHA로 실행한다.
   Worker로 향하는 URL/리다이렉트는 Pages smoke가 거절한다.

DNS 캐시, 도메인 충돌 해소, 인증서 발급 때문에 **즉시 롤백을 보장하지 않는다**.
훈련에서만 측정하며 아직 숫자를 약속하지 않는다:

| 지표 | 시작 → 종료 | 훈련 측정값 |
| --- | --- | --- |
| T_custom_domain_ready | 승인된 연결 시작 → Custom Domain 준비 | 미측정 |
| T_certificate_active | 연결 시작 → 인증서 Active | 미측정 |
| T_dns_observed | DNS 변경 → 지정 관측점 모두 새 대상 확인 | 미측정 |
| T_pages_restore | Pages 복구 승인 → DNS/TLS/Pages smoke 정상 | 미측정 |
| T_end_to_end_recovery | 장애 선언 → 사용자 경로 수용 완료 | 미측정 |

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
