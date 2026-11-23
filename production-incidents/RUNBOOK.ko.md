# 재계산 장애 전용 Worker

## 최초 설치: 소유자 1회 예약 → 해당 Worker Editor 배포

**검토·병합한 새 보호 `main`의 source 검증이 성공하기 전에는 실행하지 않는다.** 이전 설치 workflow를 호출하지 않는다. 현재 GitHub 소유자 권한은 Cloudflare 생성 권한의 증명이 아니다. 기존 collector-stop/uploader, OAuth 연결, Site 발행기 자격은 재사용하지 않는다. 비밀값·토큰·키 파일·응답 본문을 채팅, 명령 인수, 로그, 이슈, Actions 입력에 넣지 않는다.

1. 새 SHA의 깨끗한 checkout에서 `.nvmrc` / 고정 pnpm / frozen lock / `--ignore-scripts`로 workflow `prepare`와 동일한 `inert` dry-run 번들을 독립 생성한다. `cloudflare-site-production` **환경 변수** `INCIDENT_REVIEWED_MAIN`과 `INCIDENT_MODULE_SHA256`에 검토한 전체 SHA와 `worker.js` SHA-256을 지정한다. 읽기 환경은 기존 `cloudflare-site-production`, 새 승인·Editor 환경은 `incident-private-install`이다. **둘 다** 배포 브랜치는 `main` 하나, required reviewer는 본인 하나, 단독 소유자의 self review 허용, admin bypass 불허다. 전용 변경 창 동안 계정의 Worker·route·domain·권한·namespace와 `main`을 다른 경로로 변경하지 않는다. 이 검사는 여러 API의 원자적 트랜잭션이 아니다.
2. 아래 권한을 Cloudflare 대시보드에서 구분한다. 현재 소유자가 어떤 토큰·권한을 실제로 보유했는지는 확인되지 않았다. `node scripts/ci/incident-owner.mjs enroll-graph`가 **계정 소유 읽기 토큰**(stdin)의 ID와 실제 정책을 확인한 후에만 보호 환경에 `CF_INCIDENT_GRAPH_READ`와 ID를 등록한다. 정책 조회용 자격은 별도 로컬 FD 3으로만 준다. 권한·리소스 형식이 확인되지 않으면 중단한다.
3. `gh workflow run incident-inert-install.yml --ref main -f source_sha="$(git rev-parse HEAD)"`. 그래프 읽기 단계를 승인한다. 담당 환경이 `incident-private-install`로 바뀌어 대기하면 **웹에서 그 첫 gate를 승인하지 말고** `node scripts/ci/incident-owner.mjs reserve RUN_ID`에 로컬 생성 자격을 stdin으로 공급한다. 이 명령만 비공개 이름 신규 예약을 수행한다. 보호 실행/시도 1·현재 main·검토 모듈·GitHub 서명된 부재 증명(60분)·현재 이름 부재를 확인한다. 반환·재조회한 불변 ID를 기록할 뿐 버전이나 트래픽은 생성하지 않는다.
4. 출력된 **그 ID 하나에만** 계정 소유 `Individual Workers Editor`를 지정한다. `node scripts/ci/incident-owner.mjs authorize RUN_ID`에 Editor를 stdin, 정책 조회 자격을 FD 3으로 준다. helper가 정책·token ID·단일 대상 가시성과 실제 빈 상태를 재확인하고, Editor만 전용 환경 secret에 넣은 뒤 같은 실행의 승인 API에 예약 결과를 연결한다. 수동 JSON/UUID 복사, 다른 기존 Worker 인수, 안 보이는 권한을 계정 편집자로 대체하는 방법은 없다. 이후 같은 run에서 추가 환경 승인이 요구되면 **같은 SHA·run**인지 확인하고 승인한다. 읽기 job이 비공개 예약 영수증을 GitHub OIDC로 서명한 뒤 Editor job만 UUID에 첫 버전을 설치한다. 서명된 `incident-installed-RUN_ID-1`과 최종 읽기 검증 성공이 완료 조건이다. 로컬 영수증은 `~/.incident-private-install/RUN_ID/`에 보존한다.

토큰은 소유자 장치의 secret manager나 접근 제한 파일에서 파이프로 공급한다. 예: `node scripts/ci/incident-owner.mjs authorize "$RUN_ID" < "$editor_file" 3< "$policy_reader_file"` (변수는 **값이 아니라 비공개 파일 경로**). 세 명령 모두 FD 3으로 정책 조회 자격을 받는다. 셸 추적·CLI debug를 끄고, 토큰 발급·회수는 대시보드 소유자 경계에 둔다.

|경계|필요 권한과 제한|
|---|---|
|소유자 장치, 신규 예약 한 번|helper는 계정 소유 토큰의 실제 정책이 이 계정의 `Workers Scripts Write` 하나인 경우만 허용한다. **계정 수준 권한이며 provider가 create-only로 제한한 토큰이 아니다.** helper만 고정 계정/이름의 `POST /workers/workers` 하나를 허용한다. GitHub에 보관 금지. 실제 소유 여부는 미확인이다.|
|소유자 장치, 정책 조회|해당 계정의 `Account API Tokens Read`로 permission groups와 해당 token ID의 정책을 조회한다. 이 자격은 GitHub에 등록하지 않는다. 설치·토큰 생성·관리 쓰기 권한을 대신 요청하지 않는다.|
|보호된 그래프 reader|계정 `Workers Scripts Read`(모든 활성 binding·preview·custom domain), `Pages Read`, `D1 Read`, 이 계정의 전체 zone 목록을 볼 `Zone Read`, 검토한 zone 하나의 `Workers Routes Read`. 새 zone/Pages, 불명확한 페이지, 읽기 거부는 중단이다. 개별 Worker Editor는 이 계정 그래프를 증명할 수 없다.|
|보호된 Editor|해당 UUID 하나에 `Individual Workers Editor`만. 생성·타 Worker·D1 직접 접근·route 쓰기·계정 Admin 없음. 인증 실패 시 범위 확대 금지.|

