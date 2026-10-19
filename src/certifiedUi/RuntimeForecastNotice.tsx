import { useEffect, useState } from "react";
import { useI18n } from "../i18n/locale";
import { type RuntimeForecastStatus, runtimeForecast } from "../lib/runtimeForecast";

const messages = {
  ko: {
    unavailable:
      "승인된 공급 예측을 불러오지 못해 지금은 계산할 수 없습니다. 앱에 포함된 예측으로 대체하지 않습니다. 입력과 기록은 보존됩니다.",
    retry: "다시 확인",
    retrying: "확인 중…",
  },
  en: {
    unavailable:
      "Calculation unavailable: the approved supply forecast could not be loaded. The bundled forecast is not used. Your inputs and history are preserved.",
    retry: "Check again",
    retrying: "Checking…",
  },
  ja: {
    unavailable:
      "承認済みの供給予測を読み込めないため、現在は計算できません。アプリ内蔵の予測では代替しません。入力と記録は保持されます。",
    retry: "再確認",
    retrying: "確認中…",
  },
} as const;

/** Staging fail-closed state: no approved runtime publication means no calculation. */
export function RuntimeForecastNotice() {
  const { locale } = useI18n();
  const [status, setStatus] = useState<RuntimeForecastStatus>("checking");
  const [retrying, setRetrying] = useState(false);
  useEffect(() => runtimeForecast.subscribe(setStatus), []);
  if (status !== "unavailable" && status !== "off") return null;
  const words = messages[locale];
  const retry = () => {
    setRetrying(true);
    void runtimeForecast.refresh().finally(() => setRetrying(false));
  };
  return (
    <p
      className="cert-notice cert-notice-danger"
      role="alert"
      data-runtime-forecast={status}
      data-testid="certified-forecast-unavailable"
    >
      {words.unavailable}
      <button type="button" className="cert-button" disabled={retrying} onClick={retry}>
        {retrying ? words.retrying : words.retry}
      </button>
    </p>
  );
}
