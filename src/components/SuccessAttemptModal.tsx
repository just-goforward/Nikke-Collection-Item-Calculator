import { useEffect, useRef } from "react";

import type { SuccessAttemptModalState } from "../ui-types";

type SuccessAttemptModalProps = {
  modal: SuccessAttemptModalState;
  onAttemptChange: (attempt: number) => void;
  onSubmit: (successAttempt: number | null) => void;
};

export default function SuccessAttemptModal({
  modal,
  onAttemptChange,
  onSubmit,
}: SuccessAttemptModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!modal.open) return;
    inputRef.current?.focus();
  }, [modal.open]);

  if (!modal.open) return null;

  return (
    <div
      className="attempt-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="attemptModalTitle"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onSubmit(null);
      }}
    >
      <div className="attempt-modal">
        <div className="attempt-modal-header">
          <h3 id="attemptModalTitle">대성공이 발생한 시점을 입력해주세요.</h3>
        </div>
        <form
          className="attempt-entry-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(modal.attempt);
          }}
        >
          <div className="attempt-input-row">
            <button
              className="attempt-step-button"
              type="button"
              aria-label="회차 감소"
              onClick={() => onAttemptChange(modal.attempt - 1)}
            >
              -
            </button>
            <label className="attempt-number-field">
              <input
                ref={inputRef}
                className="attempt-number-input"
                type="number"
                inputMode="numeric"
                pattern="[0-9]*"
                min="1"
                max={modal.maxAttempt}
                step="1"
                value={modal.attempt}
                aria-label="대성공 발생 회차"
                onChange={(event) => onAttemptChange(Number(event.target.value))}
                onBlur={(event) => onAttemptChange(Number(event.target.value))}
              />
              <span>회 / {modal.maxAttempt}회</span>
            </label>
            <button
              className="attempt-step-button"
              type="button"
              aria-label="회차 증가"
              onClick={() => onAttemptChange(modal.attempt + 1)}
            >
              +
            </button>
          </div>
          <div className="attempt-modal-actions">
            <button className="attempt-submit-button" type="submit">
              기록
            </button>
            <button className="attempt-unknown-button" type="button" onClick={() => onSubmit(null)}>
              <strong>모르겠음</strong>
              <small>통계 기록 제외</small>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
