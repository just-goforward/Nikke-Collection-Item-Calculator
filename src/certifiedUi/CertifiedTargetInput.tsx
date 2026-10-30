/** Raw user input stays textual until the bounded exact UI parser accepts it. */
export type CertifiedTargetDraft = {
  enabled: boolean;
  alpha: string;
  maxDays: number;
};

export const initialCertifiedTargetDraft: CertifiedTargetDraft = {
  enabled: false,
  alpha: "",
  maxDays: 14,
};

const targetInputWords = {
  en: {
    title: "Target probability (optional)",
    alpha: "Target probability: decimal or percentage",
    days: "Search horizon (days)",
    invalid: "Enter 0–1 or 0%–100%, without spaces or exponents. Before arithmetic, numerator digits (including leading zeros) and denominator digits derived from decimal places and % must each fit 128 digits.",
    help: "Choose your own target, for example 0.8 or 80%. A small probability gap can still require a long wait. This is separate from the existing waiting recommendation.",
  },
  ko: {
    title: "목표 확률 (선택)",
    alpha: "목표 확률: 소수 또는 백분율",
    days: "검색 범위 (일)",
    invalid: "공백·지수 없이 0~1 또는 0%~100%를 입력하세요. 계산 전 분자(앞자리 0 포함)와 소수 자릿수·%로 정해지는 분모가 각각 128자리 이하여야 합니다.",
    help: "0.8 또는 80%처럼 목표를 직접 입력하세요. 확률 차이가 작아도 오래 기다려야 할 수 있습니다. 기존 대기 추천과 별개입니다.",
  },
  ja: {
    title: "目標確率（任意）",
    alpha: "目標確率：小数またはパーセント",
    days: "検索範囲（日）",
    invalid: "空白・指数なしで 0～1 または 0%～100% を入力してください。計算前の分子（先頭の0を含む）と小数桁数・%から決まる分母は各128桁以内です。",
    help: "0.8 または 80% のように目標を入力してください。確率の差が小さくても長い待機が必要な場合があります。既存の待機推奨とは別です。",
  },
};

type Props = {
  locale: keyof typeof targetInputWords;
  value: CertifiedTargetDraft;
  disabled: boolean;
  error?: string;
  /** Owner must synchronously retire the current generation on every edit. */
  onChange: (next: CertifiedTargetDraft) => void;
};

/** Controlled draft; validation is owned by the exact UI parser. */
export function CertifiedTargetInput({ locale, value, disabled, error, onChange }: Props) {
  const words = targetInputWords[locale];
  return (
    <section className="cert-card" data-testid="certified-target-input">
      <label>
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />{" "}
        {words.title}
      </label>
      {value.enabled && (
        <>
          <label>
            {words.alpha}
            <input
              type="text"
              maxLength={260}
              value={value.alpha}
              disabled={disabled}
              aria-invalid={Boolean(error)}
              onChange={(event) => onChange({ ...value, alpha: event.target.value })}
            />
          </label>
          <label>
            {words.days}
            <select
              value={value.maxDays}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, maxDays: Number(event.target.value) })}
            >
              {Array.from({ length: 15 }, (_, day) => (
                <option key={day} value={day}>{day}</option>
              ))}
            </select>
          </label>
          <p className="cert-muted">{words.help}</p>
          {error && <p role="alert" className="cert-notice cert-notice-danger">{words.invalid}</p>}
        </>
      )}
    </section>
  );
}
