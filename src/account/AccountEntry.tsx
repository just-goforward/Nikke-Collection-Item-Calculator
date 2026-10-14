import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AccountPanel,
  accountClasses,
  ConflictDialog,
  ConsentDialog,
  InputSummary,
  SignOutDialog,
  useAccountText,
} from "./AccountDialogs";
import type {
  AccountEntryProps,
  CalculatorInputBinding,
  CertifiedSessionBinding,
} from "./accountBinding";
import { CheckingIndicator } from "./accountCheck";
import { AccountController, type AccountUi } from "./accountController";
import type {
  AccountNotice,
  AccountView,
  CalculatorBridge,
  StaleReason,
  SyncStatus,
} from "./accountState";
import { createAccountApi } from "./api";
import { useAccountLock } from "./bootGate";
import { createCertifiedSessionCodec } from "./certifiedSessionItem";
import { createCrossTabChannel } from "./crossTab";
import { takeAccountError } from "./loginError";
import { createTabIdentity } from "./tabIdentity";
import { type CalculatorInput, calculatorInputKey } from "./workspaceDocument";
import { calculatorInputCodec, type WorkspaceItemCodec } from "./workspaceItem";
import { openWorkspaceStore } from "./workspaceStore";

/** A display switch the engine performs once it is idle. */
type EngineSwitch =
  | { kind: "input"; value: CalculatorInput }
  | { kind: "session"; text: string }
  | { kind: "guest" };

