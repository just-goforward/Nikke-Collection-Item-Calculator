import { SITE_CONTACT_EMAIL } from "../siteLocales.ts";
import type { LocalizedLegalDocument } from "./types.ts";

const email = { href: `mailto:${SITE_CONTACT_EMAIL}`, text: SITE_CONTACT_EMAIL };
const TURNSTILE_PRIVACY = "https://www.cloudflare.com/turnstile-privacy-policy/";
const turnstilePrivacyLink = { href: TURNSTILE_PRIVACY, text: TURNSTILE_PRIVACY };
const JSDELIVR_PRIVACY = "https://www.jsdelivr.com/terms/privacy-policy";
const CLOUDFLARE_RECIPIENT = "Cloudflare, Inc. (dpo@cloudflare.com)";

export const PRIVACY_POLICY = {
  ko: {
    title: "개인정보 처리방침",
    description: "NIKKE 소장품 레벨업 계산기의 개인정보 처리방침입니다.",
    effective: ["시행일: 2026년 10월 21일"],
    intro: [
      {
        type: "paragraph",
        text: 'NIKKE 소장품 레벨업 계산기(이하 "서비스", https://nikkecollection.com)는 「개인정보 보호법」 등 관련 법령을 지킵니다. 회원가입·로그인 없이 이용할 수 있으며 이름·이메일 주소·전화번호를 입력받지 않습니다. 다만 서비스 제공과 보안을 위해 접속 정보(IP 주소, 브라우저 정보 등)를 처리하고, 문의 메일을 보내면 발신자 이메일 주소와 문의 내용을 처리합니다.',
      },
    ],
    sections: [
      {
        heading: "1. 처리하는 정보와 목적",
        blocks: [
          {
            type: "table",
            head: ["구분", "처리하는 정보", "목적", "보관"],
            rows: [
              [
                "계산과 계산 진단",
                "입력한 소장품 단계·키트 재고 구간값, 추천 결과 요약, 계산 엔진 진단 정보(소요 시간 구간, 버전, 언어 등), 이벤트 ID. 오류가 나면 오류 종류와 기기 종류, 브라우저·운영체제 종류·주요 버전도 포함. 계산이 완료되면 자동 전송(시험용 certified 모드는 보내지 않음)",
                "계산 수행, 계산 엔진 품질 확인",
                "원본 전송값은 구간별 집계에 반영한 뒤 저장하지 않으며, 집계값은 서비스 운영 기간 동안 보관(이벤트 ID는 중복 방지 기록에 따름)",
              ],
              [
                "결과 통계 전송",
                "(이용자가 전송할 때) 사용 전후 키트 재고, 결과, 이벤트 ID, 언어, 브라우저·운영체제 종류·주요 버전, 기기 종류, 접속 출처",
                "결과 검증, 공개 통계 집계",
                "원본 전송값(원본 재고 포함)과 IP 주소는 집계에 반영한 뒤 저장하지 않으며, 집계값은 서비스 운영 기간 동안 보관",
              ],
              [
                "중복 방지 기록",
                "이벤트 ID(브라우저가 만든 무작위 값), 수신 시각",
                "같은 결과·진단의 중복 반영 방지",
                "14일이 지나면 매일 정리 작업에서 삭제(통상 15일 이내, 정리 작업이 지연되면 더 남을 수 있음)",
              ],
              [
                "악용 방지",
                "IP 주소, 요청 정보",
                "과도한 요청 제한, 자동 요청 차단",
                "요청 수 제한에 일시적으로만 사용하고 별도 저장하지 않음(운영 로그는 아래 항목)",
              ],
              [
                "운영 로그",
                "요청·응답 정보(주소, 시각, 헤더, IP 주소, 브라우저 정보 등)",
                "장애 대응, 서비스 운영",
                "최대 7일 후 자동 삭제",
              ],
              [
                "방문 통계",
                "방문 경로, 유입 경로, 국가, 브라우저·OS·기기 종류, 성능 지표",
                "방문 현황·성능 파악",
                "Cloudflare가 정한 기간",
              ],
              [
                "문의 및 권리 행사 요청",
                "발신자 이메일 주소, 문의 내용, 첨부한 정보, 접수·처리 기록",
                "문의 답변, 개인정보 관련 요청 처리",
                "처리 완료 후 1년 보관 후 삭제",
              ],
            ],
          },
          {
            type: "list",
            items: [
              "운영 로그는 통상 요청의 약 10%를 무작위로 기록하며, 도메인 이전 점검 기간(2026년 10월 28일 무렵 종료 예정)에는 일시적으로 모든 요청을 기록합니다.",
              "결과 통계는 이용자가 전송한 경우에만 받으며, 계산 진단 정보는 계산이 완료되면 자동으로 전송됩니다(시험용 certified 모드 제외). 이용자 수는 세지 않고, 집계값에 이용자별 식별자를 연결하지 않습니다.",
            ],
          },
        ],
      },
      {
        heading: "2. 이용자 기기에 저장하는 정보",
        blocks: [
          {
            type: "paragraph",
            text: "운영자가 설정하는 쿠키는 없습니다. 다만 Cloudflare의 보안 기능(Turnstile 등)이 보안용 쿠키를 설정할 수 있습니다(3항 참고). 서비스는 아래 정보를 브라우저 저장소에 보관하며, 브라우저 설정에서 언제든 지울 수 있습니다.",
          },
          {
            type: "list",
            items: [
              "화면 테마: 이용자가 바꾸거나 지울 때까지",
              "전송하지 못한 결과·진단 정보: 15분간 재전송용으로 보관, 만료된 기록은 다음 접속 때 삭제",
              "계산 화면 입력값 임시 저장: 약 5분 안에 다시 불러올 때만 복구에 쓰고 바로 삭제, 탭을 닫으면 사라짐",
              "시험용 계산 모드(certified)의 입력값과 기록 세션: 이용자가 지울 때까지",
            ],
          },
          {
            type: "paragraph",
            text: "Cloudflare Web Analytics는 쿠키나 브라우저 저장소를 사용하지 않습니다.",
          },
        ],
      },
      {
        heading: "3. 처리 위탁 및 국외 이전",
        blocks: [
          {
            type: "paragraph",
            text: "서비스 제공을 위해 아래와 같이 개인정보 처리를 위탁하며, 이 과정에서 개인정보가 국외로 이전됩니다.",
          },
          {
            type: "table",
            head: [
              "받는 자(연락처)",
              "업무",
              "이전 국가",
              "이전 시기·방법",
              "이전 항목",
              "보유 기간",
            ],
            rows: [
              [
                CLOUDFLARE_RECIPIENT,
                "사이트 호스팅·보안, 통계 서버·DB, 방문 통계(Web Analytics), 자동 요청 확인(Turnstile), 문의 메일 전달(Email Routing)",
                "미국 및 Cloudflare 데이터센터 소재국",
                "사이트 접속, 계산, 통계 전송, 문의 메일 수신 시 네트워크로 전송",
                "1항의 접속 정보·계산 진단·결과 통계·중복 방지 기록·방문 통계, Turnstile 확인 정보(IP 주소, 브라우저·기기 정보), 문의 메일(발신자·수신자 주소, 제목, 내용)",
                "1항과 같음(방문 통계·Turnstile은 Cloudflare가 정한 기간). 문의 메일 전달 기록(발신자·수신자 주소, 제목 등)은 31일",
              ],
              [
                "Volentio JSD Limited (jsDelivr) (legal@jsdelivr.com)",
                "웹 글꼴(Pretendard) 전송",
                "jsDelivr와 CDN 제공업체의 데이터센터 소재국",
                "페이지를 열 때 브라우저가 글꼴을 직접 받음",
                "접속 IP 주소, 브라우저 요청 정보",
                [
                  "분석 후 삭제하며 집계 통계는 계속 보관(",
                  { href: JSDELIVR_PRIVACY, text: "jsDelivr 개인정보 처리방침" },
                  "에 따름)",
                ],
              ],
              [
                "Google LLC (Gmail) (googlekrsupport@google.com)",
                "문의 메일 수신·보관",
                "미국 등 Google 데이터센터 소재국",
                "문의 메일 수신 시 Cloudflare Email Routing을 거쳐 네트워크로 전송",
                '1항 "문의 및 권리 행사 요청"',
                "1항과 같음",
              ],
            ],
          },
          {
            type: "list",
            items: [
              [
                "Turnstile: Cloudflare는 이 정보를 탐지 기능 개선에도 처리한다고 밝히고 있으며, 확인 과정에서 자체 쿠키나 브라우저 저장소를 사용할 수 있습니다(",
                turnstilePrivacyLink,
                ").",
              ],
              '방문 통계에는 Cloudflare의 "EU 방문자 제외" 설정을 적용합니다(사이트 제공·보안에 필요한 처리에는 적용되지 않음).',
              "이전을 원하지 않는 경우: 호스팅·보안을 위한 이전은 사이트 이용에 필요하므로 거부하면 서비스를 이용할 수 없습니다. 결과 통계는 전송하지 않으면 되고, 계산 진단 정보는 계산할 때 자동으로 전송되므로 원하지 않으면 계산 기능을 이용하지 않아야 합니다. 방문 통계는 브라우저의 추적 차단 기능으로 막을 수 있으며 서비스 이용에는 영향이 없습니다. 문의 메일(Gmail)은 보내지 않으면 되지만, 다른 문의 창구가 없어 문의를 받거나 답변할 수 없습니다. 글꼴(jsDelivr)은 브라우저에서 cdn.jsdelivr.net을 차단하면 되며, 이 경우 페이지가 기본 시스템 글꼴로 표시될 뿐 다른 영향은 없습니다.",
            ],
          },
          {
            type: "paragraph",
            text: "이 밖에 개인정보를 제3자에게 제공하거나 판매하지 않습니다.",
          },
        ],
      },
      {
        heading: "4. 파기",
        blocks: [
          {
            type: "paragraph",
            text: "보관 기간이 지난 정보는 자동으로 또는 지체 없이 삭제합니다. 통계 DB에서 삭제한 기록은 복구 이력에 최대 30일 남을 수 있으며 그 뒤 자동으로 사라집니다. 중복 방지 기록이 삭제된 뒤에는 개인을 식별할 수 없는 집계값만 남습니다.",
          },
        ],
      },
      {
        heading: "5. 이용자의 권리와 행사 방법",
        blocks: [
          {
            type: "paragraph",
            text: [
              "이용자와 법정대리인은 관계 법령에 따라 개인정보의 열람, 정정·삭제, 처리정지를 요구하거나 동의를 철회할 수 있습니다. 요청은 ",
              email,
              " 으로 보내 주세요.",
            ],
          },
          {
            type: "paragraph",
            text: "운영자는 필요한 범위에서 본인 또는 적법한 대리인인지 확인한 뒤 관계 법령에 따라 처리하고 결과를 알려 드리며, 법령상 제한이 있거나 대상 정보를 확인할 수 없으면 그 이유를 알려 드립니다.",
          },
          {
            type: "paragraph",
            text: "이미 삭제되었거나 이용자와 연결할 수 없는 집계값만 남은 정보는 찾아 제공하거나 삭제하지 못할 수 있습니다. 브라우저에 저장된 정보는 브라우저 설정에서 직접 지울 수 있습니다.",
          },
        ],
      },
      {
        heading: "6. 안전성 확보 조치",
        blocks: [
          {
            type: "list",
            items: [
              "브라우저와 서비스 웹사이트·API 사이의 통신에 HTTPS를 적용합니다.",
              "서버·DB 관리 권한은 운영자 계정에만 최소한으로 부여하고, 관리용 인증 정보는 별도로 보호합니다.",
              "필요한 최소한의 정보만 처리하고 통계는 집계값으로만 저장합니다.",
            ],
          },
        ],
      },
      {
        heading: "7. 개인정보 보호책임자",
        blocks: [
          {
            type: "list",
            items: ["개인정보 보호책임자: 서비스 운영자", ["개인정보 관련 문의: ", email]],
          },
        ],
      },
      {
        heading: "8. 변경",
        blocks: [
          {
            type: "paragraph",
            text: "이 방침을 변경하면 시행 7일 전부터 이 페이지에 알리고, 관계 법령상 동의가 필요한 변경은 별도로 동의를 받습니다.",
          },
          { type: "list", items: ["이전 버전: 없음"] },
        ],
      },
    ],
  },
  en: {
    title: "Privacy Policy",
    description: "Privacy policy of the NIKKE Collection Item Upgrade Calculator.",
    effective: ["Effective date: October 21, 2026"],
    intro: [
      {
        type: "paragraph",
        text: 'The NIKKE Collection Item Upgrade Calculator (the "Service", https://nikkecollection.com) complies with the Personal Information Protection Act of Korea and other applicable laws. It can be used without sign-up or login and does not ask for your name, email address or phone number. However, to provide and secure the Service, it processes connection information (IP address, browser information, etc.), and if you send an inquiry email, it processes the sender\'s email address and the inquiry.',
      },
    ],
    sections: [
      {
        heading: "1. Information processed and purposes",
        blocks: [
          {
            type: "table",
            head: ["Category", "Information processed", "Purpose", "Retention"],
            rows: [
              [
                "Calculation and calculation diagnostics",
                "Entered collection item phase and kit stock ranges, recommendation summary, calculation-engine diagnostics (duration range, version, language, etc.), event ID. On errors, also the error type, device type, and browser and OS type and major version. Sent automatically when a calculation completes (not sent in the trial certified mode)",
                "Performing calculations, checking calculation-engine quality",
                'Raw submitted values are not stored after being added to range-based aggregates; aggregates are kept for as long as the Service operates (event IDs follow "Duplicate-prevention records")',
              ],
              [
                "Result statistics submission",
                "(When you submit) kit stock before and after use, outcome, event ID, language, browser and OS type and major version, device type, referring host",
                "Validating results, compiling public statistics",
                "Raw submitted values (including raw stock) and IP addresses are not stored after being added to aggregates; aggregates are kept for as long as the Service operates",
              ],
              [
                "Duplicate-prevention records",
                "Event ID (a random value generated by the browser), time received",
                "Preventing the same result or diagnostic from being counted twice",
                "Deleted by a daily cleanup once 14 days have passed (normally within 15 days; records may remain longer if the cleanup is delayed)",
              ],
              [
                "Abuse prevention",
                "IP address, request information",
                "Limiting excessive requests, blocking automated requests",
                "Used only temporarily for rate limiting, not stored separately (operational logs: see below)",
              ],
              [
                "Operational logs",
                "Request/response information (URL, time, headers, IP address, browser information, etc.)",
                "Incident response, service operation",
                "Automatically deleted after at most 7 days",
              ],
              [
                "Visit statistics",
                "Visited path, referrer, country, browser/OS/device type, performance metrics",
                "Understanding visits and performance",
                "Period set by Cloudflare",
              ],
              [
                "Inquiries and rights requests",
                "Sender's email address, inquiry content, attachments, receipt and handling records",
                "Answering inquiries, handling personal-information requests",
                "Kept for 1 year after handling, then deleted",
              ],
            ],
          },
          {
            type: "list",
            items: [
              "Operational logs normally record a random sample of about 10% of requests; during the domain-migration check period (expected to end around October 28, 2026), all requests are temporarily recorded.",
              "Result statistics are received only when you submit them; calculation diagnostics are sent automatically when a calculation completes (except in the trial certified mode). The number of users is not counted, and no per-user identifier is linked to the aggregates.",
            ],
          },
        ],
      },
      {
        heading: "2. Information stored on your device",
        blocks: [
          {
            type: "paragraph",
            text: "The operator sets no cookies. However, Cloudflare's security features (such as Turnstile) may set security cookies (see section 3). The Service keeps the following in browser storage, which you can clear at any time in your browser settings.",
          },
          {
            type: "list",
            items: [
              "Display theme: until you change or delete it",
              "Results and diagnostics not yet submitted: kept for resubmission for 15 minutes; expired records are deleted on your next visit",
              "Temporary copy of calculator inputs: used only if the calculator reloads within about 5 minutes, deleted once used, and gone when the tab is closed",
              "Inputs and history session of the trial calculation mode (certified): until you delete them",
            ],
          },
          {
            type: "paragraph",
            text: "Cloudflare Web Analytics does not use cookies or browser storage.",
          },
        ],
      },
      {
        heading: "3. Outsourcing and international transfer",
        blocks: [
          {
            type: "paragraph",
            text: "To provide the Service, the processing of personal information is outsourced as follows, and personal information is transferred abroad in the process.",
          },
          {
            type: "table",
            head: [
              "Recipient (contact)",
              "Tasks",
              "Destination countries",
              "Timing and method of transfer",
              "Items transferred",
              "Retention period",
            ],
            rows: [
              [
                CLOUDFLARE_RECIPIENT,
                "Site hosting and security, statistics server and DB, visit statistics (Web Analytics), automated-request checks (Turnstile), forwarding inquiry emails (Email Routing)",
                "United States and countries where Cloudflare data centers are located",
                "Network transmission when you access the site, calculate, submit statistics or send an inquiry email",
                "Connection information, calculation diagnostics, result statistics, duplicate-prevention records and visit statistics in section 1; Turnstile check information (IP address, browser and device information); inquiry emails (sender and recipient addresses, subject, content)",
                "Same as section 1 (visit statistics and Turnstile: period set by Cloudflare). Inquiry email forwarding records (sender and recipient addresses, subject, etc.): 31 days",
              ],
              [
                "Volentio JSD Limited (jsDelivr) (legal@jsdelivr.com)",
                "Delivering web fonts (Pretendard)",
                "Countries where data centers of jsDelivr and its CDN providers are located",
                "Your browser downloads the fonts directly when a page opens",
                "IP address, browser request information",
                [
                  "Deleted after analysis; aggregated statistics are kept indefinitely (subject to the ",
                  { href: JSDELIVR_PRIVACY, text: "jsDelivr Privacy Policy" },
                  ")",
                ],
              ],
              [
                "Google LLC (Gmail) (googlekrsupport@google.com)",
                "Receiving and storing inquiry emails",
                "United States and other countries where Google data centers are located",
                "Network transmission via Cloudflare Email Routing when an inquiry email is received",
                'Section 1 "Inquiries and rights requests"',
                "Same as section 1",
              ],
            ],
          },
          {
            type: "list",
            items: [
              [
                "Turnstile: Cloudflare states that it also processes this information to improve detection, and it may use its own cookies or browser storage during the check (",
                turnstilePrivacyLink,
                ").",
              ],
              'Cloudflare\'s "Exclude EU visitors" setting is applied to visit statistics (not to processing needed to provide and secure the site).',
              "If you do not want the transfer: transfers for hosting and security are needed to use the site, so if you refuse them you cannot use the Service. You can simply not submit result statistics; calculation diagnostics are sent automatically when you calculate, so if you do not want them sent, do not use the calculator. Visit statistics can be blocked with your browser's tracking protection without affecting use of the Service. You can simply not send inquiry emails (Gmail), but as there is no other inquiry channel, your inquiry then cannot be received or answered. Fonts (jsDelivr) can be avoided by blocking cdn.jsdelivr.net in your browser; pages are then shown in system fonts with no other effect.",
            ],
          },
          {
            type: "paragraph",
            text: "Apart from the above, personal information is not provided or sold to third parties.",
          },
        ],
      },
      {
        heading: "4. Destruction",
        blocks: [
          {
            type: "paragraph",
            text: "Information past its retention period is deleted automatically or without delay. Records deleted from the statistics DB may remain in its recovery history for up to 30 days and then disappear automatically. Once duplicate-prevention records are deleted, only aggregates that cannot identify individuals remain.",
          },
        ],
      },
      {
        heading: "5. Your rights and how to exercise them",
        blocks: [
          {
            type: "paragraph",
            text: [
              "You and your legal representative may, in accordance with applicable laws, request access to, correction or deletion of, or suspension of processing of personal information, or withdraw consent. Please send requests to ",
              email,
              ".",
            ],
          },
          {
            type: "paragraph",
            text: "Where necessary, the operator will verify that the request comes from you or a lawful representative, handle it under applicable laws and tell you the result, or tell you why if legal restrictions apply or the relevant information cannot be identified.",
          },
          {
            type: "paragraph",
            text: "Information that has already been deleted, or that remains only as aggregates not linkable to you, may not be found, provided or deleted. You can clear information stored in your browser in your browser settings.",
          },
        ],
      },
      {
        heading: "6. Security measures",
        blocks: [
          {
            type: "list",
            items: [
              "HTTPS is used between your browser and the Service's website and API.",
              "Server and DB administration privileges are granted minimally and only to the operator account, and administrative credentials are protected separately.",
              "Only the minimum necessary information is processed, and statistics are stored only as aggregates.",
            ],
          },
        ],
      },
      {
        heading: "7. Privacy Officer",
        blocks: [
          {
            type: "list",
            items: ["Privacy Officer: Service operator", ["Privacy inquiries: ", email]],
          },
        ],
      },
      {
        heading: "8. Changes",
        blocks: [
          {
            type: "paragraph",
            text: "If this policy changes, notice will be posted on this page at least 7 days before the change takes effect, and separate consent will be obtained where applicable laws require it.",
          },
          { type: "list", items: ["Previous versions: none"] },
        ],
      },
    ],
  },
  ja: {
    title: "プライバシーポリシー",
    description: "NIKKE コレクション強化計算機のプライバシーポリシーです。",
    effective: ["施行日: 2026年10月21日"],
    intro: [
      {
        type: "paragraph",
        text: "NIKKE コレクション強化計算機(以下「本サービス」、https://nikkecollection.com)は、韓国「個人情報保護法」その他の関係法令を遵守します。会員登録やログインなしで利用でき、氏名・メールアドレス・電話番号の入力は求めません。ただし、サービスの提供とセキュリティのために接続情報(IPアドレス、ブラウザ情報など)を取り扱い、お問い合わせメールを送信した場合は送信者のメールアドレスとお問い合わせ内容を取り扱います。",
      },
    ],
    sections: [
      {
        heading: "1. 取り扱う情報と目的",
        blocks: [
          {
            type: "table",
            head: ["区分", "取り扱う情報", "目的", "保管"],
            rows: [
              [
                "計算と計算の診断",
                "入力したコレクションの段階・キット在庫の区間値、推奨結果の概要、計算エンジンの診断情報(所要時間の区間、バージョン、言語など)、イベントID。エラー時はエラーの種類、デバイスの種類、ブラウザ・OSの種類・メジャーバージョンも含む。計算が完了すると自動送信(試験用certifiedモードでは送信しない)",
                "計算の実行、計算エンジンの品質確認",
                "元の送信値は区間ごとの集計に反映した後は保存せず、集計値はサービス運営期間中保管(イベントIDは「重複防止の記録」に従う)",
              ],
              [
                "結果統計の送信",
                "(利用者が送信した場合)使用前後のキット在庫、結果、イベントID、言語、ブラウザ・OSの種類・メジャーバージョン、デバイスの種類、アクセス元",
                "結果の検証、公開統計の集計",
                "元の送信値(元の在庫を含む)とIPアドレスは集計に反映した後は保存せず、集計値はサービス運営期間中保管",
              ],
              [
                "重複防止の記録",
                "イベントID(ブラウザが生成するランダムな値)、受信時刻",
                "同じ結果・診断の重複反映の防止",
                "14日が経過すると毎日の整理処理で削除(通常15日以内、整理処理が遅れるとそれ以上残る場合あり)",
              ],
              [
                "不正利用の防止",
                "IPアドレス、リクエスト情報",
                "過剰なリクエストの制限、自動リクエストの遮断",
                "リクエスト数の制限に一時的にのみ使用し、別途保存しない(運用ログは下記の項目)",
              ],
              [
                "運用ログ",
                "リクエスト・レスポンス情報(URL、時刻、ヘッダー、IPアドレス、ブラウザ情報など)",
                "障害対応、サービス運営",
                "最大7日後に自動削除",
              ],
              [
                "訪問統計",
                "訪問したパス、流入元、国、ブラウザ・OS・デバイスの種類、パフォーマンス指標",
                "訪問状況・パフォーマンスの把握",
                "Cloudflareが定める期間",
              ],
              [
                "お問い合わせ・権利行使の請求",
                "送信者のメールアドレス、お問い合わせ内容、添付された情報、受付・対応の記録",
                "お問い合わせへの回答、個人情報に関する請求への対応",
                "対応完了後1年保管した後に削除",
              ],
            ],
          },
          {
            type: "list",
            items: [
              "運用ログは通常、リクエストの約10%を無作為に記録し、ドメイン移行の点検期間(2026年10月28日ごろ終了予定)中は一時的にすべてのリクエストを記録します。",
              "結果統計は利用者が送信した場合にのみ受け取り、計算の診断情報は計算が完了すると自動で送信されます(試験用certifiedモードを除く)。利用者数は数えず、集計値に利用者ごとの識別子を結び付けません。",
            ],
          },
        ],
      },
      {
        heading: "2. 利用者の端末に保存する情報",
        blocks: [
          {
            type: "paragraph",
            text: "運営者が設定するCookieはありません。ただし、Cloudflareのセキュリティ機能(Turnstileなど)がセキュリティ用のCookieを設定する場合があります(第3項を参照)。本サービスは以下の情報をブラウザのストレージに保存し、ブラウザの設定からいつでも削除できます。",
          },
          {
            type: "list",
            items: [
              "画面テーマ: 利用者が変更または削除するまで",
              "未送信の結果・診断情報: 再送信用に15分間保持し、期限切れの記録は次回アクセス時に削除",
              "計算画面の入力値の一時保存: 約5分以内に再読み込みした場合のみ復元に使ってすぐに削除し、タブを閉じると消去",
              "試験用計算モード(certified)の入力値と記録セッション: 利用者が削除するまで",
            ],
          },
          {
            type: "paragraph",
            text: "Cloudflare Web AnalyticsはCookieやブラウザのストレージを使用しません。",
          },
        ],
      },
      {
        heading: "3. 処理の委託および国外移転",
        blocks: [
          {
            type: "paragraph",
            text: "本サービスの提供のため、以下のとおり個人情報の処理を委託しており、その過程で個人情報が国外へ移転されます。",
          },
          {
            type: "table",
            head: [
              "受領者(連絡先)",
              "業務",
              "移転先の国",
              "移転の時期・方法",
              "移転する項目",
              "保有期間",
            ],
            rows: [
              [
                CLOUDFLARE_RECIPIENT,
                "サイトのホスティング・セキュリティ、統計サーバー・DB、訪問統計(Web Analytics)、自動リクエストの確認(Turnstile)、お問い合わせメールの転送(Email Routing)",
                "米国およびCloudflareのデータセンター所在国",
                "サイトへのアクセス、計算、統計送信、お問い合わせメール受信時にネットワークで送信",
                "第1項の接続情報・計算の診断・結果統計・重複防止の記録・訪問統計、Turnstileの確認情報(IPアドレス、ブラウザ・端末の情報)、お問い合わせメール(送信者・受信者のアドレス、件名、内容)",
                "第1項と同じ(訪問統計・TurnstileはCloudflareが定める期間)。お問い合わせメールの転送記録(送信者・受信者のアドレス、件名など)は31日",
              ],
              [
                "Volentio JSD Limited (jsDelivr) (legal@jsdelivr.com)",
                "Webフォント(Pretendard)の配信",
                "jsDelivrおよびCDN事業者のデータセンター所在国",
                "ページを開くとブラウザがフォントを直接取得",
                "アクセス元IPアドレス、ブラウザのリクエスト情報",
                [
                  "分析後に削除し、集計統計は継続して保管(",
                  { href: JSDELIVR_PRIVACY, text: "jsDelivrのプライバシーポリシー" },
                  "に従う)",
                ],
              ],
              [
                "Google LLC (Gmail) (googlekrsupport@google.com)",
                "お問い合わせメールの受信・保管",
                "米国などGoogleのデータセンター所在国",
                "お問い合わせメール受信時にCloudflare Email Routingを経由してネットワークで送信",
                "第1項「お問い合わせ・権利行使の請求」",
                "第1項と同じ",
              ],
            ],
          },
          {
            type: "list",
            items: [
              [
                "Turnstile: Cloudflareはこの情報を検知機能の改善のためにも処理すると説明しており、確認の過程で独自のCookieやブラウザのストレージを使用する場合があります(",
                turnstilePrivacyLink,
                ")。",
              ],
              "訪問統計にはCloudflareの「EU訪問者を除外」設定を適用しています(サイトの提供・セキュリティに必要な取り扱いには適用されません)。",
              "移転を望まない場合: ホスティング・セキュリティのための移転はサイトの利用に必要なため、拒否するとサービスを利用できません。結果統計は送信しないことができ、計算の診断情報は計算時に自動で送信されるため、望まない場合は計算機能を利用しないでください。訪問統計はブラウザのトラッキング防止機能でブロックでき、サービスの利用には影響しません。お問い合わせメール(Gmail)は送信しないことができますが、ほかにお問い合わせ窓口がないため、お問い合わせの受付・回答ができなくなります。フォント(jsDelivr)はブラウザでcdn.jsdelivr.netをブロックでき、その場合ページがシステムフォントで表示されるだけで、ほかに影響はありません。",
            ],
          },
          {
            type: "paragraph",
            text: "上記のほか、個人情報を第三者に提供または販売することはありません。",
          },
        ],
      },
      {
        heading: "4. 破棄",
        blocks: [
          {
            type: "paragraph",
            text: "保管期間を過ぎた情報は自動的に、または遅滞なく削除します。統計DBから削除した記録は復旧用の履歴に最大30日間残る場合があり、その後自動的に消去されます。重複防止の記録が削除された後は、個人を識別できない集計値のみが残ります。",
          },
        ],
      },
      {
        heading: "5. 利用者の権利とその行使方法",
        blocks: [
          {
            type: "paragraph",
            text: [
              "利用者およびその法定代理人は、関係法令に基づき、個人情報の閲覧、訂正・削除、処理停止を求め、または同意を撤回することができます。ご請求は",
              email,
              "までお送りください。",
            ],
          },
          {
            type: "paragraph",
            text: "運営者は、必要な範囲で本人または適法な代理人であることを確認したうえで、関係法令に基づき対応して結果をお知らせし、法令上の制限がある場合や対象の情報を確認できない場合はその理由をお知らせします。",
          },
          {
            type: "paragraph",
            text: "すでに削除された情報や、利用者と結び付けられない集計値のみが残っている情報は、探して提供または削除できないことがあります。ブラウザに保存された情報は、ブラウザの設定からご自身で削除できます。",
          },
        ],
      },
      {
        heading: "6. 安全管理措置",
        blocks: [
          {
            type: "list",
            items: [
              "ブラウザと本サービスのWebサイト・APIとの間の通信にHTTPSを適用しています。",
              "サーバー・DBの管理権限は運営者のアカウントにのみ必要最小限で付与し、管理用の認証情報は別途保護しています。",
              "必要最小限の情報のみを取り扱い、統計は集計値としてのみ保存します。",
            ],
          },
        ],
      },
      {
        heading: "7. 個人情報保護責任者",
        blocks: [
          {
            type: "list",
            items: [
              "個人情報保護責任者: サービス運営者",
              ["個人情報に関するお問い合わせ: ", email],
            ],
          },
        ],
      },
      {
        heading: "8. 変更",
        blocks: [
          {
            type: "paragraph",
            text: "本ポリシーを変更する場合は施行の7日前からこのページでお知らせし、関係法令上同意が必要な変更については別途同意を得ます。",
          },
          { type: "list", items: ["以前のバージョン: なし"] },
        ],
      },
    ],
  },
} as const satisfies LocalizedLegalDocument;
