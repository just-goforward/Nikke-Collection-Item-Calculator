import { SITE_LICENSE_URL, SITE_SOURCE_REPOSITORY } from "../siteLocales.ts";
import type { LegalDocument, LegalText } from "./types.ts";

const repository = { href: SITE_SOURCE_REPOSITORY, text: SITE_SOURCE_REPOSITORY };

type LicensesContent = {
  document: LegalDocument;
  /** Generated sections appended by the build. */
  rustHeading: string;
  rustIntro: LegalText;
  rustColumns: readonly [string, string, string];
  npmHeading: string;
  npmIntro: LegalText;
};

export const LICENSES = {
  ko: {
    document: {
      title: "라이선스",
      description: "NIKKE 소장품 레벨업 계산기의 라이선스와 제3자 고지입니다.",
      intro: [],
      sections: [
        {
          heading: "프로젝트 라이선스",
          blocks: [
            {
              type: "paragraph",
              text: "이 프로그램은 AGPL-3.0-or-later로 제공되며, 어떠한 보증도 제공하지 않습니다.",
            },
            {
              type: "list",
              items: [
                ["소스 코드: ", repository],
                [{ href: SITE_LICENSE_URL, text: "라이선스 전문 (LICENSE)" }],
              ],
            },
          ],
        },
      ],
    },
    rustHeading: "WASM에 포함된 Rust 크레이트",
    rustIntro: "계산 엔진 WebAssembly에 컴파일되는 Rust 의존성과 라이선스입니다.",
    rustColumns: ["크레이트", "버전", "라이선스"],
    npmHeading: "번들에 포함된 JavaScript 패키지",
    npmIntro: "빌드 시 생성된 제3자 라이선스 고지 원문입니다.",
  },
  en: {
    document: {
      title: "Licenses",
      description:
        "License and third-party notices of the NIKKE Collection Item Upgrade Calculator.",
      intro: [],
      sections: [
        {
          heading: "Project license",
          blocks: [
            {
              type: "paragraph",
              text: "This program is provided under AGPL-3.0-or-later, without any warranty.",
            },
            {
              type: "list",
              items: [
                ["Source code: ", repository],
                [{ href: SITE_LICENSE_URL, text: "Full license text (LICENSE)" }],
              ],
            },
          ],
        },
      ],
    },
    rustHeading: "Rust crates compiled into WASM",
    rustIntro: "Rust dependencies compiled into the calculation engine WebAssembly.",
    rustColumns: ["Crate", "Version", "License"],
    npmHeading: "JavaScript packages in the bundle",
    npmIntro: "Third-party license notices generated at build time.",
  },
  ja: {
    document: {
      title: "ライセンス",
      description: "NIKKE コレクション強化計算機のライセンスと第三者通知です。",
      intro: [],
      sections: [
        {
          heading: "プロジェクトのライセンス",
          blocks: [
            {
              type: "paragraph",
              text: "本プログラムはAGPL-3.0-or-laterに基づき、無保証で提供されます。",
            },
            {
              type: "list",
              items: [
                ["ソースコード: ", repository],
                [{ href: SITE_LICENSE_URL, text: "ライセンス全文 (LICENSE)" }],
              ],
            },
          ],
        },
      ],
    },
    rustHeading: "WASMに含まれるRustクレート",
    rustIntro: "計算エンジンのWebAssemblyにコンパイルされるRustの依存関係です。",
    rustColumns: ["クレート", "バージョン", "ライセンス"],
    npmHeading: "バンドルに含まれるJavaScriptパッケージ",
    npmIntro: "ビルド時に生成された第三者ライセンス通知の原文です。",
  },
} as const satisfies Record<string, LicensesContent>;
