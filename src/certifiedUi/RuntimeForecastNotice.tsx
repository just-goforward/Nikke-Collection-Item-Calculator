import { useEffect, useState } from "react";
import { useI18n } from "../i18n/locale";
import { type RuntimeForecastStatus, runtimeForecast } from "../lib/runtimeForecast";

const messages = {
  ko: "공급 예측이 업데이트되지 않았습니다. 앱에 포함된 예측을 사용합니다.",
  en: "Forecast not updated. Using the bundled forecast.",
  ja: "供給予測は更新されていません。アプリ内蔵の予測を使用します。",
} as const;

export function RuntimeForecastNotice() {
  const { locale } = useI18n();
  const [status, setStatus] = useState<RuntimeForecastStatus>("checking");
  useEffect(() => runtimeForecast.subscribe(setStatus), []);
  if (status !== "unavailable" && status !== "off") return null;
  return (
    <p className="cert-notice" role="status" data-runtime-forecast={status}>
      {messages[locale]}
    </p>
  );
}
