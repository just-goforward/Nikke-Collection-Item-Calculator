import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AccountPanel,
  accountClasses,
  ConflictDialog,
  ConsentDialog,
  useAccountText,
} from "./AccountDialogs";
import { AccountController } from "./accountController";
import type {
  AccountNotice,
  AccountView,
  CalculatorBridge,
  StaleReason,
  SyncStatus,
} from "./accountState";
import { createAccountApi } from "./api";
import { createCrossTabChannel } from "./crossTab";
import type { CalculatorInput } from "./workspaceDocument";
import { openWorkspaceStore } from "./workspaceStore";

export type AccountEntryProps = {
  input: CalculatorInput;
  /** While the calculator is busy, server/guest inputs are applied once it is idle again. */
  inputLocked: boolean;
  onApplyInput: (input: CalculatorInput) => void;
};

const SAVE_DELAY_MS = 1_500;
const SESSION_RECHECK_MS = 30_000;

const SYNC_DOT_CLASSES: Record<SyncStatus, string> = {
  synced: "bg-primary",
  pending: "bg-muted",
  saving: "bg-muted",
  offline: "bg-warning",
  conflict: "bg-danger",
  paused: "bg-warning",
  error: "bg-danger",
};

const entryClasses = {
  root: "account-entry flex items-center",
  dot: "inline-block size-2 shrink-0 rounded-full",
  notice:
    "fixed bottom-5 left-5 z-40 flex max-w-[min(380px,calc(100%-40px))] items-start gap-3 rounded-card border border-border bg-surface px-4 py-3 text-[12.5px] font-semibold leading-[1.5] text-text shadow-panel empty:border-0 empty:p-0 empty:shadow-none max-mobile:bottom-[calc(var(--mobile-bottom-height,0px)+12px)] max-mobile:left-2.5",
  stale:
    "fixed inset-x-3 top-3 z-50 mx-auto flex max-w-[640px] flex-wrap items-center gap-3 rounded-card border border-warning bg-warning-soft px-4 py-3 text-[13px] font-semibold leading-[1.5] text-warning shadow-panel",
} as const;

function downloadJson(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function createBrowserController(calculator: CalculatorBridge) {
  return new AccountController({
    api: createAccountApi(),
    channel: createCrossTabChannel(),
    calculator,
    openStore: openWorkspaceStore,
    newOpId: () => crypto.randomUUID(),
    navigate: (url) => window.location.assign(url),
    download: downloadJson,
    now: Date.now,
    schedule: (callback, delayMs) => {
      const timer = window.setTimeout(callback, delayMs);
      return () => window.clearTimeout(timer);
    },
    saveDelayMs: SAVE_DELAY_MS,
  });
}

function useBrowserSignals(controller: AccountController) {
  useEffect(() => {
    let lastCheck = Date.now();
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheck < SESSION_RECHECK_MS) return;
      lastCheck = Date.now();
      void controller.checkSession();
    };
    const onOnline = () => void controller.syncNow();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [controller]);
}

function useAccountController({ input, inputLocked, onApplyInput }: AccountEntryProps) {
  const latestInput = useRef(input);
  useEffect(() => {
    latestInput.current = input;
  });
  const [pendingApply, setPendingApply] = useState<CalculatorInput | null>(null);
  const [controller] = useState(() =>
    createBrowserController({ capture: () => latestInput.current, apply: setPendingApply }),
  );
  useEffect(() => {
    void controller.start();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    if (!pendingApply || inputLocked) return;
    onApplyInput(pendingApply);
    setPendingApply(null);
  }, [inputLocked, onApplyInput, pendingApply]);
  const { grade, level, exp } = input;
  const { blue, purple, yellow } = input.stock;
  useEffect(() => {
    controller.notifyLocalChange({ grade, level, exp, stock: { blue, purple, yellow } });
  }, [blue, controller, exp, grade, level, purple, yellow]);
  useBrowserSignals(controller);
  return controller;
}

function GoogleMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path
        d="M14.6 8.2c0-.5 0-1-.1-1.4H8v2.7h3.7a3.2 3.2 0 0 1-1.4 2.1v1.7h2.3c1.3-1.2 2-3 2-5.1Z"
        fill="#4285F4"
      />
      <path
        d="M8 15c1.9 0 3.5-.6 4.6-1.7l-2.3-1.7c-.6.4-1.4.7-2.3.7-1.8 0-3.3-1.2-3.8-2.8H1.8v1.8A7 7 0 0 0 8 15Z"
        fill="#34A853"
      />
      <path d="M4.2 9.5a4.2 4.2 0 0 1 0-2.7V5H1.8a7 7 0 0 0 0 6.3l2.4-1.8Z" fill="#FBBC05" />
      <path
        d="M8 3.8c1 0 1.9.4 2.6 1l2-2A7 7 0 0 0 1.8 5l2.4 1.8C4.7 5 6.2 3.8 8 3.8Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function AccountTrigger({
  onLogin,
  onOpen,
  view,
}: {
  onLogin: () => void;
  onOpen: () => void;
  view: AccountView;
}) {
  const text = useAccountText();
  if (view.phase === "signed-in") {
    return (
      <button
        className={accountClasses.trigger}
        type="button"
        data-account-trigger
        aria-haspopup="dialog"
        aria-label={text("accountLabel", { status: text(`sync.${view.sync}`) })}
        onClick={onOpen}
      >
        <span className={`${entryClasses.dot} ${SYNC_DOT_CLASSES[view.sync]}`} aria-hidden="true" />
        <span>{text("account")}</span>
      </button>
    );
  }
  const busy = view.phase === "loading" || (view.phase === "guest" && view.busy === "login");
  return (
    <button
      className={accountClasses.trigger}
      type="button"
      data-account-trigger
      aria-label={text(busy && view.phase === "guest" ? "loginBusy" : "loginLabel")}
      aria-busy={busy}
      disabled={busy || view.phase === "stale"}
      onClick={onLogin}
    >
      <GoogleMark />
      <span>{text("login")}</span>
    </button>
  );
}

function StaleAlert({ reason }: { reason: StaleReason }) {
  const text = useAccountText();
  return (
    <div className={entryClasses.stale} role="alert">
      <span className="min-w-0 flex-1">{text(`stale.${reason}`)}</span>
      <button
        className={accountClasses.button}
        type="button"
        onClick={() => window.location.reload()}
      >
        {text("reload")}
      </button>
    </div>
  );
}

function NoticeRegion({
  notice,
  onDismiss,
}: {
  notice: AccountNotice | null;
  onDismiss: () => void;
}) {
  const text = useAccountText();
  return (
    <div className={entryClasses.notice} role="status" aria-live="polite" aria-atomic="true">
      {notice ? (
        <>
          <span className="min-w-0 flex-1">{text(`notice.${notice}`)}</span>
          <button className={accountClasses.button} type="button" onClick={onDismiss}>
            {text("dismiss")}
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Lazy account entry point: guests keep every feature; nothing here gates the calculator. */
export default function AccountEntry(props: AccountEntryProps) {
  const controller = useAccountController(props);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [panelOpen, setPanelOpen] = useState(false);
  const view = snapshot.view;
  const signedIn = view.phase === "signed-in" ? view : null;
  useEffect(() => {
    if (!signedIn) setPanelOpen(false);
  }, [signedIn]);
  return (
    <div className={entryClasses.root}>
      <AccountTrigger
        view={view}
        onLogin={() => void controller.login()}
        onOpen={() => setPanelOpen(true)}
      />
      {signedIn ? (
        <>
          <AccountPanel
            controller={controller}
            open={panelOpen}
            persistent={snapshot.persistent}
            view={signedIn}
            onClose={() => setPanelOpen(false)}
          />
          <ConsentDialog
            open={signedIn.consentPrompt && !panelOpen && signedIn.conflict === null}
            busy={signedIn.busy === "consent"}
            onChoose={(participation) => void controller.setConsent(participation)}
            onLater={() => controller.dismissConsentPrompt()}
          />
          <ConflictDialog
            conflict={signedIn.conflict}
            onChoose={(choice) => void controller.resolveConflict(choice)}
          />
        </>
      ) : null}
      {view.phase === "stale" ? <StaleAlert reason={view.reason} /> : null}
      <NoticeRegion notice={snapshot.notice} onDismiss={() => controller.dismissNotice()} />
    </div>
  );
}
