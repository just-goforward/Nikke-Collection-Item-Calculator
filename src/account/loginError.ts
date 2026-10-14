import type { AccountNotice } from "./accountState";

/**
 * The callback bridge redirects failed sign-ins to `/?account_error=<code>`.
 * Documented codes; anything else (or an empty value) is shown as `unknown`.
 */
const ACCOUNT_ERROR_PARAM = "account_error";
const LOGIN_ERROR_NOTICES = {
  account_switch_requires_logout: "account_switch_requires_logout",
  google_issuer_unsupported: "google_issuer_unsupported",
  admission_full: "beta_full",
  rate_limited: "rate_limited",
  login_flow_expired: "login_flow_expired",
  service_unavailable: "service_unavailable",
  unknown: "login_error_unknown",
} as const satisfies Record<string, AccountNotice>;

type LoginErrorCode = keyof typeof LOGIN_ERROR_NOTICES;

function isLoginErrorCode(code: string): code is LoginErrorCode {
  return Object.hasOwn(LOGIN_ERROR_NOTICES, code);
}

/** Reads and strips the login error parameter; `url` keeps every other parameter and the hash. */
export function takeAccountError(href: string): { notice: AccountNotice; url: string } | null {
  const url = new URL(href);
  if (!url.searchParams.has(ACCOUNT_ERROR_PARAM)) return null;
  const code = url.searchParams.get(ACCOUNT_ERROR_PARAM) ?? "";
  url.searchParams.delete(ACCOUNT_ERROR_PARAM);
  return {
    notice: LOGIN_ERROR_NOTICES[isLoginErrorCode(code) ? code : "unknown"],
    url: `${url.pathname}${url.search}${url.hash}`,
  };
}
