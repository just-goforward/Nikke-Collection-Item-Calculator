import type { SupplyForecastProfile } from "../../shared/generated/supplyForecast";
import type { SiteLocale } from "../../shared/siteLocales";

const KST_TIME_ZONE = "Asia/Seoul";
const PROFILE_END_INCLUSIVE_OFFSET_MS = 60_000;
const LOCALE_CODES: Record<SiteLocale, string> = {
  ko: "ko-KR",
  en: "en-US",
  ja: "ja-JP",
};
const boundaryFormatters = new Map<SiteLocale, Intl.DateTimeFormat>();

function boundaryFormatter(locale: SiteLocale) {
  let formatter = boundaryFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE_CODES[locale], {
      timeZone: KST_TIME_ZONE,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    boundaryFormatters.set(locale, formatter);
  }
  return formatter;
}

function parsedTimestamp(value: string, label: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new RangeError(`Invalid ${label}: ${value}`);
  return timestamp;
}

export function formatStagingForecastKstWindow(
  profile: Pick<SupplyForecastProfile, "effectiveFrom" | "effectiveUntil">,
  locale: SiteLocale,
) {
  const formatter = boundaryFormatter(locale);
  const fromMs = parsedTimestamp(profile.effectiveFrom, "forecast effectiveFrom");
  if (profile.effectiveUntil === null) {
    return { from: formatter.format(fromMs), until: null };
  }

  const untilExclusiveMs = parsedTimestamp(profile.effectiveUntil, "forecast effectiveUntil");
  if (untilExclusiveMs <= fromMs) {
    throw new RangeError("Forecast effectiveUntil must be later than effectiveFrom.");
  }
  return {
    from: formatter.format(fromMs),
    until: formatter.format(untilExclusiveMs - PROFILE_END_INCLUSIVE_OFFSET_MS),
  };
}
