import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/locale";
import { lazyModuleRetryUrl, reloadWithLegacyInputs } from "../lib/lazyModuleRetry";
import type { SuccessAttemptModalState } from "../ui-types";
import { LazySectionErrorBoundary } from "./LazySectionErrorBoundary";
import { useDialogFocusTrap } from "./useDialogFocusTrap";

type ModalProps = {
  modal: SuccessAttemptModalState;
  onSubmit: (successAttempt: number | null) => void;
};
type ModalModule = typeof import("./SuccessAttemptModal");
let modalLoad: Promise<ModalModule> | null = null;
let retryUrl: string | null = null;
let retryGeneration = 0;

function createModal() {
  return lazy(() => {
    modalLoad ??= (
      retryUrl
        ? (import(/* @vite-ignore */ retryUrl) as Promise<ModalModule>)
        : import("./SuccessAttemptModal")
    )
      .then((module) => {
        retryUrl = null;
        retryGeneration = 0;
        return module;
      })
      .catch((error: unknown) => {
        retryUrl = lazyModuleRetryUrl(
          error,
          "SuccessAttemptModal",
          location.origin,
          ++retryGeneration,
        );
        throw error;
      });
    return modalLoad;
  });
}

function ModalFallback({
  firstFocusRef,
  onDismiss,
  onRetry,
  onReload,
  reloadFailed,
}: {
  firstFocusRef: React.RefObject<HTMLButtonElement | null>;
  onDismiss: () => void;
  onRetry?: (() => void) | undefined;
  onReload?: (() => void) | undefined;
  reloadFailed?: boolean;
}) {
  const { t } = useI18n();
  useLayoutEffect(() => {
    firstFocusRef.current?.focus();
  }, [firstFocusRef]);
  return (
    <div
      className="modal-cover"
      role="dialog"
      aria-modal="true"
      aria-labelledby="attemptPendingTitle"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <div>
        <h3 id="attemptPendingTitle" className="m-0 text-text-strong">
          {t("result.outcomeTitle")}
        </h3>
        <p role={onRetry || onReload ? "alert" : "status"}>
          {t(
            reloadFailed
              ? "error.reloadInputsUnavailable"
              : onReload
                ? "error.reloadInputsDetail"
                : onRetry
                  ? "error.sectionDetail"
                  : "modal.preparing",
          )}
        </p>
        <div className="flex justify-end gap-3">
          {onRetry || onReload ? (
            <button type="button" onClick={onReload ?? onRetry}>
              {t(onReload ? "error.reload" : "error.retrySection")}
            </button>
          ) : null}
          <button ref={firstFocusRef} type="button" onClick={onDismiss}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

function OpenModal({ modal, onSubmit }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFocusRef = useRef<HTMLButtonElement | null>(null);
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [Modal, setModal] = useState(createModal);
  const [reloadFailed, setReloadFailed] = useState(false);
  const dismiss = () => onSubmit(null);
  useDialogFocusTrap(true, dialogRef, firstFocusRef, dismiss, returnFocus);
  const retry = useCallback(() => {
    modalLoad = null;
    setModal(createModal());
  }, []);
  const reload = () => {
    if (!reloadWithLegacyInputs()) setReloadFailed(true);
  };
  return (
    <div ref={dialogRef} className="contents">
      <LazySectionErrorBoundary
        name="SuccessAttemptModal"
        onRetry={retry}
        fallback={(onRetry) => (
          <ModalFallback
            firstFocusRef={firstFocusRef}
            onDismiss={dismiss}
            onRetry={retryUrl ? onRetry : undefined}
            onReload={retryUrl ? undefined : reload}
            reloadFailed={reloadFailed}
          />
        )}
      >
        <Suspense fallback={<ModalFallback firstFocusRef={firstFocusRef} onDismiss={dismiss} />}>
          <Modal modal={modal} onSubmit={onSubmit} firstFocusRef={firstFocusRef} />
        </Suspense>
      </LazySectionErrorBoundary>
    </div>
  );
}

export default function LazySuccessAttemptModal(props: ModalProps) {
  return props.modal.open ? <OpenModal {...props} /> : null;
}
