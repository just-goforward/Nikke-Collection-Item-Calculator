import type { LocalizedLegalDocument } from "./types.ts";

/** Placeholder until the operator supplies the terms; accepts the same blocks as privacy. */
export const TERMS_OF_SERVICE = {
  ko: {
    title: "이용약관",
    description: "NIKKE 소장품 레벨업 계산기의 이용약관입니다.",
    intro: [{ type: "placeholder", text: "이용약관 준비 중입니다." }],
    sections: [],
  },
  en: {
    title: "Terms of Service",
    description: "Terms of service of the NIKKE Collection Item Upgrade Calculator.",
    intro: [{ type: "placeholder", text: "The terms of service are being prepared." }],
    sections: [],
  },
  ja: {
    title: "利用規約",
    description: "NIKKE コレクション強化計算機の利用規約です。",
    intro: [{ type: "placeholder", text: "利用規約は準備中です。" }],
    sections: [],
  },
} as const satisfies LocalizedLegalDocument;
