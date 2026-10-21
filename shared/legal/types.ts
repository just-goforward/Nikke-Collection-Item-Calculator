import type { SiteLocale } from "../siteLocales.ts";

/** Inline text: plain text, a link, or a value the operator still has to supply. */
export type LegalInline = string | { href: string; text: string } | { placeholder: string };

export type LegalText = string | readonly LegalInline[];

export type LegalBlock =
  | { type: "paragraph"; text: LegalText }
  | { type: "list"; items: readonly LegalText[] }
  | { type: "table"; head: readonly string[]; rows: readonly (readonly LegalText[])[] }
  | { type: "placeholder"; text: string };

export type LegalSection = { heading: string; blocks: readonly LegalBlock[] };

export type LegalDocument = {
  title: string;
  description: string;
  /** Effective-date line shown under the title. */
  effective?: LegalText;
  intro: readonly LegalBlock[];
  sections: readonly LegalSection[];
};

export type LocalizedLegalDocument = Record<SiteLocale, LegalDocument>;
