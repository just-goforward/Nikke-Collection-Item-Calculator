import { SITE_CONTACT_EMAIL, siteLegalPagePath } from "../siteLocales.ts";
import type { LocalizedLegalDocument } from "./types.ts";

const email = { href: `mailto:${SITE_CONTACT_EMAIL}`, text: SITE_CONTACT_EMAIL };

export const TERMS_OF_SERVICE = {
  ko: {
    title: "서비스 이용약관",
    description: "NIKKE 소장품 레벨업 계산기의 서비스 이용약관입니다.",
    effective: ["시행일: ", { placeholder: "2026년 ○월 ○일" }],
    intro: [],
    sections: [
      {
        heading: "1. 목적",
        blocks: [
          {
            type: "paragraph",
            text: '이 약관은 NIKKE 소장품 레벨업 계산기(이하 "서비스", https://nikkecollection.com)를 이용하는 조건을 정합니다. 서비스를 이용하면 이 약관에 동의한 것으로 봅니다.',
          },
        ],
      },
      {
        heading: "2. 서비스 내용",
        blocks: [
          {
            type: "list",
            items: [
              "게임 「승리의 여신: 니케」의 소장품 레벨업에 필요한 키트 사용 계획과 확률을 계산합니다.",
              "관리 키트 수급 예보와, 이용자가 보낸 결과로 만든 공개 통계를 보여 줍니다.",
              "서비스는 무료이며 회원가입 없이 이용할 수 있습니다.",
            ],
          },
        ],
      },
      {
        heading: "3. 비공식 서비스",
        blocks: [
          {
            type: "list",
            items: [
              "서비스는 팬이 만든 비공식 도구입니다. 게임 개발사·퍼블리셔와 제휴하지 않았고, 이들의 승인이나 후원을 받지 않았습니다.",
              "NIKKE 및 관련 명칭·상표·게임 자산의 권리는 각 권리자에게 있습니다.",
            ],
          },
        ],
      },
      {
        heading: "4. 계산 결과와 예보의 한계",
        blocks: [
          {
            type: "list",
            items: [
              "계산 결과와 확률은 공개된 정보와 수학적 모델로 낸 추정값이며, 실제 게임 결과를 보장하지 않습니다.",
              "수급 예보는 공식 공지를 바탕으로 한 예상이며, 일정이 바뀌거나 빠지거나 틀릴 수 있습니다.",
              "게임 업데이트로 규칙이 바뀌면 서비스에 반영되기 전까지 결과가 맞지 않을 수 있습니다.",
              "게임 안에서 재화를 쓰는 결정은 이용자가 스스로 판단해 주세요.",
            ],
          },
        ],
      },
      {
        heading: "5. 이용자가 지킬 사항",
        blocks: [
          { type: "paragraph", text: "아래 행위를 하면 안 됩니다." },
          {
            type: "list",
            items: [
              "자동화된 대량 요청, 공격, 보안 우회 등 서비스 운영을 방해하는 행위",
              "거짓 결과를 일부러 보내 공개 통계를 왜곡하는 행위",
              "통계 서버나 API를 허용된 범위 밖에서 사용하는 행위",
              "관련 법령을 위반하는 행위",
            ],
          },
          {
            type: "paragraph",
            text: "위반이 확인되면 별도 통지 없이 해당 요청을 차단할 수 있습니다.",
          },
        ],
      },
      {
        heading: "6. 공개 통계",
        blocks: [
          {
            type: "list",
            items: [
              "이용자가 보낸 결과는 개인을 알아볼 수 없는 집계 형태로 공개 통계에 반영되며, 한 번 반영된 집계값은 개별로 되돌리기 어렵습니다.",
              [
                "정보 처리에 관한 자세한 내용은 ",
                { href: siteLegalPagePath("ko", "privacy"), text: "개인정보 처리방침" },
                "을 따릅니다.",
              ],
            ],
          },
        ],
      },
      {
        heading: "7. 서비스 변경과 중단",
        blocks: [
          {
            type: "paragraph",
            text: "서비스 운영자는 게임 규칙 변경, 운영 비용, 외부 서비스 장애, 그 밖에 운영상 필요가 있을 때 서비스의 일부나 전부를 바꾸거나 중단할 수 있으며, 가능하면 미리 알립니다.",
          },
        ],
      },
      {
        heading: "8. 책임의 한계",
        blocks: [
          {
            type: "paragraph",
            text: '서비스는 "있는 그대로" 무료로 제공됩니다. 서비스 운영자에게 고의나 중대한 과실이 없는 한, 아래 손해에 대해 책임지지 않습니다.',
          },
          {
            type: "list",
            items: [
              "계산 결과, 예보, 통계를 이용해 생긴 게임 안팎의 손해",
              "서비스 중단이나 오류로 생긴 손해",
            ],
          },
          { type: "paragraph", text: "다만 관련 법령이 달리 정하는 경우에는 그 법령을 따릅니다." },
        ],
      },
      {
        heading: "9. 소프트웨어 라이선스",
        blocks: [
          {
            type: "paragraph",
            text: [
              "서비스의 소스 코드는 AGPL-3.0-or-later 라이선스로 공개되어 있습니다. 자세한 내용과 사용한 오픈소스 목록은 ",
              { href: siteLegalPagePath("ko", "licenses"), text: "라이선스" },
              " 페이지에서 확인할 수 있습니다.",
            ],
          },
        ],
      },
      {
        heading: "10. 약관 변경",
        blocks: [
          {
            type: "paragraph",
            text: "약관을 바꾸면 시행 7일 전부터 이 페이지에 알립니다. 변경 후에도 서비스를 계속 이용하면 바뀐 약관에 동의한 것으로 봅니다.",
          },
        ],
      },
      {
        heading: "11. 준거법과 문의",
        blocks: [
          {
            type: "list",
            items: ["이 약관은 대한민국 법을 따릅니다.", ["문의: ", email]],
          },
        ],
      },
    ],
  },
  en: {
    title: "Terms of Service",
    description: "Terms of service of the NIKKE Collection Item Upgrade Calculator.",
    effective: ["Effective date: ", { placeholder: "○○ ○○, 2026" }],
    intro: [],
    sections: [
      {
        heading: "1. Purpose",
        blocks: [
          {
            type: "paragraph",
            text: 'These terms set out the conditions for using the NIKKE Collection Item Upgrade Calculator (the "Service", https://nikkecollection.com). By using the Service, you are deemed to agree to these terms.',
          },
        ],
      },
      {
        heading: "2. What the Service Provides",
        blocks: [
          {
            type: "list",
            items: [
              "It calculates kit usage plans and probabilities for leveling up collection items in the game GODDESS OF VICTORY: NIKKE.",
              "It shows forecasts of Maintenance Kit supply and public statistics built from results sent by users.",
              "The Service is free and can be used without creating an account.",
            ],
          },
        ],
      },
      {
        heading: "3. Unofficial Service",
        blocks: [
          {
            type: "list",
            items: [
              "The Service is an unofficial fan-made tool. It is not affiliated with the game's developer or publisher and is not approved or sponsored by them.",
              "Rights to NIKKE and related names, trademarks and game assets belong to their respective owners.",
            ],
          },
        ],
      },
      {
        heading: "4. Limits of Calculation Results and Forecasts",
        blocks: [
          {
            type: "list",
            items: [
              "Calculation results and probabilities are estimates produced from public information and mathematical models, and do not guarantee actual in-game outcomes.",
              "Supply forecasts are projections based on official announcements; schedules may change, be omitted or be wrong.",
              "If a game update changes the rules, results may be inaccurate until the change is reflected in the Service.",
              "Please use your own judgment when deciding how to spend in-game resources.",
            ],
          },
        ],
      },
      {
        heading: "5. User Obligations",
        blocks: [
          { type: "paragraph", text: "You must not:" },
          {
            type: "list",
            items: [
              "Interfere with the operation of the Service, for example through automated bulk requests, attacks or circumventing security",
              "Deliberately send false results to distort the public statistics",
              "Use the statistics server or API beyond the permitted scope",
              "Violate applicable laws",
            ],
          },
          {
            type: "paragraph",
            text: "If a violation is confirmed, the relevant requests may be blocked without separate notice.",
          },
        ],
      },
      {
        heading: "6. Public Statistics",
        blocks: [
          {
            type: "list",
            items: [
              "Results you send are reflected in the public statistics in aggregated form that cannot identify individuals; once reflected, aggregated values are difficult to reverse individually.",
              [
                "Details on how information is processed are governed by the ",
                { href: siteLegalPagePath("en", "privacy"), text: "Privacy Policy" },
                ".",
              ],
            ],
          },
        ],
      },
      {
        heading: "7. Changes to and Suspension of the Service",
        blocks: [
          {
            type: "paragraph",
            text: "The service operator may change or suspend part or all of the Service when necessary, such as due to game rule changes, operating costs, outages of external services or other operational needs, and will give advance notice where possible.",
          },
        ],
      },
      {
        heading: "8. Limitation of Liability",
        blocks: [
          {
            type: "paragraph",
            text: 'The Service is provided free of charge "as is". Unless the damage results from the service operator’s intentional misconduct or gross negligence, the operator is not liable for the following damages:',
          },
          {
            type: "list",
            items: [
              "Damages in or outside the game arising from use of calculation results, forecasts or statistics",
              "Damages arising from suspension of or errors in the Service",
            ],
          },
          {
            type: "paragraph",
            text: "However, where applicable laws provide otherwise, those laws apply.",
          },
        ],
      },
      {
        heading: "9. Software License",
        blocks: [
          {
            type: "paragraph",
            text: [
              "The Service's source code is published under the AGPL-3.0-or-later license. Details and the list of open-source software used are available on the ",
              { href: siteLegalPagePath("en", "licenses"), text: "Licenses" },
              " page.",
            ],
          },
        ],
      },
      {
        heading: "10. Changes to These Terms",
        blocks: [
          {
            type: "paragraph",
            text: "If these terms change, notice will be posted on this page from 7 days before the changes take effect. If you continue to use the Service after the change, you are deemed to agree to the revised terms.",
          },
        ],
      },
      {
        heading: "11. Governing Law and Contact",
        blocks: [
          {
            type: "list",
            items: [
              "These terms are governed by the laws of the Republic of Korea.",
              ["Contact: ", email],
            ],
          },
        ],
      },
    ],
  },
  ja: {
    title: "サービス利用規約",
    description: "NIKKE コレクション強化計算機のサービス利用規約です。",
    effective: ["施行日: ", { placeholder: "2026年○月○日" }],
    intro: [],
    sections: [
      {
        heading: "1. 目的",
        blocks: [
          {
            type: "paragraph",
            text: "本規約は、NIKKE コレクション強化計算機(以下「本サービス」、https://nikkecollection.com)を利用する条件を定めます。本サービスを利用した場合、本規約に同意したものとみなします。",
          },
        ],
      },
      {
        heading: "2. サービスの内容",
        blocks: [
          {
            type: "list",
            items: [
              "ゲーム『勝利の女神：NIKKE』のコレクション強化に必要なキットの使用計画と確率を計算します。",
              "お手入れキットの入手予報と、利用者が送信した結果から作成した公開統計を表示します。",
              "本サービスは無料で、会員登録なしで利用できます。",
            ],
          },
        ],
      },
      {
        heading: "3. 非公式サービス",
        blocks: [
          {
            type: "list",
            items: [
              "本サービスはファンが制作した非公式ツールです。ゲームの開発会社・パブリッシャーとは提携しておらず、その承認や後援も受けていません。",
              "NIKKEおよび関連する名称・商標・ゲーム素材の権利は、各権利者に帰属します。",
            ],
          },
        ],
      },
      {
        heading: "4. 計算結果と予報の限界",
        blocks: [
          {
            type: "list",
            items: [
              "計算結果と確率は、公開情報と数学的モデルにもとづく推定値であり、実際のゲーム結果を保証するものではありません。",
              "入手予報は公式のお知らせにもとづく予想であり、日程の変更・欠落・誤りが生じる場合があります。",
              "ゲームのアップデートでルールが変わった場合、本サービスに反映されるまで結果が合わないことがあります。",
              "ゲーム内で資源を使う判断は、利用者ご自身で行ってください。",
            ],
          },
        ],
      },
      {
        heading: "5. 利用者の遵守事項",
        blocks: [
          { type: "paragraph", text: "以下の行為をしてはなりません。" },
          {
            type: "list",
            items: [
              "自動化された大量リクエスト、攻撃、セキュリティの回避など、本サービスの運営を妨げる行為",
              "虚偽の結果を意図的に送信し、公開統計を歪める行為",
              "統計サーバーやAPIを許可された範囲外で使用する行為",
              "関連法令に違反する行為",
            ],
          },
          {
            type: "paragraph",
            text: "違反が確認された場合、別途の通知なく該当するリクエストを遮断することがあります。",
          },
        ],
      },
      {
        heading: "6. 公開統計",
        blocks: [
          {
            type: "list",
            items: [
              "利用者が送信した結果は、個人を識別できない集計の形で公開統計に反映され、一度反映された集計値を個別に取り消すことは困難です。",
              [
                "情報の取り扱いの詳細は",
                { href: siteLegalPagePath("ja", "privacy"), text: "プライバシーポリシー" },
                "に従います。",
              ],
            ],
          },
        ],
      },
      {
        heading: "7. サービスの変更と中止",
        blocks: [
          {
            type: "paragraph",
            text: "サービス運営者は、ゲームのルール変更、運営費用、外部サービスの障害、その他運営上の必要がある場合、本サービスの一部または全部を変更または中止することがあり、可能な場合は事前にお知らせします。",
          },
        ],
      },
      {
        heading: "8. 責任の制限",
        blocks: [
          {
            type: "paragraph",
            text: "本サービスは「現状のまま」無料で提供されます。サービス運営者に故意または重大な過失がない限り、以下の損害について責任を負いません。",
          },
          {
            type: "list",
            items: [
              "計算結果、予報、統計を利用したことにより生じたゲーム内外の損害",
              "本サービスの中止や誤りにより生じた損害",
            ],
          },
          {
            type: "paragraph",
            text: "ただし、関連法令に別段の定めがある場合は、その法令に従います。",
          },
        ],
      },
      {
        heading: "9. ソフトウェアライセンス",
        blocks: [
          {
            type: "paragraph",
            text: [
              "本サービスのソースコードはAGPL-3.0-or-laterライセンスで公開されています。詳細と使用しているオープンソースの一覧は",
              { href: siteLegalPagePath("ja", "licenses"), text: "ライセンス" },
              "ページで確認できます。",
            ],
          },
        ],
      },
      {
        heading: "10. 規約の変更",
        blocks: [
          {
            type: "paragraph",
            text: "本規約を変更する場合は、施行の7日前からこのページでお知らせします。変更後も本サービスを引き続き利用した場合、変更後の規約に同意したものとみなします。",
          },
        ],
      },
      {
        heading: "11. 準拠法とお問い合わせ",
        blocks: [
          {
            type: "list",
            items: ["本規約は大韓民国の法律に準拠します。", ["お問い合わせ: ", email]],
          },
        ],
      },
    ],
  },
} as const satisfies LocalizedLegalDocument;
