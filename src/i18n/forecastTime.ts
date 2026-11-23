export function forecastTimeFormatter(locale: string, includeSeconds: boolean, includeMillis = false) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Seoul", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    ...(includeMillis ? { fractionalSecondDigits: 3 } : {}),
  });
}
