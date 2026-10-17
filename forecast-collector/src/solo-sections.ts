import type { NormalizedSourceItem } from "./types";

export type NoticeText = {
  effective: string;
  evidence: string;
  legacyText?: string;
  parsed?: unknown;
};
// Side-channel only: never mutate the frozen Actions-compatible item or its hash.
export const noticeTexts = new WeakMap<NormalizedSourceItem, NoticeText>();

export function extractNoticeText(raw: string): NoticeText {
  let input = raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (parsed !== undefined) {
    const values: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else {
        const record = value as Record<string, unknown>;
        if (record["@ctype"] === "textNode" && typeof record["value"] === "string")
          values.push(record["value"]);
        else for (const child of Object.values(record)) visit(child);
      }
    };
    visit(parsed);
    input = values.join("\n");
  }
  const effective: string[] = [];
  const evidence: string[] = [];
  let strike = 0;
  let hidden = 0;
  for (const token of input.matchAll(/<!--[\s\S]*?-->|<[^>]*>|[^<]+|</g)) {
    const text = token[0];
    if (text.startsWith("<!--")) {
      continue;
    }
    if (text.startsWith("<") && text !== "<") {
      const tag = /^<\s*(\/?)\s*([\w-]+)/.exec(text);
      if (!tag) continue;
      const closing = tag[1] === "/";
      const name = tag[2]?.toLowerCase();
      if (name && /^(script|style|template)$/.test(name)) {
        hidden += closing ? -1 : 1;
        continue;
      }
      if (hidden) continue;
      if (name && /^(strike|s|del)$/.test(name)) {
        if (!closing && strike++ === 0) evidence.push("~~");
        if (closing && strike > 0 && --strike === 0) evidence.push("~~");
      } else if (name === "br" || (closing && name && /^(p|div|li|h[1-6]|tr)$/.test(name))) {
        effective.push("\n");
        evidence.push("\n");
      }
    } else if (!hidden) {
      const decoded = decodeEntities(text);
      evidence.push(decoded);
      if (!strike) effective.push(decoded);
    }
  }
  const clean = (parts: string[]) =>
    parts
      .join("")
      .replace(/[\u200b\ufeff]/g, "")
      .split("\n")
      .map((line) => line.replace(/[ \t\r]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  return {
    effective: clean(effective),
    evidence: clean(evidence),
    legacyText: decodeEntities(
      raw
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|li|h[1-6]|tr)\s*>/gi, "\n")
        .replace(/<[^>]*>/g, " "),
    )
      .replace(/\s+/g, " ")
      .trim(),
    ...(parsed === undefined ? {} : { parsed }),
  };
}

function decodeEntities(value: string) {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|nbsp|quot|apos);/gi,
    (original, entity: string) => {
      const name = entity.toLowerCase();
      if (name.startsWith("#")) {
        const code = name.startsWith("#x")
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original;
      }
      return (
        ({ amp: "&", lt: "<", gt: ">", nbsp: " ", quot: '"', apos: "'" } as Record<string, string>)[
          name
        ] ?? original
      );
    },
  );
}

export function soloSections(text: NoticeText) {
  const split = (input: string) => {
    const lines = input.split("\n");
    const blocks: string[] = [];
    let block: string[] | null = null;
    for (const line of lines) {
      if (/^\d+\.\s/.test(line) || /^[·─\s]+$/.test(line)) {
        if (block) blocks.push(block.join("\n"));
        block = /^\d+\.\s+솔로\s*레이드(?:\s|$)/.test(line) ? [line] : null;
      } else if (block) block.push(line);
    }
    if (block) blocks.push(block.join("\n"));
    return blocks;
  };
  const effective = split(text.effective);
  const evidence = split(text.evidence);
  return effective.map((block, index) => ({
    effective: block,
    evidence: evidence[index] ?? block,
  }));
}
