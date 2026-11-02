import { SITE_LOCALES } from "../shared/siteLocales.ts";

const expectedLocaleStylesheets = new Set([
  SITE_LOCALES.ko.fontStylesheet,
  SITE_LOCALES.en.fontStylesheet,
  SITE_LOCALES.ja.fontStylesheet,
]);

export function isExpectedBlockedFont({ url, method, resourceType }) {
  return method === "GET" && resourceType === "stylesheet" &&
    expectedLocaleStylesheets.has(url);
}
