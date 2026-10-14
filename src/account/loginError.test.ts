import { describe, expect, it } from "vitest";
import { accountText } from "./accountMessages";
import { takeAccountError } from "./loginError";

const ORIGIN = "https://staging.example";

describe("?account_error=<code> from the callback bridge", () => {
  it.each([
    ["account_switch_requires_logout", "account_switch_requires_logout"],
    ["google_issuer_unsupported", "google_issuer_unsupported"],
    ["admission_full", "beta_full"],
    ["rate_limited", "rate_limited"],
    ["login_flow_expired", "login_flow_expired"],
    ["service_unavailable", "service_unavailable"],
    ["unknown", "login_error_unknown"],
    ["not_a_documented_code", "login_error_unknown"],
    ["", "login_error_unknown"],
    ["__proto__", "login_error_unknown"],
  ])("maps %s to a localized notice", (code, notice) => {
    expect(takeAccountError(`${ORIGIN}/?account_error=${code}`)?.notice).toBe(notice);
  });

  it("removes only the error parameter and keeps the path, other parameters and hash", () => {
    expect(
      takeAccountError(`${ORIGIN}/ja/?statsEnv=staging&account_error=rate_limited&x=1#top`)?.url,
    ).toBe("/ja/?statsEnv=staging&x=1#top");
    expect(takeAccountError(`${ORIGIN}/?account_error=unknown`)?.url).toBe("/");
  });

  it("does nothing without the parameter", () => {
    expect(takeAccountError(`${ORIGIN}/?statsEnv=staging`)).toBeNull();
  });

  it("has KO/EN/JA text for every login error notice", () => {
    for (const locale of ["ko", "en", "ja"] as const) {
      for (const key of [
        "notice.google_issuer_unsupported",
        "notice.login_flow_expired",
        "notice.login_error_unknown",
        "notice.beta_full",
      ] as const) {
        expect(accountText(locale, key)).not.toBe(accountText("ko", "notice.unexpected"));
      }
    }
  });
});