[Create Worker](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/create/) 요청 자체에 `subdomain.enabled=false`와 `previews_enabled=false`를 함께 보낸다. 먼저 공개로 만들고 나중에 닫는 경로는 없다. 제공자가 이를 무시하거나 빈 Worker의 상태·비노출을 증명하지 못하면, 이미 빈 예약이 생겼을 수 있으므로 **설치하지 않고 조사**한다. 버전·배포·secret 이름·cron·route·custom domain·preview·다른 리소스의 참조와 `419204` 충돌을 점검한다. 배포 뒤에도 핀된 모듈/바인딩·배포 버전 하나·비공개 상태를 다시 읽는다. [Workers 역할과 scope](https://developers.cloudflare.com/workers/authorization/workers/).

그래프 확인에서 [Worker 목록](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/list/)은 첫 페이지의 `count`와 `total_count`가 실제 행 수와 같아야 한다. `total_pages`는 없을 수 있다. Worker·버전·preview의 지정된 beta GET에서만 `success:true`와 명시적인 `errors:null, messages:null` 쌍을 정상 진단 형식으로 인정한다. 이는 부재 자체의 증명이 아니다. 오류, 누락된 목록·페이지 정보, 불일치하는 ID, 비어 있음을 확인하지 못한 참조는 여전히 중단 조건이다. 쓰기 응답에는 이 예외를 적용하지 않는다.

409·403·timeout·응답 유실·부분 성공·만료·승인 불일치는 다른 자격으로 재시도하거나 PUT/삭제하지 않는다. 원래 run과 로컬 시도 표시를 보존하고 소유자가 읽기만으로 대조한다. 성공/중단 후 사용한 단기 자격을 회수하고 전용 환경 secret을 정리한다(공용 secret은 건드리지 않는다). 이 절차는 D1 쓰기·키 등록·Discord canary·공개 전환을 승인하지 않는다. `schema.sql`은 별도 승인으로 빈 전용 D1에만 적용한다.

관리자가 기존 승인 계정의 Discord snowflake를 `ADMIN_ID`, 소유한 봇 토큰을 `BOT_TOKEN`으로 **새 Worker에만** 비공개 등록한다(Cloudflare Worker Settings → Variables and Secrets → Secret). 기존 secret 추출·회전 금지. 메시지 수락을 위해 이 계정에서 봇 DM을 허용한다. 값·스크린샷·Discord 응답을 증적에 담지 않는다.

부분 등록 시 inert 상태를 유지하고 secret 목록에서 **이름·Secret 형식만** 확인한다. 빠진 이름만 등록하고 기존 값을 표시·교체하지 않는다. 값의 정확성은 목록만으로 확인할 수 없다. 두 이름이 모두 있으면 기존 경로·cron 비활성 상태를 다시 확인한 후 보호된 canary 단계로 전환한다. `operator-private-canary` 키는 보존 기간 내 동일하여 INSERT를 반복해도 새 알림은 생기지 않는다. 이 canary는 1회만 시행하고 장기 보존 만료 후 재삽입하지 않는다. 수락 여부가 불명확하면 관리자 inbox로 확인하고 재전송하지 않는다.

별도 승인된 `canary` 설정에는 cron만 있다. 전용 DB에서 다음 단일 INSERT로 같은 전달 경로를 확인한다 (`:build`는 설정과 일치하는 승인된 64자리 해시로 바인딩).

```sql
INSERT INTO incidents VALUES ('operator-private-canary',unixepoch(),:build,'canary','private') ON CONFLICT DO NOTHING;
SELECT day,state,attempts FROM notifications WHERE reason='canary';
```

`sent` 및 관리자의 실제 DM 수신을 둘 다 확인한 뒤에만 `public` 정확 경로를 승인·등록한다. canary 실패/미확인은 서비스 준비 완료가 아니다. 운영자 canary는 브라우저에서 만들 수 없다. 승인 경로에서 전달할 증적은 phase, codeHash, UTC, 상태, 관리자 수신 확인뿐이다. `claimed`가 오래되면 `uncertain`으로 격리한다. `uncertain`은 실제 발송됐을 수 있으므로 자동/수동 재큐하지 않는다. `blocked`는 secret/수신권한/빌드 및 API 거절을 비공개로 조사한다.

브라우저는 인증 없이 호출하므로 이 신호는 사용자 신원이나 진짜 장애의 증명이 아니다. Origin은 인증이 아니다. 전역 일일 신규 240건, 위치별 분당 60요청, 빌드·이유·단계당 UTC 하루 1통, cron당 1통이다. 과부하 시 429로 누락될 수 있다. 난수 시도 ID의 SHA-256만 저장한다. 사용자 ID/IP, URL, 입력, 예외문, stack은 저장하지 않는다. 5분 cron에서 사건은 30일, UTC 날짜별 발송 기록은 30~31일 후 삭제한다(중단 시 재개 후 삭제). Cloudflare 계정의 로그 수집·push 및 D1 백업 보존 정책은 별도 확인한다. 롤백 시 경로를 먼저 철회한다. 장기 비활성화 시 보존 기간 종료 후 전용 DB 폐기까지 담당자를 지정한다.
