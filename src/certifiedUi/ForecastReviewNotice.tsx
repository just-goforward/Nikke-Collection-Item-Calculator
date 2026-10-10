import { useEffect, useState } from "react";
import { useI18n } from "../i18n/locale";
import { type ForecastReviewStatus, watchForecastReviewStatus } from "./forecastReviewStatus";
import { certifiedMessages } from "./messages";

export function ForecastReviewNotice() {
  const { locale } = useI18n();
  const [status, setStatus] = useState<ForecastReviewStatus>("checking");
  useEffect(() => watchForecastReviewStatus({ onStatus: setStatus, visibility: document }), []);
  const words = certifiedMessages[locale];
  if (status !== "review_pending" && status !== "unknown") return null;
  return (
    <p className="cert-notice" role="status" data-forecast-review={status}>
      {status === "review_pending" ? words.reviewPending : words.reviewUnknown}
    </p>
  );
}
