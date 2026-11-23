# 재계산 장애 전용 Worker

최초 설치는 독립 검토한 보호 `main`의 `.github/workflows/incident-inert-install.yml`만 실행한다. `cloudflare-site-production` 환경의 `INCIDENT_REVIEWED_MAIN`은 최종 전체 SHA, `INCIDENT_MODULE_SHA256`은 그 SHA에서 동결된 패키지로 별도 검증한 Worker 모듈의 SHA-256이다. `CF_INCIDENT_INSTALL_TOKEN`은 환경 secret에만 등록한다. 검토하지 않은 workflow 출력의 해시를 그대로 승인하지 않는다. 환경 승인 전에는 자격 증명 없이 테스트와 번들만 만든다.

설치는 `collection-kit-production-incidents` 전용 D1 ID와 rate namespace `419204`를 확인한다. 기존 Worker별 활성 binding·배포와 라우팅 정보만 읽어 충돌을 검사하고 다른 Worker를 수정하지 않는다. 이름을 신규 예약하고 검토된 모듈 1개만 설치한다. workers.dev, preview URL, route, cron, 수집 로그, 공개 ingress는 비활성이다. 실패·응답 유실 후 이미 예약된 이름에 덮어쓰거나 같은 실행을 재시도하지 않는다. 운영자가 실제 단계와 버전을 확인한다. 이 작업은 D1 쓰기나 secret 등록을 하지 않는다. `schema.sql`은 별도 승인으로 빈 전용 D1에만 적용한다.

관리자가 기존 승인 계정의 Discord snowflake를 `ADMIN_ID`, 소유한 봇 토큰을 `BOT_TOKEN`으로 **새 Worker에만** 비공개 등록한다(Cloudflare Worker Settings → Variables and Secrets → Secret). 기존 secret 추출·회전 금지. 메시지 수락을 위해 이 계정에서 봇 DM을 허용한다. 값·스크린샷·Discord 응답을 증적에 담지 않는다.

부분 등록 시 inert 상태를 유지하고 secret 목록에서 **이름·Secret 형식만** 확인한다. 빠진 이름만 등록하고 기존 값을 표시·교체하지 않는다. 값의 정확성은 목록만으로 확인할 수 없다. 두 이름이 모두 있으면 기존 경로·cron 비활성 상태를 다시 확인한 후 보호된 canary 단계로 전환한다. `operator-private-canary` 키는 보존 기간 내 동일하여 INSERT를 반복해도 새 알림은 생기지 않는다. 이 canary는 1회만 시행하고 장기 보존 만료 후 재삽입하지 않는다. 수락 여부가 불명확하면 관리자 inbox로 확인하고 재전송하지 않는다.

별도 승인된 `canary` 설정에는 cron만 있다. 전용 DB에서 다음 단일 INSERT로 같은 전달 경로를 확인한다 (`:build`는 설정과 일치하는 승인된 64자리 해시로 바인딩).

```sql
INSERT INTO incidents VALUES ('operator-private-canary',unixepoch(),:build,'canary','private') ON CONFLICT DO NOTHING;
SELECT day,state,attempts FROM notifications WHERE reason='canary';
```

`sent` 및 관리자의 실제 DM 수신을 둘 다 확인한 뒤에만 `public` 정확 경로를 승인·등록한다. canary 실패/미확인은 서비스 준비 완료가 아니다. 운영자 canary는 브라우저에서 만들 수 없다. 승인 경로에서 전달할 증적은 phase, codeHash, UTC, 상태, 관리자 수신 확인뿐이다. `claimed`가 오래되면 `uncertain`으로 격리한다. `uncertain`은 실제 발송됐을 수 있으므로 자동/수동 재큐하지 않는다. `blocked`는 secret/수신권한/빌드 및 API 거절을 비공개로 조사한다.

브라우저는 인증 없이 호출하므로 이 신호는 사용자 신원이나 진짜 장애의 증명이 아니다. Origin은 인증이 아니다. 전역 일일 신규 240건, 위치별 분당 60요청, 빌드·이유·단계당 UTC 하루 1통, cron당 1통이다. 과부하 시 429로 누락될 수 있다. 난수 시도 ID의 SHA-256만 저장한다. 사용자 ID/IP, URL, 입력, 예외문, stack은 저장하지 않는다. 5분 cron에서 사건은 30일, UTC 날짜별 발송 기록은 30~31일 후 삭제한다(중단 시 재개 후 삭제). Cloudflare 계정의 로그 수집·push 및 D1 백업 보존 정책은 별도 확인한다. 롤백 시 경로를 먼저 철회한다. 장기 비활성화 시 보존 기간 종료 후 전용 DB 폐기까지 담당자를 지정한다.
