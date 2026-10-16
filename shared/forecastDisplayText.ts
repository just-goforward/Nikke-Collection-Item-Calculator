/** Display-only normalization; never write the result back to source records. */
export function forecastDisplayText(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value
    .replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity: string) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? original;
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    })
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(
        code < 32 ||
        code === 127 ||
        code === 173 ||
        code === 847 ||
        code === 1564 ||
        code === 6158 ||
        (code >= 8203 && code <= 8207) ||
        (code >= 8234 && code <= 8238) ||
        (code >= 8288 && code <= 8303) ||
        code === 65279
      );
    })
    .join("");
}
