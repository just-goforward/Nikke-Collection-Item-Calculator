import { useI18n } from "../i18n/locale";
import { certifiedMessages } from "./messages";

export function ForecastReviewNotice() {
  const { locale } = useI18n();
  return (
    <p className="cert-notice" role="status" data-forecast-review="unknown">
      {certifiedMessages[locale].reviewUnknown}
    </p>
  );
}
