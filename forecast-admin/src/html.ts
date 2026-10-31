/** The page's only HTML encoder: every interpolated value passes through `escapeHtml`. */
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export class SafeHtml {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export type HtmlValue =
  | SafeHtml
  | string
  | number
  | null
  | undefined
  | false
  | readonly HtmlValue[];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function encode(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(encode).join("");
  return escapeHtml(String(value));
}

/** Tagged template: literal markup is trusted source text, interpolations are encoded. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let index = 0; index < values.length; index++)
    out += encode(values[index]) + (strings[index + 1] ?? "");
  return new SafeHtml(out);
}
