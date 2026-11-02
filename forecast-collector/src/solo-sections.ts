import type { NormalizedSourceItem } from "./types";

export type NoticeText = {
  effective: string;
  evidence: string;
  legacyText?: string;
  parsed?: unknown;
};
// Side-channel only: never mutate the frozen Actions-compatible item or its hash.
export const noticeTexts = new WeakMap<NormalizedSourceItem, NoticeText>();

function collectTextNodes(value: unknown, values: string[]) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) collectTextNodes(child, values);
  } else {
    const record = value as Record<string, unknown>;
    if (record["@ctype"] === "textNode" && typeof record["value"] === "string")
      values.push(record["value"]);
    else for (const child of Object.values(record)) collectTextNodes(child, values);
  }
}

type TextState = {
  effective: string[];
  evidence: string[];
  strike: number;
  hidden: number;
};

function consumeTag(text: string, state: TextState) {
  const tag = /^<\s*(\/?)\s*([\w-]+)/.exec(text);
  if (!tag) return;
  const closing = tag[1] === "/";
  const name = tag[2]?.toLowerCase();
  if (name && /^(script|style|template)$/.test(name)) {
    state.hidden += closing ? -1 : 1;
    return;
  }
  if (state.hidden) return;
  if (name && /^(strike|s|del)$/.test(name)) {
    consumeStrike(closing, state);
  } else if (name === "br" || (closing && name && /^(p|div|li|h[1-6]|tr)$/.test(name))) {
    state.effective.push("\n");
    state.evidence.push("\n");
  }
}

function consumeStrike(closing: boolean, state: TextState) {
  if (!closing && state.strike++ === 0) state.evidence.push("~~");
  if (closing && state.strike > 0 && --state.strike === 0) state.evidence.push("~~");
}

function consumeText(input: string) {
  const state: TextState = { effective: [], evidence: [], strike: 0, hidden: 0 };
  for (const token of input.matchAll(/<!--[\s\S]*?-->|<[^>]*>|[^<]+|</g)) {
    const text = token[0];
    if (text.startsWith("<!--")) continue;
    if (text.startsWith("<") && text !== "<") consumeTag(text, state);
    else if (!state.hidden) {
      const decoded = decodeEntities(text);
      state.evidence.push(decoded);
      if (!state.strike) state.effective.push(decoded);
    }
  }
  return state;
}

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
    collectTextNodes(parsed, values);
    input = values.join("\n");
  }
  const { effective, evidence } = consumeText(input);
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
