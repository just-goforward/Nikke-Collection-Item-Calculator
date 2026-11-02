// Safe Discord link presentation shared by publication and v2 notifications.
// Display only: no I/O or interaction controls.

// Link text is rendered by Discord clients that may show backslash escapes
// literally, so escape only inline formatting characters. Brackets survive only
// as simple balanced pairs not followed by "(" (Discord's label grammar); any
// other bracket becomes its full-width form so it cannot close the label or
// start a nested link.
export function linkLabel(value: string) {
  // "@" and "<" get an invisible zero-width space so "@everyone", "<@id>", "<#id>",
  // "<t:…>" or custom emoji never form a mention or Discord token.
  const formatted = value
    .replace(/[\\`*_~|]/g, "\\$&")
    .replaceAll("@", "@\u200b")
    .replaceAll("<", "<\u200b");
  return formatted.replace(/\[([^[\]]*)\](?!\()|[[\]]/g, (match, inner?: string) =>
    inner === undefined ? (match === "[" ? "［" : "］") : `[${inner}]`,
  );
}

function naverUrl(value: string) {
  const url = URL.parse(value);
  // ")" would end the masked link early; encode it (and "(") for Discord.
  return url?.protocol === "https:" && url.hostname === "game.naver.com"
    ? url.toString().replaceAll("(", "%28").replaceAll(")", "%29")
    : "https://game.naver.com/lounge/nikke/home";
}

/** Markdown link for an already display-normalized, length-bounded title. */
export function manualReviewPostLink(title: string, url: string) {
  return `[${linkLabel(title)}](${naverUrl(url)})`;
}
