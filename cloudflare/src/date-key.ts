const KST_OFFSET_SECONDS = 9 * 60 * 60;

export function kstDateKeyFromUnixSeconds(seconds: number) {
  return new Date((seconds + KST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}
