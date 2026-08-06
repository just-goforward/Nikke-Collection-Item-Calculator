import { useI18n } from "../i18n/locale";

const SOURCE_REPOSITORY = "https://github.com/just-goforward/Nikke-Collection-Item-Calculator";

export default function PrivacyFooter() {
  const { t } = useI18n();
  return (
    <footer className="privacy-footer mt-auto w-full pt-6 text-muted text-[11px] font-normal leading-[1.55] max-mobile:pt-5">
      <p>{t("privacy.notice")}</p>
      <p className="mt-1">
        {t("license.notice")}{" "}
        <a
          className="font-semibold text-text-soft underline underline-offset-[3px] hover:text-text-strong"
          href={`${SOURCE_REPOSITORY}/tree/${__SOURCE_REVISION__}`}
          rel="noreferrer"
          target="_blank"
        >
          {t("license.source")}
        </a>
      </p>
    </footer>
  );
}
