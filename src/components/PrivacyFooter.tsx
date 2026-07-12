import { useI18n } from "../i18n/locale";

export default function PrivacyFooter() {
  const { t } = useI18n();
  return (
    <footer className="privacy-footer mt-auto w-full pt-6 text-muted text-[11px] font-normal leading-[1.55] max-mobile:pt-5">
      {t("privacy.notice")}
    </footer>
  );
}
