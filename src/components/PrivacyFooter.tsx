import { SITE_CONTACT_EMAIL, siteLegalPagePath } from "../../shared/siteLocales";
import { useI18n } from "../i18n/locale";

const LINK_CLASS =
  "font-semibold text-text-soft underline underline-offset-[3px] hover:text-text-strong";

export default function PrivacyFooter() {
  const { locale, t } = useI18n();
  const links = [
    { href: siteLegalPagePath(locale, "privacy"), label: t("footer.privacy") },
    { href: siteLegalPagePath(locale, "terms"), label: t("footer.terms") },
    {
      href: `mailto:${SITE_CONTACT_EMAIL}?subject=${encodeURIComponent(t("footer.contactSubject"))}`,
      label: t("footer.contact"),
    },
    { href: siteLegalPagePath(locale, "licenses"), label: t("footer.license") },
  ];
  return (
    <footer className="privacy-footer mt-auto w-full pt-6 text-muted text-[11px] font-normal leading-[1.55] max-mobile:pt-5">
      <nav aria-label={t("footer.nav")}>
        <ul className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {links.map((link, index) => (
            <li className="flex items-center gap-x-2" key={link.href}>
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              <a className={LINK_CLASS} href={link.href}>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <p className="mt-1">{t("rights.notice")}</p>
    </footer>
  );
}