type EntryController = {
  ui: AccountUi;
  notifyChange(): void;
  /** Shows switched data in the engine once it is idle. */
  perform(next: EngineSwitch): void;
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
  offer:
    "fixed right-5 bottom-5 z-40 grid w-[min(380px,calc(100%-40px))] gap-2 rounded-card border border-primary bg-surface p-4 shadow-panel max-mobile:inset-x-2.5 max-mobile:bottom-[calc(var(--mobile-bottom-height,0px)+12px)] max-mobile:w-auto",
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

function createBrowserController<T>(codec: WorkspaceItemCodec<T>, calculator: CalculatorBridge<T>) {
  return new AccountController<T>({
    api: createAccountApi(),
    channel: createCrossTabChannel(),
    codec,
    calculator,
    openStore: () => openWorkspaceStore(codec.type),
    tab: createTabIdentity(),
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

/** The engine kind of a mounted entry never changes; the binding ref always holds that kind. */
function createEntryController(
  binding: { readonly current: AccountEntryProps },
  queue: (next: EngineSwitch) => void,
): EntryController {
  const initial = binding.current;
  if (initial.kind === "calculator-input") {
    const input = () => (binding.current as CalculatorInputBinding).input;
    const controller = createBrowserController(calculatorInputCodec, {
      capture: input,
      apply: (value) => queue({ kind: "input", value }),
    });
    return {
      ui: controller,
      notifyChange: () => controller.notifyLocalChange(input()),
      perform: (next) => {
        if (next.kind === "input")
          (binding.current as CalculatorInputBinding).onApplyInput(next.value);
      },
    };
  }
  const port = initial.createPort(() => (binding.current as CertifiedSessionBinding).deps);
  const controller = createBrowserController(createCertifiedSessionCodec(port), {
    capture: () => port.current(),
    apply: (text) => queue({ kind: "session", text }),
    ownGuest: { read: () => port.readGuest(), show: () => queue({ kind: "guest" }) },
  });
  return {
    ui: controller,
    notifyChange: () => {
      // Serializing the session is only needed while an account is shown.
      if (controller.getSnapshot().view.phase === "signed-in") {
        controller.notifyLocalChange(port.current());
      }
    },
    perform: (next) => {
      if (next.kind === "session") port.applyAccount(next.text);
      else if (next.kind === "guest") port.showGuest();
    },
  };
}

function useBrowserSignals(controller: AccountUi) {
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

function useAccountController(props: AccountEntryProps) {
  const binding = useRef(props);
  useEffect(() => {
    binding.current = props;
  });
  const [pending, setPending] = useState<EngineSwitch | null>(null);
  const [entry] = useState(() => createEntryController(binding, setPending));
  const controller = entry.ui;
  useEffect(() => {
    void controller.start();
    const loginError = takeAccountError(window.location.href);
    if (loginError) {
      window.history.replaceState(window.history.state, "", loginError.url);
      void controller.showNotice(loginError.notice);
    }
    return () => controller.dispose();
  }, [controller]);
  const { inputLocked } = props;
  useEffect(() => {
    if (!pending || inputLocked) return;
    setPending(null);
    entry.perform(pending);
    // An undo snapshot from before the switch belongs to the other data set.
    binding.current.onSwitched?.();
  }, [entry, inputLocked, pending]);
  const changeToken =
    props.kind === "calculator-input" ? calculatorInputKey(props.input) : props.changeToken;
  const notified = useRef<unknown>(null);
  useEffect(() => {
    // While a switch is pending the shown data is about to be replaced: edits to it are not
    // edits to the account (or guest) data the controller already moved to.
    if (pending || notified.current === changeToken) return;
    notified.current = changeToken;
    entry.notifyChange();
  }, [changeToken, entry, pending]);
  useBrowserSignals(controller);
  return { controller, switchPending: pending !== null };
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
  onRetry,
  view,
}: {
  onLogin: () => void;
  onOpen: () => void;
  onRetry: () => void;
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
  if (view.phase === "unavailable") {
    return (
      <button
        className={accountClasses.trigger}
        type="button"
        data-account-trigger
        aria-label={text("unavailableLabel")}
        onClick={onRetry}
      >
        <span className={`${entryClasses.dot} bg-warning`} aria-hidden="true" />
        <span>{text("unavailable")}</span>
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

function GuestImportCard({
  input,
  onCopy,
  onLater,
}: {
  input: CalculatorInput;
  onCopy: () => void;
  onLater: () => void;
}) {
  const text = useAccountText();
  return (
    <section className={entryClasses.offer} aria-labelledby="account-guest-import-title">
      <h2 id="account-guest-import-title" className={accountClasses.heading}>
        {text("guestImportTitle")}
      </h2>
      <p className={accountClasses.text}>{text("guestImportDetail")}</p>
      <InputSummary input={input} title={text("guestImportSummary")} />
      <div className={accountClasses.row}>
        <button className={accountClasses.primary} type="button" onClick={onCopy}>
          {text("guestImportCopy")}
        </button>
        <button className={accountClasses.button} type="button" onClick={onLater}>
          {text("guestImportLater")}
        </button>
      </div>
    </section>
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
  const { controller, switchPending } = useAccountController(props);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [panelOpen, setPanelOpen] = useState(false);
  const view = snapshot.view;
  const checking = useAccountLock(controller, view.phase, switchPending, {
    fellBack: props.bootFellBack.current,
    onLockChange: props.onLockChange,
  });
  const signedIn = view.phase === "signed-in" ? view : null;
  useEffect(() => {
    if (!signedIn) setPanelOpen(false);
  }, [signedIn]);
  return (
    <div className={entryClasses.root}>
      {checking ? <CheckingIndicator /> : null}
      <AccountTrigger
        view={view}
        onLogin={() => void controller.login()}
        onOpen={() => setPanelOpen(true)}
        onRetry={() => void controller.retryAccount()}
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
          <SignOutDialog
            kind={signedIn.signOutChoice}
            onCancel={() => controller.cancelSignOut()}
            onConfirm={(keepUnsynced) => void controller.confirmSignOut(keepUnsynced)}
          />
          {signedIn.guestImport ? (
            <GuestImportCard
              input={signedIn.guestImport}
              onCopy={() => void controller.copyGuestInputs()}
              onLater={() => controller.dismissGuestImport()}
            />
          ) : null}
        </>
      ) : null}
      {view.phase === "stale" ? <StaleAlert reason={view.reason} /> : null}
      <NoticeRegion notice={snapshot.notice} onDismiss={() => controller.dismissNotice()} />
    </div>
  );
}
